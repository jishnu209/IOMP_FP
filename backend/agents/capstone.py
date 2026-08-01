"""
capstone.py — Capstone Agent (LangGraph)
=========================================
Generates a real, hands-on capstone assessment that is SPECIFIC to the learning
path the learner just finished, and covers ALL of that path's modules.

Triggered when: allModulesDone AND confidence >= CAPSTONE_CONFIDENCE_GATE.

Pipeline (LangGraph, with a sequential fallback when LangGraph is unavailable):
  1. fetch_state      — completed modules + per-module confidence from the DB
  2. select_context   — industry vertical + fictional company for the scenario
  3. retrieve         — RAG-ground the brief in the track's real AEP docs
  4. generate         — a tiered capstone (basic → intermediate → expert) whose
                        tasks collectively exercise every module in the path,
                        shaped by a track-specific BLUEPRINT (see below)
  5. rubric           — a human-evaluation rubric (this is human-graded)
  6. validate         — sanity-check the tasks reference real AEP capabilities

Every LLM call goes through llm_call (Groq → Anthropic failover) so a rate-
limited or unconfigured provider degrades gracefully instead of dead-ending.
"""

from .config import (
    set_current_agent,
    GROQ_MODEL, ANTHROPIC_MODEL,
    groq_call, anthropic_call, llm_call, get_db_url, make_meta,
    parse_json_lenient, PRODUCT_DISTINCTIONS, call_with_tools, run_with_timeout,
)
from evaluation import evaluate_and_log, extract_tool_contexts, summarize_for_ragas

import os
import json
import time
import random

try:
    from langgraph.graph import StateGraph, END
    LANGGRAPH_AVAILABLE = True
except ImportError:
    LANGGRAPH_AVAILABLE = False

# Optional shared RAG (grounds the scenario in real Adobe docs when available).
try:
    from . import rag as shared_rag
    _RAG_AVAILABLE = True
except Exception:
    _RAG_AVAILABLE = False


VERTICALS = [
    "Banking & Financial Services",
    "Retail & E-Commerce",
    "Healthcare & Life Sciences",
    "Travel & Hospitality",
    "Telecommunications",
    "Media & Entertainment",
]

_COMPANY_MAP = {
    "Banking & Financial Services": "Pacific National Bank",
    "Retail & E-Commerce":          "NovaMart Retail Group",
    "Healthcare & Life Sciences":   "Meridian Health Systems",
    "Travel & Hospitality":         "SkyPath Travel & Resorts",
    "Telecommunications":           "ConnectEdge Telecom",
    "Media & Entertainment":        "Luminary Media Group",
}

