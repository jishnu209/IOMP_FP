"""
curriculum_routes.py — FastAPI router for the Curriculum Agent
===============================================================
Self-contained router that exposes the Curriculum Agent's full surface,
including the SEQUENTIAL quiz lifecycle (one question per request/tab/page).

Wire it into the app with a single line in main.py:

    from agents.curriculum_routes import router as curriculum_router
    app.include_router(curriculum_router)

All endpoints are namespaced under /api/curriculum/* so they don't collide with
the existing /api/agents/curriculum single-shot endpoint.
"""

from fastapi import APIRouter
from pydantic import BaseModel
from typing import Optional, List, Dict, Any

from . import curriculum as C
from .curriculum import build_curriculum_graph, run_curriculum

router = APIRouter(prefix="/api/curriculum", tags=["curriculum"])

# Compile the graph once at import (falls back to sequential if unavailable).
_GRAPH = None
try:
    _GRAPH = build_curriculum_graph()
except Exception as e:
    print(f"[curriculum_routes] graph build failed, using sequential: {e}")


# ── Request models ────────────────────────────────────────────────────────────

class QuizStartRequest(BaseModel):
    user_name: str
    track: str = "rtcdp"
    module_id: Optional[int] = None
    module_title: str = ""
    topic: str = ""
    mode: str = "path"                 # "path" (after learning path) | "optout" (test-out)
    confidence: float = 0.5            # learner's prior confidence 0-1


class AnswerRequest(BaseModel):
    session_id: str
    question_id: int
    given_index: int


class FinishRequest(BaseModel):
    session_id: str
    manager: str = ""


class NBARequest(BaseModel):
    user_name: str = ""
    track: str = "rtcdp"
    overall_confidence: float = 0.5
    modules: List[Dict[str, Any]] = []
    done_modules: List[Any] = []
    conf_scores: Dict[str, Any] = {}


class SequenceRequest(NBARequest):
    pass


class GuardrailRequest(BaseModel):
    query: str
    user_name: str = ""
    track: str = "rtcdp"
    overall_confidence: float = 0.5
    modules: List[Dict[str, Any]] = []
    done_modules: List[Any] = []
    conf_scores: Dict[str, Any] = {}
    profile: Dict[str, Any] = {}


# ── Quiz lifecycle (sequential delivery) ──────────────────────────────────────

@router.post("/quiz/start")
def quiz_start(body: QuizStartRequest):
    """
    Begin an adaptive quiz session. Returns the session id, the enforced
    constraints (max 15 Qs / 10-min timer / 70% threshold — from config), and
    the FIRST question only. Subsequent questions come one at a time from /next.
    """
    return C.start_quiz_session(
        user_name=body.user_name, track=body.track, module_id=body.module_id,
        module_title=body.module_title, topic=body.topic, mode=body.mode,
        confidence=body.confidence,
    )


@router.get("/quiz/{session_id}/next")
def quiz_next(session_id: str):
    """Return the next adaptively-selected question, or {done: true}."""
    return C.get_next_question(session_id)


@router.post("/quiz/answer")
def quiz_answer(body: AnswerRequest):
    """Submit one answer. Returns correctness + explanation + whether to stop."""
    return C.submit_answer(body.session_id, body.question_id, body.given_index)


@router.post("/quiz/finish")
def quiz_finish(body: FinishRequest):
    """Grade the session, store confidence + attempt, return result + fresh NBA."""
    return C.finish_quiz(body.session_id, manager=body.manager)


# ── NBA / sequence / guardrail (single-shot graph flows) ──────────────────────

@router.post("/nba")
def nba(body: NBARequest):
    ctx = {
        "learner_name": body.user_name, "track": body.track,
        "overall_confidence": body.overall_confidence,
        "modules": body.modules, "done_modules": body.done_modules,
        "conf_scores": body.conf_scores,
    }
    out = run_curriculum("nba", ctx, graph=_GRAPH)
    return {"result": out["result"], "meta": out["meta"]}


@router.post("/sequence")
def sequence(body: SequenceRequest):
    ctx = {
        "learner_name": body.user_name, "track": body.track,
        "overall_confidence": body.overall_confidence,
        "modules": body.modules, "done_modules": body.done_modules,
        "conf_scores": body.conf_scores,
    }
    out = run_curriculum("sequence", ctx, graph=_GRAPH)
    return {"result": out["result"], "meta": out["meta"]}


@router.post("/guardrail")
def guardrail(body: GuardrailRequest):
    """
    Handle a meta/guidance question. Returns either:
      {result: {kind:'answer',  answer, label}, ...}          — answered here
      {result: {kind:'redirect', target, endpoint, payload, message}, ...}
    The frontend follows the redirect to the Reasoning / Socratic agent.
    """
    ctx = {
        "learner_name": body.user_name, "track": body.track, "query": body.query,
        "overall_confidence": body.overall_confidence, "modules": body.modules,
        "done_modules": body.done_modules, "conf_scores": body.conf_scores,
        "profile": body.profile,
    }
    out = run_curriculum("guardrail", ctx, graph=_GRAPH)
    return {"result": out["result"], "meta": out["meta"]}


@router.get("/status")
def status():
    return {
        "graph": "compiled" if _GRAPH is not None else "sequential",
        "constraints": {
            "max_questions":        C.QUIZ_MAX_QUESTIONS,
            "min_questions":        C.QUIZ_MIN_QUESTIONS,
            "timer_seconds":        C.QUIZ_TIMER_SECONDS,
            "confidence_threshold": C.QUIZ_CONFIDENCE_PASS,
            "testout_pass_pct":     C.TESTOUT_PASS_THRESHOLD,
        },
    }
