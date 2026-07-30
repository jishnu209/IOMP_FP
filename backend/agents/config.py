"""
config.py — Shared configuration and helpers for all agent files
=================================================================
Single source of truth for:
  - API endpoints and model names (from env, no hardcoded credentials)
  - Shared groq_call() / anthropic_call() HTTP helpers
  - DB connection helpers (URL + raw conn + context manager)
  - All configurable thresholds / weights / quiz + CAT parameters

Everything that used to live here is preserved (backward compatible).
New values are additive and read from the environment so nothing is
hardcoded in the agent logic.
"""

import os
import time
import json
import requests
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor, TimeoutError as _FutureTimeout

try:
    import tiktoken
    _TIKTOKEN_ENC = tiktoken.get_encoding("cl100k_base")  # used by gpt-4o-mini/gpt-oss/claude-adjacent tokenizers closely enough for budgeting
except Exception:
    _TIKTOKEN_ENC = None

# Shared thread pool for time-bounding calls that MUST NOT be allowed to hang a
# request indefinitely (chiefly RAG/embedding retrieval — the fastembed model's
# first-use load, or a degraded vector store, can otherwise block forever with
# no exception raised). One pool, reused by every agent via run_with_timeout(),
# instead of each agent hand-rolling its own ThreadPoolExecutor.
_TIMEOUT_POOL = ThreadPoolExecutor(max_workers=4)


def run_with_timeout(fn, *args, timeout: float = 8.0, default=None, on_timeout_log: str = None, **kwargs):
    """Run fn(*args, **kwargs) with a hard wall-clock timeout. Returns `default`
    (never raises) if it times out or raises internally — callers use this for
    best-effort grounding lookups that should degrade gracefully, not for
    anything whose result correctness the caller can't do without."""
    try:
        return _TIMEOUT_POOL.submit(fn, *args, **kwargs).result(timeout=timeout)
    except _FutureTimeout:
        if on_timeout_log:
            print(f"[timeout] {on_timeout_log} exceeded {timeout}s — using default")
        return default
    except Exception as e:
        if on_timeout_log:
            print(f"[timeout] {on_timeout_log} error: {e} — using default")
        return default

# ── Token counting / budgeting ─────────────────────────────────────────────────
# Real tokenizer-based counting (tiktoken's cl100k_base), not a message-count or
# character-count heuristic. Every provider we call (OpenAI, Groq's OSS models,
# Anthropic) tokenizes slightly differently, but cl100k_base is close enough
# across all three for BUDGETING purposes (deciding what to trim before sending),
# as opposed to billing-exact accounting. Falls back to a ~4-chars-per-token
# estimate if tiktoken is unavailable, so callers never break on a missing dep.