# ── Per-track capstone blueprints ─────────────────────────────────────────────
# Each blueprint is a concrete scaffold describing the SHAPE of a realistic
# capstone for that team — the deliverables a practitioner on that path would
# actually be asked to produce. The `rtcdp` blueprint is modeled directly on the
# real CDP capstone example provided by the business. These steer the LLM so the
# generated tasks are concrete and job-relevant (not vague), and also seed the
# offline fallback so a learner still gets a real capstone if the LLM is down.
CAPSTONE_BLUEPRINTS = {
    "rtcdp": {
        "name": "Real-Time CDP",
        "focus": "Build audiences from PII (CRM) + non-PII (web activity), configure destinations, and present the end-to-end ingestion→activation story.",
        "hands_on": [
            "Create 5–10 segments (simple → complex) combining PII (CRM) and non-PII (website activity): cart abandoners (web-activity triggers), website profiles (browsing + CRM), upsell (CRM attributes), and suppression of converted audiences (completion event triggers).",
            "Configure a Data Landing Zone destination in AEP.",
            "Set up export mappings for 2–3 segments keyed on the attributes needed for a personalized email.",
            "Set up a 12-hour-cadence export for one chosen segment.",
        ],
        "deck": [
            "Segmentation types and key differences",
            "End-to-end workflow: ingestion → activation (diagram), aligned to one industry use case",
            "Streaming source → streaming segmentation → streaming activation",
            "Batch source → batch segmentation → batch activation",
            "Profile snapshot and its importance in AEP (including for activation)",
            "Facebook destination slide (prerequisites + config requirements)",
            "Key guardrails for segmentation and activation",
            "Profile qualification debugging",
        ],
    },
    "aep": {
        "name": "AEP / Data Architecture",
        "focus": "Design the schema, identity, and governance foundation of an AEP implementation.",
        "hands_on": [
            "Design XDM schemas (profile + event) with correct field groups and identity fields.",
            "Define identity namespaces and a primary identity strategy.",
            "Configure datasets, enable them for Profile, and set merge policies.",
            "Apply data governance labels (DULE) and a sandbox promotion strategy.",
        ],
        "deck": [
            "Schema design decisions and field-group reuse",
            "Identity graph and identity resolution approach",
            "Merge policies and profile stitching",
            "Data governance (DULE) and consent enforcement",
            "Sandbox strategy: dev → stage → prod promotion",
            "Key guardrails and common schema/identity pitfalls",
        ],
    },
    "de": {
        "name": "Data Engineering",
        "focus": "Build and operate the ingestion pipelines that feed AEP.",
        "hands_on": [
            "Configure a batch source connector and a streaming HTTP ingestion endpoint.",
            "Build Data Prep mappings (including a computed/derived field).",
            "Write Query Service queries against the data lake and schedule one.",
            "Set up ingestion monitoring + a data-quality validation check.",
        ],
        "deck": [
            "Pipeline architecture: streaming vs batch ingestion",
            "Data Prep mapping and transformation strategy",
            "Query Service + Accelerated Store use",
            "Monitoring, alerting, and data-quality guardrails",
            "Error handling and reprocessing strategy",
        ],
    },
    "aa-sdk": {
        "name": "Web SDK Analytics",
        "focus": "Implement first-party data collection via Web SDK and route it to Analytics/CJA and AEP.",
        "hands_on": [
            "Configure a datastream and implement Web SDK (sendEvent) with an XDM event schema.",
            "Set the identity map (ECID + a hashed authenticated identity) and wire consent.",
            "Forward events to Adobe Analytics / CJA and to AEP via the datastream.",
            "Validate collection with the debugger and fix an identity/consent misconfiguration.",
        ],
        "deck": [
            "Tag + datastream architecture (Web SDK vs legacy AppMeasurement)",
            "XDM event schema and data elements",
            "Identity (ECID + authenticated) and consent handling",
            "Event forwarding and server-side routing",
            "Debugging collection + key guardrails",
        ],
    },
    "analytics": {
        "name": "Adobe Analytics",
        "focus": "Design a measurement plan and analysis in Analysis Workspace / CJA.",
        "hands_on": [
            "Design a measurement plan mapping business questions to eVars/props/events.",
            "Build report suites / data views with calculated metrics and segments.",
            "Build an Analysis Workspace project answering 3 real business questions.",
            "Apply an attribution model and validate the numbers.",
        ],
        "deck": [
            "Measurement plan and variable map",
            "Segmentation and calculated-metric design",
            "Attribution IQ model choice and rationale",
            "Analysis Workspace project walkthrough",
            "Data governance and key guardrails",
        ],
    },
    "cja": {
        "name": "Customer Journey Analytics",
        "focus": "Stitch cross-channel data and analyze journeys in CJA.",
        "hands_on": [
            "Create connections and data views over AEP datasets.",
            "Configure cross-channel stitching and person-ID.",
            "Build calculated metrics and a cross-channel Workspace project.",
            "Apply an attribution model across channels.",
        ],
        "deck": [
            "Connection + data view design",
            "Cross-channel stitching approach",
            "Attribution across channels",
            "Governance and key guardrails",
        ],
    },
    "ajo": {
        "name": "Adobe Journey Optimizer",
        "focus": "Design and orchestrate a real-time, cross-channel customer journey.",
        "hands_on": [
            "Design a journey with an entry event, wait/condition nodes, and email + push messages.",
            "Configure decisioning/offers and a personalization expression.",
            "Set frequency capping and a suppression audience.",
            "Test end-to-end with a flagged test profile (dry run).",
        ],
        "deck": [
            "Journey architecture (entry events, orchestration)",
            "Channel strategy: email / push / SMS / in-app",
            "Decisioning + offers + personalization",
            "Frequency capping, suppression, and consent guardrails",
            "Journey testing and debugging",
        ],
    },
    "campaign": {
        "name": "Adobe Campaign (ACC)",
        "focus": "Build and deliver a targeted campaign with Adobe Campaign.",
        "hands_on": [
            "Build a targeting workflow (query → segmentation → deduplication).",
            "Design a personalized email delivery with typology rules.",
            "Configure a recurring/triggered delivery and approval flow.",
            "Set pressure/typology rules and validate deliverability.",
        ],
        "deck": [
            "Campaign architecture and targeting workflow",
            "Delivery + personalization design",
            "Typology rules and pressure management",
            "Deliverability and key guardrails",
        ],
    },
}
# Aliases so track codes map onto a blueprint even when named differently.
CAPSTONE_BLUEPRINTS["da"]      = CAPSTONE_BLUEPRINTS["aep"]
CAPSTONE_BLUEPRINTS["acc"]     = CAPSTONE_BLUEPRINTS["campaign"]
CAPSTONE_BLUEPRINTS["marketo"] = CAPSTONE_BLUEPRINTS["campaign"]


