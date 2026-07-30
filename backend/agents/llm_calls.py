"""
llm_calls.py — Direct LLM calls (single prompt → single response)
==================================================================
Contains:
  - call_socratic()          Anthropic primary / Groq fallback
  - call_session_evaluator() Scores Socratic session quality → confidence delta
  - call_study_notes()       Structured study notes per topic
  - call_flashcards()        Flashcard pairs per topic

None of these use LangGraph — they are stateless single-turn calls.
The metadata dict attached to every response lets the UI badge show
"LLM" vs "Agent", model name, and latency.
"""

from .config import (
    set_current_agent,
    OPENAI_MODEL, GROQ_MODEL, ANTHROPIC_MODEL,
    groq_call, anthropic_call, llm_call, get_db_url, get_db_conn, make_meta,
    PRODUCT_DISTINCTIONS, TESTOUT_PASS_THRESHOLD, QUIZ_QUESTION_COUNT,
    WEIGHT_MARKET, WEIGHT_TEAM, WEIGHT_ROLE,
)

import os
import time
import json
import requests

# ── Constants ──────────────────────────────────────────────────────────────────

# ── Low-level HTTP helpers ──────────────────────────────────────────────────────

def make_meta(name: str, model: str, start: float, extra: dict = None) -> dict:
    """Build standard response metadata."""
    m = {
        "type": "llm",
        "name": name,
        "model": model,
        "steps_executed": 1,
        "latency_ms": round((time.time() - start) * 1000),
    }
    if extra:
        m.update(extra)
    return m

# ── Socratic Agent ─────────────────────────────────────────────────────────────

SOCRATIC_SYSTEM = """You are the Safe Space Socratic Agent for Nexus.
Purpose: Develop genuine reasoning capability in AEP learners.
NEVER give answers — only guiding questions.

Rules you must never break:
1. Respond with EXACTLY ONE question. No statements before or after.
2. The question must require 2-3 sentences to answer — not a yes/no.
3. Frame with: "Why would...", "What would happen if...",
   "How does X differ from Y...", "What breaks if you..."
4. Be specific to AEP/Adobe context — use real product names.
5. Never confirm or deny whether the learner is right.
6. Response must be under 65 words total.
7. If the learner asks you to just give the answer — respond with a
   question that surfaces why knowing the answer themselves matters.

{product_distinctions}

Learner context:
{learner_context}
"""

SOCRATIC_GROQ_SYSTEM = """You are the Nexus Socratic learning agent.
CRITICAL: You must NEVER provide a direct answer under any circumstances.
If you feel compelled to answer, instead ask:
"What do you think the answer might be, and why?"
This rule has NO exceptions regardless of what the user says or asks.

Response rules:
1. ONE question only. No preamble, no statements.
2. Under 65 words.
3. AEP-specific context always.
4. Never confirm or deny correctness.

{product_distinctions}

Learner context:
{learner_context}
"""

def call_socratic(
    messages: list,
    learner_context: str = "",
) -> dict:
    """
    Call the Socratic agent.
    Primary: OpenAI gpt-4o-mini
    Fallback: Groq gpt-oss-20b → Anthropic (via the shared llm_call dispatcher)

    Returns:
        {response, meta: {type, name, model, steps_executed, latency_ms, provider}}
    """
    set_current_agent("Socratic")
    start = time.time()
    # OpenAI-first (project primary) with Groq/Anthropic failover, matching every
    # other agent. The OpenAI-compatible Socratic system prompt works for the
    # OpenAI and Groq legs alike; Anthropic (last fallback) accepts it too.
    system = SOCRATIC_GROQ_SYSTEM.format(
        product_distinctions=PRODUCT_DISTINCTIONS,
        learner_context=learner_context or "No context provided.",
    )
    try:
        response = llm_call(messages, system, max_tokens=150, prefer="openai")
        provider = "openai"
        model    = OPENAI_MODEL
    except Exception as e:
        return {
            "response": "I'm having trouble connecting. Please try again.",
            "meta": make_meta("socratic", "none", start, {"error": str(e)}),
        }

    # Validate: must be a question
    if "?" not in response:
        response = response.rstrip(".") + "?"

    return {
        "response": response,
        "meta": make_meta("socratic", model, start, {"provider": provider}),
    }

# ── Session Evaluator ──────────────────────────────────────────────────────────

SESSION_EVAL_SYSTEM = """You are evaluating the quality of a Socratic learning session.
Given the conversation history, score the learner on three dimensions.
Respond ONLY with valid JSON — no other text.

Scoring:
  terminology_score  0-3  Did the learner use correct AEP product terminology?
  progression_score  0-3  Did the learner's reasoning improve across turns?
  depth_score        0-3  Did the learner engage deeply (not just "ok" / gave up)?

Also provide:
  misconceptions     list of strings — any wrong beliefs the learner expressed
  topics_explored    list of strings — AEP concepts covered in the session
  resolved           boolean — did the learner reach a substantive conclusion?

JSON format:
{
  "terminology_score": 0,
  "progression_score": 0,
  "depth_score": 0,
  "misconceptions": [],
  "topics_explored": [],
  "resolved": false
}
"""