def count_tokens(text: str) -> int:
    """Real token count for `text` via tiktoken, or a length/4 estimate as a
    fallback. Never raises."""
    if not text:
        return 0
    if _TIKTOKEN_ENC is not None:
        try:
            return len(_TIKTOKEN_ENC.encode(text))
        except Exception:
            pass
    return max(1, len(text) // 4)


def count_message_tokens(messages: list, system: str = "") -> int:
    """Total token estimate for a system prompt + a list of {role, content}
    messages, including a small per-message overhead (role/formatting tokens)."""
    total = count_tokens(system) if system else 0
    for m in messages:
        content = m.get("content", "")
        if not isinstance(content, str):
            content = str(content)
        total += count_tokens(content) + 4  # ~4 tokens overhead per message (role/wrapper)
    return total


def trim_messages_to_budget(messages: list, max_tokens: int, system: str = "",
                             keep_recent: int = 2) -> list:
    """Drop the OLDEST messages (never the most recent `keep_recent`) until the
    remaining conversation + system prompt fits within `max_tokens`. Used for
    chat-style agent conversations that can grow unboundedly turn over turn
    (e.g. CrossSkilling's follow-up chat) — a message-count cap alone doesn't
    protect against a few very long messages blowing the context budget, and
    an uncapped history risks silently ballooning cost/latency or hitting the
    provider's context-length limit mid-conversation.

    Always returns at least the last `keep_recent` messages, even if that alone
    exceeds the budget — trimming can't fix a single message that's too long,
    and returning nothing would break the conversation contract entirely."""
    if not messages:
        return messages
    keep_recent = max(1, min(keep_recent, len(messages)))
    head, tail = messages[:-keep_recent], messages[-keep_recent:]
    kept = list(tail)
    for m in reversed(head):
        candidate = [m] + kept
        if count_message_tokens(candidate, system) > max_tokens:
            break
        kept = candidate
    return kept


# ── API config (all from environment) ─────────────────────────────────────────
# OpenAI is the PRIMARY provider for every agent (see llm_call / groq_call below);
# Groq stays configured as an automatic fallback. Both speak the same OpenAI
# chat-completions schema, so the shared call helpers only differ by URL/key/model.
OPENAI_URL      = os.getenv("OPENAI_URL",      "https://api.openai.com/v1/chat/completions")
OPENAI_MODEL    = os.getenv("OPENAI_MODEL",    "gpt-4o-mini")
GROQ_URL        = os.getenv("GROQ_URL",        "https://api.groq.com/openai/v1/chat/completions")
GROQ_MODEL      = os.getenv("GROQ_MODEL",      "openai/gpt-oss-20b")
ANTHROPIC_URL   = os.getenv("ANTHROPIC_URL",   "https://api.anthropic.com/v1/messages")
ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-6")


# ── DB (no hardcoded credentials — must be set in .env) ───────────────────────
def get_db_url() -> str:
    url = os.getenv("DATABASE_URL", "")
    if not url:
        raise ValueError(
            "DATABASE_URL not set in .env — "
            "example: postgresql://user:pass@localhost:5432/nexus"
        )
    return url


# ── Connection pool (avoids opening a fresh TCP+auth connection per tool call) ──
# Agents open a DB connection inside almost every node and tool. Without pooling
# that is one connect()+auth handshake each time — connection churn that does not
# survive load. A ThreadedConnectionPool reuses a small set of live connections.
_DB_POOL = None

def _get_db_pool():
    global _DB_POOL
    if _DB_POOL is None:
        from psycopg2.pool import ThreadedConnectionPool
        _DB_POOL = ThreadedConnectionPool(
            int(os.getenv("DB_POOL_MIN", "1")),
            int(os.getenv("DB_POOL_MAX", "10")),
            get_db_url(),
        )
    return _DB_POOL


class _PooledConn:
    """Thin proxy so existing `conn.close()` call sites return the connection to
    the pool instead of tearing it down. Everything else proxies to the real
    connection. `.close()` rolls back any open/aborted transaction first so the
    connection is clean for the next borrower."""
    def __init__(self, pool, conn):
        self._pool = pool
        self._conn = conn

    def __getattr__(self, name):
        return getattr(self._conn, name)

    def close(self):
        try:
            if not self._conn.closed:
                self._conn.rollback()  # clear any open/aborted txn before reuse
        except Exception:
            pass
        try:
            self._pool.putconn(self._conn)
        except Exception:
            try:
                self._conn.close()
            except Exception:
                pass


def get_db_conn():
    """Return a pooled psycopg2 connection. Call .close() to return it to the pool.

    Falls back to a direct connection if the pool cannot be created (keeps agents
    working even if pooling is misconfigured)."""
    try:
        pool = _get_db_pool()
        return _PooledConn(pool, pool.getconn())
    except Exception:
        import psycopg2
        import psycopg2.extras
        return psycopg2.connect(get_db_url())


@contextmanager
def db_cursor(dict_rows: bool = False, autocommit: bool = True):
    """
    Context manager yielding a cursor. Commits on success, rolls back on error,
    always closes. Used by the quiz engine + routes so persistence is uniform.

        with db_cursor(dict_rows=True) as cur:
            cur.execute("SELECT ...")
            rows = cur.fetchall()
    """
    import psycopg2
    import psycopg2.extras
    conn = psycopg2.connect(get_db_url())
    conn.autocommit = autocommit
    factory = psycopg2.extras.RealDictCursor if dict_rows else None
    try:
        cur = conn.cursor(cursor_factory=factory) if factory else conn.cursor()
        yield cur
        if not autocommit:
            conn.commit()
    except Exception:
        if not autocommit:
            conn.rollback()
        raise
    finally:
        conn.close()


# ── Configurable thresholds (override via .env) ───────────────────────────────
# Existing (kept for backward compatibility)
TESTOUT_PASS_THRESHOLD = int(os.getenv("TESTOUT_PASS_THRESHOLD", "90"))    # % — opt-out pass mark
QUIZ_QUESTION_COUNT    = int(os.getenv("QUIZ_QUESTION_COUNT",    "10"))    # default target length
SOCRATIC_MAX_TOKENS    = int(os.getenv("SOCRATIC_MAX_TOKENS",    "150"))

# ── Quiz / CAT engine parameters (per the Curriculum Agent spec) ──────────────
# All configurable — none of these are hardcoded in the engine.
QUIZ_MAX_QUESTIONS      = int(os.getenv("QUIZ_MAX_QUESTIONS",      "10"))   # hard cap on served items
QUIZ_MIN_QUESTIONS      = int(os.getenv("QUIZ_MIN_QUESTIONS",      "8"))    # min items a learner must answer before CAT may stop, even at high confidence (spec: 8)
QUIZ_TIMER_SECONDS      = int(os.getenv("QUIZ_TIMER_SECONDS",      "600"))  # 10-minute timer
QUIZ_CONFIDENCE_PASS    = float(os.getenv("QUIZ_CONFIDENCE_PASS",  "0.60")) # 60% confidence threshold (spec requirement)
QUIZ_MAX_ATTEMPTS       = int(os.getenv("QUIZ_MAX_ATTEMPTS",       "3"))    # cap on attempts per topic/module (spec requirement)
QUIZ_POOL_MULTIPLIER    = float(os.getenv("QUIZ_POOL_MULTIPLIER",  "1.4"))  # generate pool = cap * mult (smaller pool = much faster generation; 10*1.4=14)
QUIZ_SESSION_TTL_MIN    = int(os.getenv("QUIZ_SESSION_TTL_MIN",    "60"))   # sessions expire after N min

# CAT (Computerized Adaptive Testing) — simple ability-estimate parameters
CAT_START_THETA         = float(os.getenv("CAT_START_THETA",       "0.0"))  # neutral start
CAT_STEP                = float(os.getenv("CAT_STEP",              "0.35"))  # theta move per item
CAT_SE_STOP             = float(os.getenv("CAT_SE_STOP",          "0.35"))  # standard-error stop rule

# ── Cross-skilling weights (must sum to 1.0) ──────────────────────────────────
WEIGHT_MARKET = float(os.getenv("CROSSSKILL_WEIGHT_MARKET", "0.40"))
WEIGHT_TEAM   = float(os.getenv("CROSSSKILL_WEIGHT_TEAM",   "0.35"))
WEIGHT_ROLE   = float(os.getenv("CROSSSKILL_WEIGHT_ROLE",   "0.25"))

# ── Token budgeting ────────────────────────────────────────────────────────────
# Max tokens of conversation history call_with_tools() will send on the first
# call, before trimming the oldest turns (see trim_messages_to_budget). Sized
# well under any provider's context window — this bounds cost/latency growth
# on long-running chats (e.g. CrossSkilling follow-up conversation), not a
# context-overflow guard.
TOOL_CALL_HISTORY_TOKEN_BUDGET = int(os.getenv("TOOL_CALL_HISTORY_TOKEN_BUDGET", "6000"))

# ── Retrieval defaults (shared RAG) ───────────────────────────────────────────
RAG_TOP_K            = int(os.getenv("RAG_TOP_K",            "4"))
RAG_MIN_SCORE        = float(os.getenv("RAG_MIN_SCORE",      "0.25"))   # discard weak cosine matches
RAG_EMBED_MODEL      = os.getenv("RAG_EMBED_MODEL", "BAAI/bge-small-en-v1.5")
RAG_EMBED_DIM        = int(os.getenv("RAG_EMBED_DIM",       "384"))     # BAAI/bge-small-en-v1.5 → 384-dim

# ── Persistent vector store (pgvector via LlamaIndex PGVectorStore) ────────────
# When enabled, the shared retriever's vector leg is served by a pgvector index
# in the SAME Postgres instead of loading the whole doc_embeddings table into
# Python per query. Falls back to the in-memory cosine path automatically if the
# pgvector packages / extension are unavailable, so this is safe to leave on.
PGVECTOR_ENABLE      = os.getenv("PGVECTOR_ENABLE", "1").lower() not in ("0", "false", "no", "off")
PGVECTOR_TABLE       = os.getenv("PGVECTOR_TABLE",  "nexus_docs")       # LlamaIndex creates data_<table>
PGVECTOR_HNSW        = os.getenv("PGVECTOR_HNSW",   "1").lower() not in ("0", "false", "no", "off")


# ── Shared LLM helpers ────────────────────────────────────────────────────────

# ── Per-agent LLM usage logging ───────────────────────────────────────────────
# Every LLM call made through the shared helpers below is written to the same
# `llm_logs` table main.py's Admin → LLM Operations view reads, so the per-agent
# token/latency breakdown covers ALL agents (previously only the /api/agent proxy
# path logged, leaving Reasoning/Study Aid/Practice/RAG/etc. invisible). Each
# request-handling thread tags its calls via set_current_agent() at the agent's
# run_* entry point; a ContextVar keeps that attribution correct per request.
import contextvars
_CURRENT_AGENT = contextvars.ContextVar("nx_agent", default="Agent")

def set_current_agent(name: str) -> None:
    """Tag subsequent LLM calls on this request's thread with an agent name."""
    try:
        _CURRENT_AGENT.set(name or "Agent")
    except Exception:
        pass

def _log_llm(model, input_tokens, output_tokens, latency_ms, success, error=None, agent=None) -> None:
    """Best-effort insert into llm_logs. Never raises — a logging failure must
    never break generation."""
    try:
        ag = agent or _CURRENT_AGENT.get()
    except Exception:
        ag = agent or "Agent"
    try:
        with db_cursor() as cur:
            cur.execute(
                "INSERT INTO llm_logs (agent_name, model, input_tokens, output_tokens, latency_ms, success, error) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s)",
                (ag, model, int(input_tokens or 0), int(output_tokens or 0),
                 int(latency_ms or 0), bool(success), (str(error)[:400] if error else None)),
            )
    except Exception as e:
        print(f"[llm_log] skipped: {e}")


def _openai_call(messages: list, system: str, max_tokens: int = 600, timeout: int = 30, agent: str = None) -> str:
    """
    Make a synchronous OpenAI Chat Completions call (the PRIMARY provider).
    Raises ValueError if OPENAI_API_KEY is not set.
    Raises requests.HTTPError on non-2xx response.

    Same OpenAI-compatible schema as Groq, so callers are provider-agnostic.
    Retries on 429 / 5xx with a bounded backoff (honouring Retry-After when the
    API supplies it) — one shared key across every agent means concurrent bursts
    (several learners generating quizzes/flashcards at once) can transiently hit
    the rate limit even when the key is healthy. gpt-4o-* are NOT reasoning
    models, so no reasoning_effort cap is sent (that param is Groq gpt-oss only).
    """
    key = os.getenv("OPENAI_API_KEY", "")
    if not key:
        raise ValueError("OPENAI_API_KEY not set in .env")

    _t0 = time.time()
    last_exc = None
    for attempt in range(3):
        resp = requests.post(
            OPENAI_URL,
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type":  "application/json",
            },
            json={
                "model":      OPENAI_MODEL,
                "max_tokens": max_tokens,
                "messages":   [{"role": "system", "content": system}] + messages,
            },
            timeout=timeout,
        )
        if resp.status_code == 429 or resp.status_code >= 500:
            last_exc = requests.exceptions.HTTPError(
                f"{resp.status_code} from OpenAI (attempt {attempt+1}/3)", response=resp
            )
            if attempt < 2:
                retry_after = resp.headers.get("Retry-After")
                wait = float(retry_after) if retry_after else (1.5 * (attempt + 1))
                time.sleep(min(wait, 8))
                continue
            break
        resp.raise_for_status()
        body = resp.json()
        usage = body.get("usage") or {}
        _log_llm(OPENAI_MODEL, usage.get("prompt_tokens"), usage.get("completion_tokens"),
                 (time.time() - _t0) * 1000, True, agent=agent)
        return body["choices"][0]["message"]["content"]
    _log_llm(OPENAI_MODEL, 0, 0, (time.time() - _t0) * 1000, False, error=last_exc, agent=agent)
    raise last_exc


