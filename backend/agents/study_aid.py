"""
study_aid.py — Study Aid Agent
=========================================================
Generates 8 reasoning-oriented flashcards for a module.

v2 — single-call architecture (see git history / audit notes for the prior
tool-calling design). The previous version let the model decide whether to
call list_module_topics()/get_full_topic_content() tools, at the cost of up to
4 Groq calls per request (each re-sending the growing conversation). On the
Groq free tier (8000 TPM), that reliably rate-limited after 1-2 generations
per minute and occasionally hit a hard 400 when gpt-oss emitted prose instead
of a valid tool call — both collapsed straight to the hardcoded fallback card
("Flashcard generation failed. Please retry."), which then got cached and kept
being served. Verified against the live API before and after this rewrite.

Now: curriculum_topics is fetched directly (one pooled DB query, no LLM round
trip) and folded into the system prompt, so generation is normally exactly ONE
Groq call (two only if that first call comes back empty and the clean retry
fires). A 429 is now handled with a bounded backoff honoring Groq's own
suggested wait, instead of failing immediately.

Flow: generate (curriculum fetch + one grounded LLM call)
      → validate (quality gate) → [retry] → done

Self-contained, matching the agents/ package conventions:
  - imports from .config and .reasoning (both sibling package modules, never
    `from main import ...` — main imports us)
  - plain-dict state, StateGraph(dict)
  - build_study_aid_graph() + run_study_aid() entry point returning a meta dict

Track labels come from reasoning.get_track_label() — the same DB-backed
learning_tracks config the Reasoning agent uses (60s-cached, admin-editable via
POST /api/admin/tracks). Study Aid used to keep its own separate hardcoded
TRACK_LABELS dict, which meant a track added through the admin panel worked in
Reasoning but silently fell back to a generic "AEP" label here — two agents
disagreeing about which tracks exist. Sharing the same accessor keeps them in
sync with zero extra code.
"""

from .config import (
    set_current_agent,
    OPENAI_MODEL, GROQ_URL, GROQ_MODEL,
    llm_call, get_db_conn, PRODUCT_DISTINCTIONS, call_with_tools,
)
from .reasoning import get_track_label
from evaluation import evaluate_and_log, extract_tool_contexts, summarize_for_ragas

import os
import re
import json
import time
import uuid
import requests

try:
    from langgraph.graph import StateGraph, END
    LANGGRAPH_AVAILABLE = True
except ImportError:
    LANGGRAPH_AVAILABLE = False

# ── Config (env-overridable, no code change needed to tune) ────────────────────
GENERATE_MAX_TOKENS = int(os.getenv("STUDY_AID_MAX_TOKENS", "1400"))
# Now that generation is a single call instead of a 4-call tool loop, a real
# retry is affordable again (the old MAX_RETRIES=0 meant any transient hiccup —
# not just a genuine outage — was a permanent failure for that request).
MAX_RETRIES         = int(os.getenv("STUDY_AID_MAX_RETRIES", "1"))
STUDY_AID_MIN_CARDS  = int(os.getenv("STUDY_AID_MIN_CARDS", "6"))   # quality bar, out of 8
RETRY_DEFAULT_WAIT_SEC = float(os.getenv("STUDY_AID_RETRY_WAIT_SEC", "3"))
RETRY_MAX_WAIT_SEC     = float(os.getenv("STUDY_AID_RETRY_MAX_WAIT_SEC", "15"))

# Confidence bands for flashcard difficulty. Reuses the same thresholds as the
# Reasoning agent (REASONING_CONF_LOW/HIGH) so a learner is treated consistently
# across agents; falls back to the same 0.4 / 0.7 defaults if those aren't set.
CONF_LOW  = float(os.getenv("REASONING_CONF_LOW", "0.4"))
CONF_HIGH = float(os.getenv("REASONING_CONF_HIGH", "0.7"))


# ── Curriculum grounding — direct DB fetch, no tool round-trip ─────────────────

