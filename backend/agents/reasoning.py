"""
reasoning.py — Reasoning Agent / AI Tutor (LangGraph, tool-calling)
===================================================================
Step-by-step concept scaffolding assistant with real tool calling.

Flow:
  load_context → classify → retrieve → generate_with_tools → judge
              → [retry up to 2x] → done

6 tools exposed to the model during generation:
  1. search_adobe_docs         — semantic search over Adobe documentation
  2. get_module_content        — fetch curriculum content for a topic
  3. check_learner_progress    — query the learner's status on a module
  4. generate_practice_question— create a targeted practice question
  5. update_confidence         — record a confidence score change
  6. log_learning_milestone    — record demonstrated understanding

Guardrails:
  - Max 3 tool calls per turn (prevents runaway loops)
  - Tool results capped at 500 chars (prevents context bloat)
  - Forbidden tool sequences blocked (e.g. update_confidence without evidence)
  - Every tool call logged to the telemetry table for observability

Package conventions (matches study_aid.py):
  - imports shared layer from .config (no top-level `from main import ...`)
  - symbols living in main.py are lazy-imported inside functions
  - plain-dict state, StateGraph(dict)
  - ISOLATED tool model: the tool loop runs on REASONING_TOOL_MODEL so the rest
    of the system stays on GROQ_MODEL (gpt-oss-20b)
"""

from .config import (
    set_current_agent,
    OPENAI_URL, OPENAI_MODEL,
    GROQ_URL, GROQ_MODEL,
    groq_call, get_db_conn, make_meta,
    PRODUCT_DISTINCTIONS,
    check_input_guardrail,
)

import os
import re
import json
import time
import uuid
import functools
import requests

from evaluation import evaluate_and_log
from guardrails import check_output

try:
    from langgraph.graph import StateGraph, END
    LANGGRAPH_AVAILABLE = True
except ImportError:
    LANGGRAPH_AVAILABLE = False

# ── Isolated tool-loop model chain (critical) ───────────────────────────────────
# The tool loop MUST NOT touch the shared GROQ_MODEL — the rest of the system
# stays on gpt-oss-20b. Tools are attached ONLY to the first model in the chain
# (the "tool model"); every subsequent model is a fallback called WITHOUT tools.
#
# The chain is now fully config-driven: set REASONING_MODEL_CHAIN to a
# comma-separated list to add, remove, or reorder models with NO code change —
# e.g. "openai/gpt-oss-20b,llama-3.3-70b-versatile,llama-3.1-8b-instant" to add a
# mid-tier model between the primary and the small fallback. More models = more
# resilience to a single model being down/rate-limited (each 4xx/5xx falls
# through to the next). REASONING_TOOL_MODEL / REASONING_FALLBACK_MODEL are still
# honored as the default first/last links when REASONING_MODEL_CHAIN is unset, so
# existing deployments keep working unchanged.
REASONING_TOOL_MODEL     = os.getenv("REASONING_TOOL_MODEL", "openai/gpt-oss-20b")
REASONING_FALLBACK_MODEL = os.getenv("REASONING_FALLBACK_MODEL", "llama-3.1-8b-instant")


def _build_model_chain() -> list:
    """Ordered, de-duplicated model chain from REASONING_MODEL_CHAIN (comma-sep),
    falling back to [tool_model, fallback_model]. First entry is the tool model."""
    raw = os.getenv("REASONING_MODEL_CHAIN", "")
    chain = [m.strip() for m in raw.split(",") if m.strip()] if raw else []
    if not chain:
        chain = [REASONING_TOOL_MODEL, REASONING_FALLBACK_MODEL]
    seen, out = set(), []
    for m in chain:
        if m not in seen:
            seen.add(m)
            out.append(m)
    return out


REASONING_MODEL_CHAIN = _build_model_chain()

MAX_TOOL_CALLS_PER_TURN = int(os.getenv("REASONING_MAX_TOOL_CALLS", "3"))
MAX_TOOL_RESULT_CHARS   = int(os.getenv("REASONING_MAX_TOOL_RESULT_CHARS", "500"))
MAX_RETRIES             = int(os.getenv("REASONING_MAX_RETRIES", "2"))
# Aggregate wall-clock budget for the WHOLE turn (initial attempt + retries).
# Each individual Groq call already times out at 30s and can cascade through up
# to 4 fallback layers, so a fully-degraded turn could otherwise retry its way
# past 100+ seconds with no upper bound. Once the budget is spent, _should_retry
# stops retrying and accepts whatever answer was produced (still safe — every
# fallback layer already guarantees SOME response text).
REASONING_TIME_BUDGET_SEC = float(os.getenv("REASONING_TIME_BUDGET_SEC", "45"))

# ── Long-thread handling ─────────────────────────────────────────────────────
# The endpoint layer (main.py) bounds the raw message list before it ever
# reaches this module, but that's a hard cutoff — everything before it just
# vanishes with no trace. Within that bounded list, only the most RECENT
# REASONING_HISTORY_WINDOW messages are sent to the model verbatim; anything
# older is compressed into a short summary instead of being silently dropped,
# so a long-running tutoring thread keeps a thread of continuity rather than
# abruptly "forgetting" everything before the window.
REASONING_HISTORY_WINDOW = int(os.getenv("REASONING_HISTORY_WINDOW", "12"))

# Low temperature → reproducible, less "creative" (safer) tutoring output.
REASONING_TEMPERATURE = float(os.getenv("REASONING_TEMPERATURE", "0.3"))
# Approx cost per 1M tokens (USD) for cost estimation in meta — override via env.
REASONING_COST_PER_1M_TOKENS = float(os.getenv("REASONING_COST_PER_1M_TOKENS", "0.20"))

# ── Feedback-driven adaptation (👍/👎 → future prompt behaviour) ────────────────
# How many of the learner's most-recent RATED reasoning answers to analyse.
FEEDBACK_LOOKBACK = int(os.getenv("FEEDBACK_ADAPTATION_LOOKBACK", "20"))
# Below this many ratings, the sample is too small to act on — say nothing rather
# than overfit to 1-2 noisy clicks.
FEEDBACK_MIN_SAMPLES = int(os.getenv("FEEDBACK_ADAPTATION_MIN_SAMPLES", "4"))
# Minimum gap between the up-rated and down-rated group before a factor is
# considered a real pattern (not noise). Same idea for the length ratio.
FEEDBACK_RATE_GAP = float(os.getenv("FEEDBACK_ADAPTATION_RATE_GAP", "0.20"))     # 20 percentage points
FEEDBACK_LEN_RATIO = float(os.getenv("FEEDBACK_ADAPTATION_LEN_RATIO", "1.3"))    # 30% longer/shorter

# ── Dynamic checkpoint-difficulty thresholds (env-overridable, no code change) ──
CONF_LOW  = float(os.getenv("REASONING_CONF_LOW", "0.4"))
CONF_HIGH = float(os.getenv("REASONING_CONF_HIGH", "0.7"))

# ── Quality judge thresholds (env-overridable) ──────────────────────────────────
QUALITY_MIN_WORDS = int(os.getenv("REASONING_QUALITY_MIN_WORDS", "10"))
QUALITY_MAX_WORDS = int(os.getenv("REASONING_QUALITY_MAX_WORDS", "250"))
QUALITY_FALLBACK_MIN_WORDS = int(os.getenv("REASONING_QUALITY_FALLBACK_MIN_WORDS", "15"))

# ── Grounding check thresholds ──────────────────────────────────────────────────
GROUNDING_MIN_OVERLAP = int(os.getenv("REASONING_GROUNDING_MIN_OVERLAP", "3"))
GROUNDING_DOC_RATIO = float(os.getenv("REASONING_GROUNDING_DOC_RATIO", "0.08"))

# ── Vector search tuning ────────────────────────────────────────────────────────
VECTOR_SEARCH_TOP_K = int(os.getenv("REASONING_VECTOR_SEARCH_TOP_K", "3"))
VECTOR_SEARCH_CONTENT_CHARS = int(os.getenv("REASONING_VECTOR_SEARCH_CONTENT_CHARS", "400"))
VECTOR_SEARCH_FALLBACK_CHARS = int(os.getenv("REASONING_VECTOR_SEARCH_FALLBACK_CHARS", "300"))

# ── System prompt context limits ────────────────────────────────────────────────
CONTEXT_DOCS_CHARS = int(os.getenv("REASONING_CONTEXT_DOCS_CHARS", "600"))
CONTEXT_COMPLETED_MODULES_LIMIT = int(os.getenv("REASONING_CONTEXT_COMPLETED_MODULES_LIMIT", "5"))
CONTEXT_FAILED_TESTS_LIMIT = int(os.getenv("REASONING_CONTEXT_FAILED_TESTS_LIMIT", "3"))
CONTEXT_SKILLS_LIMIT = int(os.getenv("REASONING_CONTEXT_SKILLS_LIMIT", "4"))

# ── Feedback adaptation thresholds ──────────────────────────────────────────────
FEEDBACK_DOWN_RATIO_THRESHOLD = float(os.getenv("REASONING_FEEDBACK_DOWN_RATIO_THRESHOLD", "0.4"))
FEEDBACK_UP_RATIO_THRESHOLD = float(os.getenv("REASONING_FEEDBACK_UP_RATIO_THRESHOLD", "0.15"))
FEEDBACK_UP_COUNT_THRESHOLD = int(os.getenv("REASONING_FEEDBACK_UP_COUNT_THRESHOLD", "3"))

# ── PII redaction threshold ─────────────────────────────────────────────────────
PII_MIN_LENGTH = int(os.getenv("REASONING_PII_MIN_LENGTH", "3"))

# ── Step structure detection window (chars between first and second step) ────────
STEP_STRUCTURE_WINDOW = int(os.getenv("REASONING_STEP_STRUCTURE_WINDOW", "300"))

# ══════════════════════════════════════════════════════════════════════════════
# DYNAMIC TRACK CONFIG — labels / keywords / grounding terms live in the DB
# ══════════════════════════════════════════════════════════════════════════════
# Everything product-specific (which Adobe products this tutor covers, the
# vocabulary that marks a message on-topic, the terms used for the grounding
# check, and the `track` enum offered to the tool-calling model) is loaded from
# the `learning_tracks` table at runtime and cached briefly. Adding a NEW learning
# track (e.g. a new Adobe product) is therefore a data change — insert a row — not
# a code deploy. The hardcoded dicts below are ONLY defaults: they seed an empty
# table on first run and act as a safety net if the DB is unreachable, so the
# agent never breaks.

# Product-agnostic pedagogy / interaction vocabulary. These describe HOW the tutor
# converses (not any product), so they legitimately stay in code and are always
# treated as on-topic regardless of which tracks exist.
_GENERIC_KEYWORDS = [
    "aep", "adobe", "experience platform", "customer",
    "module", "track", "checkpoint", "lesson", "curriculum", "learning",
    "step", "explain", "example", "practice", "question", "continue",
    "what if", "how does", "why", "when", "which",
    # Conversational continuations — a bare "yes"/"thanks"/"ok" is never a topic
    # change, it's a reply to whatever the tutor just said. Without these, a
    # keyword-only off-topic check would wrongly redirect these short replies.
    "yes", "no", "ok", "okay", "sure", "right", "got it", "thanks", "thank you",
    "please", "correct", "not really", "kind of",
]