def _groq_call_impl(messages: list, system: str, max_tokens: int = 600, timeout: int = 30, agent: str = None) -> str:
    """
    Make a synchronous Groq API call (the FALLBACK provider).
    Raises ValueError if GROQ_API_KEY is not set.
    Raises requests.HTTPError on non-2xx response.

    reasoning_effort is pinned to "low": GROQ_MODEL (openai/gpt-oss-*) is a
    reasoning model — without this cap, an unknown chunk of max_tokens is spent
    on hidden reasoning tokens the caller never sees, leaving too few tokens for
    the actual answer and truncating it mid-output (e.g. a cut-off JSON string
    the caller then fails to parse). study_aid.py already discovered and fixed
    this for its own isolated call path; every OTHER caller of this shared
    helper (Study Notes, Quiz generation, Reasoning's layer-3 fallback,
    Crossskilling, Capstone, Practice) was still hitting it. "low" only trims
    the model's internal deliberation depth, not the quality of the final
    answer, so this has no downside for any existing caller.
    """
    key = os.getenv("GROQ_API_KEY", "")
    if not key:
        raise ValueError("GROQ_API_KEY not set in .env")

    # Retry on rate limiting (429) and transient server errors (5xx) — a single
    # shared key across every agent in this app means a burst of calls (e.g.
    # several learners generating quizzes/flashcards/scenarios at once) can hit
    # Groq's per-minute rate limit even though the key itself is fine. Without
    # a retry, that surfaces to the caller as a generic "could not generate"
    # failure that looks identical to a missing/invalid key — this is what was
    # actually happening for quiz generation, not an api-key problem.
    _t0 = time.time()
    last_exc = None
    for attempt in range(3):
        resp = requests.post(
            GROQ_URL,
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type":  "application/json",
            },
            json={
                "model":            GROQ_MODEL,
                "max_tokens":       max_tokens,
                "reasoning_effort": "low",
                "include_reasoning": False,
                "messages":         [{"role": "system", "content": system}] + messages,
            },
            timeout=timeout,
        )
        if resp.status_code == 429 or resp.status_code >= 500:
            last_exc = requests.exceptions.HTTPError(
                f"{resp.status_code} from Groq (attempt {attempt+1}/3)", response=resp
            )
            if attempt < 2:
                retry_after = resp.headers.get("Retry-After")
                wait = float(retry_after) if retry_after else (1.5 * (attempt + 1))
                time.sleep(min(wait, 8))
                continue
            break
        resp.raise_for_status()
        body = resp.json()
        usage = body.get("usage") or {}
        _log_llm(GROQ_MODEL, usage.get("prompt_tokens"), usage.get("completion_tokens"),
                 (time.time() - _t0) * 1000, True, agent=agent)
        return body["choices"][0]["message"]["content"]
    _log_llm(GROQ_MODEL, 0, 0, (time.time() - _t0) * 1000, False, error=last_exc, agent=agent)
    raise last_exc