def _fetch_curriculum_topics(module_id, track) -> str:
    """This module's topic titles + objectives, direct from curriculum_topics —
    replaces the old list_module_topics tool call with a single upfront DB
    query. Returns "" (never raises) if unavailable, so the caller can fall
    back to general product knowledge instead of failing the whole request."""
    if not module_id:
        return ""
    import psycopg2.extras
    try:
        conn = get_db_conn()
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT topic_order, title, objective FROM curriculum_topics
                   WHERE module_id=%s AND track=%s ORDER BY topic_order""",
                (module_id, track))
            rows = cur.fetchall()
        conn.close()
    except Exception:
        return ""
    if not rows:
        return ""
    return "\n".join(
        f"{r['topic_order']}. {r['title']} — {(r['objective'] or '').strip()}"
        for r in rows
    )


# ── Groq call with bounded 429 backoff ──────────────────────────────────────────

def _parse_retry_after(resp) -> float:
    """Extract Groq's suggested wait from a 429 response body/header. Falls back
    to RETRY_DEFAULT_WAIT_SEC if the format isn't recognized. Always capped at
    RETRY_MAX_WAIT_SEC so a single request can't hang the caller indefinitely."""
    try:
        msg = resp.json().get("error", {}).get("message", "")
        m = re.search(r"try again in ([\d.]+)s", msg)
        if m:
            return min(float(m.group(1)) + 0.5, RETRY_MAX_WAIT_SEC)
    except Exception:
        pass
    try:
        hdr = resp.headers.get("Retry-After")
        if hdr:
            return min(float(hdr), RETRY_MAX_WAIT_SEC)
    except Exception:
        pass
    return RETRY_DEFAULT_WAIT_SEC


def _groq_call(messages: list, system: str, max_tokens: int = GENERATE_MAX_TOKENS) -> str:
    """Single grounded generation, no tool-calling. Routes through the shared
    provider-agnostic dispatcher: OpenAI first (the project's primary provider),
    Groq as automatic fallback. Both providers handle their own 429/5xx backoff
    inside llm_call, so the previous single manual retry here is now covered for
    both. Returns "" (not an exception) when no provider is configured/reachable,
    matching the empty-response contract the caller's quality gate expects."""
    try:
        return llm_call(messages, system, max_tokens=max_tokens, timeout=30, prefer="openai") or ""
    except Exception:
        return ""


# ── Tool-calling path — used ONLY when curriculum topics are unavailable ───────
# The single-call rewrite above intentionally dropped the old multi-round
# tool-calling design (see module docstring: it caused Groq free-tier rate
# limiting and malformed tool-call 400s). That design had no bound on rounds
# and ran on Groq-only. The shared call_with_tools harness fixes both: it's
# OpenAI-primary (Groq only as fallback) and hard-caps at max_rounds with a
# final tools-free round that forces a plain answer. So a tool is reintroduced
# here, but narrowly — only as a fallback for the ungrounded case, capped at
# 2 rounds, keeping the direct DB fetch as the normal (zero-extra-call) path.

def _study_aid_tools() -> list:
    return [
        {"type": "function", "function": {
            "name": "search_docs",
            "description": "Full-text search real indexed AEP documentation for this module's topic — use this only if you don't have enough specific detail to write grounded, non-generic flashcards.",
            "parameters": {"type": "object", "properties": {
                "query": {"type": "string", "description": "Search terms, e.g. 'RTCDP identity graph namespaces'"},
            }, "required": ["query"]},
        }},
    ]


def _study_aid_tool_executor():
    def executor(name: str, args: dict):
        if name == "search_docs":
            query = args.get("query", "")
            try:
                import psycopg2
                conn = get_db_conn()
                with conn.cursor() as c:
                    c.execute(
                        """SELECT chunk_text FROM doc_embeddings
                           WHERE to_tsvector('english', chunk_text) @@ plainto_tsquery('english', %s)
                           ORDER BY ts_rank(to_tsvector('english', chunk_text), plainto_tsquery('english', %s)) DESC
                           LIMIT 3""",
                        (query, query))
                    rows = [r[0][:500] for r in c.fetchall()]
                conn.close()
                return rows if rows else {"note": "No indexed docs matched — use your own real AEP product knowledge, don't invent capabilities."}
            except Exception as e:
                return {"error": str(e)}
        return {"error": f"Unknown tool '{name}'"}
    return executor