def _blueprint_for(track: str) -> dict:
    t = (track or "rtcdp").lower().strip().replace(" ", "-")
    return CAPSTONE_BLUEPRINTS.get(t) or CAPSTONE_BLUEPRINTS["rtcdp"]


# ── Node 1: fetch learner state ───────────────────────────────────────────────

def node_fetch_state(state: dict) -> dict:
    try:
        import psycopg2
        import psycopg2.extras
        conn    = psycopg2.connect(get_db_url())
        learner = state.get("learner_name", "")
        track   = state.get("track", "rtcdp")
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as c:
            c.execute(
                "SELECT module_id, score FROM confidence_scores WHERE member_name=%s ORDER BY score ASC",
                (learner,))
            conf_rows = [dict(r) for r in c.fetchall()]
            c.execute(
                "SELECT DISTINCT module_id FROM user_module_progress WHERE member_name=%s AND track=%s AND status='done'",
                (learner, track))
            done_modules = [r["module_id"] for r in c.fetchall()]
            # All module titles for the track — the capstone must cover ALL of them.
            all_titles = list(state.get("all_module_titles") or [])
            if not all_titles:
                try:
                    c.execute(
                        "SELECT DISTINCT module_id, title FROM curriculum_topics WHERE track=%s ORDER BY module_id",
                        (track,))
                    seen, all_titles = set(), []
                    for r in c.fetchall():
                        mt = (r["title"] or "").split(":")[0].strip()
                        if mt and mt not in seen:
                            seen.add(mt); all_titles.append(mt)
                except Exception:
                    pass
        conn.close()
        return {**state, "conf_rows": conf_rows, "done_modules": done_modules,
                "weakest_modules": [r["module_id"] for r in conf_rows[:2]],
                "all_module_titles": all_titles}
    except Exception as e:
        print(f"[capstone] fetch_state warning: {e}")
        return {**state,
                "conf_rows": state.get("conf_rows", []),
                "done_modules": state.get("done_modules", []),
                "weakest_modules": state.get("weakest_modules", []),
                "all_module_titles": state.get("all_module_titles", [])}


# ── Node 2: select vertical / company ─────────────────────────────────────────

def node_select_context(state: dict) -> dict:
    team = (state.get("team_context", "") or "").lower()
    vmap = {"bank": "Banking & Financial Services", "fsi": "Banking & Financial Services",
            "fina": "Banking & Financial Services", "retai": "Retail & E-Commerce",
            "ecomm": "Retail & E-Commerce", "health": "Healthcare & Life Sciences",
            "pharma": "Healthcare & Life Sciences", "travel": "Travel & Hospitality",
            "hotel": "Travel & Hospitality", "telco": "Telecommunications",
            "media": "Media & Entertainment"}
    vertical = next((v for k, v in vmap.items() if k in team), None) or random.choice(VERTICALS)
    return {**state, "vertical": vertical, "company": _COMPANY_MAP.get(vertical, "Acme Corporation")}


