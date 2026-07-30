"""
policy.py — Shared guardrail policy (single source of truth)
=============================================================
Reusable, data-driven policy consumed by BOTH input_guardrails and
output_guardrails so every agent enforces the same rules without copy-paste.

Nothing here calls an LLM — these are cheap, deterministic checks that run on
every request/response. LLM-based grounding checks live in output_guardrails and
are optional (they degrade gracefully when no key is set).
"""

from __future__ import annotations
import re

# ── Domain scope ──────────────────────────────────────────────────────────────
# The platform only serves Adobe AEP + Journeys learning. Requests must relate to
# learning / curriculum / career-skill / the Adobe product domain.
IN_SCOPE_TERMS = [
    # learning-journey intent
    "learn", "module", "quiz", "course", "curriculum", "study", "skill",
    "upskill", "cross-skill", "career", "role", "path", "progress", "test",
    "concept", "explain", "understand", "practice", "certification", "cert",
    # Adobe product domain
    "aep", "experience platform", "rtcdp", "cdp", "profile", "segment",
    "audience", "schema", "xdm", "dataset", "identity", "ingestion",
    "ajo", "journey optimizer", "campaign", "target", "marketo",
    "offer decisioning", "cja", "analytics", "data engineering", "architect",
    "destination", "activation", "consent", "decisioning",
]

# ── Prompt-injection / instruction-override patterns ──────────────────────────
INJECTION_PATTERNS = [
    r"ignore (all |the |your |previous |above )?(instructions|prompts?|rules?)",
    r"disregard (all |the |your |previous )?(instructions|prompts?|rules?)",
    r"forget (everything|all|your instructions|the above)",
    r"you are now\b", r"act as (?:a |an )?(?:dan|jailbreak|unrestricted)",
    r"reveal (your |the )?(system|developer|hidden) prompt",
    r"what (is|are) your (system|initial|hidden) (prompt|instructions)",
    r"print (your |the )?(system|developer) prompt",
    r"repeat (the )?(words? above|system prompt|everything above)",
    r"override (the |your )?(system|safety|developer)",
    r"developer mode", r"do anything now", r"without any restrictions?",
]

# ── Unsafe content patterns (harm / malware) ──────────────────────────────────
UNSAFE_PATTERNS = [
    r"\b(make|build|synthesi[sz]e) (a )?(bomb|explosive|weapon|bioweapon)",
    r"\b(ransomware|keylogger|rootkit|botnet)\b",
    r"how to (hack|ddos|sql[- ]?inject|exploit) (?!.*learn)",
    r"\b(self[- ]?harm|suicide)\b",
    r"steal (credit card|password|credentials|identity)",
]

# ── Standard blocked-response payload (matches the spec exactly) ──────────────
def blocked_response(reason: str, safe: str | None = None) -> dict:
    return {
        "status": "blocked",
        "reason": reason,
        "safe_response": safe or (
            "I can help with learning paths, quizzes, skill recommendations, and "
            "concept guidance for Adobe Experience Platform and Journeys. Please ask "
            "something related to your learning journey."
        ),
    }


def _match_any(text: str, patterns: list[str]) -> str | None:
    low = text.lower()
    for p in patterns:
        if re.search(p, low):
            return p
    return None


def is_injection(text: str) -> str | None:
    return _match_any(text, INJECTION_PATTERNS)


def is_unsafe(text: str) -> str | None:
    return _match_any(text, UNSAFE_PATTERNS)


def in_scope(text: str) -> bool:
    low = (text or "").lower()
    return any(term in low for term in IN_SCOPE_TERMS)