# Default seed data — one entry per product track. Migrated verbatim from the
# former TRACK_LABELS / ON_TOPIC_KEYWORDS / AEP_TERMS constants.
_DEFAULT_TRACKS = {
    "aep": {
        "label": "Adobe Experience Platform", "sort_order": 5,
        "keywords": [
            "aep", "experience platform", "adobe experience platform", "unified profile",
            "flow service", "source connector", "destination connector", "sandbox types",
            "access control", "permissions", "ims org", "developer console", "api",
            "sdk", "web sdk", "mobile sdk", "catalog service", "sensei", "data governance",
            "platform ui", "experience league"],
        "grounding": [
            "aep", "experience platform", "unified profile", "flow service", "sandbox",
            "developer console", "api", "sdk", "catalog service"],
    },
    "rtcdp": {
        "label": "Real-Time CDP", "sort_order": 10,
        "keywords": [
            "rtcdp", "cdp", "segment", "profile", "identity", "schema", "xdm", "dataset",
            "destination", "audience", "activation", "edge", "datastream", "sandbox",
            "merge policy", "merge", "query service", "namespace", "batch", "streaming",
            "ingestion", "lookup", "record", "event", "consent", "governance", "label",
            "policy", "action", "field", "field group", "class", "mixin", "union schema",
            "computed attribute", "enrichment", "timestamp", "priority", "source",
            "real-time", "data collection", "tags", "event forwarding"],
        "grounding": [
            "segment", "profile", "aep", "rtcdp", "schema", "dataset", "destination",
            "identity", "xdm", "sandbox", "merge policy", "query service", "audience",
            "activation", "edge", "datastream", "module"],
    },
    "analytics": {
        "label": "Adobe Analytics", "sort_order": 20,
        "keywords": [
            "analytics", "attribution", "funnel", "fallout", "flow", "report", "metric",
            "calculated metric", "dimension", "classification", "processing rule",
            "data feed", "data warehouse", "analysis workspace", "report builder", "workspace"],
        "grounding": ["analytics", "workspace", "report", "metric", "dimension"],
    },
    "ajo": {
        "label": "Adobe Journey Optimizer", "sort_order": 30,
        "keywords": [
            "ajo", "journey", "campaign", "message", "push notification", "email", "sms",
            "in-app", "offer decisioning", "content card", "fragment", "offer", "decisioning"],
        "grounding": ["ajo", "journey", "offer", "decisioning"],
    },
    "cja": {
        "label": "Customer Journey Analytics", "sort_order": 40,
        "keywords": ["cja", "customer journey", "connection", "data view", "project", "workspace"],
        "grounding": ["cja", "customer journey"],
    },
    # ── Added: these 6 tracks had real curriculum content (see curriculum_topics)
    # but no learning_tracks row, so their vocabulary was silently missing from
    # the on-topic/grounding gate — a learner asking about e.g. "batch ingestion"
    # or "App Builder actions" could be wrongly flagged off-topic. Keywords below
    # are drawn from each track's actual seeded topic titles.
    "da": {
        "label": "AEP - Data Architect", "sort_order": 50,
        "keywords": [
            "data architect", "aep architecture", "sandboxes", "permissions", "roles",
            "xdm", "schema", "schemas", "data ingestion", "datasets", "destinations",
            "convert data model", "identity concepts", "profile enablement",
            "real-time customer profile", "audience segmentation", "audience evaluation",
            "activate audiences", "data governance", "monitoring", "data quality"],
        "grounding": ["xdm", "schema", "dataset", "sandbox", "identity", "profile", "audience"],
    },
    "de": {
        "label": "AEP - Data Engineer", "sort_order": 55,
        "keywords": [
            "data engineer", "aep architecture", "sandboxes", "permissions", "roles",
            "xdm", "schema", "schemas", "data ingestion", "datasets", "destinations",
            "identity concepts", "batch ingestion", "streaming ingestion",
            "sources", "connectors", "profile enablement", "real-time customer profile",
            "audience segmentation", "audience evaluation", "activate audiences",
            "data governance", "monitoring", "data quality"],
        "grounding": ["xdm", "schema", "dataset", "batch", "streaming", "source", "connector", "identity"],
    },
    "es": {
        "label": "Engineering Services", "sort_order": 60,
        "keywords": [
            "engineering services", "code deployment", "workflow engine", "ci/cd",
            "troubleshooting", "aep apis", "app builder", "i/o runtime", "runtime",
            "event-driven", "app builder actions", "destination sdk", "streaming destination",
            "message format", "migration"],
        "grounding": ["app builder", "destination sdk", "ci/cd", "api", "runtime"],
    },
    "target": {
        "label": "Adobe Target", "sort_order": 70,
        "keywords": [
            "target", "adobe target", "recommendations", "environments", "design",
            "remote offers", "feature flag", "feature group", "auto target",
            "auto allocate", "ab activity", "content folder", "json offer", "activity"],
        "grounding": ["target", "activity", "recommendations", "offer", "feature flag"],
    },
    "marketo": {
        "label": "Marketo Engage", "sort_order": 80,
        "keywords": [
            "marketo", "marketo engage", "sales connect", "sales insight",
            "account insight", "tam", "target account management", "smart campaign",
            "lead", "program", "setup checklist", "content patterns", "admin section"],
        "grounding": ["marketo", "sales insight", "lead", "program", "campaign"],
    },
    "campaign": {
        "label": "Adobe Campaign Classic", "sort_order": 90,
        "keywords": [
            "campaign classic", "campaign", "offer catalog", "surveys",
            "campaign optimization", "campaign typologies", "marketing campaigns",
            "recipient table", "data model", "schema edition", "schema reference",
            "web services", "workflow", "delivery", "recipient"],
        "grounding": ["campaign", "offer catalog", "recipient", "workflow", "delivery"],
    },
}

TRACK_CACHE_TTL = float(os.getenv("REASONING_TRACK_CACHE_TTL", "60"))  # seconds
_TRACK_CACHE = {"ts": 0.0, "data": None}