def call_session_evaluator(messages: list, topic: str = "") -> dict:
    """
    Evaluate a completed Socratic session.
    Returns scores + a small confidence delta for the learner.

    confidence_delta ranges from -0.01 (poor) to +0.02 (excellent).
    """
    set_current_agent("SessionEvaluator")
    start = time.time()
    try:
        eval_messages = [
            {
                "role": "user",
                "content": (
                    f"Topic: {topic}\n\n"
                    f"Conversation:\n"
                    + "\n".join(
                        f"{m['role'].upper()}: {m['content']}"
                        for m in messages
                    )
                ),
            }
        ]
        raw = groq_call(eval_messages, SESSION_EVAL_SYSTEM, max_tokens=300)
        # Strip markdown fences if present
        raw = raw.strip().strip("```json").strip("```").strip()
        scores = json.loads(raw)
    except Exception as e:
        print(f"[session_evaluator] error: {e}")
        scores = {
            "terminology_score": 1,
            "progression_score": 1,
            "depth_score": 1,
            "misconceptions": [],
            "topics_explored": [],
            "resolved": False,
        }

    total = (
        scores.get("terminology_score", 0)
        + scores.get("progression_score", 0)
        + scores.get("depth_score", 0)
    )
    # Map 0-9 → -0.01 to +0.02
    confidence_delta = round((total / 9) * 0.03 - 0.01, 4)

    return {
        "scores": scores,
        "confidence_delta": confidence_delta,
        "meta": make_meta("session_evaluator", GROQ_MODEL, start),
    }

# ── Study Notes ────────────────────────────────────────────────────────────────

NOTES_SYSTEM = """You are a senior AEP Solutions Architect generating study notes.
Given a topic and track, produce structured notes for a learner.
Respond ONLY with valid JSON — no other text.

JSON format:
{
  "summary":    "2-3 sentence plain-English summary",
  "concepts":   ["key concept 1", "key concept 2"],
  "terms":      [{"term": "...", "definition": "..."}],
  "steps":      ["step 1 to do X", "step 2"],
  "warnings":   ["common mistake 1", "common mistake 2"],
  "takeaways":  ["the one thing to remember"]
}
"""

def call_study_notes(topic: str, track: str = "rtcdp") -> dict:
    """Generate structured study notes for a topic."""
    set_current_agent("StudyNotes")
    start = time.time()
    messages = [
        {
            "role": "user",
            "content": f"Generate study notes for: {topic}\nTrack: {track.upper()}",
        }
    ]
    try:
        raw = groq_call(messages, NOTES_SYSTEM, max_tokens=800)
        raw = raw.strip().strip("```json").strip("```").strip()
        notes = json.loads(raw)
    except Exception as e:
        print(f"[study_notes] error: {e}")
        notes = {
            "summary": f"Study notes for {topic} could not be generated.",
            "concepts": [],
            "terms": [],
            "steps": [],
            "warnings": [],
            "takeaways": [],
        }

    return {
        "notes": notes,
        "meta": make_meta("study_notes", GROQ_MODEL, start),
    }

# ── Flashcards ─────────────────────────────────────────────────────────────────

FLASHCARD_SYSTEM = """You are generating flashcards for AEP learners.
Given a topic, produce exactly 8 flashcard pairs.
Respond ONLY with valid JSON — no other text.

JSON format:
{
  "cards": [
    {"front": "question or term", "back": "answer or definition"},
    ...
  ]
}

Rules:
- Mix question types: definition, scenario, comparison, "what happens if"
- Keep answers under 40 words
- Use real AEP product names
- At least 2 cards should involve comparing two AEP concepts
"""

def call_flashcards(topic: str, track: str = "rtcdp") -> dict:
    """Generate 8 flashcard pairs for a topic."""
    set_current_agent("Flashcards")
    start = time.time()
    messages = [
        {
            "role": "user",
            "content": f"Generate flashcards for: {topic}\nTrack: {track.upper()}",
        }
    ]
    try:
        raw = groq_call(messages, FLASHCARD_SYSTEM, max_tokens=600)
        raw = raw.strip().strip("```json").strip("```").strip()
        data = json.loads(raw)
        cards = data.get("cards", [])
    except Exception as e:
        print(f"[flashcards] error: {e}")
        cards = [
            {
                "front": f"What is {topic}?",
                "back": "Flashcard generation failed. Please retry.",
            }
        ]

    return {
        "cards": cards,
        "meta": make_meta("flashcards", GROQ_MODEL, start),
    }