def anthropic_call(messages: list, system: str, max_tokens: int = 400, timeout: int = 30, agent: str = None) -> str:
    """Synchronous Anthropic call. Raises ValueError if ANTHROPIC_API_KEY missing."""
    key = os.getenv("ANTHROPIC_API_KEY", "")
    if not key:
        raise ValueError("ANTHROPIC_API_KEY not set in .env")
    anthropic_messages = [
        {"role": m["role"], "content": m["content"]}
        for m in messages
        if m.get("role") in ("user", "assistant")
    ]
    _t0 = time.time()
    resp = requests.post(
        ANTHROPIC_URL,
        headers={
            "x-api-key":         key,
            "anthropic-version": "2023-06-01",
            "Content-Type":      "application/json",
        },
        json={
            "model":      ANTHROPIC_MODEL,
            "max_tokens": max_tokens,
            "system":     system,
            "messages":   anthropic_messages,
        },
        timeout=timeout,
    )
    resp.raise_for_status()
    body = resp.json()
    usage = body.get("usage") or {}
    _log_llm(ANTHROPIC_MODEL, usage.get("input_tokens"), usage.get("output_tokens"),
             (time.time() - _t0) * 1000, True, agent=agent)
    return body["content"][0]["text"]


_GUARDRAIL_REFUSAL = ("I can't help with that request. Let's keep this focused on your "
                      "Adobe Experience Platform learning — what topic would you like to explore?")


