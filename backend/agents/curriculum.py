"""
curriculum.py — Curriculum Agent (LangGraph)
=============================================
Implements the full Curriculum Agent spec:

  1. Quiz generation & grading
       - Adaptive (CAT): difficulty follows a running ability estimate (theta)
       - Constraints (all env-configurable): max 15 Qs, 10-min timer, 70% conf
       - Two triggers: after a learning path  OR  opt-out module test
       - Confidence stored in DB, per user profile
       - No two users get the same static set: pool is RAG-grounded + randomized
         with a per-session salt/nonce and shuffled option order
       - Sequential delivery: one question per call (get_next_question)

  2. NBA (Next Best Action) for modules

  3. Guardrail / guidance
       - Answers meta questions ("what next", "how to finish", "how long")
       - Subject-level questions are NOT answered here — they are handed off to
         the Reasoning Agent, or the Socratic Agent for Socratic-style prompts,
         with a redirect payload the frontend can act on.

Retrieval:
  - General grounding via the SHARED rag.retrieve()
  - Quiz grounding via the RESTRICTED curriculum_rag (module-scoped)

Nothing (questions, thresholds, ordering) is hardcoded — questions come from the
LLM grounded in the module's indexed docs; all limits come from config/env.
"""

from .config import (
    set_current_agent,
    GROQ_MODEL, groq_call, llm_call, get_db_url, parse_json_lenient, PRODUCT_DISTINCTIONS,
    TESTOUT_PASS_THRESHOLD,
    QUIZ_MAX_QUESTIONS, QUIZ_MIN_QUESTIONS, QUIZ_TIMER_SECONDS,
    QUIZ_CONFIDENCE_PASS, QUIZ_MAX_ATTEMPTS, QUIZ_POOL_MULTIPLIER, QUIZ_SESSION_TTL_MIN,
    CAT_START_THETA, CAT_STEP, CAT_SE_STOP, call_with_tools,
)
from . import curriculum_rag
from . import rag as shared_rag
from evaluation import evaluate_and_log, extract_tool_contexts
from guardrails import check_output

import json
import time
import math
import uuid
import random

try:
    from langgraph.graph import StateGraph, END
    LANGGRAPH_AVAILABLE = True
except ImportError:
    LANGGRAPH_AVAILABLE = False


# ══════════════════════════════════════════════════════════════════════════════
# DB SCHEMA (idempotent) + persistence helpers
# ══════════════════════════════════════════════════════════════════════════════

def _conn():
    import psycopg2
    import psycopg2.extras  # noqa: F401
    c = psycopg2.connect(get_db_url())
    c.autocommit = True
    return c


def ensure_tables():
    """Create quiz/NBA tables if absent. confidence_scores is reused as-is."""
    try:
        conn = _conn()
        with conn.cursor() as c:
            c.execute("""CREATE TABLE IF NOT EXISTS quiz_sessions (
                id            VARCHAR(48) PRIMARY KEY,
                user_name     VARCHAR(120) NOT NULL,
                track         VARCHAR(50)  DEFAULT 'rtcdp',
                module_id     INTEGER,
                module_title  VARCHAR(255),
                topic         VARCHAR(255),
                mode          VARCHAR(20)  DEFAULT 'path',   -- 'path' | 'optout'
                pool          JSONB        NOT NULL,          -- full generated pool (with answers)
                serve_order   JSONB        DEFAULT '[]',      -- question ids already served
                theta         FLOAT        DEFAULT 0,
                max_q         INTEGER,
                timer_s       INTEGER,
                threshold     FLOAT,
                grounded      BOOLEAN      DEFAULT TRUE,
                status        VARCHAR(20)  DEFAULT 'active',  -- active | finished | expired
                started_at    TIMESTAMP    DEFAULT NOW(),
                expires_at    TIMESTAMP)""")
            c.execute("""CREATE TABLE IF NOT EXISTS quiz_answers (
                id            SERIAL PRIMARY KEY,
                session_id    VARCHAR(48) REFERENCES quiz_sessions(id) ON DELETE CASCADE,
                question_id   INTEGER,
                given_index   INTEGER,
                correct_index INTEGER,
                is_correct    BOOLEAN,
                difficulty    VARCHAR(20),
                answered_at   TIMESTAMP DEFAULT NOW())""")
            c.execute("""CREATE TABLE IF NOT EXISTS quiz_attempts (
                id            SERIAL PRIMARY KEY,
                user_name     VARCHAR(120) NOT NULL,
                track         VARCHAR(50),
                module_id     INTEGER,
                module_title  VARCHAR(255),
                topic         VARCHAR(255),
                mode          VARCHAR(20),
                score_pct     NUMERIC,
                confidence    FLOAT,
                num_questions INTEGER,
                num_correct   INTEGER,
                passed        BOOLEAN,
                session_id    VARCHAR(48),
                created_at    TIMESTAMP DEFAULT NOW())""")
            c.execute("""CREATE TABLE IF NOT EXISTS nba_recommendations (
                id            SERIAL PRIMARY KEY,
                user_name     VARCHAR(120) NOT NULL,
                track         VARCHAR(50),
                action_type   VARCHAR(30),
                title         VARCHAR(255),
                reason        TEXT,
                module_id     INTEGER,
                urgency       VARCHAR(20),
                created_at    TIMESTAMP DEFAULT NOW())""")
            # confidence_scores already exists in the app schema:
            #   (user_name VARCHAR, module VARCHAR, score FLOAT, created_at)
            c.execute("""CREATE TABLE IF NOT EXISTS confidence_scores (
                id         SERIAL PRIMARY KEY,
                user_name  VARCHAR(120),
                module     VARCHAR(255),
                score      FLOAT,
                created_at TIMESTAMP DEFAULT NOW())""")
        conn.close()
    except Exception as e:
        print(f"[curriculum] ensure_tables warning: {e}")