def _tool_call(messages: list, system: str, max_tokens: int = GENERATE_MAX_TOKENS) -> str:
    """Same contract as _groq_call (never raises, "" on failure) but with the
    search_docs tool attached — reserved for the ungrounded (no curriculum
    topics) case only. Stashes the tool-call trace on the function object
    (._last_tool_calls) so node_generate can RAGAS-score it without changing
    this function's plain-string return contract shared with _groq_call."""
    _tool_call._last_tool_calls = []
    try:
        resp = call_with_tools(
            messages, system, _study_aid_tools(), _study_aid_tool_executor(),
            max_tokens=max_tokens, max_rounds=2, agent="StudyAid",
        )
        _tool_call._last_tool_calls = resp.get("tool_calls", [])
        return (resp.get("content") or "").strip()
    except Exception:
        return ""


# ── Difficulty personalization ─────────────────────────────────────────────────

def _difficulty_directive(conf) -> str:
    """Map a learner's 0-1 confidence to a flashcard-difficulty instruction, so a
    struggling learner gets recall/recognition cards and a confident one gets
    edge cases and multi-step scenarios — instead of the same 8 fixed-difficulty
    cards for everyone. Returns "" when confidence is unknown (neutral: the model
    picks its own mix, matching the prior behavior), so nothing regresses for the
    anonymous/demo path that has no confidence."""
    if conf is None:
        return ""
    try:
        conf = float(conf)
    except (TypeError, ValueError):
        return ""
    if conf < CONF_LOW:
        band, guidance = "LOW", ("This learner is still building confidence — favor recall and "
                                 "recognition cards on core ideas, keep scenarios simple and single-step.")
    elif conf < CONF_HIGH:
        band, guidance = "MODERATE", ("Mix straightforward application cards with a couple of "
                                      "'what happens if' scenarios.")
    else:
        band, guidance = "HIGH", ("This learner is confident — favor harder cards: edge cases, "
                                  "trade-off decisions, and multi-step scenarios combining concepts.")
    return f"\nLEARNER CONFIDENCE: {conf:.2f} ({band}). {guidance}\n"


# ── System prompt ────────────────────────────────────────────────────────────────

def _build_system(track_label: str, module: str, topics_block: str = "", difficulty_directive: str = "") -> str:
    topics_section = (
        f"\nThis module's actual topics — ground your cards in these, do not invent "
        f"unrelated content:\n{topics_block}\n"
        if topics_block else
        f"\nNo curriculum topic list is available for this module. Use the search_docs "
        f"tool to look up specific real {track_label} documentation before writing cards "
        f"if you need it; otherwise write from general {track_label} product knowledge.\n"
    )
    return f"""You are the Study Aid Agent, embedded in Nexus.
Generate 8 flashcards for {track_label}: {module}.

Your purpose is to generate high-quality flashcards that help learners test their understanding
of this module. These are not definition cards — they should require the learner to reason, not
just recall.
{topics_section}{difficulty_directive}
Requirements for each card:
1. The question must require applying knowledge, not just stating a definition.
2. The answer must be concise — 1 to 2 sentences maximum.
3. Where possible, ground the question in a realistic {track_label} scenario.
4. Vary question types: "when would you use X", "what happens if Y", "why does Z work this way".
5. Cards must be specific to {track_label}. No generic AEP questions.

{PRODUCT_DISTINCTIONS}

Output format: respond with ONLY a valid JSON array, no markdown fences, no preamble.
[{{"q":"question text","a":"answer text"}}, ...]
Generate exactly 8 cards."""


# ── Node: generate (single grounded call) ───────────────────────────────────────

