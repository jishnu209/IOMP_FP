"""
input_guardrails.py — Validate a user query BEFORE any agent runs
==================================================================
Reusable across every agent + the orchestrator. One function, `check_input`,
returns either:

    {"ok": True,  "query": "<cleaned>"}                       → proceed
    {"ok": False, "blocked": {status, reason, safe_response}} → stop, return blocked

Checks (deterministic, no LLM, cheap):
  1. empty / low-quality input
  2. prompt injection / instruction-override / prompt-exposure attempts
  3. unsafe / harmful / malware requests
  4. out-of-scope (not related to learning or the Adobe product domain)

Scope is enforced leniently: a query passes scope if it contains ANY in-scope
term OR is a short natural follow-up (<= 6 words) in an ongoing session, so we
don't block legitimate one-word replies like "yes" / "continue".
"""

from __future__ import annotations
from . import policy


def check_input(query: str, *, allow_short_followup: bool = True,
                enforce_scope: bool = True) -> dict:
    q = (query or "").strip()

    # 1) empty / too short to be meaningful
    if not q:
        return {"ok": False, "blocked": policy.blocked_response(
            "Empty input.", "Please type a question about your learning journey.")}
    if len(q) < 2:
        return {"ok": False, "blocked": policy.blocked_response(
            "Input too short to process.")}

    # 2) prompt injection / override / exposure
    hit = policy.is_injection(q)
    if hit:
        return {"ok": False, "blocked": policy.blocked_response(
            "The request attempts to override system instructions or expose hidden "
            "prompts, which isn't allowed.")}

    # 3) unsafe / harmful
    hit = policy.is_unsafe(q)
    if hit:
        return {"ok": False, "blocked": policy.blocked_response(
            "The request involves unsafe or harmful content.")}

    # 4) out-of-scope
    if enforce_scope:
        # Only treat as a benign follow-up if it's very short AND not a fresh
        # standalone question (so "recipe for lasagna" is still caught, but
        # replies like "yes" / "continue" / "next module" pass).
        words = q.split()
        looks_like_question = q.lower().startswith(
            ("what", "how", "why", "when", "where", "who", "which", "can ", "is ", "are ")
        ) or q.endswith("?")
        short_followup = allow_short_followup and len(words) <= 3 and not looks_like_question
        if not policy.in_scope(q) and not short_followup:
            return {"ok": False, "blocked": policy.blocked_response(
                "The request is outside the supported learning scope.")}

    return {"ok": True, "query": q}