def _load_confidence(user_name: str) -> dict:
    """Return {module_title: latest_score(0-1)} from the existing table."""
    out = {}
    try:
        conn = _conn()
        import psycopg2.extras
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as c:
            c.execute(
                """SELECT DISTINCT ON (module) module, score
                   FROM confidence_scores
                   WHERE user_name = %s
                   ORDER BY module, created_at DESC""",
                (user_name,),
            )
            for r in c.fetchall():
                out[r["module"]] = float(r["score"] or 0)
        conn.close()
    except Exception as e:
        print(f"[curriculum] load_confidence warning: {e}")
    return out


def save_confidence(user_name: str, module: str, score_0_1: float):
    try:
        conn = _conn()
        with conn.cursor() as c:
            c.execute(
                "INSERT INTO confidence_scores (user_name, module, score) VALUES (%s,%s,%s)",
                (user_name, module, round(float(score_0_1), 4)),
            )
        conn.close()
    except Exception as e:
        print(f"[curriculum] save_confidence error: {e}")


def save_nba(user_name: str, track: str, nba: dict):
    try:
        conn = _conn()
        with conn.cursor() as c:
            c.execute(
                """INSERT INTO nba_recommendations
                   (user_name, track, action_type, title, reason, module_id, urgency)
                   VALUES (%s,%s,%s,%s,%s,%s,%s)""",
                (user_name, track, nba.get("action_type"), nba.get("title"),
                 nba.get("reason"), nba.get("module_id"), nba.get("urgency")),
            )
        conn.close()
    except Exception as e:
        print(f"[curriculum] save_nba error: {e}")


# ══════════════════════════════════════════════════════════════════════════════
# CAT (Computerized Adaptive Testing) — pure functions
# ══════════════════════════════════════════════════════════════════════════════

_BANDS = ("beginner", "intermediate", "advanced")


def theta_from_confidence(conf_0_1: float) -> float:
    """Seed ability from prior confidence: 0.5→0, 0.7→0.8, 0.9→1.6."""
    return round((float(conf_0_1) - 0.5) * 4.0, 3)


def band_for_theta(theta: float) -> str:
    if theta < -0.4:
        return "beginner"
    if theta > 0.8:
        return "advanced"
    return "intermediate"


def update_theta(theta: float, correct: bool, difficulty: str) -> float:
    """Move ability estimate; harder correct answers move it more, and vice-versa."""
    weight = {"beginner": 0.7, "intermediate": 1.0, "advanced": 1.3}.get(difficulty, 1.0)
    delta = CAT_STEP * weight
    theta = theta + delta if correct else theta - delta
    return round(max(-3.0, min(3.0, theta)), 3)


def standard_error(n_answered: int) -> float:
    """Crude SE proxy: shrinks as more items are answered."""
    return 1.0 / math.sqrt(n_answered) if n_answered > 0 else 1.0


def should_stop(n_answered: int, max_q: int) -> bool:
    if n_answered >= max_q:
        return True
    if n_answered >= QUIZ_MIN_QUESTIONS and standard_error(n_answered) <= CAT_SE_STOP:
        return True
    return False


# ══════════════════════════════════════════════════════════════════════════════
# QUIZ POOL GENERATION (RAG-grounded, randomized, not hardcoded)
# ══════════════════════════════════════════════════════════════════════════════

QUIZ_SYSTEM = """You are the Nexus Curriculum Agent generating an adaptive-quiz question pool.
Generate {n} multiple-choice questions for the given module, spread across three
difficulty bands so an adaptive engine can pick per learner:
  - beginner      (recall, definitions)
  - intermediate  (application, comparison)
  - advanced      (design decisions, troubleshooting, trade-offs)
Aim for a roughly even split across bands.

GROUND every question in the provided module material. Do NOT invent AEP
features. If the material is thin, still produce valid questions but stay
conservative and factual.

Diversity salt (use to vary phrasing/scenarios so no two learners get an
identical set): {salt}

{product_distinctions}

Respond ONLY with valid JSON — no other text:
{{
  "questions": [
    {{
      "question": "...",
      "options": ["...", "...", "...", "..."],   // exactly 4, no A./B. prefixes
      "correct": 0,                               // zero-based index into options
      "difficulty": "beginner|intermediate|advanced",
      "explanation": "why the correct option is right"
    }}
  ]
}}
"""

TESTOUT_HINT = """This is an OPT-OUT / test-out quiz: skew HARDER (mostly
intermediate and advanced, scenario-based) — the learner is trying to skip the
module by proving mastery."""


