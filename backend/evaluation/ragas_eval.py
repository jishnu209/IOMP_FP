"""
evaluation/ragas_eval.py — RAGAS evaluation for every RAG-grounded agent
=========================================================================
Uses the real `ragas` package (not a hand-rolled re-implementation) to score
every retrieval-grounded generation in the platform against three standard
RAG quality metrics:

  - faithfulness        : is the answer actually supported by the retrieved
                          context, or does it say things the context doesn't
                          back up (hallucination)?
  - answer_relevancy    : does the answer actually address the question asked?
  - context_utilization : of the chunks retrieved, how many were actually used
                          to support the answer (retrieval quality, not
                          generation quality). This is ragas's reference-free
                          stand-in for context_precision — true precision needs
                          human-labeled ground-truth answers, which this
                          deployment doesn't have.

Applies to the main RAG agent (rag.py) AND every other agent's own retrieval
step, wherever real retrieved context is available:
  - Curriculum's get_module_topics tool (curriculum_topics DB rows)
  - Capstone / Practice / Study Aid's search_docs tool (doc_embeddings rows)

Runs OpenAI-backed (ChatOpenAI + OpenAIEmbeddings via langchain_openai,
reusing the same OPENAI_API_KEY every agent already requires) — no separate
credential to configure.

Pinned to ragas==0.1.21 deliberately, NOT the latest release: newer ragas
versions (0.2.x/0.4.x) pull in langgraph>=1.2 and langchain-core>=1.5, which
would force-upgrade the langgraph 0.2.45 every agent's StateGraph is built
against — a breaking major-version jump across the whole agent system for an
evaluation-only dependency. 0.1.21 only needs langchain-core>=0.2.43, which
langgraph 0.2.45 already supports, so it installs additively with zero
version conflicts. Verified live: all 6 agent graphs still compile and a full
smoke-tested agent call still succeeds after installing it.

Evaluation is NEVER on the user-facing request path — evaluate_and_log() fires
the (slow: 2-4 extra LLM calls per row) scoring in a background thread and
returns immediately, so a learner's answer is never delayed by its own grading.
"""

import os
import json
import time
import threading
import traceback

try:
    import psycopg2
    import psycopg2.extras
except Exception:
    psycopg2 = None

# NOT imported at module level: agents.config (and therefore the whole agents/
# package, since importing a submodule always runs the parent package's
# __init__ first) imports curriculum/capstone/practice/study_aid, each of
# which imports THIS module — an eager import here would be a circular import
# (agents -> evaluation -> agents.config -> agents -> ...). Deferred into each
# function that needs it instead, by which point both packages are already
# fully loaded.
def _get_db_url():
    from agents.config import get_db_url
    return get_db_url()

_RAGAS_AVAILABLE = None  # lazy-checked on first use
_llm = None
_embeddings = None

# ragas.metrics.{faithfulness,answer_relevancy,context_utilization} are MODULE-
# LEVEL SINGLETONS — `from ragas.metrics import faithfulness` returns the exact
# same object every call, in every thread. ragas.evaluate() mutates each
# metric's `.llm` attribute in place before scoring it. Since every agent's
# evaluate_and_log() fires its own background thread, two evaluations from
# different requests can run concurrently and race on that shared mutable
# state — one thread's evaluate() call reassigning/tearing down a metric's
# `.llm` while another thread's still-in-flight async job on that SAME object
# reads it, producing "'NoneType' object has no attribute 'generate'" instead
# of a real score. Serializing the actual ragas_evaluate() call process-wide
# fixes this — a few seconds of queueing during a concurrent burst is invisible
# to users since this never blocks the request path to begin with.
_EVAL_LOCK = threading.Lock()


_RAGAS_UNAVAILABLE_REASON = None  # set once, printed once — see _ensure_ragas()

# ── Quality thresholds ──────────────────────────────────────────────────────────
# Applied uniformly to all three metrics (faithfulness, answer_relevancy,
# context_utilization) — they're all 0-1 "how good is this" scores from the same
# family of ragas judge calls, so one shared pair of bands is the right default
# rather than inventing a separate threshold per metric with no basis for a
# different number. Override per-deployment via .env if a specific metric
# genuinely needs a different bar (e.g. a stricter faithfulness gate).
# Same env-override pattern as the rest of the codebase's tunables (see
# agents/config.py's QUIZ_CONFIDENCE_PASS etc.) — never hardcoded.
def get_ragas_thresholds() -> dict:
    return {
        "good": float(os.getenv("RAGAS_GOOD_THRESHOLD", "0.7")),
        "warn": float(os.getenv("RAGAS_WARN_THRESHOLD", "0.4")),
    }