# ── Node 3: RAG grounding ─────────────────────────────────────────────────────

def node_retrieve(state: dict) -> dict:
    if not _RAG_AVAILABLE:
        return {**state, "rag_context": "", "rag_sources": []}
    try:
        bp = _blueprint_for(state.get("track", "rtcdp"))
        query = f"{bp['name']} {bp['focus']}"
        # NOTE: shared_rag.retrieve()'s real signature takes `top_k`, not `k` —
        # the previous `k=4` silently raised TypeError on every call (caught by
        # the except below), so this grounding step had ALWAYS returned empty.
        # Hard-timed: a cold embedding-model load or degraded vector store can
        # otherwise hang this call indefinitely (same failure mode found and
        # fixed for the quiz engine's grounding step).
        docs = run_with_timeout(
            shared_rag.retrieve, query, track=state.get("track", "rtcdp"), top_k=4,
            timeout=8.0, default=[], on_timeout_log="capstone RAG retrieve",
        ) if hasattr(shared_rag, "retrieve") else []
        docs = docs or []
        ctx = "\n\n".join(f"[{d.get('title','doc')}] {str(d.get('content',''))[:600]}" for d in docs[:4])
        return {**state, "rag_context": ctx, "rag_sources": [d.get("title", "") for d in docs[:4]]}
    except Exception as e:
        print(f"[capstone] retrieve warning: {e}")
        return {**state, "rag_context": "", "rag_sources": []}


# ── Node 4: generate the tiered capstone ──────────────────────────────────────

CAPSTONE_SYSTEM = """You are a senior Adobe Solutions Architect writing a CAPSTONE
assessment for a practitioner who has just completed the "{track_name}" learning
path. This is the final, human-graded assessment — make it concrete and real.

Hard requirements:
- The capstone must be SPECIFIC to the {track_name} path and, across all its
  tasks, must exercise EVERY module the learner completed (listed below).
- Provide tiered tasks: at least one "basic", one "intermediate", and one
  "expert" task. Higher tiers build on lower ones.
- Tasks must be hands-on and concrete (create X, configure Y, export Z), using
  REAL Adobe product capabilities — never invented features.
- Include a presentation/deck deliverable with specific required slides.
- Ground everything in the same industry/company scenario.

Use this track-specific blueprint as the backbone (adapt the numbers/context to
the scenario, keep the spirit and the concrete deliverables):
HANDS-ON DELIVERABLES:
{blueprint_hands_on}
REQUIRED DECK SLIDES:
{blueprint_deck}

{product_distinctions}

You have a search_docs tool to look up more real Adobe documentation for a
specific module or capability if the grounding docs already given aren't
enough to write a concrete, accurate task for it — use it rather than
inventing a feature that doesn't exist.

Respond ONLY with valid JSON — no prose, no markdown fences:
{{
  "title": "short capstone title",
  "company_brief": "2-3 sentences: the company, industry, and their data challenge",
  "objective": "one sentence: what the learner must demonstrate",
  "tasks": [
    {{
      "level": "basic|intermediate|expert",
      "title": "...",
      "description": "what to build/do, concretely",
      "deliverable": "the artifact to submit",
      "modules_covered": ["module titles this exercises"],
      "aep_products": ["RTCDP", ...]
    }}
  ],
  "deck_requirements": [
    {{"slide": "slide title", "must_cover": ["point 1", "point 2"]}}
  ],
  "submission_checklist": ["...", "..."],
  "estimated_effort_hours": 20
}}
Produce 4-6 tasks total spanning all three levels."""


def _capstone_tools() -> list:
    return [
        {"type": "function", "function": {
            "name": "search_docs",
            "description": "Search real Adobe Experience Platform documentation for a specific module's capabilities or a feature, to ground a task in what the product actually does.",
            "parameters": {"type": "object", "properties": {
                "query": {"type": "string", "description": "Natural language search, e.g. 'RTCDP merge policy configuration'"},
            }, "required": ["query"]},
        }},
    ]


