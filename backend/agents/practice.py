"""
practice.py — Practice Agent (LangGraph)
=========================================
Steps:
  1. Resolve the practice topic — either:
       (a) a free-text topic the learner typed themselves, or
       (b) (no topic given) fall back to the learner's weakest module,
           detected from confidence scores — original behaviour, unchanged.
  2. Retrieve relevant AEP content via RAG for that topic/module
  3. Generate a realistic practice scenario grounded in that content
  4. Validate: no hallucinated client names, products, or AEP features

A second, separate entry point — run_validate_understanding() — powers the
"Validate My Understanding" flow: the learner writes their own explanation of
a scenario, and this does a lightweight RAG-grounded comparison against the
scenario's own content (+ retrieved docs) to produce a confidence score and
targeted, scenario-specific feedback. This intentionally does NOT go through
LangGraph — it's two straightforward calls (retrieve, then score) and keeping
it as a plain function avoids the overhead of compiling/caching a second graph
for something this small.
"""

from .config import (
    set_current_agent,
    GROQ_MODEL, ANTHROPIC_MODEL,
    groq_call, anthropic_call, get_db_url, get_db_conn, make_meta,
    PRODUCT_DISTINCTIONS, TESTOUT_PASS_THRESHOLD, QUIZ_QUESTION_COUNT,
    WEIGHT_MARKET, WEIGHT_TEAM, WEIGHT_ROLE, call_with_tools,
)
from evaluation import evaluate_and_log, extract_tool_contexts

import os
import json
import time
import requests

try:
    from langgraph.graph import StateGraph, END
    LANGGRAPH_AVAILABLE = True
except ImportError:
    LANGGRAPH_AVAILABLE = False

AEP_PRODUCTS = [
    "Real-Time CDP", "Adobe Journey Optimizer", "Customer Journey Analytics",
    "Adobe Analytics", "Experience Platform", "Adobe Experience Manager",
    "Marketo Engage", "Adobe Target", "Adobe Campaign",
]

# ── Node 1: Resolve the practice topic ────────────────────────────────────────

def node_resolve_topic(state: dict) -> dict:
    """
    Decide what this scenario should be about.

    Priority order:
      1. A free-text topic the learner typed themselves (state["topic"]).
         This is the primary path for the "generate a use case for a topic
         I choose" experience — no predefined list, no weak-module lookup.
      2. (no topic given) original behaviour — find the module with the
         lowest confidence score among the learner's completed modules.
      3. Final fallback — an explicit module_id/module_title passed by the
         caller, or a generic default.
    """
    topic = (state.get("topic") or "").strip()

    if topic:
        # Learner-driven topic — this IS the target, no module lookup needed.
        return {
            **state,
            "weak_module_id":    state.get("module_id"),
            "weak_module_title": topic,
            "topic_is_freeform": True,
        }

    # ── Fallback: original weakest-module detection (unchanged) ──────────────
    conf_scores  = state.get("conf_scores", {})
    modules      = state.get("modules", [])
    done_modules = set(state.get("done_modules", []))

    done_conf = {
        mid: score
        for mid, score in conf_scores.items()
        if mid in done_modules
    }

    if not done_conf:
        weak_id    = state.get("module_id", 1)
        weak_title = state.get("module_title", "AEP Fundamentals")
    else:
        weak_id    = min(done_conf, key=done_conf.get)
        weak_title = next(
            (m["title"] for m in modules if m.get("id") == weak_id),
            str(weak_id),
        )

    return {
        **state,
        "weak_module_id":    weak_id,
        "weak_module_title": weak_title,
        "topic_is_freeform": False,
    }

# ── Node 2: Retrieve relevant content ─────────────────────────────────────────