def generate_quiz_pool(topic: str, module_title: str, track: str,
                       confidence: float, mode: str = "path",
                       n: int = None, seed: int = None) -> dict:
    """
    Build a randomized, RAG-grounded question pool.

    Returns {pool: [...], grounded: bool, sources: [...]}
    Each pool item: {id, question, options[4], correct(int), difficulty, explanation}
    """
    if n is None:
        n = int(QUIZ_MAX_QUESTIONS * QUIZ_POOL_MULTIPLIER)
    rng = random.Random(seed if seed is not None else uuid.uuid4().int)
    salt = f"{mode}:{rng.randint(100000, 999999)}"

    grounding = curriculum_rag.build_grounding_pack(module_title or topic, track=track, topic=topic)
    context = grounding["context"]

    sys = QUIZ_SYSTEM.format(
        n=n, salt=salt, product_distinctions=PRODUCT_DISTINCTIONS
    )
    if mode == "optout":
        sys += "\n" + TESTOUT_HINT

    user = (
        f"Module: {module_title or topic}\n"
        f"Topic: {topic or module_title}\n"
        f"Track: {(track or 'rtcdp').upper()}\n"
        f"Learner prior confidence: {confidence:.2f}\n\n"
        f"MODULE MATERIAL (ground questions in this):\n"
        f"{context if context else '(no indexed material found — stay factual and generic)'}"
    )

    gen_error = None
    try:
        # ~30 questions (n = QUIZ_MAX_QUESTIONS * QUIZ_POOL_MULTIPLIER) each need a
        # question + 4 options + explanation — 2200 tokens was tight enough that
        # verbose topics could truncate mid-JSON and silently produce zero valid
        # questions. Scale the budget with n instead of a fixed guess.
        # llm_call → Groq first, automatic Anthropic failover on missing key /
        # 429 / 5xx, so a rate-limited or unconfigured Groq no longer dead-ends
        # quiz generation with "Could not generate… check your Groq key".
        raw = llm_call([{"role": "user", "content": user}], sys, max_tokens=max(2200, n * 180))
        data = parse_json_lenient(raw)
        questions = data.get("questions", []) if isinstance(data, dict) else []
    except Exception as e:
        print(f"[curriculum] quiz pool generation error: {e}")
        questions = []
        # Distinguish "Groq is rate-limited/down right now" from "the model's
        # response didn't parse as valid JSON" — the frontend should tell the
        # learner something truthful instead of guessing "no API key set" for
        # every failure mode, which is what happened before this was tracked.
        # llm_call wraps per-provider failures in a RuntimeError whose message
        # joins each provider's error, so classify off the text (plus any direct
        # HTTP status) to keep giving the learner a truthful reason.
        status  = getattr(getattr(e, "response", None), "status_code", None)
        err_txt = str(e)
        both_keys_missing = "GROQ_API_KEY not set" in err_txt and "ANTHROPIC_API_KEY not set" in err_txt
        if isinstance(e, ValueError) and "GROQ_API_KEY" in err_txt:
            gen_error = "missing_api_key"
        elif both_keys_missing:
            gen_error = "missing_api_key"
        elif status == 429 or "429" in err_txt:
            gen_error = "rate_limited"
        elif status is not None and status >= 500:
            gen_error = "upstream_unavailable"
        elif "All LLM providers failed" in err_txt:
            # both providers unreachable (e.g. rate-limited Groq + invalid Anthropic key)
            gen_error = "upstream_unavailable"
        else:
            gen_error = "generation_failed"

    pool = []
    for i, q in enumerate(questions):
        opts = q.get("options", [])
        if not isinstance(opts, list) or len(opts) < 2:
            continue
        opts = [str(o) for o in opts][:4]
        correct = q.get("correct", 0)
        try:
            correct = int(correct)
        except Exception:
            correct = 0
        correct = max(0, min(correct, len(opts) - 1))

        # Shuffle option order so the correct index differs per learner.
        order = list(range(len(opts)))
        rng.shuffle(order)
        shuffled = [opts[j] for j in order]
        new_correct = order.index(correct)

        diff = q.get("difficulty", "intermediate")
        if diff not in _BANDS:
            diff = "intermediate"

        pool.append({
            "id":          i + 1,
            "question":    str(q.get("question", "")).strip(),
            "options":     shuffled,
            "correct":     new_correct,
            "difficulty":  diff,
            "explanation": str(q.get("explanation", "")).strip(),
        })

    # Randomize pool order too — the CAT selector then picks by band from this.
    rng.shuffle(pool)
    for idx, item in enumerate(pool):
        item["id"] = idx + 1  # stable ids after shuffle

    return {"pool": pool, "grounded": grounding["grounded"], "sources": grounding["sources"],
            "error": gen_error if not pool else None}


def public_question(q: dict, position: int, total_hint: int) -> dict:
    """Strip the answer + explanation before sending a question to the client."""
    return {
        "id":         q["id"],
        "question":   q["question"],
        "options":    q["options"],
        "difficulty": q["difficulty"],
        "position":   position,       # 1-based, sequential delivery
        "of_max":     total_hint,
    }


# ══════════════════════════════════════════════════════════════════════════════
# GRADING + CONFIDENCE
# ══════════════════════════════════════════════════════════════════════════════

def grade(answers: list) -> dict:
    """
    answers: [{is_correct: bool, difficulty: str}]
    Returns {score_pct, confidence, num_correct, num_questions}.
    Confidence is difficulty-weighted correctness mapped to 0..1.
    """
    n = len(answers)
    if n == 0:
        return {"score_pct": 0.0, "confidence": 0.0, "num_correct": 0, "num_questions": 0}

    w = {"beginner": 0.8, "intermediate": 1.0, "advanced": 1.3}
    got = tot = 0.0
    correct_count = 0
    for a in answers:
        weight = w.get(a.get("difficulty", "intermediate"), 1.0)
        tot += weight
        if a.get("is_correct"):
            got += weight
            correct_count += 1

    weighted = (got / tot) if tot else 0.0
    raw_pct = (correct_count / n) * 100.0
    confidence = round(max(0.0, min(1.0, weighted)), 4)
    return {
        "score_pct":     round(raw_pct, 1),
        "confidence":    confidence,
        "num_correct":   correct_count,
        "num_questions": n,
    }


# ══════════════════════════════════════════════════════════════════════════════
# SESSION LIFECYCLE (sequential, one-question-per-call)  — used by the routes
# ══════════════════════════════════════════════════════════════════════════════

def _get_session(session_id: str):
    import psycopg2.extras
    conn = _conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as c:
            c.execute("SELECT * FROM quiz_sessions WHERE id=%s", (session_id,))
            return c.fetchone()
    finally:
        conn.close()


def _session_expired(sess) -> bool:
    if not sess or not sess.get("expires_at"):
        return False
    try:
        return time.time() > sess["expires_at"].timestamp()
    except Exception:
        return False