def node_generate(state: dict) -> dict:
    module      = state.get("module", "")
    module_id   = state.get("module_id")
    track       = state.get("track", "rtcdp")
    track_label = get_track_label(track)
    topics_block = _fetch_curriculum_topics(module_id, track)
    difficulty  = _difficulty_directive(state.get("confidence"))
    sys = _build_system(track_label, module, topics_block, difficulty)

    messages = [{"role": "user", "content": f"Create 8 {track_label} flashcards for module: {module}"}]
    caller = _tool_call if not topics_block else _groq_call
    try:
        content = caller(messages, sys, max_tokens=GENERATE_MAX_TOKENS)
    except Exception as e:
        print(f"[study_aid] generate error: {e}")
        content = ""

    if not content.strip():
        # One clean retry with a minimal, more directive prompt — cheap now that
        # each attempt is a single call (or a capped 2-round tool call) instead
        # of an unbounded tool-calling chain.
        try:
            content = _groq_call(
                [{"role": "user", "content": f"Create 8 {track_label} flashcards for module: {module}. "
                                             f"Respond only with the JSON array — no other text."}],
                sys, max_tokens=GENERATE_MAX_TOKENS)
        except Exception as e:
            print(f"[study_aid] generate retry error: {e}")
            content = ""

    # RAGAS scoring against whatever real grounding was used — the direct
    # curriculum_topics fetch when grounded, or search_docs tool results when
    # not. Fire-and-forget, never blocks this response.
    if content:
        if topics_block:
            contexts = [topics_block]
        else:
            contexts = extract_tool_contexts(getattr(_tool_call, "_last_tool_calls", []), {"search_docs"})
        if contexts:
            try:
                evaluate_and_log("study_aid", f"flashcards for {module}", summarize_for_ragas(content), contexts)
            except Exception:
                pass

    return {**state, "response": content or "", "grounded": bool(topics_block),
            "difficulty_applied": bool(difficulty)}


# ── Node: validate ───────────────────────────────────────────────────────────────

def _salvage_objects(frag: str) -> list:
    """Pull every complete {...} object out of a (possibly truncated) fragment."""
    cards = []
    for o in re.findall(r"\{[^{}]*\}", frag):
        try:
            c = json.loads(o)
            if isinstance(c, dict):
                cards.append(c)
        except Exception:
            continue
    return cards


def _extract_cards(resp: str) -> list:
    """Best-effort extraction of a [{q,a}, ...] list from a model response that
    may include markdown fences, a prose preamble, a {"cards":[...]} wrapper, or
    a truncated trailing object (max_tokens cut-off)."""
    if not resp:
        return []
    text = resp.replace("```json", "").replace("```", "").strip()

    # 1. Straight parse (array or {"cards":[...]}).
    try:
        data = json.loads(text)
        if isinstance(data, list):
            return data
        if isinstance(data, dict) and isinstance(data.get("cards"), list):
            return data["cards"]
    except Exception:
        pass

    # 2. Locate the outermost array; parse it, or salvage complete objects if cut off.
    start = text.find("[")
    if start == -1:
        return []
    frag = text[start:]
    end = frag.rfind("]")
    if end != -1:
        try:
            data = json.loads(frag[:end + 1])
            if isinstance(data, list):
                return data
        except Exception:
            pass
    return _salvage_objects(frag)


def node_validate(state: dict) -> dict:
    cards = _extract_cards(state.get("response", ""))
    cards = [c for c in cards if isinstance(c, dict) and c.get("q") and c.get("a")]
    quality_ok = len(cards) >= STUDY_AID_MIN_CARDS
    return {**state, "cards": cards, "quality_ok": quality_ok}


# ── Retry control ────────────────────────────────────────────────────────────────

def node_increment_retry(state: dict) -> dict:
    return {**state, "retries": state.get("retries", 0) + 1}


def _should_retry(state: dict) -> str:
    if state.get("quality_ok"):
        return "end"
    if state.get("retries", 0) >= state.get("max_retries", MAX_RETRIES):
        return "end"
    return "retry"


# ── Build graph ──────────────────────────────────────────────────────────────────