def check_input_guardrail(messages: list, agent: str = None):
    """Uniform input safety gate — applies to EVERY agent, both the plain
    llm_call() path and the tool-calling call_with_tools() path (previously
    this check only lived inline in llm_call(), so any agent that resolved
    within its first tool-calling round — the common case — never ran it at
    all; only conversations that reached call_with_tools' final forced-answer
    round, which falls back to llm_call(), got checked). Per-agent guardrails
    vary in richness (Reasoning/RAG are rich; others thin), but injection and
    genuinely unsafe requests should be refused consistently for all of them.
    Scope-gating is deliberately NOT applied here (too aggressive centrally —
    each agent owns its own topic policy); only injection + unsafe.

    Returns the refusal string if blocked, else None. Never raises."""
    try:
        from guardrails import policy as _gr_policy
        user_text = " ".join(m.get("content", "") for m in messages if m.get("role") == "user")
        blocked = _gr_policy.is_injection(user_text) or _gr_policy.is_unsafe(user_text)
        if blocked:
            _log_llm("guardrail", 0, 0, 0, False, error=f"blocked: {blocked}", agent=agent)
            return _GUARDRAIL_REFUSAL
    except Exception:
        pass  # guardrail must never break generation
    return None


def llm_call(messages: list, system: str, max_tokens: int = 600, timeout: int = 30,
             prefer: str = "openai", agent: str = None) -> str:
    """Provider-agnostic text completion with automatic failover.

    Tries the preferred provider first (OpenAI by default — the project's primary
    provider), then falls back to the next on ANY failure: missing/blank key, 429
    after the internal retries are exhausted, 5xx, or a network error. Order is
    OpenAI → Anthropic (Claude) → Groq (rotated so `prefer` is always first) —
    Claude sits ahead of Groq as the quality-tier fallback before dropping to
    the free-tier model.

    This is what makes quiz / flashcard / study-note / test-out generation
    reliable regardless of which key happens to be configured on a given backend:
    a missing OpenAI key or a transient 429 quietly falls back to Groq instead of
    surfacing to the learner as a dead-end "Could not generate" with no failover.

    Raises RuntimeError only when ALL providers are unavailable/failing, with the
    underlying per-provider errors joined for debugging.
    """
    blocked = check_input_guardrail(messages, agent=agent)
    if blocked:
        return blocked

    base = ["openai", "anthropic", "groq"]
    order = ([prefer] + [p for p in base if p != prefer]) if prefer in base else base
    impls = {"openai": _openai_call, "groq": _groq_call_impl, "anthropic": anthropic_call}
    errors = []
    for provider in order:
        try:
            return impls[provider](messages, system, max_tokens=max_tokens, timeout=timeout, agent=agent)
        except Exception as e:            # noqa: BLE001 — deliberately provider-agnostic
            errors.append(f"{provider}: {e}")
            continue
    raise RuntimeError("All LLM providers failed → " + " | ".join(errors))


