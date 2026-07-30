"""
routes_learning.py — Curriculum chat API surface
===========================================================
A single APIRouter exposing /api/curriculum/chat, mapped to the existing
run_curriculum() guardrail node. This is the REAL endpoint the Curriculum
Agent's tutor chat UI calls (see src/App.jsx sendAgent/curriculum chat) —
distinct from the deterministic /api/agents/curriculum path in main.py.

Mount with two lines in main.py:

    from routes_learning import router as learning_router
    app.include_router(learning_router)

Endpoints:
    POST /api/curriculum/chat

This previously also exposed a parallel set of endpoints (rag/query,
socratic/chat, curriculum/generate-quiz, curriculum/submit-answer,
cross-skilling/recommend, cross-skilling/start-learning-path,
agents/orchestrate, rag/ingest-pdf, rag/pdf-docs, learning/status) built for
a standalone "AI Agents" testing panel (src/components/LearningAgents.jsx)
that duplicated functionality already in the main per-feature tabs (AI Tutor,
AI Advisor, Learning Path, etc) using a different backend path with its own
guardrail wiring. Both the panel and these unused routes were removed rather
than maintained as a second, confusing implementation of the same agents.

Every endpoint runs the reusable input guardrail first and returns the spec's
blocked payload on failure, so guardrails are enforced uniformly.
"""

from __future__ import annotations

from typing import Optional
from fastapi import APIRouter
from pydantic import BaseModel

from guardrails import check_input

router = APIRouter(tags=["learning-agents"])


class CurriculumChatRequest(BaseModel):
    user_id: str = ""
    message: str
    current_module_id: Optional[str] = None
    learning_goal: Optional[str] = None
    track: str = "rtcdp"
    confidence: float = 0.5
    modules: list = []
    done_modules: list = []
    conf_scores: dict = {}


@router.post("/api/curriculum/chat")
def curriculum_chat(body: CurriculumChatRequest):
    """Curriculum chatbot — meta guidance ('what next', 'how long', 'why this module')."""
    gate = check_input(body.message)
    if not gate["ok"]:
        return gate["blocked"]

    from agents.curriculum import run_curriculum
    out = run_curriculum("guardrail", {
        "learner_name": body.user_id,
        "track": body.track,
        "query": gate["query"],
        "overall_confidence": body.confidence,
        "modules": body.modules,
        "done_modules": body.done_modules,
        "conf_scores": body.conf_scores,
        "profile": {"learning_goal": body.learning_goal,
                    "current_module_id": body.current_module_id},
    })
    return {"result": out.get("result", {}), "meta": out.get("meta", {})}