def _attempt_count(user_name, module_title, topic, mode) -> int:
    """How many times this learner has already finished a quiz for this
    topic/module in this mode. Keyed on module_title-or-topic since callers use
    whichever is set (topic for ad-hoc checks, module_title for module quizzes)."""
    try:
        conn = _conn()
        with conn.cursor() as c:
            c.execute(
                """SELECT COUNT(*) FROM quiz_attempts
                   WHERE user_name=%s AND mode=%s
                     AND COALESCE(module_title,'')=%s AND COALESCE(topic,'')=%s""",
                (user_name, mode, module_title or "", topic or ""))
            return c.fetchone()[0]
    except Exception as e:
        print(f"[curriculum] attempt count error: {e}")
        return 0  # fail open — a DB blip shouldn't lock a learner out of studying


def start_quiz_session(user_name, track, module_id, module_title, topic,
                       mode="path", confidence=0.5) -> dict:
    """Create a session, generate the pool, return session meta + first question."""
    ensure_tables()

    prior_attempts = _attempt_count(user_name, module_title, topic, mode)
    if prior_attempts >= QUIZ_MAX_ATTEMPTS:
        return {
            "ok": False,
            "error": f"You've reached the {QUIZ_MAX_ATTEMPTS}-attempt limit for this quiz. Review the module content with the AI Tutor before trying a related topic.",
            "error_code": "max_attempts_reached",
            "attempts_used": prior_attempts,
        }

    gen = generate_quiz_pool(topic, module_title, track, confidence, mode=mode)
    pool = gen["pool"]
    if not pool:
        reason = gen.get("error") or "generation_failed"
        messages = {
            "missing_api_key":     "The quiz agent's API key isn't configured on the server — this isn't something you can fix from here.",
            "rate_limited":        "The AI service is rate-limited right now (too many quiz/study requests at once). Please wait a moment and try again.",
            "upstream_unavailable": "The AI service is temporarily unavailable. Please try again shortly.",
            "generation_failed":   "Could not generate quiz questions for this module. Please try again.",
        }
        return {"ok": False, "error": messages.get(reason, messages["generation_failed"]), "error_code": reason}

    sid = uuid.uuid4().hex
    threshold = float(TESTOUT_PASS_THRESHOLD) / 100.0 if mode == "optout" else QUIZ_CONFIDENCE_PASS
    theta = theta_from_confidence(confidence)

    conn = _conn()
    with conn.cursor() as c:
        c.execute(
            """INSERT INTO quiz_sessions
               (id, user_name, track, module_id, module_title, topic, mode, pool,
                serve_order, theta, max_q, timer_s, threshold, grounded, status, expires_at)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'active',
                       NOW() + (%s || ' minutes')::interval)""",
            (sid, user_name, track, module_id, module_title, topic, mode,
             json.dumps(pool), json.dumps([]), theta,
             QUIZ_MAX_QUESTIONS, QUIZ_TIMER_SECONDS, threshold,
             gen["grounded"], str(QUIZ_SESSION_TTL_MIN)),
        )
    conn.close()

    first = _select_next(pool, [], theta)
    return {
        "ok": True,
        "session_id": sid,
        "mode": mode,
        "grounded": gen["grounded"],
        "sources": gen["sources"],
        "constraints": {
            "max_questions":        QUIZ_MAX_QUESTIONS,
            "timer_seconds":        QUIZ_TIMER_SECONDS,
            "confidence_threshold": threshold,
        },
        "question": public_question(first, 1, QUIZ_MAX_QUESTIONS) if first else None,
    }


def _served_ids(sess) -> list:
    v = sess.get("serve_order")
    if isinstance(v, str):
        try:
            return json.loads(v)
        except Exception:
            return []
    return v or []


def _pool(sess) -> list:
    v = sess.get("pool")
    if isinstance(v, str):
        return json.loads(v)
    return v or []


def _select_next(pool, served_ids, theta):
    """CAT selection: prefer an unserved question in the band matching theta."""
    served = set(served_ids)
    remaining = [q for q in pool if q["id"] not in served]
    if not remaining:
        return None
    target = band_for_theta(theta)
    same = [q for q in remaining if q["difficulty"] == target]
    if same:
        return same[0]
    # nearest band fallback
    order = {"beginner": 0, "intermediate": 1, "advanced": 2}
    remaining.sort(key=lambda q: abs(order[q["difficulty"]] - order[target]))
    return remaining[0]


def get_next_question(session_id: str) -> dict:
    sess = _get_session(session_id)
    if not sess:
        return {"ok": False, "error": "session not found"}
    if sess["status"] != "active" or _session_expired(sess):
        return {"ok": True, "done": True, "reason": "expired_or_finished"}

    served = _served_ids(sess)
    if should_stop(len(served), sess["max_q"]):
        return {"ok": True, "done": True, "reason": "limit_reached"}

    nxt = _select_next(_pool(sess), served, sess["theta"])
    if not nxt:
        return {"ok": True, "done": True, "reason": "pool_exhausted"}
    return {"ok": True, "done": False,
            "question": public_question(nxt, len(served) + 1, sess["max_q"])}