def openai_call(messages: list, system: str, max_tokens: int = 600, timeout: int = 30, agent: str = None) -> str:
    """Public OpenAI call (primary provider). Thin alias over the impl."""
    return _openai_call(messages, system, max_tokens=max_tokens, timeout=timeout, agent=agent)


def groq_call(messages: list, system: str, max_tokens: int = 600, timeout: int = 30, agent: str = None) -> str:
    """Back-compat entry point for the many agents that historically called
    groq_call() directly. It now routes through the provider-agnostic dispatcher
    OpenAI-first (Groq fallback), so every existing caller is migrated to OpenAI
    with zero changes on their side. Pass prefer= to llm_call() for other orders."""
    return llm_call(messages, system, max_tokens=max_tokens, timeout=timeout, prefer="openai", agent=agent)


def parse_json_lenient(raw: str) -> dict:
    """
    Best-effort JSON extraction from an LLM response.
    Strips ```json fences and grabs the outermost {...} or [...] if there's
    surrounding prose. Raises json.JSONDecodeError if nothing parses.
    """
    if raw is None:
        raise json.JSONDecodeError("empty", "", 0)
    txt = raw.strip()
    if txt.startswith("```"):
        txt = txt.strip("`")
        # drop a leading "json" language tag if present
        if txt[:4].lower() == "json":
            txt = txt[4:]
        txt = txt.strip()
    try:
        return json.loads(txt)
    except json.JSONDecodeError:
        # fall back to first {...} or [...]
        for open_c, close_c in (("{", "}"), ("[", "]")):
            start = txt.find(open_c)
            end   = txt.rfind(close_c)
            if start != -1 and end != -1 and end > start:
                return json.loads(txt[start:end + 1])
        raise