def _capstone_tool_executor(track: str):
    def executor(name: str, args: dict):
        if name == "search_docs":
            if not _RAG_AVAILABLE:
                return {"error": "search unavailable"}
            docs = run_with_timeout(
                shared_rag.retrieve, args.get("query", ""), track=track, top_k=3,
                timeout=8.0, default=[], on_timeout_log="capstone search_docs tool",
            ) or []
            return [{"title": d.get("title", ""), "excerpt": str(d.get("content", ""))[:400]} for d in docs]
        return {"error": f"Unknown tool '{name}'"}
    return executor


def node_generate(state: dict) -> dict:
    track      = state.get("track", "rtcdp")
    bp         = _blueprint_for(track)
    vertical   = state.get("vertical", "Retail & E-Commerce")
    company    = state.get("company", "NovaMart")
    modules    = state.get("all_module_titles") or state.get("done_module_titles") or []
    rag_ctx    = state.get("rag_context", "")

    user = (
        f"Industry: {vertical}\nCompany: {company}\nTrack: {bp['name']}\n"
        f"Modules the learner completed (cover ALL of these): "
        f"{', '.join(modules) if modules else 'the full ' + bp['name'] + ' path'}\n"
        + (f"\nGrounding docs:\n{rag_ctx}\n" if rag_ctx else "")
    )
    sys = CAPSTONE_SYSTEM.format(
        track_name=bp["name"],
        blueprint_hands_on="\n".join(f"- {x}" for x in bp["hands_on"]),
        blueprint_deck="\n".join(f"- {x}" for x in bp["deck"]),
        product_distinctions=PRODUCT_DISTINCTIONS,
    )
    resp = None
    try:
        resp = call_with_tools(
            [{"role": "user", "content": user}], sys,
            _capstone_tools(), _capstone_tool_executor(track),
            max_tokens=2000, max_rounds=3, agent="Capstone",
        )
        result = parse_json_lenient(resp["content"])
        if not result.get("tasks"):
            raise ValueError("no tasks in generated capstone")
    except Exception as e:
        print(f"[capstone] generate error: {e} — using blueprint fallback")
        result = _fallback_capstone(bp, vertical, company, modules)
    result.setdefault("modules_covered", modules)
    result["track"] = track

    # RAGAS scoring when search_docs actually returned real grounding docs —
    # fire-and-forget, never blocks this response.
    if resp is not None:
        contexts = extract_tool_contexts(resp.get("tool_calls", []), {"search_docs"})
        if contexts:
            try:
                evaluate_and_log("capstone", user, summarize_for_ragas(result), contexts)
            except Exception:
                pass

    return {**state, "capstone": result}


def _fallback_capstone(bp: dict, vertical: str, company: str, modules: list) -> dict:
    """A real, concrete capstone straight from the blueprint — used when the LLM
    is unavailable, so the learner is never blocked by a provider outage."""
    hands = bp["hands_on"]
    levels = ["basic", "intermediate", "intermediate", "expert"]
    tasks = []
    for i, step in enumerate(hands):
        tasks.append({
            "level": levels[min(i, len(levels) - 1)],
            "title": step.split(":")[0][:80],
            "description": step,
            "deliverable": "Working configuration + short write-up of your decisions",
            "modules_covered": modules,
            "aep_products": [bp["name"]],
        })
    return {
        "title": f"{bp['name']} Capstone — {company}",
        "company_brief": f"{company} is a {vertical} organisation rolling out {bp['name']}. {bp['focus']}",
        "objective": f"Demonstrate end-to-end mastery of {bp['name']} by delivering the tasks below and presenting your design.",
        "tasks": tasks,
        "deck_requirements": [{"slide": s, "must_cover": []} for s in bp["deck"]],
        "submission_checklist": [
            "All hands-on tasks completed with screenshots/config",
            "Presentation deck covering every required slide",
            "Short reflection: trade-offs and what you'd do differently",
        ],
        "estimated_effort_hours": 20,
    }


# ── Node 5: human-evaluation rubric ───────────────────────────────────────────