def _ensure_tracks_table(conn):
    """Create learning_tracks (if absent) and seed it from _DEFAULT_TRACKS.
    Idempotent: ON CONFLICT DO NOTHING preserves any admin edits/new rows."""
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS learning_tracks (
                track_code      VARCHAR(40) PRIMARY KEY,
                label           VARCHAR(160) NOT NULL,
                keywords        JSONB NOT NULL DEFAULT '[]',
                grounding_terms JSONB NOT NULL DEFAULT '[]',
                active          BOOLEAN NOT NULL DEFAULT TRUE,
                sort_order      INTEGER NOT NULL DEFAULT 100,
                created_at      TIMESTAMP DEFAULT NOW(),
                updated_at      TIMESTAMP DEFAULT NOW()
            )""")
        for code, v in _DEFAULT_TRACKS.items():
            cur.execute(
                """INSERT INTO learning_tracks (track_code,label,keywords,grounding_terms,sort_order)
                   VALUES (%s,%s,%s,%s,%s) ON CONFLICT (track_code) DO NOTHING""",
                (code, v["label"], json.dumps(v["keywords"]),
                 json.dumps(v["grounding"]), v["sort_order"]))
    conn.commit()


def _assemble_config(labels, kw_by, gr_by):
    all_kw = set(_GENERIC_KEYWORDS)
    for lst in kw_by.values():
        all_kw.update(lst)
    all_gr = set()
    for lst in gr_by.values():
        all_gr.update(lst)
    return {
        "labels": labels,
        "keywords_by_track": kw_by,
        "grounding_by_track": gr_by,
        "all_keywords": sorted(all_kw),
        "all_grounding": sorted(all_gr),
        "track_codes": list(labels.keys()),
    }


def _defaults_config():
    return _assemble_config(
        {c: v["label"] for c, v in _DEFAULT_TRACKS.items()},
        {c: list(v["keywords"]) for c, v in _DEFAULT_TRACKS.items()},
        {c: list(v["grounding"]) for c, v in _DEFAULT_TRACKS.items()})


def _load_track_config(force: bool = False) -> dict:
    """Return the assembled track config, cached for TRACK_CACHE_TTL seconds.
    Falls back to _DEFAULT_TRACKS (never raises) so a DB blip can't break tutoring."""
    now = time.time()
    if (not force and _TRACK_CACHE["data"] is not None
            and (now - _TRACK_CACHE["ts"]) < TRACK_CACHE_TTL):
        return _TRACK_CACHE["data"]

    data = None
    try:
        import psycopg2.extras
        conn = get_db_conn()
        _ensure_tracks_table(conn)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT track_code, label, keywords, grounding_terms
                   FROM learning_tracks WHERE active=TRUE
                   ORDER BY sort_order, track_code""")
            rows = cur.fetchall()
        conn.close()
        if rows:
            labels, kw_by, gr_by = {}, {}, {}
            for r in rows:
                labels[r["track_code"]] = r["label"]
                kw_by[r["track_code"]] = list(r["keywords"] or [])
                gr_by[r["track_code"]] = list(r["grounding_terms"] or [])
            data = _assemble_config(labels, kw_by, gr_by)
    except Exception:
        data = None

    if data is None:                      # DB down / empty → defaults, retry soon
        data = _defaults_config()
        _TRACK_CACHE.update(ts=now - TRACK_CACHE_TTL + 5, data=data)
    else:
        _TRACK_CACHE.update(ts=now, data=data)
    return data


def get_track_label(code: str) -> str:
    cfg = _load_track_config()
    return cfg["labels"].get(code) or _DEFAULT_TRACKS.get(code, {}).get("label", "AEP")


def get_on_topic_keywords() -> list:
    return _load_track_config()["all_keywords"]


def get_grounding_terms(track: str = None) -> list:
    cfg = _load_track_config()
    if track and cfg["grounding_by_track"].get(track):
        return cfg["grounding_by_track"][track]
    return cfg["all_grounding"]


def get_track_codes() -> list:
    return _load_track_config()["track_codes"] or list(_DEFAULT_TRACKS.keys())


def get_product_distinctions() -> str:
    """PRODUCT_DISTINCTIONS (config.py) is a curated, hand-written explanation of
    how the ORIGINAL products differ — that nuance can't be auto-derived, so it
    legitimately stays as static text. But a track added later via the admin API
    (e.g. a brand-new Adobe product) would otherwise never be mentioned here at
    all, silently reintroducing the exact hardcoding this file was built to
    remove. Append a generated reminder listing every currently active track so
    a new one is never missing, without touching the curated text itself."""
    labels = _load_track_config()["labels"]
    if not labels:
        return PRODUCT_DISTINCTIONS
    lines = [f"- {label} is its own product/track — never blend it with the others."
             for label in labels.values()]
    return (PRODUCT_DISTINCTIONS
            + "\nActive learning tracks in this deployment (each is distinct):\n"
            + "\n".join(lines) + "\n")


# ══════════════════════════════════════════════════════════════════════════════
# TOOL DEFINITIONS (OpenAI-compatible function calling format)
# ══════════════════════════════════════════════════════════════════════════════

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "search_adobe_docs",
            "description": "Search Adobe Experience Platform documentation by meaning. Use when you need to look up a specific feature, concept, or workflow that wasn't covered in the initial context. Returns the top matching doc chunks.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Natural language search query, e.g. 'how do merge policies resolve identity conflicts in RTCDP'"
                    },
                    "track": {
                        "type": "string",
                        "enum": ["rtcdp", "analytics", "ajo", "cja"],
                        "description": "Which product track to search within"
                    }
                },
                "required": ["query"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_module_content",
            "description": "Fetch the actual curriculum content for a specific module and topic. Use when you want to reference what the learner studied or should study in a specific module.",
            "parameters": {
                "type": "object",
                "properties": {
                    "module_id": {
                        "type": "integer",
                        "description": "Module number (1-9)"
                    },
                    "topic_order": {
                        "type": "integer",
                        "description": "Topic number within the module (1-based)"
                    },
                    "track": {
                        "type": "string",
                        "enum": ["rtcdp", "analytics", "ajo", "cja"],
                        "description": "Learning track"
                    }
                },
                "required": ["module_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "check_learner_progress",
            "description": "Check whether the learner has completed a specific module, and if they tested out or studied normally. Use to avoid re-explaining concepts the learner already mastered.",
            "parameters": {
                "type": "object",
                "properties": {
                    "module_id": {
                        "type": "integer",
                        "description": "Module number to check (1-9)"
                    }
                },
                "required": ["module_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "generate_practice_question",
            "description": "Generate a targeted practice question to test the learner's understanding of a specific concept. Use after the learner demonstrates partial understanding to reinforce learning.",
            "parameters": {
                "type": "object",
                "properties": {
                    "topic": {
                        "type": "string",
                        "description": "The specific concept to test, e.g. 'segment evaluation edge vs hub'"
                    },
                    "difficulty": {
                        "type": "string",
                        "enum": ["beginner", "intermediate", "advanced"],
                        "description": "Difficulty level based on learner's demonstrated understanding"
                    }
                },
                "required": ["topic"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "update_confidence",
            "description": "Record a confidence score change based on the learner demonstrating understanding in this conversation. Only call this when the learner has correctly answered a checkpoint or demonstrated clear reasoning.",
            "parameters": {
                "type": "object",
                "properties": {
                    "delta": {
                        "type": "number",
                        "description": "Score change: +0.01 for partial understanding, +0.02 for solid understanding, +0.03 for excellent reasoning. Never negative."
                    },
                    "reason": {
                        "type": "string",
                        "description": "Brief reason for the score change, e.g. 'correctly explained identity stitching'"
                    }
                },
                "required": ["delta", "reason"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "log_learning_milestone",
            "description": "Record that the learner demonstrated understanding of a specific concept. This feeds into the manager dashboard and future session planning. Only call when the learner clearly showed they understand something.",
            "parameters": {
                "type": "object",
                "properties": {
                    "concept": {
                        "type": "string",
                        "description": "The concept the learner demonstrated understanding of"
                    },
                    "level": {
                        "type": "string",
                        "enum": ["developing", "proficient", "expert"],
                        "description": "Level of understanding demonstrated"
                    }
                },
                "required": ["concept", "level"]
            }
        }
    },
]

TOOL_NAMES = {t["function"]["name"] for t in TOOLS}


def get_tools() -> list:
    """Return the tool schema with the `track` enum populated from the live track
    config, so a newly-added track is offered to the model without a code change.
    Tool NAMES never change, so TOOL_NAMES stays derived from the static template."""
    codes = get_track_codes()
    tools = json.loads(json.dumps(TOOLS))   # deep copy (schema is plain JSON)
    for t in tools:
        props = t.get("function", {}).get("parameters", {}).get("properties", {})
        track_prop = props.get("track")
        if isinstance(track_prop, dict) and "enum" in track_prop:
            track_prop["enum"] = codes
    return tools


# ══════════════════════════════════════════════════════════════════════════════
# TOOL EXECUTION — each tool's actual implementation
# ══════════════════════════════════════════════════════════════════════════════

def execute_tool(tool_name: str, args: dict, state: dict) -> str:
    """Execute a tool and return the result as a string.

    Each tool implementation is self-contained and accesses the DB directly.
    Results are truncated to MAX_TOOL_RESULT_CHARS to prevent context bloat.
    """
    profile = state.get("profile", {})
    name = profile.get("name", "")
    track = state.get("track", "rtcdp")

    try:
        if tool_name == "search_adobe_docs":
            return _tool_search_docs(args, track)
        elif tool_name == "get_module_content":
            return _tool_get_module(args, track)
        elif tool_name == "check_learner_progress":
            return _tool_check_progress(args, name, track)
        elif tool_name == "generate_practice_question":
            return _tool_practice_question(args, track)
        elif tool_name == "update_confidence":
            return _tool_update_confidence(args, name, state)
        elif tool_name == "log_learning_milestone":
            return _tool_log_milestone(args, name, state)
        else:
            return f"Unknown tool: {tool_name}"
    except Exception as e:
        return f"Tool error: {str(e)[:200]}"


# plain lru_cache has no expiry — if doc_embeddings is ever updated, an
# identical (query, track) lookup would keep returning the stale cached result
# for the rest of the process's life. Folding a coarse time bucket into the
# cache key gives it a natural TTL: once the bucket advances, a fresh lookup
# runs, and the old entries just age out of the LRU normally.
VECTOR_CACHE_TTL_SEC = float(os.getenv("REASONING_VECTOR_CACHE_TTL", "300"))


@functools.lru_cache(maxsize=256)
def _vector_search_cached(query: str, track: str, top_k: int, _bucket: int):
    """LRU-cached wrapper so identical (query, track) lookups embed + scan once.
    This dedupes the retrieval done by node_retrieve_docs_semantic and any
    search_adobe_docs tool call in the same turn (previously each embedded the
    query independently), and also serves repeat queries across turns/users.
    Returns a tuple (hashable) so lru_cache can store it. `_bucket` (see
    VECTOR_CACHE_TTL_SEC) isn't part of the query — it just forces a fresh
    lookup once the bucket advances, giving the cache a TTL."""
    return tuple(json.dumps(r, sort_keys=True) for r in _vector_search_uncached(query, track, top_k))


def _vector_search(query, track, top_k=3):
    """Semantic search with a small, TTL'd result cache (see _vector_search_cached)."""
    bucket = int(time.time() // VECTOR_CACHE_TTL_SEC) if VECTOR_CACHE_TTL_SEC > 0 else 0
    try:
        cached = _vector_search_cached(query or "", track or "rtcdp", top_k, bucket)
        return [json.loads(r) for r in cached]
    except Exception:
        return _vector_search_uncached(query, track, top_k)


# Local fallback corpus — mirrors src/lib/ai.js's ADOBEDOCS_FALLBACK, used when
# both the embeddings index (doc_embeddings) and the raw DB keyword scan come
# back empty. Without this, Reasoning silently got zero grounding docs on an
# empty index while Socratic mode (via retrieveDocs()) still got these same
# docs client-side — the two agents disagreed on whether "no index" means "no
# docs" or "fall back to a small real corpus."
_LOCAL_DOCS_FALLBACK = [
    {"title": "Segment Evaluation Modes", "repo": "experience-platform.en", "content": "Adobe Experience Platform supports three segment evaluation modes. Batch evaluation runs on a scheduled basis and processes all profiles against segment definitions at a fixed time. Streaming evaluation processes segment membership in real time as events arrive, typically within seconds of ingestion. Edge evaluation runs on-device for sub-millisecond decisions without a server round-trip, ideal for same-page personalisation. The evaluation mode is set per segment definition and cannot be changed after creation without rebuilding the segment."},
    {"title": "XDM Schema Design", "repo": "experience-platform.en", "content": "XDM schemas define the structure of data ingested into Adobe Experience Platform. Field groups are reusable components that add specific sets of fields to a schema. Breaking changes to a schema — removing fields or changing data types — require a version bump. Additive changes such as adding new optional fields are backward compatible and do not require versioning. Identity namespaces declared in the schema determine how profile fragments are stitched into a unified profile."},
    {"title": "AJO Journey Orchestration", "repo": "journey-optimizer.en", "content": "Adobe Journey Optimizer journeys are event-driven or audience-based flows. Triggered journeys start when a qualifying event occurs for a profile. Scheduled journeys run against an audience at a defined time. Wait nodes introduce time delays between actions. Frequency capping limits how often a profile can enter or receive communications. Suppression rules exclude profiles from specific journey actions. Journey re-entry settings control whether a profile can re-enter the same journey after exiting."},
    {"title": "RT-CDP Profile Merge Policies", "repo": "experience-platform.en", "content": "Merge policies in Adobe Real-Time CDP define how profile fragments from multiple datasets are combined into a single unified profile. Dataset precedence merge policies give priority to specific datasets when conflicts exist. Timestamp-ordered policies use the most recent value. The default merge policy applies when no policy is explicitly specified. Incorrect merge policy configuration is a common cause of unexpected profile deduplication or unexpected identity stitching."},
    {"title": "CJA Identity Stitching", "repo": "customer-journey-analytics.en", "content": "Customer Journey Analytics stitching links anonymous behaviour to authenticated profiles using field-based or graph-based stitching. Field-based stitching uses a persistent ID and a transient ID to replay sessions. Graph-based stitching uses the Adobe Experience Platform identity graph. Stitching enables person-level analysis by connecting sessions that were recorded under different identities. The stitching lookback window determines how far back anonymous behaviour is attributed to an authenticated profile."},
    {"title": "Streaming Data Ingestion", "repo": "experience-platform.en", "content": "Adobe Experience Platform streaming ingestion uses HTTP API endpoints called inlets to receive real-time event data. Each record must conform to the dataset XDM schema or ingestion fails. Ingestion errors are logged but successful records in the same batch are still processed. High-volume streams may experience throttling if throughput exceeds the inlet capacity. Authenticated inlets require an IMS token; unauthenticated inlets accept data from any source."},
    {"title": "Real-Time Profile Unification", "repo": "experience-platform.en", "content": "The Adobe Experience Platform Real-Time Customer Profile assembles a unified view of each customer from data ingested across all channels. Profile fragments from different datasets are merged according to the active merge policy. Identity resolution links fragments belonging to the same person using the identity graph. Profile lookup returns the merged profile in under 100ms for real-time use cases. The profile store is separate from the data lake and optimised for low-latency reads."},
    {"title": "Edge Network and Edge Evaluation", "repo": "experience-platform.en", "content": "The Adobe Edge Network processes events at the closest point of presence to the end user. Edge segmentation evaluates segment membership on the Edge Network without a round-trip to the central platform, enabling sub-millisecond personalisation decisions at page load. Only segments using a restricted set of operators are eligible for edge evaluation. Edge-evaluated segments must be explicitly configured for edge delivery via the Destinations UI."},
]


def _local_docs_fallback(query, top_k=3):
    words = [w for w in re.split(r"\W+", (query or "").lower()) if len(w) > 3]
    def _matches(doc):
        text = (doc["title"] + " " + doc["content"]).lower()
        return any(w in text for w in words)
    matched = [d for d in _LOCAL_DOCS_FALLBACK if _matches(d)]
    pool = matched if matched else _LOCAL_DOCS_FALLBACK
    return [{**d, "score": 0.0} for d in pool[:top_k]]


def _vector_search_uncached(query, track, top_k=3):
    """Semantic search — lazy import of main.vector_search (main loads us)."""
    results = None
    try:
        from main import vector_search
        results = vector_search(query, track=track, top_k=top_k)
    except Exception:
        results = None
    if not results:
        # Fallback: raw keyword scan over doc_embeddings if main unavailable.
        import psycopg2.extras
        try:
            conn = get_db_conn()
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    """SELECT title, repo, chunk_text FROM doc_embeddings
                       WHERE track=%s OR track IS NULL
                       ORDER BY created_at DESC LIMIT %s""",
                    (track, top_k))
                rows = cur.fetchall()
            conn.close()
            results = [
                {"title": r["title"], "repo": r.get("repo", "EL"),
                 "content": (r["chunk_text"] or ""), "score": 0.0}
                for r in rows if r.get("chunk_text")
            ]
        except Exception:
            results = []
    if not results:
        # Final fallback: small static corpus of real AEP doc excerpts — keeps
        # Reasoning grounded even when the embeddings index is empty and the
        # DB scan also came back empty (not an error, just no rows yet).
        results = _local_docs_fallback(query, top_k)
    return results


def _tool_search_docs(args, default_track):
    query = args.get("query", "")
    track = args.get("track", default_track)
    if not query:
        return "Error: query is required"
    results = _vector_search(query, track=track, top_k=3)
    if not results:
        return "No matching documentation found. Answer from your training knowledge."
    lines = []
    for r in results:
        lines.append(f"[{r.get('repo','EL')}] {r['title']} (score:{r.get('score',0):.2f}): {r['content'][:200]}")
    return "\n".join(lines)[:MAX_TOOL_RESULT_CHARS]


def _tool_get_module(args, default_track):
    module_id = args.get("module_id")
    topic_order = args.get("topic_order")
    track = args.get("track", default_track)
    if module_id is None:
        return "Error: module_id is required"
    import psycopg2.extras
    try:
        conn = get_db_conn()
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            if topic_order:
                cur.execute(
                    """SELECT title, objective, activity, checkpoint
                       FROM curriculum_topics
                       WHERE module_id=%s AND topic_order=%s AND track=%s""",
                    (module_id, topic_order, track))
                row = cur.fetchone()
                if not row:
                    conn.close()
                    return f"No content found for module {module_id}, topic {topic_order}, track {track}"
                conn.close()
                return (f"Topic: {row['title']}\n"
                        f"Objective: {row['objective'] or 'N/A'}\n"
                        f"Activity: {row['activity'] or 'N/A'}\n"
                        f"Checkpoint: {row['checkpoint'] or 'N/A'}")[:MAX_TOOL_RESULT_CHARS]
            else:
                cur.execute(
                    """SELECT topic_order, title, objective
                       FROM curriculum_topics
                       WHERE module_id=%s AND track=%s ORDER BY topic_order""",
                    (module_id, track))
                rows = cur.fetchall()
                conn.close()
                if not rows:
                    return f"No curriculum found for module {module_id}, track {track}"
                lines = [f"Module {module_id} topics:"]
                for r in rows:
                    lines.append(f"  {r['topic_order']}. {r['title']} — {(r['objective'] or '')[:60]}")
                return "\n".join(lines)[:MAX_TOOL_RESULT_CHARS]
    except Exception as e:
        return f"DB error: {str(e)[:100]}"