def make_meta(name: str, model: str, start: float, extra: dict = None) -> dict:
    """Build standard response metadata dict for the UI badge."""
    m = {
        "type":           "llm" if name in ("socratic", "study_notes", "flashcards", "session_evaluator") else "agent",
        "name":           name,
        "model":          model,
        "steps_executed": 1,
        "latency_ms":     round((time.time() - start) * 1000),
    }
    if extra:
        m.update(extra)
    return m


# ── AEP product distinctions (injected into every system prompt) ──────────────
PRODUCT_DISTINCTIONS = """
CRITICAL AEP product distinctions — never confuse these:
- Adobe Analytics (AA) ≠ Customer Journey Analytics (CJA)
- Web SDK ≠ Adobe Analytics ≠ Real-Time CDP
- RTCDP ≠ AEP (RTCDP is one application built on AEP)
- AJO (Journey Optimizer) is separate from Campaign
- Segments in RTCDP ≠ segments in AA
"""


# ══════════════════════════════════════════════════════════════════════════════
# SHARED TOOL-CALLING HARNESS — one implementation, used by every agent that
# needs real LLM function-calling (the model decides what to look up/do, instead
# of a fixed Python pipeline pre-fetching everything into the prompt).
#
# This generalizes the pattern proven in reasoning.py's `_groq_call_with_tools`
# (the only agent that had real tool-calling before this): OpenAI-primary with
# automatic Groq fallback, same OpenAI-compatible `tools`/`tool_choice` schema on
# both providers, a bounded dispatch loop that runs the model's chosen tool via
# an agent-supplied executor callback and feeds the result back, and per-call
# logging to llm_logs so every agent's tool-calling usage shows up in Admin →
# LLM Operations.
#
# NOTE on provider order: plain (non-tool) calls via llm_call() go
# OpenAI → Anthropic → Groq. Tool-calling here is OpenAI → Groq ONLY — Anthropic
# is deliberately NOT in this chain because Claude's tool-use format (content
# blocks with `tool_use`/`tool_result`) is not wire-compatible with the OpenAI
# `tools`/`tool_calls` schema every agent's tool definitions are written in;
# adding it would need a second, differently-shaped tool-calling implementation,
# not just another URL in the same loop.
# ══════════════════════════════════════════════════════════════════════════════

def _tool_call_once(messages: list, system: str, tools: list, max_tokens: int,
                     agent: str, temperature: float = 0.4):
    """One raw call with tools attached. OpenAI first, Groq fallback (same
    tools schema on both — both are OpenAI-compatible chat-completions APIs).
    Returns the raw assistant message dict (may contain `tool_calls`).
    Raises RuntimeError only if every provider is unavailable/failing."""
    openai_key = os.getenv("OPENAI_API_KEY", "")
    groq_key   = os.getenv("GROQ_API_KEY", "")
    attempts = []
    if openai_key:
        attempts.append((OPENAI_URL, openai_key, OPENAI_MODEL))
    if groq_key:
        attempts.append((GROQ_URL, groq_key, GROQ_MODEL))
    if not attempts:
        raise RuntimeError("No LLM API key configured (OPENAI_API_KEY / GROQ_API_KEY)")

    last_err = None
    for i, (endpoint, key, model) in enumerate(attempts):
        is_last = i == len(attempts) - 1
        payload = {
            "model": model,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "messages": [{"role": "system", "content": system}] + messages,
            "tools": tools,
            "tool_choice": "auto",
        }
        _t0 = time.time()
        try:
            resp = requests.post(endpoint,
                                  headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                                  json=payload, timeout=30)
        except requests.RequestException as e:
            last_err = e
            if is_last:
                raise RuntimeError(str(e))
            continue
        if resp.status_code == 400:
            # Model rejected the tool schema — retry same model without tools
            # so the turn still completes (degrades to plain completion).
            payload.pop("tools", None)
            payload.pop("tool_choice", None)
            try:
                resp = requests.post(endpoint,
                                      headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                                      json=payload, timeout=30)
            except requests.RequestException as e:
                last_err = e
                if is_last:
                    raise RuntimeError(str(e))
                continue
        if resp.status_code == 429 or resp.status_code >= 500:
            last_err = requests.exceptions.HTTPError(f"{resp.status_code} from {model}")
            if is_last:
                raise RuntimeError(str(last_err))
            continue
        if resp.status_code != 200:
            last_err = requests.exceptions.HTTPError(f"{resp.status_code} from {model}: {resp.text[:200]}")
            if is_last:
                raise RuntimeError(str(last_err))
            continue
        body = resp.json()
        usage = body.get("usage") or {}
        _log_llm(model, usage.get("prompt_tokens"), usage.get("completion_tokens"),
                 (time.time() - _t0) * 1000, True, agent=agent)
        return body["choices"][0]["message"]
    raise RuntimeError(str(last_err) if last_err else "All providers failed")


