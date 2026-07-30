"""
evaluation/ragas_eval.py — RAGAS evaluation for every RAG-grounded agent
=========================================================================
Uses the real `ragas` package (not a hand-rolled re-implementation) to score
every retrieval-grounded generation in the platform against three standard
RAG quality metrics:

  - faithfulness      : is the answer actually supported by the retrieved
                        context, or does it say things the context doesn't
                        back up (hallucination)?
  - answer_relevancy  : does the answer actually address the question asked?
  - context_precision : of the chunks retrieved, how many were relevant to
                        the question (retrieval quality, not generation
                        quality)?

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


def _ensure_ragas():
    """Lazily import ragas + build the shared judge LLM/embeddings once.
    Returns True if ragas is usable, False otherwise (never raises) —
    callers degrade to a no-op rather than breaking generation."""
    global _RAGAS_AVAILABLE, _llm, _embeddings
    if _RAGAS_AVAILABLE is not None:
        return _RAGAS_AVAILABLE
    try:
        from langchain_openai import ChatOpenAI, OpenAIEmbeddings
        api_key = os.getenv("OPENAI_API_KEY", "")
        if not api_key:
            _RAGAS_AVAILABLE = False
            return False
        _llm = ChatOpenAI(model=os.getenv("RAGAS_JUDGE_MODEL", "gpt-4o-mini"),
                           api_key=api_key, temperature=0)
        _embeddings = OpenAIEmbeddings(model="text-embedding-3-small", api_key=api_key)
        _RAGAS_AVAILABLE = True
    except Exception as e:
        print(f"[ragas_eval] unavailable: {e}")
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
                    context_precision REAL,
                    error TEXT,
                    latency_ms INTEGER,
                    created_at TIMESTAMP DEFAULT NOW()
                )
            """)
        conn.close()
        _TABLE_READY = True
    except Exception as e:
        print(f"[ragas_eval] table setup error: {e}")


def evaluate_now(agent: str, query: str, answer: str, contexts: list) -> dict:
    """Synchronous RAGAS scoring — {faithfulness, answer_relevancy,
    context_precision} each 0-1, or {"error": str} if ragas/contexts/answer
    aren't usable. Never raises. Call evaluate_and_log() instead of this
    directly unless you specifically need to block on the result."""
    if not query or not answer or not contexts:
        return {"error": "missing query/answer/contexts"}
    if not _ensure_ragas():
        return {"error": "ragas not configured (no OPENAI_API_KEY or import failure)"}
    try:
        from ragas import evaluate as ragas_evaluate
        from ragas.metrics import faithfulness, answer_relevancy, context_utilization
        from datasets import Dataset

        # context_precision needs a ground_truth column we don't have (no
        # human-labeled reference answers in this deployment) — context_utilization
        # is ragas's reference-free equivalent: does the retrieved context, ranked
        # by position, actually support answering the question. Still stored under
        # the "context_precision" column name in ragas_evaluations for a stable
        # schema/API, since it's the same concept measured without a reference.
        ds = Dataset.from_dict({
            "question": [query],
            "answer":   [answer],
            "contexts": [[str(c) for c in contexts if c]],
        })
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
            "faithfulness":      _clean(row.get("faithfulness")),
            "answer_relevancy":  _clean(row.get("answer_relevancy")),
            "context_precision": _clean(row.get("context_utilization")),
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
                     context_precision, error, latency_ms)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """, (
                agent, (query or "")[:2000], (answer or "")[:4000],
                json.dumps([str(c)[:1000] for c in (contexts or [])]),
                scores.get("faithfulness"), scores.get("answer_relevancy"),
                scores.get("context_precision"), scores.get("error"), latency_ms,
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
            scores = evaluate_now(agent, query, answer, contexts)
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
    topic, which hurt context_precision/faithfulness scoring)."""
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


def get_evaluation_summary() -> dict:
    """Per-agent average scores + sample count — for the Admin AI Safety
    summary cards. Returns {} if the table doesn't exist yet (no evals run)."""
    _ensure_table()
    if psycopg2 is None:
        return {}
    try:
        conn = psycopg2.connect(_get_db_url())
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as c:
            c.execute("""
                SELECT agent,
                       COUNT(*) AS n,
                       AVG(faithfulness) AS avg_faithfulness,
                       AVG(answer_relevancy) AS avg_answer_relevancy,
                       AVG(context_precision) AS avg_context_precision,
                       SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS error_count
                FROM ragas_evaluations
                GROUP BY agent
                ORDER BY agent
            """)
            rows = [dict(r) for r in c.fetchall()]
        conn.close()
        return {r["agent"]: r for r in rows}
    except Exception as e:
        print(f"[ragas_eval] summary error: {e}")
        return {}