def submit_answer(session_id: str, question_id: int, given_index: int) -> dict:
    """Grade one answer, update theta + serve_order, decide whether to continue."""
    sess = _get_session(session_id)
    if not sess:
        return {"ok": False, "error": "session not found"}
    if sess["status"] != "active":
        return {"ok": False, "error": "session not active"}

    pool = _pool(sess)
    q = next((x for x in pool if x["id"] == question_id), None)
    if not q:
        return {"ok": False, "error": "question not in session"}

    served = _served_ids(sess)
    if question_id in served:
        return {"ok": False, "error": "question already answered"}

    is_correct = int(given_index) == int(q["correct"])
    new_theta = update_theta(sess["theta"], is_correct, q["difficulty"])
    served.append(question_id)

    conn = _conn()
    with conn.cursor() as c:
        c.execute(
            """INSERT INTO quiz_answers
               (session_id, question_id, given_index, correct_index, is_correct, difficulty)
               VALUES (%s,%s,%s,%s,%s,%s)""",
            (session_id, question_id, given_index, q["correct"], is_correct, q["difficulty"]),
        )
        c.execute(
            "UPDATE quiz_sessions SET serve_order=%s, theta=%s WHERE id=%s",
            (json.dumps(served), new_theta, session_id),
        )
    conn.close()

    expired = _session_expired(sess)
    done = expired or should_stop(len(served), sess["max_q"])
    return {
        "ok": True,
        "is_correct": is_correct,
        "correct_index": q["correct"],
        "explanation": q["explanation"],
        "answered": len(served),
        "theta": new_theta,
        "done": done,
        "timed_out": expired,
    }


def _answered_rows(session_id: str) -> list:
    import psycopg2.extras
    conn = _conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as c:
            c.execute(
                "SELECT is_correct, difficulty FROM quiz_answers WHERE session_id=%s",
                (session_id,),
            )
            return c.fetchall()
    finally:
        conn.close()