def _ensure_ragas():
    """Lazily import ragas + build the shared judge LLM/embeddings once.
    Returns True if ragas is usable, False otherwise (never raises) —
    callers degrade to a no-op rather than breaking generation.

    Every request that skips evaluation used to fail completely silently —
    the only trace was a NULL-scored row in ragas_evaluations that nobody
    was watching, easy to mistake for "the agents are scoring 0" instead of
    "evaluation never ran at all". This now prints ONE clear, specific
    warning the first time it's skipped (not once per request), naming
    exactly which of the two distinct causes it is."""
    global _RAGAS_AVAILABLE, _llm, _embeddings, _RAGAS_UNAVAILABLE_REASON
    if _RAGAS_AVAILABLE is not None:
        return _RAGAS_AVAILABLE
    api_key = os.getenv("OPENAI_API_KEY", "")
    if not api_key:
        _RAGAS_AVAILABLE = False
        _RAGAS_UNAVAILABLE_REASON = "no OPENAI_API_KEY set"
        print(f"⚠ [ragas_eval] DISABLED — {_RAGAS_UNAVAILABLE_REASON}. "
              f"RAG-groundedness scoring will not run for ANY agent until this is set "
              f"(Groq/Anthropic keys don't cover this — RAGAS specifically needs OpenAI "
              f"for its judge model + embeddings). Every evaluate_and_log() call will "
              f"silently no-op until then.")
        return False
    try:
        from langchain_openai import ChatOpenAI, OpenAIEmbeddings
        _llm = ChatOpenAI(model=os.getenv("RAGAS_JUDGE_MODEL", "gpt-4o-mini"),
                           api_key=api_key, temperature=0)
        _embeddings = OpenAIEmbeddings(model="text-embedding-3-small", api_key=api_key)
        _RAGAS_AVAILABLE = True
    except Exception as e:
        _RAGAS_UNAVAILABLE_REASON = f"import/init failure: {e}"
        print(f"⚠ [ragas_eval] DISABLED — {_RAGAS_UNAVAILABLE_REASON}. "
              f"OPENAI_API_KEY is set, so this is a package/dependency problem "
              f"(check `pip show ragas langchain-openai`), not a missing-key issue. "
              f"RAG-groundedness scoring will not run for ANY agent until this is fixed.")
        _RAGAS_AVAILABLE = False
    return _RAGAS_AVAILABLE


_TABLE_READY = False


def _ensure_table():
    global _TABLE_READY
    if _TABLE_READY or psycopg2 is None:
        return
    try:
        conn = psycopg2.connect(_get_db_url())
        conn.autocommit = True
        with conn.cursor() as c:
            c.execute("""
                CREATE TABLE IF NOT EXISTS ragas_evaluations (
                    id SERIAL PRIMARY KEY,
                    agent VARCHAR(50) NOT NULL,
                    query TEXT,
                    answer TEXT,
                    contexts JSONB,
                    faithfulness REAL,
                    answer_relevancy REAL,
                    context_utilization REAL,
                    error TEXT,
                    latency_ms INTEGER,
                    created_at TIMESTAMP DEFAULT NOW()
                )
            """)
            # Migration for existing databases: the column used to be named
            # context_precision even though it's always held the reference-free
            # context_utilization metric (no ground_truth labels exist in this
            # deployment) — a confusing mismatch between the label and what was
            # actually measured. Renamed for real instead of just documenting it.
            c.execute("""
                DO $$
                BEGIN
                    IF EXISTS (SELECT 1 FROM information_schema.columns
                               WHERE table_name='ragas_evaluations' AND column_name='context_precision')
                       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                               WHERE table_name='ragas_evaluations' AND column_name='context_utilization')
                    THEN
                        ALTER TABLE ragas_evaluations RENAME COLUMN context_precision TO context_utilization;
                    END IF;
                END $$;
            """)
        conn.close()
        _TABLE_READY = True
    except Exception as e:
        print(f"[ragas_eval] table setup error: {e}")