def node_retrieve_content(state: dict) -> dict:
    """
    Fetch relevant documentation for the resolved topic/module from
    doc_embeddings. Simple keyword search — full RAG agent used separately.
    Works the same whether the topic came from the learner or from
    weak-module detection — both land in weak_module_title by this point.
    """
    module_title = state.get("weak_module_title", "")
    docs         = []

    try:
        import psycopg2
        import psycopg2.extras
        conn   = psycopg2.connect(get_db_url())
        with conn.cursor() as c:
            c.execute(
                """SELECT content FROM doc_embeddings
                   WHERE to_tsvector('english', content) @@ plainto_tsquery('english', %s)
                   ORDER BY ts_rank(to_tsvector('english', content),
                            plainto_tsquery('english', %s)) DESC
                   LIMIT 4""",
                (module_title, module_title),
            )
            docs = [row[0][:400] for row in c.fetchall()]
        conn.close()
    except Exception as e:
        print(f"[practice] retrieve_content warning: {e}")

    return {**state, "retrieved_content": docs}

# ── Node 3: Generate scenario ─────────────────────────────────────────────────

SCENARIO_SYSTEM = """You are a senior AEP Solutions Architect designing a practice scenario.
Generate a realistic, grounded practice scenario for an AEP practitioner.

The scenario must:
- Be based on a real-world business problem
- Use ONLY real AEP products and features (no invented capabilities)
- Target the specified topic specifically — do not drift to a different topic
- Include a clear problem statement, constraints, and expected deliverable
- Be completable in 30-60 minutes
{crossskill_note}
{product_distinctions}

Source documentation (use this to ground the scenario):
{docs_context}

If the source documentation above is not specific enough to ground an accurate scenario, call the search_docs tool to look up more specific real documentation before writing the scenario.

Respond ONLY with valid JSON — no other text.

JSON format:
{{
  "title": "scenario title",
  "module_targeted": "...",
  "business_context": "2-3 sentences setting the scene",
  "problem_statement": "exactly what the learner must solve",
  "constraints": ["constraint 1", "constraint 2"],
  "aep_products_involved": ["RTCDP", "AJO"],
  "expected_deliverable": "what the learner must produce",
  "hints": ["optional hint 1", "optional hint 2"],
  "estimated_minutes": 45
}}
"""

CROSSSKILL_NOTE = (
    "- The learner is practising this as a CROSS-SKILL topic (not their home "
    "track) — frame the business context so it's clear how this skill applies "
    "in a real working context, as if they were asked to help on a project "
    "that needed it.\n"
)


def _practice_tools() -> list:
    return [
        {"type": "function", "function": {
            "name": "search_docs",
            "description": "Full-text search real indexed AEP documentation for a topic — use this if the pre-fetched source documentation isn't specific enough to ground the scenario accurately.",
            "parameters": {"type": "object", "properties": {
                "query": {"type": "string", "description": "Search terms, e.g. 'RTCDP segment evaluation modes'"},
            }, "required": ["query"]},
        }},
    ]


def _practice_tool_executor():
    def executor(name: str, args: dict):
        if name == "search_docs":
            query = args.get("query", "")
            try:
                import psycopg2
                conn = psycopg2.connect(get_db_url())
                with conn.cursor() as c:
                    c.execute(
                        """SELECT content FROM doc_embeddings
                           WHERE to_tsvector('english', content) @@ plainto_tsquery('english', %s)
                           ORDER BY ts_rank(to_tsvector('english', content), plainto_tsquery('english', %s)) DESC
                           LIMIT 3""",
                        (query, query))
                    rows = [r[0][:500] for r in c.fetchall()]
                conn.close()
                return rows if rows else {"note": "No indexed docs matched — use your own real AEP knowledge, don't invent capabilities."}
            except Exception as e:
                return {"error": str(e)}
        return {"error": f"Unknown tool '{name}'"}
    return executor