def _tool_check_progress(args, member_name, default_track):
    module_id = args.get("module_id")
    if module_id is None:
        return "Error: module_id is required"
    if not member_name:
        return "Learner name not available — cannot check progress."
    import psycopg2.extras
    try:
        conn = get_db_conn()
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT module_title, via, completed_at
                   FROM user_module_progress
                   WHERE member_name=%s AND track=%s AND module_id=%s""",
                (member_name, default_track, module_id))
            progress = cur.fetchone()
            cur.execute(
                """SELECT score, passed, created_at
                   FROM module_test_outs
                   WHERE member_name=%s AND track=%s AND module_id=%s
                   ORDER BY created_at DESC LIMIT 1""",
                (member_name, default_track, module_id))
            test = cur.fetchone()
        conn.close()
        parts = []
        if progress:
            parts.append(f"Module {module_id} ({progress['module_title']}): COMPLETED via {progress['via']}")
        else:
            parts.append(f"Module {module_id}: NOT completed")
        if test:
            parts.append(f"Last test-out: {float(test['score']):.0f}% ({'passed' if test['passed'] else 'failed'})")
        return "\n".join(parts)
    except Exception as e:
        return f"DB error: {str(e)[:100]}"


def _tool_practice_question(args, default_track):
    topic = args.get("topic", "")
    difficulty = args.get("difficulty", "intermediate")
    track_label = get_track_label(default_track)
    if not topic:
        return "Error: topic is required"
    sys = (f"Generate exactly 1 {difficulty}-level practice question about '{topic}' "
           f"for a {track_label} consultant. Return JSON: "
           f'{{"question":"...","hint":"...","expected_answer_contains":"..."}}. '
           f"No markdown fences.")
    try:
        resp = groq_call(
            [{"role": "user", "content": f"Topic: {topic}, Difficulty: {difficulty}"}],
            sys, max_tokens=200)
        return (resp or "")[:MAX_TOOL_RESULT_CHARS]
    except Exception as e:
        return f"LLM error: {str(e)[:100]}"


def _tool_update_confidence(args, member_name, state):
    delta = args.get("delta", 0)
    reason = args.get("reason", "")
    if not member_name:
        return "Learner name not available."
    if delta <= 0 or delta > 0.05:
        return f"Guardrail: delta must be between 0.01 and 0.05 (got {delta}). No update applied."
    module = state.get("module", "")
    profile = state.get("profile", {})
    # Read the authoritative current score from the DB (not the client-supplied
    # profile, which a caller could forge). Fall back to profile only if the DB
    # has no row yet.
    current = None
    try:
        from main import db_get_confidence
        current = db_get_confidence(member_name, module)
    except Exception:
        current = None
    if current is None:
        current = float(profile.get("conf", profile.get("confidence", 0)) or 0)
    new_score = min(float(current) + delta, 1.0)
    try:
        from main import db_update_confidence
        db_update_confidence(member_name, module, new_score)
    except Exception:
        pass
    return f"Confidence updated: {current:.2f} → {new_score:.2f} (reason: {reason})"


def _tool_log_milestone(args, member_name, state):
    concept = args.get("concept", "")
    level = args.get("level", "developing")
    if not member_name or not concept:
        return "Error: member_name and concept required."
    if level not in ("developing", "proficient", "expert"):
        return f"Guardrail: level must be developing/proficient/expert (got {level})."
    module = state.get("module", "")
    try:
        from main import db_save_summary
        db_save_summary(
            member_name, "reasoning_milestone", module,
            f"[{level.upper()}] {concept}")
    except Exception:
        pass
    return f"Milestone logged: {concept} → {level}"


# ══════════════════════════════════════════════════════════════════════════════
# TOOL-CALLING LLM — sends tools to Groq, handles tool_calls in response
# ══════════════════════════════════════════════════════════════════════════════

def _groq_call_with_tools(messages: list, system: str, tools: list,
                          max_tokens: int = 400, usage_sink: list = None,
                          model_sink: list = None) -> dict:
    """Call Groq with OpenAI-compatible function calling, walking REASONING_MODEL_CHAIN.

    Tools are attached ONLY to the first model in the chain (the tool model);
    every fallback model is called WITHOUT tools. Each model that returns a
    non-200 (404 model_not_found, 429 rate-limited, 5xx, or a network error) is
    skipped and the next one in the chain is tried, so a single model being down
    no longer breaks the turn. Never touches the shared GROQ_MODEL.

    If `usage_sink` (a list) is passed, the Groq `usage` block for each successful
    call is appended to it for token/cost accounting.

    If `model_sink` (a list) is passed, the name of the model that actually
    produced the response is appended to it — otherwise callers have no way to
    tell whether the primary model or a fallback further down the chain answered,
    which defeats the point of exposing REASONING_MODEL_CHAIN as a resiliency
    feature (there'd be nothing to verify from the API response).
    """
    # OpenAI is the PRIMARY provider; the Groq REASONING_MODEL_CHAIN is the
    # fallback. Each attempt is (endpoint, api_key, model) and uses the same
    # OpenAI-compatible payload (tool-calling schema is identical on both), so a
    # missing OpenAI key or a transient outage transparently walks down to Groq.
    openai_key = os.getenv("OPENAI_API_KEY", "")
    groq_key   = os.getenv("GROQ_API_KEY", "")
    attempts = []
    if openai_key:
        attempts.append((OPENAI_URL, openai_key, OPENAI_MODEL))
    if groq_key:
        attempts.extend((GROQ_URL, groq_key, m) for m in REASONING_MODEL_CHAIN)
    if not attempts:
        return {"role": "assistant", "content": "[No LLM API key configured]"}
    last_err = None
    for i, (endpoint, key, model) in enumerate(attempts):
        is_last_model = i == len(attempts) - 1
        is_tool_model = i == 0
        payload = {
            "model": model,
            "max_tokens": max_tokens,
            "temperature": REASONING_TEMPERATURE,
            "messages": [{"role": "system", "content": system}] + messages,
        }
        use_tools = bool(tools) and is_tool_model
        if use_tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        try:
            resp = requests.post(
                endpoint,
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                json=payload, timeout=30)
        except requests.RequestException as e:
            # Network-level failure (timeout, connection reset) — treat like a
            # model outage and fall through to the next model in the chain.
            last_err = e
            if is_last_model:
                raise
            continue
        if resp.status_code == 400 and use_tools:
            # Model rejected the tool format — retry the same model without tools.
            payload.pop("tools", None)
            payload.pop("tool_choice", None)
            try:
                resp = requests.post(
                    endpoint,
                    headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                    json=payload, timeout=30)
            except requests.RequestException as e:
                last_err = e
                if is_last_model:
                    raise
                continue
        if resp.status_code == 200:
            body = resp.json()
            if usage_sink is not None and body.get("usage"):
                usage_sink.append(body["usage"])
            if model_sink is not None:
                model_sink.append(model)
            # Log to llm_logs so the Admin per-agent view captures the Reasoning
            # agent's primary (tool-calling) path, which bypasses config's shared
            # helpers. Best-effort; never breaks the response.
            try:
                from .config import _log_llm
                _usage = body.get("usage") or {}
                _log_llm(model, _usage.get("prompt_tokens"), _usage.get("completion_tokens"),
                         0, True, agent="Reasoning")
            except Exception:
                pass
            return body["choices"][0]["message"]
        # Any failure (404 model_not_found, 429 rate-limited, etc.) — try the
        # next candidate model instead of raising, unless this was the last one.
        last_err = resp
        if is_last_model:
            resp.raise_for_status()


# ══════════════════════════════════════════════════════════════════════════════
# GUARDRAILS — rules governing tool usage
# ══════════════════════════════════════════════════════════════════════════════

def validate_tool_call(tool_name: str, args: dict, call_history: list,
                       state: dict):
    """Return an error string if the tool call violates guardrails, else None.

    Rules:
    1. Tool name must be in the known set
    2. Max MAX_TOOL_CALLS_PER_TURN calls per turn
    3. update_confidence requires a prior checkpoint_response intent or
       a prior generate_practice_question call (can't boost confidence unprompted)
    4. delta for update_confidence capped at 0.05 (and must be positive)
    5. No duplicate identical tool calls in the same turn
    6. log_learning_milestone only for demonstrated-understanding intents
    """
    if tool_name not in TOOL_NAMES:
        return f"Unknown tool '{tool_name}'"

    if len(call_history) >= MAX_TOOL_CALLS_PER_TURN:
        return f"Tool call limit reached ({MAX_TOOL_CALLS_PER_TURN} per turn)"

    # Prevent duplicate calls
    for prev in call_history:
        if prev["name"] == tool_name and prev["args"] == args:
            return f"Duplicate tool call: {tool_name} with same arguments"

    # update_confidence guardrails
    if tool_name == "update_confidence":
        intent = state.get("intent", "")
        # Evidence must be that the LEARNER answered something, not that the model
        # merely asked a question. A prior generate_practice_question call in
        # call_history only proves a question was posed THIS turn — it says nothing
        # about whether the learner answered it, so it used to let a model call
        # generate_practice_question then update_confidence back-to-back with zero
        # evidence. The legitimate "learner answered a practice question from a
        # previous turn" case is already covered here: that question ended in "?",
        # so the learner's reply now classifies as checkpoint_response and (if
        # substantive) satisfies this check on its own.
        has_evaluation_context = (
            intent == "checkpoint_response" and state.get("checkpoint_substantive", True)
        )
        if not has_evaluation_context:
            return ("Guardrail: update_confidence requires the learner to have just "
                    "given a substantive answer to a checkpoint question")
        delta = args.get("delta", 0)
        if delta > 0.05:
            return f"Guardrail: confidence delta capped at 0.05 (got {delta})"
        if delta <= 0:
            return f"Guardrail: confidence delta must be positive (got {delta})"

    # log_learning_milestone guardrails
    if tool_name == "log_learning_milestone":
        intent = state.get("intent", "")
        nonsubstantive = intent == "checkpoint_response" and not state.get("checkpoint_substantive", True)
        if intent not in ("checkpoint_response", "new_question", "go_deeper") or nonsubstantive:
            return ("Guardrail: milestones should only be logged when the learner "
                    "demonstrates understanding (not during stuck/clarification, "
                    "and not for a non-substantive checkpoint reply)")

    return None


def log_tool_call(tool_name: str, args: dict, result: str, blocked):
    """Log every tool call attempt to the telemetry table for observability."""
    try:
        conn = get_db_conn()
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO telemetry (persona, event_type, module, detail)
                   VALUES (%s, %s, %s, %s)""",
                ("reasoning_agent",
                 "tool_call_blocked" if blocked else "tool_call",
                 tool_name,
                 json.dumps({
                     "args": args,
                     "result_preview": (result or "")[:150],
                     "blocked_reason": blocked,
                 })))
        conn.commit()
        conn.close()
    except Exception:
        pass


# ══════════════════════════════════════════════════════════════════════════════
# NODE 1: Load Learner Context from DB
# ══════════════════════════════════════════════════════════════════════════════

def node_load_learner_context(state: dict) -> dict:
    """Enrich state with the learner's real progress, scores, and history."""
    profile = state.get("profile", {})
    name = profile.get("name", "")
    track = state.get("track", "rtcdp")

    ctx = {
        "completed_modules": [],
        "failed_tests": [],
        "skills": {},
        "last_summary": None,
    }

    if not name:
        extra = dict(state.get("extra", {}))
        ctx["confidence"] = None
        extra["learner_context"] = ctx
        # Explicit rather than relying on run_reasoning's initial-state defaults
        # for these — this early-return path shouldn't silently depend on a
        # caller detail that could change independently of this function.
        return {**state, "extra": extra, "confidence": None,
                "feedback_directive": "", "feedback_stats": {"total": 0}}

    import psycopg2.extras
    try:
        conn = get_db_conn()
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT module_id, module_title, via FROM user_module_progress
                   WHERE member_name=%s AND track=%s ORDER BY module_id""",
                (name, track))
            ctx["completed_modules"] = [
                {"id": r["module_id"], "title": r["module_title"], "via": r["via"]}
                for r in cur.fetchall()]

            cur.execute(
                """SELECT module_id, module_title, score FROM module_test_outs
                   WHERE member_name=%s AND track=%s AND passed=FALSE
                   ORDER BY created_at DESC LIMIT 5""",
                (name, track))
            ctx["failed_tests"] = [
                {"id": r["module_id"], "title": r["module_title"], "score": float(r["score"])}
                for r in cur.fetchall()]

            cur.execute(
                "SELECT skill, level, theta FROM skill_assessments WHERE member_name=%s ORDER BY assessed_at DESC LIMIT 8",
                (name,))
            ctx["skills"] = {
                r["skill"]: {"level": r["level"], "theta": float(r["theta"]) if r["theta"] else None}
                for r in cur.fetchall()}

            cur.execute(
                """SELECT summary FROM session_summaries
                   WHERE user_name=%s AND module=%s ORDER BY created_at DESC LIMIT 1""",
                (name, state.get("module", "")))
            row = cur.fetchone()
            if row:
                ctx["last_summary"] = row["summary"]
        conn.close()
    except Exception:
        pass

    # Authoritative confidence for THIS module drives dynamic checkpoint difficulty.
    # DB first (can't be forged by the client), then the client profile as fallback.
    confidence = None
    try:
        from main import db_get_confidence
        confidence = db_get_confidence(name, state.get("module", ""))
    except Exception:
        confidence = None
    if confidence is None:
        pv = profile.get("conf", profile.get("confidence"))
        try:
            confidence = float(pv) if pv not in (None, "") else None
        except (TypeError, ValueError):
            confidence = None
    ctx["confidence"] = confidence

    extra = dict(state.get("extra", {}))
    extra["learner_context"] = ctx

    feedback = _load_feedback_adaptation(profile)
    return {**state, "extra": extra,
            "confidence": confidence,
            "feedback_directive": feedback["directive"],
            "feedback_stats": feedback["stats"]}


# ══════════════════════════════════════════════════════════════════════════════
# FEEDBACK-DRIVEN ADAPTATION — 👍/👎 changes future answers, statistically
# ══════════════════════════════════════════════════════════════════════════════
# Every persisted reasoning answer already carries rich metadata (grounded,
# tool usage, response length) alongside its 👍/👎 rating. Rather than reacting
# to any single click (noisy, easy to overfit), this correlates the learner's
# WHOLE recent rating history against those existing signals and only speaks up
# when a real pattern emerges — e.g. "answers this learner downvotes are
# consistently longer than the ones they upvote". Nothing here is hardcoded to
# a topic, module, or canned phrase; the directive text is generated from the
# actual computed numbers for THIS learner at call time.

def _fetch_rated_messages(email: str, limit: int = FEEDBACK_LOOKBACK) -> list:
    """Return the learner's most-recent RATED reasoning-mode assistant messages
    as dicts: {feedback, grounded, tool_count, word_count}. [] on any failure or
    if the chat-history tables don't exist yet (fresh install)."""
    if not email:
        return []
    import psycopg2.extras
    try:
        conn = get_db_conn()
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT m.content, m.metadata
                   FROM chat_messages m
                   JOIN chat_conversations c ON c.id = m.conversation_id
                   WHERE LOWER(c.user_email)=%s AND c.mode='reasoning' AND m.role='assistant'
                     AND m.metadata IS NOT NULL AND m.metadata ? 'feedback'
                   ORDER BY m.created_at DESC LIMIT %s""",
                (email.lower(), limit))
            rows = cur.fetchall()
        conn.close()
    except Exception:
        return []

    out = []
    for r in rows:
        md = r.get("metadata") or {}
        fb = md.get("feedback")
        if fb not in ("up", "down"):
            continue
        out.append({
            "feedback":    fb,
            "grounded":    md.get("grounded"),           # True / False / None
            "tool_count":  len(md.get("toolCalls") or md.get("tool_calls") or []),
            "word_count":  len((r.get("content") or "").split()),
        })
    return out


def _analyze_feedback(rated: list) -> dict:
    """Pure function: turn a list of rated-message dicts into a stats summary.
    Split out from _fetch_rated_messages so it's trivially unit-testable with
    synthetic data (no DB) — this is the actual decision logic."""
    ups   = [r for r in rated if r["feedback"] == "up"]
    downs = [r for r in rated if r["feedback"] == "down"]
    total = len(rated)
    if total == 0:
        return {"total": 0}

    def _rate(group, key):
        vals = [g[key] for g in group if g.get(key) is not None]
        return (sum(1 for v in vals if v) / len(vals)) if vals else None

    def _avg(group, key):
        vals = [g[key] for g in group]
        return (sum(vals) / len(vals)) if vals else None

    return {
        "total": total,
        "up_count": len(ups), "down_count": len(downs),
        "down_ratio": len(downs) / total,
        "grounded_rate_up":   _rate(ups, "grounded"),
        "grounded_rate_down": _rate(downs, "grounded"),
        "tool_rate_up":   _rate([{"grounded": r["tool_count"] > 0} for r in ups], "grounded"),
        "tool_rate_down": _rate([{"grounded": r["tool_count"] > 0} for r in downs], "grounded"),
        "avg_len_up":   _avg(ups, "word_count"),
        "avg_len_down": _avg(downs, "word_count"),
    }


def _build_feedback_directive(stats: dict) -> str:
    """Turn a stats summary into a natural-language system-prompt directive.
    Returns "" when the sample is too small or no factor clears the noise
    threshold — silence is the correct behaviour until there's a real signal."""
    if stats.get("total", 0) < FEEDBACK_MIN_SAMPLES:
        return ""

    total, down_ratio = stats["total"], stats["down_ratio"]
    lines = []

    if down_ratio >= FEEDBACK_DOWN_RATIO_THRESHOLD:
        gu, gd = stats["grounded_rate_up"], stats["grounded_rate_down"]
        if gu is not None and gd is not None and (gu - gd) >= FEEDBACK_RATE_GAP:
            lines.append(
                f"This learner rates documentation-grounded answers far better than ungrounded ones "
                f"({gu*100:.0f}% of liked answers were grounded vs {gd*100:.0f}% of disliked ones) — "
                f"always call search_adobe_docs before answering and lean on retrieved content."
            )
        tu, td = stats["tool_rate_up"], stats["tool_rate_down"]
        if tu is not None and td is not None and (tu - td) >= FEEDBACK_RATE_GAP:
            lines.append(
                f"This learner rates tool-assisted answers better ({tu*100:.0f}% vs {td*100:.0f}% used a tool) — "
                f"prefer calling a tool over answering from memory alone."
            )
        lu, ld = stats["avg_len_up"], stats["avg_len_down"]
        if lu is not None and ld is not None and lu > 0 and ld > 0:
            if ld >= lu * FEEDBACK_LEN_RATIO:
                lines.append(
                    f"This learner tends to dislike longer answers (avg {ld:.0f} words disliked vs "
                    f"{lu:.0f} words liked) — keep this response noticeably more concise."
                )
            elif lu >= ld * FEEDBACK_LEN_RATIO:
                lines.append(
                    f"This learner tends to dislike answers that are too short (avg {ld:.0f} words disliked vs "
                    f"{lu:.0f} words liked) — provide more depth and a concrete example."
                )
        if not lines:
            lines.append(
                f"This learner rated {stats['down_count']} of their last {total} answers unhelpful — "
                f"double-check the explanation is clear and directly answers what they asked."
            )
    elif down_ratio <= FEEDBACK_UP_RATIO_THRESHOLD and stats["up_count"] >= FEEDBACK_UP_COUNT_THRESHOLD:
        lines.append("This learner has been rating recent answers positively — keep this explanation style.")

    if not lines:
        return ""
    return "\nLEARNER FEEDBACK PATTERN (from their 👍/👎 history, act on this): " + " ".join(lines) + "\n"


def _load_feedback_adaptation(profile: dict) -> dict:
    """Convenience wrapper: email -> {directive, stats}. Never raises."""
    email = (profile or {}).get("email", "")
    try:
        rated = _fetch_rated_messages(email)
        stats = _analyze_feedback(rated)
        directive = _build_feedback_directive(stats)
        return {"directive": directive, "stats": stats}
    except Exception:
        return {"directive": "", "stats": {"total": 0}}


def get_learner_feedback_insight(email: str) -> dict:
    """Public read-only view of what the feedback-adaptation layer has learned
    about a learner — for a mentor/admin dashboard. Returns the raw stats, the
    plain-English directive currently being injected into that learner's prompts
    (empty string until the pattern clears the noise thresholds), and a short
    human-readable status so the UI needs no knowledge of the internals.

    Never raises — returns an 'unavailable' shape on any failure."""
    try:
        rated = _fetch_rated_messages(email or "")
        stats = _analyze_feedback(rated)
        directive = _build_feedback_directive(stats)
    except Exception:
        return {"email": email, "available": False, "sample_size": 0,
                "directive": "", "status": "unavailable", "stats": {"total": 0}}

    total = stats.get("total", 0)
    if total == 0:
        status = "No rated answers yet — nothing learned."
    elif total < FEEDBACK_MIN_SAMPLES:
        status = (f"Only {total} rated answer(s); need {FEEDBACK_MIN_SAMPLES} "
                  f"before adapting. Not enough signal yet.")
    elif directive:
        status = "Active pattern detected — adapting this learner's answers."
    else:
        status = (f"{total} rated answers, but no consistent pattern above the "
                  f"noise threshold yet. Not adapting.")

    return {
        "email": email,
        "available": True,
        "sample_size": total,
        "up_count": stats.get("up_count", 0),
        "down_count": stats.get("down_count", 0),
        "directive": directive.strip(),
        "adapting": bool(directive),
        "status": status,
        "stats": stats,
    }


# ══════════════════════════════════════════════════════════════════════════════
# NODE 2: Classify Intent (deterministic)
# ══════════════════════════════════════════════════════════════════════════════

# On-topic keywords + grounding terms are now loaded dynamically per active track
# via get_on_topic_keywords() / get_grounding_terms() (see DYNAMIC TRACK CONFIG).

CLARIFICATION_SIGNALS = [
    "don't understand", "dont understand", "what do you mean",
    "confused", "explain again", "not sure", "unclear", "can you clarify",
    "what does that mean", "i'm lost", "im lost",
    "help me understand", "can you explain", "explain this",
    "break it down", "simplify", "rephrase", "say that again",
    "what do you mean by", "not clear", "how does that work",
]
DEEPER_SIGNALS = [
    "more", "deeper", "elaborate", "tell me more", "go on",
    "continue", "what else", "expand", "keep going",
]
STUCK_SIGNALS = [
    "stuck", "don't know", "dont know", "no idea", "help me",
    "just tell me", "give me the answer", "i give up", "i can't",
    "show me", "walk me through",
]

# Words that talk ABOUT the interaction rather than actual domain content —
# excluded so a meta reply like "a substantive answer to the checkpoint"
# can't cheat the overlap check below by matching "checkpoint" itself.
_CHECKPOINT_STOPWORDS = {
    "the", "a", "an", "is", "are", "was", "were", "to", "of", "in", "on", "for",
    "and", "or", "that", "this", "it", "its", "be", "with", "as", "at", "by",
    "from", "your", "you", "i", "we", "they", "he", "she", "what", "which",
    "who", "how", "why", "when", "will", "would", "can", "could", "should",
    "do", "does", "did", "not", "no", "yes", "if", "then", "than", "so", "but",
    "my", "me", "our", "have", "has", "had", "their", "them", "there", "here",
    "about", "into", "just", "really", "answer", "question", "checkpoint",
    "substantive", "reply", "response", "real",
}


def _significant_words(text: str) -> set:
    return {w for w in re.findall(r"[a-zA-Z']+", (text or "").lower())
            if len(w) >= 4 and w not in _CHECKPOINT_STOPWORDS}


def _is_substantive_checkpoint_reply(user_msg: str, last_assistant_msg: str) -> bool:
    """Heuristic: does the learner's reply share domain vocabulary with the
    checkpoint question (or general product terms)? Catches replies that are
    grammatically complete but don't actually engage with the question — the
    exact-phrase vague list (STUCK_SIGNALS etc.) only catches "hmm"/"idk"/etc,
    not a full sentence that simply doesn't address what was asked.
    """
    user_words = _significant_words(user_msg)
    if not user_words:
        return False
    domain_pool = (_significant_words(last_assistant_msg)
                   | {w for w in get_on_topic_keywords() if len(w) >= 4}
                   | {w for w in get_grounding_terms() if len(w) >= 4})
    return bool(user_words & domain_pool)


def node_classify_intent(state: dict) -> dict:
    """Classify the user's latest message into one of 6 intents."""
    messages = state.get("messages", [])
    if not messages:
        return {**state, "intent": "new_question"}

    content = messages[-1].get("content", "")
    user_msg = content.lower() if isinstance(content, str) else ""

    if not user_msg:
        return {**state, "intent": "new_question"}

    last_assistant = ""
    for msg in reversed(messages[:-1]):
        if msg.get("role") == "assistant":
            last_assistant = msg.get("content", "")
            break

    if any(s in user_msg for s in CLARIFICATION_SIGNALS):
        return {**state, "intent": "clarification"}
    if any(s in user_msg for s in STUCK_SIGNALS):
        return {**state, "intent": "stuck"}
    if any(s in user_msg for s in DEEPER_SIGNALS) and len(user_msg.split()) < 12:
        return {**state, "intent": "go_deeper"}

    is_on_topic = any(kw in user_msg for kw in get_on_topic_keywords())

    # Checkpoint-reply detection is checked BEFORE off_topic. A terse or
    # keyword-less reply ("42", a name, a single word) right after the tutor asks
    # a question is overwhelmingly more likely to be an attempted answer than a
    # topic change — so this must win over the keyword-based off_topic check,
    # not the other way around. `.rstrip().endswith("?")` is also more precise
    # than scanning a fixed trailing-character window: the checkpoint is always
    # the LAST sentence by design, so checking the true end of the message can't
    # miss it on a longer answer, and can't be fooled by an earlier rhetorical "?".
    if last_assistant and last_assistant.rstrip().endswith("?") and "?" not in user_msg:
        substantive = _is_substantive_checkpoint_reply(content, last_assistant)
        return {**state, "intent": "checkpoint_response", "checkpoint_substantive": substantive}

    # Now safe to apply off_topic with no word-count exemption: any short reply
    # that was actually answering a checkpoint was already caught above, and
    # short conversational continuations (yes/ok/thanks) are covered by the
    # generic keywords, so nothing legitimate is left to protect with a length
    # floor — a genuinely off-topic 2-3 word message should still be redirected.
    if not is_on_topic:
        return {**state, "intent": "off_topic"}

    return {**state, "intent": "new_question"}


# ══════════════════════════════════════════════════════════════════════════════
# NODE 3: Semantic Document Retrieval
# ══════════════════════════════════════════════════════════════════════════════

def node_retrieve_docs_semantic(state: dict) -> dict:
    """Retrieve relevant Adobe docs using vector similarity search."""
    query = ""
    for msg in reversed(state.get("messages", [])):
        if msg.get("role") == "user":
            content = msg.get("content", "")
            query = content if isinstance(content, str) else ""
            break

    track = state.get("track", "rtcdp")
    docs = []

    if query:
        try:
            results = _vector_search(query, track=track, top_k=VECTOR_SEARCH_TOP_K)
            if results:
                docs = [f"[{r.get('repo','EL')}] {r['title']}: {r['content'][:VECTOR_SEARCH_CONTENT_CHARS]}" for r in results]
        except Exception:
            pass

    if not docs:
        import psycopg2.extras
        try:
            conn = get_db_conn()
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    """SELECT title, chunk_text FROM doc_embeddings
                       WHERE track=%s OR track IS NULL
                       ORDER BY created_at DESC LIMIT %s""", (track, VECTOR_SEARCH_TOP_K))
                docs = [f"{r['title']}: {(r['chunk_text'] or '')[:VECTOR_SEARCH_FALLBACK_CHARS]}"
                        for r in cur.fetchall() if r.get('chunk_text')]
            conn.close()
        except Exception:
            pass

    return {**state, "docs": docs}