def evaluate_now(agent: str, query: str, answer: str, contexts: list) -> dict:
    """Synchronous RAGAS scoring — {faithfulness, answer_relevancy,
    context_utilization} each 0-1, or {"error": str} if ragas/contexts/answer
    aren't usable. Never raises. Call evaluate_and_log() instead of this
    directly unless you specifically need to block on the result."""
    if not query or not answer or not contexts:
        return {"error": "missing query/answer/contexts"}
    if not _ensure_ragas():
        return {"error": f"ragas not configured ({_RAGAS_UNAVAILABLE_REASON})"}
    try:
        from ragas import evaluate as ragas_evaluate
        from ragas.metrics import faithfulness, answer_relevancy, context_utilization
        from datasets import Dataset

        # True context_precision needs a ground_truth column we don't have (no
        # human-labeled reference answers in this deployment) — context_utilization
        # is ragas's reference-free equivalent: does the retrieved context, ranked
        # by position, actually support answering the question. Stored under its
        # own honest column name (context_utilization) — not relabeled as
        # context_precision, which would measure a different thing.
        ds = Dataset.from_dict({
            "question": [query],
            "answer":   [answer],
            "contexts": [[str(c) for c in contexts if c]],
        })
        with _EVAL_LOCK:
            result = ragas_evaluate(
                ds, metrics=[faithfulness, answer_relevancy, context_utilization],
                llm=_llm, embeddings=_embeddings,
            )
        df = result.to_pandas()
        row = df.iloc[0]

        def _clean(v):
            try:
                v = float(v)
                return v if v == v else None  # filter NaN
            except (TypeError, ValueError):
                return None

        return {
            "faithfulness":        _clean(row.get("faithfulness")),
            "answer_relevancy":    _clean(row.get("answer_relevancy")),
            "context_utilization": _clean(row.get("context_utilization")),
        }
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}"}


def _log_result(agent: str, query: str, answer: str, contexts: list, scores: dict, latency_ms: int):
    _ensure_table()
    if psycopg2 is None:
        return
    try:
        conn = psycopg2.connect(_get_db_url())
        conn.autocommit = True
        with conn.cursor() as c:
            c.execute("""
                INSERT INTO ragas_evaluations
                    (agent, query, answer, contexts, faithfulness, answer_relevancy,
                     context_utilization, error, latency_ms)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """, (
                agent, (query or "")[:2000], (answer or "")[:4000],
                json.dumps([str(c)[:1000] for c in (contexts or [])]),
                scores.get("faithfulness"), scores.get("answer_relevancy"),
                scores.get("context_utilization"), scores.get("error"), latency_ms,
            ))
        conn.close()
    except Exception as e:
        print(f"[ragas_eval] log error: {e}")


def evaluate_and_log(agent: str, query: str, answer: str, contexts: list):
    """Fire-and-forget: scores this (query, answer, contexts) triple against
    RAGAS metrics on a background thread and logs the result, WITHOUT blocking
    the caller. Safe to call from any agent's response path — evaluation
    failures (missing key, ragas error, DB error) are swallowed and logged,
    never raised back to the caller."""
    def _run():
        start = time.time()
        try:
            # Two separate asyncio issues show up when evaluate_now() (which
            # constructs ChatOpenAI/OpenAIEmbeddings, then calls ragas's
            # synchronous evaluate()) runs on a background thread instead of
            # the main thread:
            #   1. langchain_openai's client construction calls
            #      asyncio.get_event_loop(), which only auto-creates a loop on
            #      the MAIN thread (since Python 3.10) — a bare worker thread
            #      raises "no current event loop" before ragas even starts.
            #   2. ragas's own Executor.results() always wraps its actual
            #      scoring coroutines in a fresh asyncio.run() call. If we'd
            #      merely set-and-forget our own loop for (1), that fresh loop
            #      and this new one are different — the OpenAI async http
            #      client ends up bound to the first (idle) loop while ragas
            #      awaits it from the second (running) one, which hangs
            #      forever instead of erroring (a classic cross-event-loop
            #      deadlock, not a timeout).
            # Fix: give this thread a loop, patch it with nest_asyncio (ragas's
            # own documented workaround for exactly this "already have a loop"
            # case — see its "jupyter-like environment" branch), and run
            # everything through THAT loop via run_until_complete so ragas's
            # is_event_loop_running() check finds it already running and
            # reuses it (nest_asyncio's patched reentrant run) instead of
            # spinning up a second, disconnected loop.
            import asyncio
            import nest_asyncio
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            nest_asyncio.apply(loop)

            async def _evaluate_async():
                return evaluate_now(agent, query, answer, contexts)

            scores = loop.run_until_complete(_evaluate_async())
        except Exception as e:
            scores = {"error": f"{type(e).__name__}: {e}"}
            traceback.print_exc()
        _log_result(agent, query, answer, contexts, scores, round((time.time() - start) * 1000))
    threading.Thread(target=_run, daemon=True).start()


def get_recent_evaluations(agent: str = None, limit: int = 50) -> list:
    """Most recent evaluation rows, newest first — for the Admin AI Safety tab."""
    _ensure_table()
    if psycopg2 is None:
        return []
    try:
        conn = psycopg2.connect(_get_db_url())
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as c:
            if agent:
                c.execute("""SELECT * FROM ragas_evaluations WHERE agent=%s
                             ORDER BY created_at DESC LIMIT %s""", (agent, limit))
            else:
                c.execute("""SELECT * FROM ragas_evaluations
                             ORDER BY created_at DESC LIMIT %s""", (limit,))
            rows = [dict(r) for r in c.fetchall()]
        conn.close()
        for r in rows:
            r["created_at"] = r["created_at"].isoformat() if r.get("created_at") else None
        return rows
    except Exception as e:
        print(f"[ragas_eval] fetch error: {e}")
        return []


