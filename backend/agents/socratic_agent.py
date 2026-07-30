"""
socratic_agent.py — Guided Socratic Agent (spec-aligned)
=========================================================
The existing llm_calls.call_socratic() is deliberately STRICT: it replies with
exactly one question and never explains. That is great for the "Safe Space"
drill tab, but the cross-agent spec wants a *guided* Socratic experience:

  "guide the learner instead of directly giving full answers ... but it should
   still be useful and detailed enough. Do not give vague, incomplete answers ...
   Provide enough explanation so the user is not stuck."

So this module adds a second, richer Socratic surface used by the orchestrator.
It returns a structured payload the UI can render in order:

    {
      "explanation":         short scaffolding (2-4 sentences),
      "hint":                a concrete nudge toward the answer,
      "follow_up_question":  one guiding question to keep the learner thinking,
      "handoff":             None | {"target": "reasoning"|"rag", "why": "..."},
      "meta": {...}
    }

It reuses the shared Groq helper and AEP product distinctions from config, so it
stays consistent with every other agent. Falls back to a safe canned scaffold if
the LLM is unavailable.
"""

from __future__ import annotations

import time
import json

from .config import GROQ_MODEL, groq_call, parse_json_lenient, PRODUCT_DISTINCTIONS, make_meta

try:
    from langgraph.graph import StateGraph, END
    LANGGRAPH_AVAILABLE = True
except ImportError:
    LANGGRAPH_AVAILABLE = False


_GUIDED_SYSTEM = """You are the Nexus Guided Socratic Agent for Adobe Experience
Platform + Adobe Journeys learners. Your job is to GUIDE, not to dump the full
answer. But you must still be genuinely helpful — never vague or half-baked.

For the learner's message produce a compact scaffold. Respond ONLY with valid
JSON (no prose, no code fences) in EXACTLY this shape:

{
  "explanation": "2-4 sentences that break the concept into its key parts, using real Adobe product names. Enough that the learner is not stuck.",
  "hint": "one concrete hint that points toward the answer without stating it outright",
  "follow_up_question": "exactly one guiding question (Why... / What happens if... / How does X differ from Y...) that makes the learner reason the last step themselves",
  "handoff": null
}

Rules:
- Never give the final answer outright — lead them to it.
- Be specific to Adobe (RTCDP, AEP, AJO, Campaign, Target, Marketo, Offer Decisioning).
- If the question truly needs deep architecture/design reasoning, set
  "handoff" to {"target": "reasoning", "why": "..."}.
- If it needs a documented, source-backed fact, set
  "handoff" to {"target": "rag", "why": "..."}.
- Otherwise keep "handoff": null.

%s
""" % PRODUCT_DISTINCTIONS


def _fallback(topic: str) -> dict:
    subject = topic or "this concept"
    return {
        "explanation": (
            f"Let's break {subject} into parts. Most Adobe Experience Platform "
            "concepts have a data side (schemas, identities, profiles) and an "
            "activation side (segments, journeys, destinations). Placing your "
            "question on that map usually makes the next step clear."
        ),
        "hint": "Start by asking what data has to exist before the action you care about can happen.",
        "follow_up_question": (
            f"What information would AEP need to already have before {subject} could work end-to-end?"
        ),
        "handoff": None,
    }


def run_socratic_guided(message: str, *, topic: str = "", learner_context: str = "") -> dict:
    """
    Guided Socratic turn. Returns the structured scaffold above + meta.
    Never raises — falls back to a safe scaffold on any error.
    """
    start = time.time()
    user = message or ""
    if topic:
        user = f"Topic: {topic}\n\nLearner said: {message}"
    if learner_context:
        user += f"\n\nLearner context:\n{learner_context}"

    try:
        raw = groq_call([{"role": "user", "content": user}], _GUIDED_SYSTEM, max_tokens=450)
        data = parse_json_lenient(raw)
        # normalise shape
        payload = {
            "explanation": (data.get("explanation") or "").strip(),
            "hint": (data.get("hint") or "").strip(),
            "follow_up_question": (data.get("follow_up_question") or "").strip(),
            "handoff": data.get("handoff") if isinstance(data.get("handoff"), dict) else None,
        }
        if not payload["explanation"] or not payload["follow_up_question"]:
            raise ValueError("incomplete scaffold")
    except Exception as e:
        print(f"[socratic_guided] fallback ({e})")
        payload = _fallback(topic)

    payload["meta"] = make_meta("socratic_guided", GROQ_MODEL, start, {"engine": "llm"})
    return payload


# ── Optional single-node LangGraph wrapper (kept parallel to other agents) ─────

def build_socratic_graph():
    if not LANGGRAPH_AVAILABLE:
        return None

    def node(state: dict) -> dict:
        out = run_socratic_guided(
            state.get("message", ""),
            topic=state.get("topic", ""),
            learner_context=state.get("learner_context", ""),
        )
        return {**state, "socratic_result": out}

    g = StateGraph(dict)
    g.add_node("socratic", node)
    g.set_entry_point("socratic")
    g.add_edge("socratic", END)
    return g.compile()