# ══════════════════════════════════════════════════════════════════════════════
# NODE 4: Generate with Tool Calling (the core agentic loop)
# ══════════════════════════════════════════════════════════════════════════════

INTENT_INSTRUCTIONS = {
    "new_question": """How to respond:
1. Break the concept into 2-3 clear steps labelled "Step 1:", "Step 2:", "Step 3:"
2. Each step should explain one part of the concept clearly and concisely.
3. Use concrete {track_label} examples from the learner's context.
4. End the response with ONE "Reasoning checkpoint:" — a SINGLE open-ended scenario question in 1-2 sentences, no more. Do NOT turn it into a multiple-choice question — no "A) / B) / C) / D)" option list. The learner must reason through their own answer, not pick from a list you already narrowed down. This is the only question you ask — do not add pause prompts or questions between steps.
5. Keep response under 200 words total (the checkpoint question itself should be well under 40 words).""",

    "checkpoint_response": """The learner just responded to your previous checkpoint or question.
FIRST — Check if their response is vague or non-substantive (e.g. "hmm", "ok", "idk", "maybe", "not sure", "I don't know", single words, or very short phrases that don't actually answer the question). If so:
- Do NOT praise them or say "solid answer". They did not answer.
- Instead, gently rephrase your original question in simpler terms, give a hint or partial example, and ask again. Say something like "Let me rephrase that..." or "Here's a hint to get you started..."
ONLY if they gave a real, substantive answer, structure your response as:
PART 1 — Evaluate their answer (2-3 sentences):
- If correct or mostly correct: confirm what they got right and WHY it matters.
- If partially correct: acknowledge what's right, then explain the missing piece.
- If incorrect: do NOT say "wrong". Gently reframe and explain the correct reasoning.
PART 2 — Follow-up (1 sentence):
- End with exactly ONE follow-up question. Label it "Reasoning checkpoint:". Keep it open-ended — no multiple-choice "A) / B) / C) / D)" options.
Keep total response under 120 words. Never respond with ONLY a question — always explain first.
If they answered well, use update_confidence to record their progress, and log_learning_milestone if they demonstrated clear understanding.""",

    "checkpoint_nonsubstantive": """The learner's reply does not address your checkpoint question at all — it shares no concepts with what you asked.
Do NOT evaluate it as an answer. Do NOT say "correct" or "you identified..." or invent a justification for it — they did not actually answer.
Gently rephrase your original checkpoint question in simpler terms, add a concrete hint or partial example, and ask again. Say something like "Let me rephrase that..." or "Here's a hint to get you started..."
Keep response under 100 words. Do NOT use any tools.""",

    "clarification": """The learner is confused about something you previously explained.
Re-explain using a DIFFERENT analogy, angle, or example. Do not repeat your previous explanation.
Use search_adobe_docs if you need to look up the exact definition or behavior.
Keep response under 100 words. End with: "Does that make more sense now?".""",

    "go_deeper": """The learner wants more depth on the current topic. Expand with:
- Edge cases or gotchas that trip up real consultants
- How this feature interacts with other {track_label} capabilities
- Advanced usage patterns or configuration nuances
Use search_adobe_docs or get_module_content for accurate details.
Keep response under 120 words.""",

    "stuck": """The learner is stuck or frustrated. Switch to worked-example mode:
1. Walk through a complete, concrete {track_label} example step by step.
2. Show your reasoning at each step — explain WHY, not just WHAT.
3. After the example, use generate_practice_question to give them a similar scenario to try.
Be encouraging. Keep response under 150 words.""",

    "off_topic": """The learner asked something unrelated to Adobe Experience Platform, {track_label}, or their learning curriculum.
Politely redirect them. Do NOT answer the off-topic question.
Say something like: "That's an interesting question, but I'm your {track_label} learning assistant! I can help with topics like [suggest 2-3 relevant topics from their current module]. What would you like to explore?"
Keep response under 60 words. Do NOT use any tools.""",
}