def _flatten_context_item(item) -> list:
    """One tool-result item -> one or more context strings. Handles the two
    real shapes agents' tool executors return: a flat {"excerpt"/"content"/
    "title"} dict (Capstone/Practice/StudyAid's search_docs), and a nested
    dict wrapping its own list (Curriculum's get_module_topics returns
    {"module_id":..., "topics":[{...}, ...]} — without unwrapping that, the
    whole dict got dumped as one giant JSON blob instead of one string per
    topic, which hurt context_utilization/faithfulness scoring)."""
    if isinstance(item, dict):
        for key in ("excerpt", "content", "objective", "title"):
            if item.get(key):
                return [str(item[key])]
        for v in item.values():
            if isinstance(v, list) and v:
                out = []
                for sub in v:
                    out.extend(_flatten_context_item(sub))
                return out
        return [json.dumps(item)]
    return [str(item)] if item else []


def extract_tool_contexts(tool_calls: list, tool_names: set) -> list:
    """Pull retrieved-context strings out of a call_with_tools() trace
    (list of {"name","args","result"}) for the given tool name(s) — shared by
    every agent's RAGAS hook so each one doesn't reimplement this shape
    handling. Skips error/empty results (nothing was actually retrieved)."""
    contexts = []
    for call in (tool_calls or []):
        if call.get("name") not in tool_names:
            continue
        result = call.get("result")
        if isinstance(result, dict) and ("error" in result or "note" in result):
            continue
        items = result if isinstance(result, list) else [result]
        for item in items:
            contexts.extend(_flatten_context_item(item))
    return contexts


def summarize_for_ragas(obj) -> str:
    """Flatten a structured agent result (dict/list, or a JSON string of one)
    into prose so ragas's faithfulness metric has real sentences to work with.

    Faithfulness sentence-segments the "answer" (via pysbd) before decomposing
    it into atomic statements to verify against context. Passing a raw JSON
    blob straight through — as capstone.py/practice.py/study_aid.py used to —
    doesn't segment into meaningful sentences, so ragas silently logs
    "No statements were generated from the answer." and faithfulness comes
    back None on EVERY call, consistently, regardless of grounding quality.
    (Confirmed by direct reproduction: identical contexts scored fine for
    answer_relevancy/context_utilization but always None for faithfulness
    when the answer was JSON.) This walks the structure and joins every
    string value into simple period-terminated "sentences" instead."""
    if isinstance(obj, str):
        try:
            obj = json.loads(obj)
        except (TypeError, ValueError):
            return obj  # already plain text, not JSON — use as-is
    parts = []
    def _walk(x):
        if isinstance(x, dict):
            for v in x.values():
                _walk(v)
        elif isinstance(x, list):
            for v in x:
                _walk(v)
        elif isinstance(x, str) and x.strip():
            s = x.strip()
            parts.append(s if s.endswith((".", "!", "?")) else s + ".")
    _walk(obj)
    return " ".join(parts)


def get_evaluation_summary() -> dict:
    """Per-agent average scores + sample count — for the Admin AI Safety
    summary cards. Returns {} if the table doesn't exist yet (no evals run).

    Also includes below_threshold: how many SCORED (non-error) rows had any
    of the three metrics fall below the "warn" band from get_ragas_thresholds()
    — a concrete, actionable count distinct from error_count (which means
    "never scored", not "scored poorly")."""
    _ensure_table()
    if psycopg2 is None:
        return {}
    warn = get_ragas_thresholds()["warn"]
    try:
        conn = psycopg2.connect(_get_db_url())
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as c:
            c.execute("""
                SELECT agent,
                       COUNT(*) AS n,
                       AVG(faithfulness) AS avg_faithfulness,
                       AVG(answer_relevancy) AS avg_answer_relevancy,
                       AVG(context_utilization) AS avg_context_utilization,
                       SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS error_count,
                       SUM(CASE WHEN error IS NULL AND (
                               faithfulness < %s OR answer_relevancy < %s OR context_utilization < %s
                           ) THEN 1 ELSE 0 END) AS below_threshold
                FROM ragas_evaluations
                GROUP BY agent
                ORDER BY agent
            """, (warn, warn, warn))
            rows = [dict(r) for r in c.fetchall()]
        conn.close()
        return {r["agent"]: r for r in rows}
    except Exception as e:
        print(f"[ragas_eval] summary error: {e}")
        return {}