def call_with_tools(messages: list, system: str, tools: list, executor,
                     max_tokens: int = 700, max_rounds: int = 4,
                     agent: str = "Agent", temperature: float = 0.4) -> dict:
    """Run a bounded tool-calling loop: the model may call any tool in `tools`,
    `executor(tool_name, args_dict)` runs it and returns a JSON-serialisable
    result, and the loop feeds that back until the model returns final content
    (or `max_rounds` is hit, at which point we force a final answer with no
    tools attached so the turn always terminates with real content).

    Returns {"content": str, "tool_calls": [{"name":..., "args":..., "result":...}]}
    — the trace is included so callers can log/validate what the model actually
    did (mirrors reasoning.py's telemetry, without duplicating that code here).

    Token budgeting: incoming `messages` is trimmed (oldest-first, keeping the
    most recent turns) to a token budget before the first call — protects any
    caller with an unbounded/growing conversation (e.g. CrossSkilling's chat
    mode) without every agent needing to implement its own history window.

    Input guardrail: checked here up front (see check_input_guardrail) —
    without this, an agent that resolves within its first tool-calling round
    (the common case) never had its input checked at all; only conversations
    that reached the final forced-answer round (which falls back to llm_call())
    got the check, since it used to live only inside llm_call().
    """
    blocked = check_input_guardrail(messages, agent=agent)
    if blocked:
        return {"content": blocked, "tool_calls": []}

    messages = trim_messages_to_budget(messages, TOOL_CALL_HISTORY_TOKEN_BUDGET, system)
    convo = list(messages)
    trace = []
    for round_i in range(max_rounds):
        use_tools = tools if round_i < max_rounds - 1 else None
        if use_tools:
            msg = _tool_call_once(convo, system, use_tools, max_tokens, agent, temperature)
        else:
            # Last allowed round: force a plain answer, no more tool calls.
            text = llm_call(convo, system, max_tokens=max_tokens, agent=agent)
            return {"content": text, "tool_calls": trace}

        tool_calls = msg.get("tool_calls")
        if not tool_calls:
            return {"content": msg.get("content") or "", "tool_calls": trace}

        # Assistant's tool-call message must be echoed back before the tool
        # results, per the OpenAI/Groq function-calling conversation contract.
        convo.append({"role": "assistant", "content": msg.get("content") or "", "tool_calls": tool_calls})
        for tc in tool_calls:
            name = tc.get("function", {}).get("name", "")
            raw_args = tc.get("function", {}).get("arguments", "{}")
            try:
                args = json.loads(raw_args) if isinstance(raw_args, str) else (raw_args or {})
            except Exception:
                args = {}
            try:
                result = executor(name, args)
            except Exception as e:
                result = {"error": str(e)}
            trace.append({"name": name, "args": args, "result": result})
            convo.append({
                "role": "tool",
                "tool_call_id": tc.get("id", ""),
                "content": json.dumps(result) if not isinstance(result, str) else result,
            })
    # Exhausted all rounds without a final answer (shouldn't normally happen
    # since the last round has no tools) — fail safe with what we have.
    return {"content": "", "tool_calls": trace}