def build_study_aid_graph():
    if not LANGGRAPH_AVAILABLE:
        return None
    g = StateGraph(dict)
    g.add_node("generate",   node_generate)
    g.add_node("validate",   node_validate)
    g.add_node("retry_bump", node_increment_retry)
    g.set_entry_point("generate")
    g.add_edge("generate", "validate")
    g.add_conditional_edges("validate", _should_retry,
                            {"retry": "retry_bump", "end": END})
    g.add_edge("retry_bump", "generate")
    return g.compile()


# ── Callable entry point ─────────────────────────────────────────────────────────

def _fallback_cards(module: str) -> list:
    return [{"q": f"What is the core idea behind {module}?",
             "a": "Flashcard generation failed. Please retry."}]


def run_study_aid(context: dict, graph=None) -> dict:
    """
    Generate reasoning-oriented flashcards for a module.

    Args:
        context: {module, module_id, track, confidence} — module_id enables
                 curriculum-grounded cards; confidence (0-1, optional) drives
                 difficulty personalization.
        graph:   compiled LangGraph graph (optional)

    Returns:
        {cards, quality_ok, used_fallback, meta}
    """
    set_current_agent("StudyAid")
    start = time.time()
    request_id = context.get("request_id") or uuid.uuid4().hex[:12]
    # confidence may arrive as "" from a form field — normalize to None so the
    # difficulty directive stays neutral rather than crashing on float("").
    conf_raw = context.get("confidence")
    try:
        confidence = float(conf_raw) if conf_raw not in (None, "") else None
    except (TypeError, ValueError):
        confidence = None
    state = {
        "module":      context.get("module", ""),
        "module_id":   context.get("module_id"),
        "track":       context.get("track", "rtcdp"),
        "confidence":  confidence,
        "retries":     0,
        "max_retries": context.get("max_retries", MAX_RETRIES),
    }

    if graph is not None:
        try:
            final = graph.invoke(state)
        except Exception as e:
            print(f"[study_aid] graph error: {e}, running inline")
            graph = None

    if graph is None:
        # Sequential fallback with manual retry loop.
        final = node_validate(node_generate(state))
        while _should_retry(final) == "retry":
            final = node_validate(node_generate(node_increment_retry(final)))

    used_fallback = not final.get("cards")
    cards = final.get("cards") or _fallback_cards(state["module"])
    latency_ms = round((time.time() - start) * 1000)

    # Structured, greppable log line (mirrors reasoning.py) — request_id ties the
    # generation to its outcome, and used_fallback/grounded make failures and
    # ungrounded runs visible in logs instead of silent print statements.
    print(json.dumps({
        "evt": "study_aid_done", "rid": request_id,
        "track": state["track"], "module_id": state["module_id"],
        "card_count": len(cards), "quality_ok": final.get("quality_ok", False),
        "grounded": final.get("grounded", False),
        "difficulty_applied": final.get("difficulty_applied", False),
        "confidence": confidence, "used_fallback": used_fallback,
        "retries": final.get("retries", 0), "latency_ms": latency_ms,
    }))

    return {
        "cards":      cards,
        "quality_ok": final.get("quality_ok", False),
        # Callers (the cache layer) need this to know the result must NOT be
        # persisted — caching a fallback card would keep serving the failure
        # on every subsequent load until someone manually regenerates.
        "used_fallback": used_fallback,
        "request_id": request_id,
        "meta": {
            "type":           "agent",
            "name":           "study_aid",
            "engine":         "langgraph" if LANGGRAPH_AVAILABLE else "sequential",
            "model":          OPENAI_MODEL,
            "steps_executed": 2 + final.get("retries", 0),
            "latency_ms":     latency_ms,
            "retries":        final.get("retries", 0),
            "quality_ok":     final.get("quality_ok", False),
            "grounded":       final.get("grounded", False),
            "difficulty_applied": final.get("difficulty_applied", False),
            "confidence":     confidence,
            "used_fallback":  used_fallback,
            "request_id":     request_id,
        },
    }