def node_generate_scenario(state: dict) -> dict:
    topic         = state.get("weak_module_title", "AEP Module")
    is_freeform   = state.get("topic_is_freeform", False)
    is_crossskill = state.get("is_cross_skill", False)
    track         = state.get("track", "rtcdp").upper()
    docs          = state.get("retrieved_content", [])
    docs_context  = "\n\n".join(docs) if docs else "No specific documentation available."

    conf_line = ""
    if not is_freeform:
        conf_line = (
            f"Learner confidence on this module: "
            f"{state.get('conf_scores', {}).get(state.get('weak_module_id'), 0.5):.2f}"
        )

    resp = None
    try:
        resp = call_with_tools(
            [{
                "role": "user",
                "content": (
                    f"Topic to target: {topic}\n"
                    f"Track: {track}\n"
                    f"{conf_line}"
                ),
            }],
            SCENARIO_SYSTEM.format(
                product_distinctions=PRODUCT_DISTINCTIONS,
                docs_context=docs_context[:1000],
                crossskill_note=CROSSSKILL_NOTE if is_crossskill else "",
            ),
            _practice_tools(), _practice_tool_executor(),
            max_tokens=800, max_rounds=2, agent="Practice",
        )
        raw    = resp["content"].strip().strip("```json").strip("```").strip()
        result = json.loads(raw)
    except Exception as e:
        print(f"[practice] generate error: {e}")
        result = {
            "title":                f"Practice: {topic}",
            "module_targeted":      topic,
            "business_context":     f"A mid-size retail company is implementing {track}.",
            "problem_statement":    f"Apply {topic} to the retail use case.",
            "constraints":          ["Use only AEP native capabilities"],
            "aep_products_involved": [track],
            "expected_deliverable": "Configuration document with rationale",
            "hints":                [],
            "estimated_minutes":    45,
        }

    # RAGAS scoring against whatever real grounding was used — the pre-fetched
    # docs (always present when docs_context is non-empty) plus any search_docs
    # tool call results. Fire-and-forget, never blocks this response.
    if resp is not None:
        contexts = list(docs) if docs else []
        contexts += extract_tool_contexts(resp.get("tool_calls", []), {"search_docs"})
        if contexts:
            try:
                evaluate_and_log("practice", topic, json.dumps(result), contexts)
            except Exception:
                pass

    return {**state, "scenario_result": result}

# ── Node 4: Validate ──────────────────────────────────────────────────────────

FICTIONAL_COMPANIES = [
    "TechCorp", "MegaBank", "SuperRetail", "GlobalHealth",
    "FakeCo", "ACME", "ExampleCorp",
]

def node_validate_scenario(state: dict) -> dict:
    """
    Check scenario doesn't reference:
    - Invented AEP features
    - Overly generic or clearly fictional company names
    """
    result   = state.get("scenario_result", {})
    products = result.get("aep_products_involved", [])
    issues   = []

    # Check products are real
    for product in products:
        normalised = product.strip()
        if not any(
            real.lower() in normalised.lower()
            for real in AEP_PRODUCTS + ["AEP", "RTCDP", "AJO", "CJA", "AA"]
        ):
            issues.append(f"Unrecognised product: {normalised}")

    # Check business context isn't using obviously fake companies
    context = result.get("business_context", "").lower()
    for fake in FICTIONAL_COMPANIES:
        if fake.lower() in context:
            issues.append(f"Overly generic company name detected: {fake}")

    return {
        **state,
        "validation_ok":     len(issues) == 0,
        "validation_issues": issues,
    }

# ── Build Graph ────────────────────────────────────────────────────────────────

def build_practice_graph():
    if not LANGGRAPH_AVAILABLE:
        return None

    g = StateGraph(dict)
    g.add_node("resolve_topic",   node_resolve_topic)
    g.add_node("retrieve",        node_retrieve_content)
    g.add_node("generate",        node_generate_scenario)
    g.add_node("validate",        node_validate_scenario)

    g.set_entry_point("resolve_topic")
    g.add_edge("resolve_topic", "retrieve")
    g.add_edge("retrieve",       "generate")
    g.add_edge("generate",       "validate")
    g.add_edge("validate",       END)

    return g.compile()

# ── Callable entry point ───────────────────────────────────────────────────────