def _redact_pii(text: str, profile: dict) -> str:
    """Remove learner-identifying strings (name, email) before the text is sent to
    the third-party LLM. The learner's identity adds nothing to the reasoning and
    should not leave our system. Replaces name/email with the generic 'the learner'
    and drops a 'Name:'/'Email:' line entirely."""
    if not text:
        return text
    out = text
    for field in ("name", "preferred_name", "email"):
        val = (profile or {}).get(field)
        if val and isinstance(val, str) and len(val) >= PII_MIN_LENGTH:
            out = re.sub(re.escape(val), "the learner", out, flags=re.IGNORECASE)
    # Drop explicit "Name: X" / "Email: X" lines that the context builder emits.
    out = re.sub(r"(?im)^\s*(name|email)\s*:.*$", "", out)
    return out


def _difficulty_directive(conf) -> str:
    """Turn a numeric confidence (0–1) into a checkpoint-difficulty instruction.
    Bands are governed by CONF_LOW / CONF_HIGH (env-overridable). Returns "" when
    confidence is unknown, so the agent doesn't guess without data."""
    if conf is None:
        return ""
    try:
        conf = float(conf)
    except (TypeError, ValueError):
        return ""
    if conf < CONF_LOW:
        band, guidance = "LOW", (
            "Keep your Reasoning checkpoint SIMPLE and concrete — test recognition or recall "
            "of a single idea, and include a small hint. Avoid multi-step or edge-case scenarios.")
    elif conf < CONF_HIGH:
        band, guidance = "MODERATE", (
            "Use a STANDARD application-level Reasoning checkpoint — one realistic scenario that "
            "asks the learner to apply the concept once.")
    else:
        band, guidance = "HIGH", (
            "CHALLENGE the learner — make the Reasoning checkpoint harder: an edge case, a trade-off "
            "decision, or a multi-step scenario that combines this concept with a related one.")
    return f"\nLEARNER CONFIDENCE: {conf:.2f} ({band}). {guidance}\n"


def _struggle_directive(lc: dict, profile: dict) -> str:
    """Build a PII-redacted running summary of what this learner struggles with,
    derived from real data (failed test-outs + weak skills). Returns "" if there's
    nothing notable, so a strong learner gets no negative framing."""
    bits = []
    failed = lc.get("failed_tests", []) or []
    if failed:
        bits.append("weaker test-out areas: " + ", ".join(f["title"] for f in failed[:3]))
    weak_skills = [
        k for k, v in (lc.get("skills") or {}).items()
        if (str(v.get("level", "")).lower() in ("beginner", "novice", "developing"))
        or (v.get("theta") is not None and v.get("theta") < 0)]
    if weak_skills:
        bits.append("still-developing skills: " + ", ".join(weak_skills[:4]))
    if not bits:
        return ""
    text = ("This learner has previously struggled with — " + "; ".join(bits) +
            ". Where relevant, connect the new concept back to these areas and reinforce fundamentals.")
    return "\nLEARNER MEMORY (personalize; do not read this aloud): " + _redact_pii(text, profile) + "\n"


def _build_system_prompt(state: dict) -> str:
    """Assemble the full system prompt with learner context and intent instructions."""
    profile = state.get("profile", {}) or {}
    ctx = _redact_pii(state.get("learner_context", "") or "", profile)
    docs = "\n".join(state.get("docs", []))[:CONTEXT_DOCS_CHARS]
    track_label = get_track_label(state.get("track", "rtcdp"))
    intent = state.get("intent", "new_question")

    lc = state.get("extra", {}).get("learner_context", {}) or {}
    history_lines = []
    completed = lc.get("completed_modules", [])
    if completed:
        titles = [c["title"] for c in completed[:CONTEXT_COMPLETED_MODULES_LIMIT]]
        history_lines.append(f"Completed modules: {', '.join(titles)} ({len(completed)} total)")
    failed = lc.get("failed_tests", [])
    if failed:
        fails = [f"{f['title']} ({f['score']:.0f}%)" for f in failed[:CONTEXT_FAILED_TESTS_LIMIT]]
        history_lines.append(f"Failed test-outs (weak areas): {', '.join(fails)}")
    skills = lc.get("skills", {})
    if skills:
        skill_str = ", ".join(f"{k}: {v['level']}" for k, v in list(skills.items())[:CONTEXT_SKILLS_LIMIT])
        history_lines.append(f"Skill levels: {skill_str}")
    last_summary = lc.get("last_summary")
    if last_summary:
        history_lines.append(f"Previous session: {last_summary[:200]}")
    learner_history = "\n".join(history_lines) if history_lines else "No prior history."

    if intent == "checkpoint_response" and not state.get("checkpoint_substantive", True):
        instructions = INTENT_INSTRUCTIONS["checkpoint_nonsubstantive"]
    else:
        instructions = INTENT_INSTRUCTIONS.get(intent, INTENT_INSTRUCTIONS["new_question"])
    instructions = instructions.replace("{track_label}", track_label)
    learner_history = _redact_pii(learner_history, profile)

    # Reflective retry: if a previous attempt failed the quality judge, tell the
    # model exactly what was wrong so it can correct rather than re-roll blindly.
    retry_feedback = state.get("retry_feedback")
    feedback_block = ""
    if retry_feedback:
        feedback_block = (
            f"\nYOUR PREVIOUS ATTEMPT WAS REJECTED for this reason: \"{retry_feedback}\".\n"
            f"Fix that specific problem in this attempt.\n"
        )

    feedback_directive = state.get("feedback_directive", "") or ""
    # Dynamic personalization: checkpoint difficulty (from confidence) + a running
    # memory of what this learner struggles with. Both are data-derived, PII-safe.
    difficulty_directive = _difficulty_directive(state.get("confidence"))
    struggle_directive = _struggle_directive(lc, profile)
    older_summary = state.get("older_summary", "") or ""
    older_block = f"\nEarlier in this conversation: {older_summary}\n" if older_summary else ""

    return f"""You are the Reasoning Agent for Nexus — a step-by-step concept scaffolding assistant for {track_label}.
You BUILD reasoning structure — help learners understand the logical flow of concepts so they can apply them independently.

You have tools available. ALWAYS call search_adobe_docs to ground your answer in official documentation when the learner asks a new concept question. Also use check_learner_progress to personalize your response, and generate_practice_question when the learner asks for practice. Use multiple tools in a single turn when the question warrants it.

{instructions}
{feedback_block}
{feedback_directive}
{difficulty_directive}
{struggle_directive}
{get_product_distinctions()}
{older_block}
Learner context:
{ctx}

Learner history:
{learner_history}

Documentation context:
{docs}"""


def _summarize_older_turns(older_msgs: list) -> str:
    """Compress everything outside the active history window into 2-3 sentences,
    so a long thread loses detail gracefully instead of the older turns just
    disappearing once REASONING_HISTORY_WINDOW is exceeded. Best-effort: returns
    "" on any failure rather than blocking the turn on a summarization call."""
    if not older_msgs:
        return ""
    convo = "\n".join(
        f"{m.get('role', 'user')}: {(m.get('content') if isinstance(m.get('content'), str) else '')[:200]}"
        for m in older_msgs
    )[:4000]
    if not convo.strip():
        return ""
    sys = ("Summarize this earlier part of a 1:1 tutoring conversation in 2-3 factual "
           "sentences: which concepts were covered and what the learner did or didn't "
           "grasp. No meta-commentary, no preamble.")
    try:
        return (groq_call([{"role": "user", "content": convo}], sys, max_tokens=120) or "").strip()
    except Exception:
        return ""


