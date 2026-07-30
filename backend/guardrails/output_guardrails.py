"""
output_guardrails.py — Validate an agent's OUTPUT before it reaches the frontend
================================================================================
Reusable across every agent. `check_output` inspects a produced answer and
either passes it, annotates it, or flags it for regeneration.

Checks:
  - empty / too-vague / too-short answers
  - overconfident language on ungrounded RAG answers
  - missing citations when the agent is RAG and sources were expected
  - broken JSON when a structured response was expected
  - (optional) hallucination flag passed through from the RAG grounding step

Returns:
  {
    "ok": bool,                 # False → caller should regenerate/repair
    "answer": str,              # possibly annotated answer
    "issues": [str, ...],       # human-readable issues found
    "action": "pass" | "annotate" | "regenerate"
  }

Design note: output guardrails NEVER silently drop content. When something is
wrong they either annotate (soft) or ask the caller to regenerate (hard). This
keeps the pipeline debuggable — the `issues` list is surfaced in meta.
"""

from __future__ import annotations
import json

_VAGUE_MARKERS = (
    "i cannot", "i can't", "i'm not sure", "i am not sure",
    "as an ai", "i don't have enough", "unable to",
)
_OVERCONFIDENT = ("definitely", "guaranteed", "always works", "100%", "never fails")


def check_output(
    answer: str,
    *,
    agent: str = "generic",
    expect_json: bool = False,
    expect_citations: bool = False,
    grounded: bool | None = None,
    min_words: int = 6,
) -> dict:
    issues: list[str] = []
    text = (answer or "").strip()
    action = "pass"

    # broken JSON when structure was promised
    if expect_json:
        try:
            json.loads(text)
        except Exception:
            issues.append("expected valid JSON but could not parse")
            return {"ok": False, "answer": text, "issues": issues, "action": "regenerate"}

    # empty / too short
    if not text:
        issues.append("empty answer")
        return {"ok": False, "answer": text, "issues": issues, "action": "regenerate"}
    if len(text.split()) < min_words:
        issues.append(f"answer too short (<{min_words} words)")
        action = "regenerate"

    low = text.lower()

    # vague / refusal
    if any(m in low for m in _VAGUE_MARKERS) and len(text.split()) < 25:
        issues.append("answer is vague or a refusal")
        action = "regenerate" if action != "regenerate" else action

    # citations expected but absent (RAG)
    if expect_citations and "[doc" not in low and "source" not in low:
        issues.append("RAG answer is missing citations")
        # soft: annotate rather than hard-fail, so we still show *something*
        action = "annotate" if action == "pass" else action

    # overconfidence on ungrounded content
    if grounded is False and any(w in low for w in _OVERCONFIDENT):
        issues.append("overconfident language on unverified content")
        action = "annotate" if action == "pass" else action

    # apply soft annotation
    final = text
    if action == "annotate":
        note = ("\n\n_Note: this answer may be partially unverified against the "
                "indexed documentation — please cross-check the official Adobe docs._")
        final = text + note

    return {
        "ok": action != "regenerate",
        "answer": final,
        "issues": issues,
        "action": action,
    }