def run_practice(context: dict, graph=None) -> dict:
    """
    Generate a practice scenario.

    If context["topic"] is a non-empty string, the scenario is generated
    dynamically for THAT topic — no predefined list, no weak-module lookup.
    If topic is empty/omitted, falls back to the original behaviour: target
    the learner's weakest completed module (via conf_scores/modules/done_modules).

    Args:
        context: dict with learner info. Recognised keys:
            topic          — (optional) free-text topic the learner typed
            is_cross_skill — (optional) bool, True if this topic sits outside
                              the learner's home track (biases scenario framing
                              toward "how this applies on a real project")
            track          — product/track label (rtcdp, analytics, ajo, cja)
            conf_scores, modules, done_modules, module_id, module_title
                           — used only when topic is empty (legacy fallback)
        graph: compiled LangGraph graph (optional)

    Returns:
        {scenario, weak_module_title, validation_ok, meta}
        (weak_module_title holds the resolved topic in both paths, kept under
        its original key name for frontend/backward compatibility)
    """
    set_current_agent("Practice")
    start = time.time()
    state = {**context}

    if graph is not None:
        try:
            final = graph.invoke(state)
        except Exception as e:
            print(f"[practice] graph error: {e}, running inline")
            graph = None

    if graph is None:
        state = node_resolve_topic(state)
        state = node_retrieve_content(state)
        state = node_generate_scenario(state)
        state = node_validate_scenario(state)
        final = state

    return {
        "scenario":            final.get("scenario_result", {}),
        "weak_module_title":   final.get("weak_module_title", ""),
        "weak_module_id":      final.get("weak_module_id"),
        "validation_ok":       final.get("validation_ok", True),
        "validation_issues":   final.get("validation_issues", []),
        "meta": {
            "type":           "agent",
            "name":           "practice",
            "engine":         "langgraph" if LANGGRAPH_AVAILABLE else "sequential",
            "model":          GROQ_MODEL,
            "steps_executed": 4,
            "latency_ms":     round((time.time() - start) * 1000),
            "module_targeted": final.get("weak_module_title", ""),
        },
    }


# ═══════════════════════════════════════════════════════════════════════════
# Validate My Understanding — RAG-grounded comprehension check
# ═══════════════════════════════════════════════════════════════════════════
# Not a LangGraph — just two calls (retrieve, then score). The learner submits
# their own explanation of a scenario; we retrieve grounding docs for the
# scenario's topic and ask the model to judge how well the explanation covers
# the scenario's actual problem/requirements, returning a confidence score and
# specific, scenario-referencing feedback (never a generic "read the docs").

def _validate_retrieve_context(topic: str) -> list:
    """Same lightweight FTS lookup as node_retrieve_content, reused here so
    the validation step is grounded in the same documentation the scenario
    itself was generated from — not just the model's own judgement."""
    docs = []
    try:
        import psycopg2
        conn = psycopg2.connect(get_db_url())
        with conn.cursor() as c:
            c.execute(
                """SELECT content FROM doc_embeddings
                   WHERE to_tsvector('english', content) @@ plainto_tsquery('english', %s)
                   ORDER BY ts_rank(to_tsvector('english', content),
                            plainto_tsquery('english', %s)) DESC
                   LIMIT 4""",
                (topic, topic),
            )
            docs = [row[0][:400] for row in c.fetchall()]
        conn.close()
    except Exception as e:
        print(f"[practice] validate retrieve warning: {e}")
    return docs


VALIDATION_SYSTEM = """You are grading a learner's own written explanation of a practice scenario.
You are supportive but honest — this is a learning check, not a pass/fail exam.

You will receive:
- The scenario the learner was given (business context, problem statement,
  requirements/constraints, expected deliverable)
- Supporting documentation excerpts (may be empty)
- The learner's own words explaining their understanding of the scenario

Score how well the learner's explanation demonstrates real understanding of
the PROBLEM and what's required to solve it — not whether their prose is
polished. Partial understanding should get partial credit.

Respond ONLY with valid JSON, no other text:
{{
  "confidence": 0-100,
  "matched_points": ["specific thing they clearly understood, referencing the scenario"],
  "missed_points": ["specific thing they missed or got wrong, referencing the scenario"],
  "guidance": "1-3 sentences, specific and actionable, telling them exactly what part of the scenario to revisit and why — never generic advice like 'review the documentation'"
}}

{docs_context}
"""