def finish_quiz(session_id: str, manager: str = "") -> dict:
    """Grade the session, persist confidence + attempt, handle opt-out completion."""
    sess = _get_session(session_id)
    if not sess:
        return {"ok": False, "error": "session not found"}

    rows = _answered_rows(session_id)
    result = grade([{"is_correct": r["is_correct"], "difficulty": r["difficulty"]} for r in rows])

    mode = sess["mode"]
    threshold = float(sess["threshold"])
    # Path quizzes pass on confidence; opt-out also requires the raw score bar.
    passed = result["confidence"] >= threshold
    if mode == "optout":
        passed = passed and result["score_pct"] >= float(TESTOUT_PASS_THRESHOLD)

    # persist
    save_confidence(sess["user_name"], sess["module_title"] or sess["topic"], result["confidence"])
    conn = _conn()
    with conn.cursor() as c:
        c.execute(
            """INSERT INTO quiz_attempts
               (user_name, track, module_id, module_title, topic, mode,
                score_pct, confidence, num_questions, num_correct, passed, session_id)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (sess["user_name"], sess["track"], sess["module_id"], sess["module_title"],
             sess["topic"], mode, result["score_pct"], result["confidence"],
             result["num_questions"], result["num_correct"], passed, session_id),
        )
        c.execute("UPDATE quiz_sessions SET status='finished' WHERE id=%s", (session_id,))
    conn.close()

    # Opt-out pass → record module test-out + mark module complete (existing tables).
    module_unlocked = False
    if mode == "optout" and passed:
        module_unlocked = _record_optout_completion(sess, manager, result)

    # Fresh NBA off the new confidence.
    nba = _quick_nba(sess["user_name"], sess["track"], sess["module_title"], result["confidence"], passed)
    save_nba(sess["user_name"], sess["track"], nba)

    attempts_used = _attempt_count(sess["user_name"], sess["module_title"], sess["topic"], mode)  # includes the one just recorded above

    return {
        "ok": True,
        "mode": mode,
        "score_pct": result["score_pct"],
        "confidence": result["confidence"],
        "num_correct": result["num_correct"],
        "num_questions": result["num_questions"],
        "threshold": threshold,
        "passed": passed,
        "module_unlocked": module_unlocked,
        "nba": nba,
        "attempts_used": attempts_used,
        "attempts_remaining": max(0, QUIZ_MAX_ATTEMPTS - attempts_used),
    }


def _record_optout_completion(sess, manager, result) -> bool:
    """Mirror main.py's test-out bookkeeping using the existing tables."""
    try:
        conn = _conn()
        with conn.cursor() as c:
            c.execute("""CREATE TABLE IF NOT EXISTS module_test_outs (
                id SERIAL PRIMARY KEY, member_name VARCHAR(120) NOT NULL,
                manager VARCHAR(120), track VARCHAR(50), module_id INTEGER,
                module_title VARCHAR(255), score NUMERIC, total_questions INTEGER,
                correct_answers INTEGER, passed BOOLEAN, created_at TIMESTAMP DEFAULT NOW())""")
            c.execute(
                """INSERT INTO module_test_outs
                   (member_name, manager, track, module_id, module_title,
                    score, total_questions, correct_answers, passed)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,TRUE)""",
                (sess["user_name"], manager, sess["track"], sess["module_id"],
                 sess["module_title"], result["score_pct"],
                 result["num_questions"], result["num_correct"]),
            )
            c.execute(
                """INSERT INTO user_module_progress
                   (member_name, manager, track, module_id, module_title, via)
                   VALUES (%s,%s,%s,%s,%s,'test-out')
                   ON CONFLICT (member_name, track, module_id) DO NOTHING""",
                (sess["user_name"], manager, sess["track"],
                 sess["module_id"], sess["module_title"]),
            )
        conn.close()
        return True
    except Exception as e:
        print(f"[curriculum] optout completion warning: {e}")
        return False


# ══════════════════════════════════════════════════════════════════════════════
# LANGGRAPH NODES  (sequence / nba / quiz-pool / guardrail)
# ══════════════════════════════════════════════════════════════════════════════

def node_load_state(state: dict) -> dict:
    user = state.get("learner_name", "")
    conf = _load_confidence(user) if user else {}
    # merge any confidence passed inline (module_title keyed) without overwriting DB
    for k, v in (state.get("conf_scores") or {}).items():
        conf.setdefault(k, v)
    return {**state, "conf_scores": conf}


def node_route(state: dict) -> dict:
    return state


def _get_route(state: dict) -> str:
    return state.get("request_type", "quiz")


# ── Sequence ──────────────────────────────────────────────────────────────────

SEQUENCE_SYSTEM = """You are the Nexus Curriculum Agent.
Reorder the learner's remaining modules to the highest-impact path.
Rules:
- Modules with confidence < 0.6 come first
- Respect prerequisites (don't break dependencies)
- Return ONLY valid JSON.

{product_distinctions}

JSON:
{{
  "ordered_modules": [{{"id": 1, "title": "...", "reason": "...", "priority": "high|medium|low"}}],
  "nba": {{"module_id": 1, "action": "...", "reason": "..."}}
}}
"""


def node_sequence(state: dict) -> dict:
    modules = state.get("modules", [])
    done = set(state.get("done_modules", []))
    conf = state.get("conf_scores", {})
    remaining = [m for m in modules if m.get("id") not in done]
    listing = "\n".join(
        f"Module {m['id']}: {m['title']} — confidence: {conf.get(m['title'], conf.get(m['id'], 0.5)):.2f}"
        for m in remaining
    )
    try:
        raw = groq_call(
            [{"role": "user", "content": f"Remaining modules:\n{listing}"}],
            SEQUENCE_SYSTEM.format(product_distinctions=PRODUCT_DISTINCTIONS),
            max_tokens=600,
        )
        result = parse_json_lenient(raw)
    except Exception as e:
        print(f"[curriculum] sequence error: {e}")
        result = {
            "ordered_modules": [
                {"id": m["id"], "title": m["title"], "reason": "default order", "priority": "medium"}
                for m in remaining
            ],
            "nba": {
                "module_id": remaining[0]["id"] if remaining else None,
                "action": f"Continue with {remaining[0]['title']}" if remaining else "All modules complete",
                "reason": "Next in sequence",
            },
        }
    return {**state, "sequence_result": result}


# ── NBA ───────────────────────────────────────────────────────────────────────

NBA_SYSTEM = """You are the Nexus Curriculum Agent generating a Next Best Action.
Recommend ONE specific action. Respond ONLY with valid JSON.
{{
  "action_type": "module|quiz|test_out|socratic|capstone",
  "title": "short action title",
  "reason": "1-2 sentences grounded in their data",
  "module_id": null or number,
  "urgency": "high|medium|low"
}}
"""


def node_nba(state: dict) -> dict:
    conf = state.get("conf_scores", {})
    done = state.get("done_modules", [])
    overall = state.get("overall_confidence", 0.5)
    modules = state.get("modules", [])

    undone = {m["id"]: conf.get(m.get("title"), conf.get(m["id"], 0.5))
              for m in modules if m.get("id") not in done}
    weakest = min(undone, key=undone.get) if undone else None

    context = (
        f"Overall confidence: {overall:.2f}\n"
        f"Modules done: {len(done)}/{len(modules)}\n"
        f"Weakest remaining module id: {weakest} "
        f"(confidence {undone.get(weakest, 0):.2f})\n"
        f"Capstone unlocked: {overall >= 0.75 and len(done) >= max(0, len(modules) - 1)}"
    )
    try:
        raw = groq_call([{"role": "user", "content": context}], NBA_SYSTEM, max_tokens=220)
        result = parse_json_lenient(raw)
    except Exception as e:
        print(f"[curriculum] nba error: {e}")
        result = {
            "action_type": "module", "title": "Continue your learning path",
            "reason": "Keep progressing through the modules.",
            "module_id": weakest, "urgency": "medium",
        }
    return {**state, "nba_result": result}


def _quick_nba(user_name, track, module_title, confidence, passed) -> dict:
    """Deterministic NBA used right after grading (no extra LLM round-trip)."""
    if passed and confidence >= QUIZ_CONFIDENCE_PASS:
        return {"action_type": "module", "title": "Advance to the next module",
                "reason": f"You cleared {module_title} at {confidence:.0%} confidence.",
                "module_id": None, "urgency": "medium"}
    if confidence >= 0.5:
        return {"action_type": "socratic", "title": f"Reinforce {module_title} with a Socratic drill",
                "reason": "You're close — a short guided-reasoning session should push you over the line.",
                "module_id": None, "urgency": "high"}
    return {"action_type": "module", "title": f"Revisit {module_title}",
            "reason": f"Confidence is {confidence:.0%}; review the material before retrying.",
            "module_id": None, "urgency": "high"}


# ── Quiz pool (graph entry for pre-generating a pool) ─────────────────────────

def node_quiz(state: dict) -> dict:
    gen = generate_quiz_pool(
        topic=state.get("topic", ""),
        module_title=state.get("module_title", state.get("topic", "")),
        track=state.get("track", "rtcdp"),
        confidence=state.get("overall_confidence", 0.5),
        mode=state.get("mode", "path"),
    )
    return {**state, "quiz_result": gen}


# ── Guardrail / guidance with redirects ───────────────────────────────────────

GUARDRAIL_CLASSIFY = """Classify the learner's message into exactly ONE label.
Respond with ONLY the label word — nothing else.

Labels:
  next     — "what should I do next", "what module is after this", planning, prioritisation
  finish   — "how do I finish/complete this topic/module/path", prerequisites
  time     — "how long will it take", pacing, effort estimate, deadline
  meta     — ANY question about the learning path itself: which modules have video,
             how to prepare for a module, which topics are covered, what are the
             objectives, how many modules remain, what is the curriculum structure,
             which modules are recommended, what skills will I gain.
             Use this for: "which modules have video content?",
             "how do I prepare for Module 4?", "what topics are in this module?",
             "which modules have the most EL documentation?",
             "what should I focus on today?"
  subject  — ONLY use this for deep technical AEP product questions needing a
             detailed explanation: architecture, how a feature works internally,
             differences between AEP products, configuration steps, data models.
             Examples: "what is the difference between batch and streaming segmentation?",
             "how does identity stitching work in RTCDP?",
             "what is XDM schema?", "explain how edge segmentation works"
  socratic — the learner wants to be coached / guided to reason it out themselves

When in doubt, use "meta" — only use "subject" for clearly technical AEP questions.
"""

GUIDANCE_SYSTEM = """You are the Nexus Curriculum Agent giving concise, personalised learning guidance.
You handle meta/logistics questions about the learning path:
- Which modules have video content
- How to prepare for a specific module
- What to focus on
- Module structure and objectives
- How long things take
- What to do next
- Which modules are complete / remaining

You have tools to look up the learner's real progress and a specific module's
real topic list (titles, objectives, video availability) — ALWAYS call
get_module_topics before answering anything about what a module covers or has
video; never invent or guess module content. If the question is a deep
technical AEP question (architecture, internals, product differences,
configuration), call redirect_to_reasoning instead of answering yourself. If
the learner explicitly wants to be coached/guided to reason it out themselves,
call redirect_to_socratic. Be specific. 2-4 sentences max.
"""


def _classify_guardrail(text: str) -> str:
    try:
        label = groq_call(
            [{"role": "user", "content": text}], GUARDRAIL_CLASSIFY, max_tokens=6
        ).strip().lower()
        for lbl in ("next", "finish", "time", "meta", "subject", "socratic"):
            if lbl in label:
                return lbl
    except Exception:
        pass
    return "meta"  # safe default: answer in curriculum agent, don't redirect


# ── Tool-calling: real learner/module data on demand ───────────────────────────
# Previously a separate classifier LLM call routed the question into a fixed
# Python branch, and the "meta" answer path only had module TITLE strings in
# context — no real topic/objective data — so a question like "what topics are
# in Module 4?" had nothing real to draw from despite the "never invent module
# names" instruction. These tools let the model pull the actual curriculum_topics
# rows and real progress data, and decide for itself whether to redirect.

def _guardrail_tools() -> list:
    return [
        {"type": "function", "function": {
            "name": "get_learner_progress",
            "description": "Get this learner's real progress: overall confidence, which modules are done, which remain, and per-module confidence scores.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        }},
        {"type": "function", "function": {
            "name": "get_module_topics",
            "description": "Get the real topic list (titles + objectives + whether each has video content) for a specific module number in the learner's track. Use this before answering ANY question about what a module covers, has video, or how to prepare for it.",
            "parameters": {"type": "object", "properties": {
                "module_id": {"type": "integer", "description": "Module number, e.g. 1, 2, 3"},
            }, "required": ["module_id"]},
        }},
        {"type": "function", "function": {
            "name": "redirect_to_reasoning",
            "description": "Hand off to the AI Tutor (Reasoning Agent) for a deep technical AEP question (architecture, how a feature works internally, product differences, configuration, data models) — this agent only handles learning-path logistics, not subject-matter teaching.",
            "parameters": {"type": "object", "properties": {
                "reason": {"type": "string", "description": "One short phrase why this needs the Reasoning agent"},
            }, "required": []},
        }},
        {"type": "function", "function": {
            "name": "redirect_to_socratic",
            "description": "Hand off to the Socratic Agent when the learner explicitly wants to be coached/guided to reason something out themselves rather than get a direct answer.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        }},
    ]


def _guardrail_tool_executor(state: dict):
    conf = state.get("conf_scores", {})
    done = state.get("done_modules", [])
    modules = state.get("modules", [])
    overall = state.get("overall_confidence", 0.5)
    track = state.get("track", "rtcdp")

    def executor(name: str, args: dict):
        if name == "get_learner_progress":
            pending = [m for m in modules if m not in done]
            return {
                "overall_confidence": round(overall, 2),
                "completed_modules": done[:10],
                "remaining_modules": pending[:10],
                "confidence_by_module": {k: round(v, 2) for k, v in list(conf.items())[:8]},
            }
        if name == "get_module_topics":
            module_id = args.get("module_id")
            try:
                import psycopg2, psycopg2.extras
                conn = psycopg2.connect(get_db_url())
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                    cur.execute(
                        """SELECT topic_order, title, objective, video_title
                           FROM curriculum_topics WHERE module_id=%s AND track=%s
                           ORDER BY topic_order""",
                        (module_id, track))
                    rows = cur.fetchall()
                conn.close()
                if not rows:
                    return {"error": f"No indexed topics found for module {module_id} in track '{track}'."}
                return {"module_id": module_id, "topics": [
                    {"order": r["topic_order"], "title": r["title"], "objective": r["objective"],
                     "has_video": bool(r["video_title"])} for r in rows]}
            except Exception as e:
                return {"error": str(e)}
        if name in ("redirect_to_reasoning", "redirect_to_socratic"):
            return {"acknowledged": True}  # actual redirect handled by caller inspecting the trace
        return {"error": f"Unknown tool '{name}'"}

    return executor


def node_guardrail(state: dict) -> dict:
    text = state.get("query", "")

    try:
        resp = call_with_tools(
            [{"role": "user", "content": text}],
            GUIDANCE_SYSTEM, _guardrail_tools(), _guardrail_tool_executor(state),
            max_tokens=350, max_rounds=3, agent="Curriculum",
        )
    except Exception as e:
        return {**state, "guardrail_result": {"kind": "answer", "label": "meta",
                                               "answer": f"Here's a suggestion based on your progress. (guidance error: {e})"}}

    # If the model called a redirect tool at any point, honour that over any
    # final text it also produced — the frontend needs the fixed redirect
    # shape to route to the right agent, not free text.
    for tc in resp.get("tool_calls", []):
        if tc["name"] == "redirect_to_reasoning":
            return {**state, "guardrail_result": {
                "kind": "redirect", "target": "reasoning", "endpoint": "/api/agents/reasoning",
                "payload": {"messages": [{"role": "user", "content": text}],
                            "track": state.get("track", "rtcdp"), "profile": state.get("profile", {})},
                "message": "That's a subject-level question — routing you to the AI Tutor (Reasoning Agent) for a full technical answer.",
            }}
        if tc["name"] == "redirect_to_socratic":
            return {**state, "guardrail_result": {
                "kind": "redirect", "target": "socratic", "endpoint": "/api/agents/socratic",
                "payload": {"messages": [{"role": "user", "content": text}], "profile": state.get("profile", {})},
                "message": "Let's reason through this together — routing you to the Socratic Agent.",
            }}

    # RAGAS scoring when get_module_topics actually returned real curriculum
    # content — fire-and-forget, never blocks this response.
    contexts = extract_tool_contexts(resp.get("tool_calls", []), {"get_module_topics"})
    if contexts:
        try:
            evaluate_and_log("curriculum", text, resp["content"], contexts)
        except Exception:
            pass

    # Output guardrail on the prose guidance answer (empty/too-short/vague check),
    # same net every text-answering agent now runs. Annotate-only; never blocks.
    answer = resp["content"]
    try:
        answer = check_output(answer, agent="curriculum", expect_citations=False, min_words=4)["answer"]
    except Exception:
        pass
    return {**state, "guardrail_result": {"kind": "answer", "label": "meta", "answer": answer}}


# ── Quality check ─────────────────────────────────────────────────────────────

def node_quality_check(state: dict) -> dict:
    req = state.get("request_type", "quiz")
    issues, ok = [], True
    if req == "quiz":
        pool = state.get("quiz_result", {}).get("pool", [])
        if len(pool) < QUIZ_MIN_QUESTIONS:
            ok = False
            issues.append(f"pool too small: {len(pool)} < {QUIZ_MIN_QUESTIONS}")
    elif req == "sequence" and not state.get("sequence_result"):
        ok, _ = False, issues.append("no sequence result")
    elif req == "nba" and not state.get("nba_result"):
        ok, _ = False, issues.append("no nba result")
    elif req == "guardrail" and not state.get("guardrail_result"):
        ok, _ = False, issues.append("no guardrail result")
    return {**state, "quality_ok": ok, "quality_issues": issues}


# ══════════════════════════════════════════════════════════════════════════════
# GRAPH
# ══════════════════════════════════════════════════════════════════════════════

def build_curriculum_graph():
    if not LANGGRAPH_AVAILABLE:
        return None
    g = StateGraph(dict)
    g.add_node("load_state",    node_load_state)
    g.add_node("route",         node_route)
    g.add_node("sequence",      node_sequence)
    g.add_node("nba",           node_nba)
    g.add_node("quiz",          node_quiz)
    g.add_node("guardrail",     node_guardrail)
    g.add_node("quality_check", node_quality_check)

    g.set_entry_point("load_state")
    g.add_edge("load_state", "route")
    g.add_conditional_edges("route", _get_route, {
        "sequence":  "sequence",
        "nba":       "nba",
        "quiz":      "quiz",
        "test_out":  "quiz",
        "guardrail": "guardrail",
    })
    for node in ("sequence", "nba", "quiz", "guardrail"):
        g.add_edge(node, "quality_check")
    g.add_edge("quality_check", END)
    return g.compile()


# ══════════════════════════════════════════════════════════════════════════════
# CALLABLE ENTRY POINT
# ══════════════════════════════════════════════════════════════════════════════

def run_curriculum(request_type: str, context: dict, graph=None) -> dict:
    """
    request_type: "sequence" | "nba" | "quiz" | "test_out" | "guardrail"
    NB: interactive quiz *sessions* use the session functions above via
    curriculum_routes; this entry point covers the single-shot graph flows.
    """
    set_current_agent("Curriculum")
    start = time.time()
    if request_type == "test_out":
        context = {**context, "mode": "optout"}
    state = {"request_type": request_type, **context}

    if graph is not None:
        try:
            final = graph.invoke(state)
        except Exception as e:
            print(f"[curriculum] graph error: {e}, running inline")
            graph = None
    if graph is None:
        state = node_load_state(state)
        state = node_route(state)
        route = _get_route(state)
        if route == "sequence":
            state = node_sequence(state)
        elif route == "nba":
            state = node_nba(state)
        elif route in ("quiz", "test_out"):
            state = node_quiz(state)
        elif route == "guardrail":
            state = node_guardrail(state)
        state = node_quality_check(state)
        final = state

    result_map = {
        "sequence":  "sequence_result",
        "nba":       "nba_result",
        "quiz":      "quiz_result",
        "test_out":  "quiz_result",
        "guardrail": "guardrail_result",
    }
    key = result_map.get(request_type, "quiz_result")

    # Persist NBA when produced through the graph too.
    if request_type == "nba" and final.get("nba_result") and context.get("learner_name"):
        save_nba(context["learner_name"], context.get("track", "rtcdp"), final["nba_result"])

    return {
        "result":         final.get(key, {}),
        "quality_ok":     final.get("quality_ok", True),
        "quality_issues": final.get("quality_issues", []),
        "meta": {
            "type":           "agent",
            "name":           "curriculum",
            "engine":         "langgraph" if LANGGRAPH_AVAILABLE else "sequential",
            "model":          GROQ_MODEL,
            "request_type":   request_type,
            "steps_executed": 4,
            "latency_ms":     round((time.time() - start) * 1000),
        },
    }