def node_rubric(state: dict) -> dict:
    """A fixed, human-graded rubric. Capstones are reviewed by a manager/SME —
    the rubric gives them consistent criteria. (No LLM call needed.)"""
    rubric = [
        {"criterion": "Correctness — uses real Adobe capabilities correctly", "weight_pct": 30},
        {"criterion": "Completeness — all tasks + required deck slides delivered", "weight_pct": 25},
        {"criterion": "Design rationale — trade-offs and decisions are justified", "weight_pct": 20},
        {"criterion": "Guardrails & edge cases — governance, limits, debugging", "weight_pct": 15},
        {"criterion": "Communication — clear, well-structured presentation", "weight_pct": 10},
    ]
    return {**state, "rubric": rubric, "graded_by": "human"}


# ── Node 6: validate ──────────────────────────────────────────────────────────

def node_validate(state: dict) -> dict:
    cap = state.get("capstone", {})
    tasks = cap.get("tasks", [])
    levels = {t.get("level") for t in tasks}
    issues = []
    if not ({"basic", "intermediate", "expert"} & levels):
        issues.append("no recognised difficulty tiers")
    if len(tasks) < 3:
        issues.append("fewer than 3 tasks")
    return {**state, "validation_ok": not issues, "validation_issues": issues}


# ── Build graph ───────────────────────────────────────────────────────────────

def build_capstone_graph():
    if not LANGGRAPH_AVAILABLE:
        return None
    g = StateGraph(dict)
    g.add_node("fetch_state",    node_fetch_state)
    g.add_node("select_context", node_select_context)
    g.add_node("retrieve",       node_retrieve)
    g.add_node("generate",       node_generate)
    g.add_node("rubric",         node_rubric)
    g.add_node("validate",       node_validate)
    g.set_entry_point("fetch_state")
    g.add_edge("fetch_state",    "select_context")
    g.add_edge("select_context", "retrieve")
    g.add_edge("retrieve",       "generate")
    g.add_edge("generate",       "rubric")
    g.add_edge("rubric",         "validate")
    g.add_edge("validate",       END)
    return g.compile()


# ── Callable entry point ──────────────────────────────────────────────────────

def run_capstone(context: dict, graph=None) -> dict:
    """Generate a full, path-specific capstone. Returns a structured capstone +
    rubric + meta. `context` supports: learner_name, track, team_context,
    all_module_titles, done_module_titles."""
    set_current_agent("Capstone")
    start = time.time()
    state = {**context}
    final = None
    if graph is not None:
        try:
            final = graph.invoke(state)
        except Exception as e:
            print(f"[capstone] graph error: {e}, running inline")
            graph = None
    if graph is None:
        state = node_fetch_state(state)
        state = node_select_context(state)
        state = node_retrieve(state)
        state = node_generate(state)
        state = node_rubric(state)
        state = node_validate(state)
        final = state

    cap = final.get("capstone", {})
    return {
        "title":         cap.get("title", ""),
        "track":         final.get("track", context.get("track", "")),
        "vertical":      final.get("vertical", ""),
        "company":       final.get("company", ""),
        "company_brief": cap.get("company_brief", ""),
        "objective":     cap.get("objective", ""),
        "tasks":         cap.get("tasks", []),
        "deck_requirements":  cap.get("deck_requirements", []),
        "submission_checklist": cap.get("submission_checklist", []),
        "estimated_effort_hours": cap.get("estimated_effort_hours", 20),
        "modules_covered": cap.get("modules_covered", final.get("all_module_titles", [])),
        "rubric":        final.get("rubric", []),
        "graded_by":     final.get("graded_by", "human"),
        "rag_sources":   final.get("rag_sources", []),
        "validation_ok": final.get("validation_ok", True),
        # Back-compat fields for the existing frontend/DB shape:
        "scenario":      cap,
        "meta": {
            "type": "agent", "name": "capstone",
            "engine": "langgraph" if (LANGGRAPH_AVAILABLE and graph is not None) else "sequential",
            "model": GROQ_MODEL, "steps_executed": 6,
            "latency_ms": round((time.time() - start) * 1000),
            "vertical": final.get("vertical", ""),
            "grounded": bool(final.get("rag_sources")),
        },
    }