def _validate_score_understanding(scenario: dict, learner_understanding: str, docs: list) -> dict:
    docs_context = (
        "Supporting documentation:\n" + "\n\n".join(docs)
        if docs else "No supporting documentation was retrieved for this topic."
    )
    scenario_text = (
        f"Title: {scenario.get('title', '')}\n"
        f"Business context: {scenario.get('business_context', '')}\n"
        f"Problem statement: {scenario.get('problem_statement', '')}\n"
        f"Requirements/constraints: {', '.join(scenario.get('constraints', []) or [])}\n"
        f"Expected deliverable: {scenario.get('expected_deliverable', '')}\n"
    )

    try:
        raw = groq_call(
            [{
                "role": "user",
                "content": (
                    f"Scenario:\n{scenario_text}\n\n"
                    f"Learner's explanation of their understanding:\n{learner_understanding}"
                ),
            }],
            VALIDATION_SYSTEM.format(docs_context=docs_context[:1200]),
            max_tokens=500,
        )
        raw    = raw.strip().strip("```json").strip("```").strip()
        result = json.loads(raw)
        # Clamp confidence defensively — a malformed/out-of-range value from
        # the model should never silently break the >60% / <=60% UI branch.
        result["confidence"] = max(0, min(100, int(result.get("confidence", 0))))
    except Exception as e:
        print(f"[practice] validate score error: {e}")
        result = {
            "confidence": 0,
            "matched_points": [],
            "missed_points": [],
            "guidance": (
                "Couldn't score your answer automatically — check your "
                "connection and try submitting again."
            ),
        }
    return result


def run_validate_understanding(context: dict) -> dict:
    """
    Score a learner's own explanation of a scenario against the scenario's
    problem statement/requirements, grounded in the same RAG documentation
    the scenario was generated from.

    Args:
        context: {
            scenario: dict                — the scenario object shown to the learner
                                             (title, business_context, problem_statement,
                                             constraints, expected_deliverable, ...)
            learner_understanding: str    — the learner's own written explanation
            topic: str                    — the scenario's topic (for doc retrieval;
                                             falls back to scenario["module_targeted"])
        }

    Returns:
        {confidence, verdict, matched_points, missed_points, guidance, meta}
        verdict is "pass" if confidence > 60, else "review".
    """
    set_current_agent("Practice")
    start = time.time()
    scenario  = context.get("scenario", {}) or {}
    answer    = (context.get("learner_understanding") or "").strip()
    topic     = context.get("topic") or scenario.get("module_targeted") or scenario.get("title") or ""

    if not answer:
        return {
            "confidence": 0,
            "verdict": "review",
            "matched_points": [],
            "missed_points": [],
            "guidance": "Write a few sentences about your understanding before submitting.",
            "meta": {
                "type": "agent", "name": "practice_validate", "model": GROQ_MODEL,
                "steps_executed": 0, "latency_ms": round((time.time() - start) * 1000),
            },
        }

    docs   = _validate_retrieve_context(topic)
    scored = _validate_score_understanding(scenario, answer, docs)
    confidence = scored.get("confidence", 0)

    return {
        "confidence":     confidence,
        "verdict":        "pass" if confidence > 60 else "review",
        "matched_points": scored.get("matched_points", []),
        "missed_points":  scored.get("missed_points", []),
        "guidance":       scored.get("guidance", ""),
        "meta": {
            "type":           "agent",
            "name":           "practice_validate",
            "model":          GROQ_MODEL,
            "steps_executed": 2,
            "latency_ms":     round((time.time() - start) * 1000),
            "docs_retrieved": len(docs),
        },
    }