def node_generate_with_tools(state: dict) -> dict:
    """LLM generation with a tool-calling loop.

    The LLM can request tool calls (up to MAX_TOOL_CALLS_PER_TURN). Each call is
    validated against guardrails, executed, and the result fed back to the LLM.
    The loop ends when the LLM produces a text response (no more tool calls).
    Off-topic messages skip tools entirely and short-circuit with a redirect.
    """
    intent = state.get("intent", "new_question")

    if intent == "off_topic":
        track_label = get_track_label(state.get("track", "rtcdp"))
        module = state.get("module", "")
        redirect = (
            f"That's an interesting question, but I'm your {track_label} learning assistant! "
            f"I can help you with topics like schemas, segments, identity resolution, "
            f"and other {track_label} concepts"
            f"{f' in {module}' if module else ''}. "
            f"What would you like to explore?"
        )
        return {**state, "response": redirect, "tool_calls": []}

    nonsubstantive_checkpoint = (intent == "checkpoint_response"
                                  and not state.get("checkpoint_substantive", True))
    active_tools = [] if nonsubstantive_checkpoint else get_tools()

    # Keep only the most recent REASONING_HISTORY_WINDOW messages verbatim for the
    # model; compress anything older into a short summary fed through the system
    # prompt instead of just dropping it (see REASONING_HISTORY_WINDOW comment).
    full_messages = list(state.get("messages", []))
    if len(full_messages) > REASONING_HISTORY_WINDOW:
        older_msgs = full_messages[:-REASONING_HISTORY_WINDOW]
        messages = full_messages[-REASONING_HISTORY_WINDOW:]
        older_summary = _summarize_older_turns(older_msgs)
    else:
        messages = full_messages
        older_summary = ""

    system = _build_system_prompt({**state, "older_summary": older_summary})
    tool_call_log = []
    call_history = []
    final_text = ""
    usage = []              # accumulates Groq usage blocks for token/cost tracking
    models_used = []        # tracks which REASONING_MODEL_CHAIN entry actually answered
    fallback_layer = 0      # 0 = primary path succeeded; 4 = hardcoded text used

    for _iteration in range(MAX_TOOL_CALLS_PER_TURN + 1):
        try:
            resp_msg = _groq_call_with_tools(messages, system, active_tools, max_tokens=600,
                                             usage_sink=usage, model_sink=models_used)
            if resp_msg is None:
                raise RuntimeError("empty response from _groq_call_with_tools")
        except Exception:
            # Layer 1 fallback: retry without tools using cleaned messages.
            fallback_layer = 1
            try:
                clean = [msg for msg in messages
                         if msg.get("role") in ("user", "assistant") and isinstance(msg.get("content"), str)]
                resp_msg = _groq_call_with_tools(clean, system, [], max_tokens=600,
                                                 usage_sink=usage, model_sink=models_used)
                content = resp_msg.get("content") or ""
                if content.strip():
                    final_text = content
            except Exception:
                pass
            break

        content = resp_msg.get("content") or ""
        tool_calls = resp_msg.get("tool_calls") or []

        if content.strip():
            final_text = content
        if not tool_calls:
            break

        # Process each tool call
        messages.append(resp_msg)
        for tc in tool_calls:
            fn = tc.get("function", {})
            tool_name = fn.get("name", "")
            try:
                args = json.loads(fn.get("arguments", "{}"))
            except json.JSONDecodeError:
                args = {}
            call_id = tc.get("id", "")

            violation = validate_tool_call(tool_name, args, call_history, state)
            if violation:
                result = f"BLOCKED: {violation}"
                log_tool_call(tool_name, args, "", violation)
                tool_call_log.append({
                    "tool": tool_name, "args": args,
                    "result": result, "blocked": True})
            else:
                result = execute_tool(tool_name, args, state)
                result = result[:MAX_TOOL_RESULT_CHARS]
                log_tool_call(tool_name, args, result, None)
                tool_call_log.append({
                    "tool": tool_name, "args": args,
                    "result": result, "blocked": False})

            call_history.append({"name": tool_name, "args": args})
            messages.append({
                "role": "tool",
                "tool_call_id": call_id,
                "content": result,
            })

    # Layer 2 fallback: force text with a no-tools call over cleaned messages.
    if not final_text.strip():
        fallback_layer = max(fallback_layer, 2)
        try:
            clean_msgs = [msg for msg in messages
                          if msg.get("role") in ("user", "assistant") and isinstance(msg.get("content"), str)]
            no_tool_resp = _groq_call_with_tools(clean_msgs, system, [], max_tokens=600,
                                                 usage_sink=usage, model_sink=models_used)
            final_text = (no_tool_resp.get("content") or "").strip()
        except Exception:
            pass

    # Layer 3 fallback: shared simple groq_call (GROQ_MODEL is fine for non-tool calls).
    if not final_text.strip():
        fallback_layer = max(fallback_layer, 3)
        try:
            user_msgs = [msg for msg in state.get("messages", [])
                         if msg.get("role") in ("user", "assistant") and isinstance(msg.get("content"), str)]
            final_text = groq_call(user_msgs, system, max_tokens=600) or ""
        except Exception:
            pass

    # Layer 4 fallback: hardcoded intent-aware text. Reaching here means every LLM
    # call failed — the response is NOT model-generated, so mark the turn degraded.
    degraded = False
    if not final_text.strip():
        degraded = True
        fallback_layer = 4
        if intent == "checkpoint_response":
            final_text = (
                "Let me rephrase that to help you think through it. "
                "Take a moment to consider what we discussed — think about the key concepts "
                "and how they connect. What aspect would you like me to clarify?"
            )
        else:
            final_text = (
                "Let me help you with that. In Adobe Experience Platform, this relates to how data is "
                "unified and managed across your customer profiles. Could you tell me which specific aspect "
                "you'd like to explore — schemas, identity resolution, segments, or merge policies?"
            )

    tok_in = sum(u.get("prompt_tokens", 0) for u in usage)
    tok_out = sum(u.get("completion_tokens", 0) for u in usage)
    # Which model actually produced final_text — the last successful entry in the
    # chain (models_used), or GROQ_MODEL if only the layer-3 shared-call fallback
    # answered, or "" if every model failed and layer-4 hardcoded text was used.
    if models_used:
        model_used = models_used[-1]
    elif fallback_layer == 3 and not degraded:
        model_used = GROQ_MODEL
    else:
        model_used = ""
    return {**state, "response": final_text, "tool_calls": tool_call_log,
            "degraded": degraded, "fallback_layer": fallback_layer,
            "tokens_in": tok_in, "tokens_out": tok_out, "model_used": model_used}


# ══════════════════════════════════════════════════════════════════════════════
# NODE 5: Intent-Aware Quality Judge + Guardrail Logging
# ══════════════════════════════════════════════════════════════════════════════

# Product terminology for the grounding check is loaded dynamically per track via
# get_grounding_terms() (see DYNAMIC TRACK CONFIG near the top of this file).

def node_reasoning_judge(state: dict) -> dict:
    """Intent-aware quality validation with guardrail logging."""
    resp = state.get("response", "")
    intent = state.get("intent", "new_question")
    quality_ok = False
    quality_score = 0
    issue = None

    if intent == "off_topic":
        return {**state, "quality_ok": True,
                "quality_score": 10, "quality_issue": "off_topic_redirect"}

    word_count = len(resp.split())
    if not resp or word_count < QUALITY_MIN_WORDS:
        return {**state, "quality_ok": False,
                "quality_score": 1, "quality_issue": f"Response too short (minimum {QUALITY_MIN_WORDS} words)"}

    if word_count > QUALITY_MAX_WORDS:
        return {**state, "quality_ok": False,
                "quality_score": 3, "quality_issue": f"Response too long (maximum {QUALITY_MAX_WORDS} words)"}

    if intent == "new_question":
        # Accept any reasonable step-structure phrasing, not just the literal
        # "step 1" — a genuinely well-structured answer using "First," / "1)" /
        # "Next," was previously scored as unstructured and sent through a
        # wasted retry for a phrasing difference, not a real quality problem.
        resp_lower = resp.lower()
        has_steps = bool(
            "step 1" in resp_lower
            or re.search(rf"\b(first|1[.)])\b.{{0,{STEP_STRUCTURE_WINDOW}}}\b(second|next|2[.)])\b",
                          resp_lower, re.DOTALL)
        )
        has_checkpoint = ("checkpoint" in resp_lower
                         or "what do you think" in resp_lower
                         or resp.rstrip().endswith("?"))
        # Backstop for the "no multiple-choice checkpoint" instruction — a model
        # can still ignore prompt wording, so catch an A)/B)/C)/D)-style option
        # list here and force a retry rather than relying on instructions alone.
        is_mcq_checkpoint = bool(re.search(r"(?:^|\n)\s*[a-d][\.)]\s+\S", resp, re.IGNORECASE | re.MULTILINE))
        if is_mcq_checkpoint:
            quality_score, issue = 4, "Checkpoint must be open-ended, not multiple-choice"
        elif has_steps and has_checkpoint:
            quality_ok, quality_score = True, 9
        elif has_steps or has_checkpoint:
            quality_ok, quality_score, issue = True, 6, "Missing steps or checkpoint"
        else:
            quality_score, issue = 3, "No step structure and no checkpoint question"

    elif intent == "checkpoint_response":
        eval_words = ["correct", "right", "close", "not quite", "consider",
                      "think about", "however", "good", "exactly", "almost",
                      "yes", "partially", "key thing", "missing", "notice"]
        has_eval = any(w in resp.lower() for w in eval_words)
        ends_q = resp.rstrip().endswith("?")
        if has_eval and ends_q:
            quality_ok, quality_score = True, 9
        elif has_eval:
            quality_ok, quality_score = True, 7
        else:
            quality_score, issue = 4, "Didn't evaluate the learner's answer"

    elif intent == "stuck":
        example_words = ["example", "scenario", "suppose", "imagine", "let's say",
                         "consider a", "walk through", "here's how", "step 1"]
        if any(w in resp.lower() for w in example_words):
            quality_ok, quality_score = True, 8
        else:
            quality_score, issue = 4, "No worked example for stuck learner"

    else:
        quality_ok = word_count > QUALITY_FALLBACK_MIN_WORDS
        quality_score = 7 if quality_ok else 3
        if not quality_ok:
            issue = f"Response too shallow (minimum {QUALITY_FALLBACK_MIN_WORDS} words for this intent)"

    if intent in ("new_question", "go_deeper"):
        if not any(t in resp.lower() for t in get_grounding_terms(state.get("track"))):
            quality_score = max(quality_score - 2, 1)
            issue = (issue or "") + "; No product-specific terminology"

    # Faithfulness / grounding: for concept answers, did retrieval actually supply
    # docs, and does the answer share vocabulary with them? If docs were retrieved
    # but the answer ignores them, the answer is likely ungrounded (parametric).
    grounded = None  # None = grounding not applicable for this intent
    if intent in ("new_question", "go_deeper", "clarification"):
        docs_text = " ".join(state.get("docs", []) or [])
        if docs_text.strip():
            doc_terms = _significant_words(docs_text)
            resp_terms = _significant_words(resp)
            overlap = doc_terms & resp_terms
            # A flat "≥2 shared words" bar let two incidental common domain terms
            # (e.g. "segment" and "profile") mark an otherwise-hallucinated answer
            # as grounded. Scale the bar with how much doc vocabulary there was to
            # draw on, with a slightly higher floor, so passing actually requires
            # meaningfully engaging with the retrieved content.
            min_overlap = max(GROUNDING_MIN_OVERLAP, round(len(doc_terms) * GROUNDING_DOC_RATIO))
            grounded = len(overlap) >= min_overlap
            if not grounded:
                issue = (issue or "") + "; Answer not grounded in retrieved docs"
        else:
            grounded = False  # no docs available at all → answer is ungrounded

    # Log guardrail
    try:
        conn = get_db_conn()
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO guardrail_logs
                   (agent_name, score, issue, response_preview, word_count, has_one_question, avoids_direct_answer)
                   VALUES (%s,%s,%s,%s,%s,NULL,NULL)""",
                ("reasoning", quality_score, issue, resp[:100], word_count))
        conn.commit()
        conn.close()
    except Exception:
        pass

    return {**state, "quality_ok": quality_ok,
            "quality_score": quality_score, "quality_issue": issue,
            "grounded": grounded}


# ══════════════════════════════════════════════════════════════════════════════
# Retry control
# ══════════════════════════════════════════════════════════════════════════════

def node_increment_retry(state: dict) -> dict:
    # Carry the judge's rejection reason into the next generation so the retry is
    # reflective (fixes the specific problem) rather than a blind re-roll.
    return {**state, "retries": state.get("retries", 0) + 1,
            "retry_feedback": state.get("quality_issue")}


def _should_retry(state: dict) -> str:
    if state.get("quality_ok"):
        return "end"
    if state.get("retries", 0) >= MAX_RETRIES:
        return "end"
    deadline = state.get("_deadline")
    if deadline is not None and time.time() >= deadline:
        return "end"
    return "retry"


# ══════════════════════════════════════════════════════════════════════════════
# Graph Builder
# ══════════════════════════════════════════════════════════════════════════════

def build_reasoning_graph():
    """Compile the Reasoning Agent StateGraph with tool calling.

    Flow: load_context → classify → retrieve → generate → judge → [retry up to 2x] → done
    """
    if not LANGGRAPH_AVAILABLE:
        return None
    g = StateGraph(dict)
    g.add_node("load_context", node_load_learner_context)
    g.add_node("classify",     node_classify_intent)
    g.add_node("retrieve",     node_retrieve_docs_semantic)
    g.add_node("generate",     node_generate_with_tools)
    g.add_node("judge",        node_reasoning_judge)
    g.add_node("retry_bump",   node_increment_retry)
    g.set_entry_point("load_context")
    g.add_edge("load_context", "classify")
    g.add_edge("classify", "retrieve")
    g.add_edge("retrieve", "generate")
    g.add_edge("generate", "judge")
    g.add_conditional_edges("judge", _should_retry,
                            {"retry": "retry_bump", "end": END})
    g.add_edge("retry_bump", "generate")
    return g.compile()


# ══════════════════════════════════════════════════════════════════════════════
# Callable entry point
# ══════════════════════════════════════════════════════════════════════════════

def run_reasoning(question: str, context: dict = None, graph=None) -> dict:
    """
    Run the reasoning tutor over a conversation.

    Args:
        question: the learner's latest message (used to seed messages if absent)
        context:  {messages, profile, learner_context, track, module, extra}
        graph:    compiled LangGraph graph (optional)

    Returns:
        {response, intent, quality_ok, quality_score, quality_issue,
         retries, tool_calls, meta}
    """
    set_current_agent("Reasoning")
    start = time.time()
    context = context or {}
    request_id = context.get("request_id") or uuid.uuid4().hex[:12]

    messages = context.get("messages") or []
    if not messages and question:
        messages = [{"role": "user", "content": question}]

    # Input safety gate — this agent has its own tool-calling loop
    # (_groq_call_with_tools) that never went through call_with_tools/llm_call,
    # so it was the one agent with no injection/unsafe-content check at all.
    # Checked here, before any model or tool call, same as every other agent.
    blocked = check_input_guardrail(messages, agent="reasoning")
    if blocked:
        return {
            "response": blocked, "intent": "blocked", "quality_ok": True,
            "quality_score": 0, "quality_issue": None, "retries": 0,
            "tool_calls": [], "degraded": False, "grounded": None,
            "request_id": request_id,
            "meta": make_meta("reasoning", REASONING_TOOL_MODEL, start, {
                "engine": "guardrail", "steps_executed": 0, "intent": "blocked",
                "model_chain": REASONING_MODEL_CHAIN, "model_used": "",
                "tokens_in": 0, "tokens_out": 0, "total_tokens": 0, "est_cost_usd": 0,
                "request_id": request_id,
            }),
        }

    state = {
        "messages":         messages,
        "profile":          context.get("profile", {}),
        "learner_context":  context.get("learner_context", ""),
        "track":            context.get("track", "rtcdp"),
        "module":           context.get("module", ""),
        "extra":            context.get("extra", {}),
        "docs":             [],
        "response":         "",
        "quality_ok":       False,
        "quality_score":    0,
        "quality_issue":    None,
        "intent":           "",
        "retries":          0,
        "tool_calls":       [],
        "degraded":         False,
        "grounded":         None,
        "tokens_in":        0,
        "tokens_out":       0,
        "confidence":       None,
        "feedback_directive": "",
        "feedback_stats":     {"total": 0},
        "_deadline":        start + REASONING_TIME_BUDGET_SEC,
    }

    final = None
    if graph is not None:
        try:
            final = graph.invoke(state)
        except Exception as e:
            print(f"[reasoning] graph error: {e}, running inline")
            graph = None

    if graph is None:
        # Sequential fallback with manual retry loop.
        s = node_load_learner_context(state)
        s = node_classify_intent(s)
        s = node_retrieve_docs_semantic(s)
        s = node_generate_with_tools(s)
        s = node_reasoning_judge(s)
        while _should_retry(s) == "retry":
            s = node_increment_retry(s)
            s = node_generate_with_tools(s)
            s = node_reasoning_judge(s)
        final = s

    raw_tool_calls = final.get("tool_calls") or []
    tool_calls = [
        {"tool": tc.get("tool", ""), "blocked": bool(tc.get("blocked"))}
        for tc in raw_tool_calls
    ]

    # RAGAS scoring against whatever real grounding was used — the semantically
    # pre-retrieved docs (node_retrieve_docs_semantic) plus any successful
    # search_adobe_docs/get_module_content tool results. Fire-and-forget, only
    # meaningful when something was actually retrieved (an off-topic/blocked/
    # pure-reasoning turn with no grounding correctly logs nothing, same as
    # rag.py skipping an empty run).
    doc_contexts = [d.get("content", "") for d in (final.get("docs") or []) if isinstance(d, dict)]
    tool_contexts = [
        tc.get("result", "") for tc in raw_tool_calls
        if tc.get("tool") in ("search_adobe_docs", "get_module_content")
        and not tc.get("blocked") and tc.get("result")
    ]
    ragas_contexts = [c for c in (doc_contexts + tool_contexts) if c]
    if ragas_contexts and final.get("response"):
        try:
            latest_q = next((m.get("content", "") for m in reversed(messages) if m.get("role") == "user"), question)
            evaluate_and_log("reasoning", latest_q, final.get("response", ""), ragas_contexts)
        except Exception:
            pass

    # Output guardrail — previously defined (guardrails/output_guardrails.py)
    # but never called by any agent. Reasoning answers are short scaffolding
    # questions/explanations, not cited RAG answers, so expect_citations=False;
    # this still catches an empty/too-short/vague-refusal response that
    # node_reasoning_judge's own heuristics don't check for. Skipped for the
    # layer-4 hardcoded fallback text (already known-safe boilerplate used only
    # when every LLM call failed) and left as annotate-only — this graph has no
    # remaining retry budget by the time this runs.
    if not final.get("degraded") and final.get("response"):
        try:
            verdict = check_output(final["response"], agent="reasoning", expect_citations=False, min_words=4)
            final["response"] = verdict["answer"]
        except Exception:
            pass

    tokens_in = final.get("tokens_in", 0)
    tokens_out = final.get("tokens_out", 0)
    total_tokens = tokens_in + tokens_out
    est_cost = round(total_tokens / 1_000_000 * REASONING_COST_PER_1M_TOKENS, 6)
    latency_ms = round((time.time() - start) * 1000)
    degraded = bool(final.get("degraded", False))
    grounded = final.get("grounded")

    feedback_stats = final.get("feedback_stats", {}) or {}
    feedback_applied = bool(final.get("feedback_directive"))
    confidence = final.get("confidence")
    lc_final = final.get("extra", {}).get("learner_context", {}) or {}
    difficulty_text = _difficulty_directive(confidence).strip()
    struggle_text = _struggle_directive(lc_final, final.get("profile", {}) or {}).strip()

    # Structured, greppable log line (correlation id ties nodes → one request).
    print(json.dumps({
        "evt": "reasoning_done", "rid": request_id,
        "intent": final.get("intent", ""), "retries": final.get("retries", 0),
        "quality_score": final.get("quality_score", 0),
        "degraded": degraded, "grounded": grounded,
        "tool_calls": len(tool_calls),
        "blocked": sum(1 for t in tool_calls if t["blocked"]),
        "tokens": total_tokens, "cost_usd": est_cost, "latency_ms": latency_ms,
        "feedback_adaptation_applied": feedback_applied,
        "feedback_sample_size": feedback_stats.get("total", 0),
        "confidence": confidence,
        "checkpoint_difficulty_applied": bool(difficulty_text),
        "struggle_memory_applied": bool(struggle_text),
    }))

    return {
        "response":       final.get("response", ""),
        "intent":         final.get("intent", ""),
        "quality_ok":     final.get("quality_ok", False),
        "quality_score":  final.get("quality_score", 0),
        "quality_issue":  final.get("quality_issue"),
        "retries":        final.get("retries", 0),
        "tool_calls":     tool_calls,
        "degraded":       degraded,
        "grounded":       grounded,
        "request_id":     request_id,
        "meta": make_meta("reasoning", final.get("model_used") or REASONING_TOOL_MODEL, start, {
            "engine":         "langgraph" if LANGGRAPH_AVAILABLE else "sequential",
            "steps_executed": 5 + final.get("retries", 0),
            "intent":         final.get("intent", ""),
            # Which model in REASONING_MODEL_CHAIN actually answered vs. the full
            # configured chain — lets multi-model resiliency be verified directly
            # from the API response (e.g. in the browser Network tab) instead of
            # only from server logs.
            "model_chain":    REASONING_MODEL_CHAIN,
            "model_used":     final.get("model_used") or "",
            "tokens_in":      tokens_in,
            "tokens_out":     tokens_out,
            "total_tokens":   total_tokens,
            "est_cost_usd":   est_cost,
            "request_id":     request_id,
            # Feedback-driven adaptation — visible here so it can be verified from
            # the browser Network tab without needing direct DB access.
            "feedback_adaptation_applied": feedback_applied,
            "feedback_adaptation_stats":   feedback_stats,
            "feedback_adaptation_text":    final.get("feedback_directive", ""),
            # Tier-2 dynamic personalization — also surfaced for UI verification.
            "track_label":                 get_track_label(final.get("track", context.get("track", "rtcdp"))),
            "confidence":                  confidence,
            "checkpoint_difficulty_text":  difficulty_text,
            "struggle_memory_text":        struggle_text,
        }),
    }


# ══════════════════════════════════════════════════════════════════════════════
# STREAMING — word-by-word delivery of the *vetted* answer (ChatGPT-style typing)
# ══════════════════════════════════════════════════════════════════════════════
# This agent is agentic: the answer must clear the quality judge (and a possible
# retry) before it is safe to show a learner. Streaming raw model tokens would
# expose drafts that can still be rejected/retried. So we run the full vetted
# pipeline first, then stream the APPROVED text word-by-word — preserving every
# guardrail while giving the responsive typing effect. A "status" event is emitted
# immediately so the UI shows a thinking indicator during the (unavoidable) think.

# Seconds to pause between streamed words — small, tunable typewriter cadence.
REASONING_STREAM_DELAY = float(os.getenv("REASONING_STREAM_DELAY_MS", "12")) / 1000.0


def stream_reasoning(question: str, context: dict = None, graph=None):
    """Generator of streaming events for the reasoning agent.

    Yields dicts (the HTTP layer serialises them as SSE):
      {"type": "status", "stage": "thinking"}       — emitted immediately
      {"type": "token",  "text": "<word+space>"}    — one per word of the answer
      {"type": "done",   ...full metadata...}        — intent, tool_calls, degraded,
                                                        grounded, quality, meta, etc.
    On failure yields {"type": "error", "detail": "..."} then a terminal "done".
    """
    # Immediate feedback so the client can render a thinking indicator right away,
    # before the (blocking) pipeline below produces the vetted answer.
    yield {"type": "status", "stage": "thinking"}

    try:
        result = run_reasoning(question, context, graph=graph)
    except Exception as e:
        yield {"type": "error", "detail": str(e)}
        yield {"type": "done", "response": "", "intent": "", "quality_ok": False,
               "quality_score": 0, "quality_issue": None, "retries": 0,
               "tool_calls": [], "degraded": True, "grounded": None,
               "request_id": (context or {}).get("request_id", ""), "meta": {}}
        return

    text = result.get("response", "") or ""
    # Split into words while KEEPING trailing whitespace, so re-joined tokens
    # reproduce the answer exactly (including newlines).
    for chunk in re.findall(r"\S+\s*|\s+", text):
        yield {"type": "token", "text": chunk}
        if REASONING_STREAM_DELAY > 0:
            time.sleep(REASONING_STREAM_DELAY)

    # Terminal event carries everything the non-streaming endpoint returned,
    # so the client can attach chips (intent/tools/degraded/grounded) + persist.
    done = dict(result)
    done["type"] = "done"
    yield done
