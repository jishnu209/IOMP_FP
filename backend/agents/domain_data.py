"""
domain_data.py — Adobe AEP + Journeys skill map (single source of domain truth)
================================================================================
Updated from the official Data Team and Journeys Team Learning Journey matrices
(July 2026).  All role→skill priority data comes directly from those slides.

Learning path priority scale (from the matrix):
  1 = Most viable next solution/track to learn
  2 = Related / mostly used in day-to-day work
  3 = Less frequently used — good to have basic-intermediate knowledge
  4 = Awareness level — follow discussions and provide inputs
  5 = Optional / good to have

Proficiency levels:
  novice       — knows about the product and usage
  basic        — enablement/capstone completed
  intermediate — certified, shadowing with 1-2 project experience
  advanced     — delivered 4-5 projects, led min 2 projects
  expert       — SME, product connect, engineering connects, roadmap view
"""

from __future__ import annotations

EASY, MEDIUM, HARD = "easy", "medium", "hard"


def _mod(title: str, order: int, difficulty: str = MEDIUM, quiz: bool = True) -> dict:
    return {"module": title, "order": order, "difficulty": difficulty, "quiz_required": quiz}


# ══════════════════════════════════════════════════════════════════════════════
# SKILL MAP
# Keys are canonical skill IDs used throughout the codebase.
# ══════════════════════════════════════════════════════════════════════════════

SKILLS: dict[str, dict] = {

    # ── Core AEP / Data ──────────────────────────────────────────────────────
    "data_foundations": {
        "label": "Data Foundations",
        "family": "aep", "category": "data",
        "market_demand": 0.70, "prerequisites": [],
        "modules": [
            _mod("Data Modelling Basics", 1, EASY),
            _mod("Batch vs Streaming Ingestion", 2, EASY),
            _mod("Data Quality & Validation", 3, MEDIUM),
        ],
    },
    "aep_platform": {
        "label": "Adobe Experience Platform (Core)",
        "family": "aep", "category": "aep",
        "market_demand": 0.95, "prerequisites": ["data_foundations"],
        "modules": [
            _mod("AEP Architecture & Sandboxes", 1, EASY),
            _mod("XDM Schemas & Field Groups", 2, MEDIUM),
            _mod("Datasets, Sources & Destinations", 3, MEDIUM),
            _mod("Identity Service & Merge Policies", 4, HARD),
        ],
    },
    "rtcdp": {
        "label": "Real-Time CDP",
        "family": "aep", "category": "cdp",
        "market_demand": 1.0, "prerequisites": ["aep_platform"],
        "modules": [
            _mod("Real-Time Customer Profile", 1, MEDIUM),
            _mod("Audiences & Segmentation", 2, MEDIUM),
            _mod("Edge Segmentation & Activation", 3, HARD),
            _mod("Destinations & Consent Enforcement", 4, HARD),
        ],
    },
    "data_engineering": {
        "label": "AEP Data Engineering (DE)",
        "family": "aep", "category": "data engineering",
        "market_demand": 0.88, "prerequisites": ["aep_platform"],
        "modules": [
            _mod("Data Prep & Mapping", 1, MEDIUM),
            _mod("Query Service & Derived Datasets", 2, MEDIUM),
            _mod("Data Distiller & Aggregations", 3, HARD),
            _mod("Pipeline Monitoring & Data Governance", 4, HARD),
        ],
    },
    "data_architecture": {
        "label": "AEP Data Architecture",
        "family": "aep", "category": "data architect",
        "market_demand": 0.90, "prerequisites": ["rtcdp", "data_engineering"],
        "modules": [
            _mod("Enterprise Schema Design", 1, MEDIUM),
            _mod("Identity Graph Architecture", 2, HARD),
            _mod("Multi-Sandbox & Data Governance Design", 3, HARD),
            _mod("Reference Architecture & Solution Design", 4, HARD),
        ],
    },
    "analytics_aa": {
        "label": "Adobe Analytics (DA)",
        "family": "aep", "category": "analytics",
        "market_demand": 0.85, "prerequisites": [],
        "modules": [
            _mod("Analytics Data Collection & Web SDK", 1, EASY),
            _mod("Analysis Workspace & Reporting", 2, EASY),
            _mod("Segments, Calculated Metrics & Attribution", 3, MEDIUM),
            _mod("Analytics + AEP Integration", 4, HARD),
        ],
    },
    "cja": {
        "label": "Customer Journey Analytics (CJA)",
        "family": "aep", "category": "cja",
        "market_demand": 0.88, "prerequisites": ["analytics_aa", "aep_platform"],
        "modules": [
            _mod("CJA vs Adobe Analytics", 1, EASY),
            _mod("Connections & Data Views", 2, MEDIUM),
            _mod("Cross-Channel Analysis in Workspace", 3, MEDIUM),
            _mod("Stitching & Attribution in CJA", 4, HARD),
        ],
    },
    "aa_sdk": {
        "label": "Adobe Analytics SDK / Web SDK (AA-SDK)",
        "family": "aep", "category": "sdk",
        "market_demand": 0.82, "prerequisites": ["analytics_aa"],
        "modules": [
            _mod("Web SDK (Alloy.js) Fundamentals", 1, MEDIUM),
            _mod("Tags (Launch) Implementation", 2, MEDIUM),
            _mod("Mobile SDK & App Measurement", 3, MEDIUM),
            _mod("Data Streams & Edge Network", 4, HARD),
        ],
    },
    "b2b_cdp": {
        "label": "B2B CDP / AEP B2B Edition",
        "family": "aep", "category": "b2b",
        "market_demand": 0.72, "prerequisites": ["rtcdp"],
        "modules": [
            _mod("B2B Data Model (Accounts & Opportunities)", 1, MEDIUM),
            _mod("B2B Segmentation & Buying Groups", 2, MEDIUM),
            _mod("Account-Based Activation", 3, HARD),
        ],
    },
    "aam": {
        "label": "Adobe Audience Manager (AAM)",
        "family": "aep", "category": "aam",
        "market_demand": 0.45,   # legacy, being replaced by RTCDP
        "prerequisites": [],
        "modules": [
            _mod("AAM Data Model & Traits", 1, EASY),
            _mod("Segments & Destinations in AAM", 2, MEDIUM),
            _mod("AAM to RTCDP Migration Path", 3, MEDIUM),
        ],
    },

    # ── Journeys family ───────────────────────────────────────────────────────
    "ajo": {
        "label": "Adobe Journey Optimizer (AJO)",
        "family": "journeys", "category": "ajo",
        "market_demand": 1.0, "prerequisites": ["rtcdp"],
        "modules": [
            _mod("Journeys & Events", 1, MEDIUM),
            _mod("Message Design & Channels", 2, MEDIUM),
            _mod("Decisioning in AJO", 3, HARD),
            _mod("Journey Orchestration at Scale", 4, HARD),
        ],
    },
    "campaign_acc": {
        "label": "Adobe Campaign (ACC/ACS)",
        "family": "journeys", "category": "campaign",
        "market_demand": 0.68, "prerequisites": ["data_foundations"],
        "modules": [
            _mod("Campaign Data Model & Workflows", 1, MEDIUM),
            _mod("Delivery Templates & Personalization", 2, MEDIUM),
            _mod("Campaign to AJO Migration Patterns", 3, HARD),
        ],
    },
    "target": {
        "label": "Adobe Target",
        "family": "journeys", "category": "target",
        "market_demand": 0.72, "prerequisites": [],
        "modules": [
            _mod("A/B & Multivariate Testing", 1, EASY),
            _mod("Automated Personalization (AP)", 2, MEDIUM),
            _mod("Recommendations & Server-Side Delivery", 3, HARD),
        ],
    },
    "marketo": {
        "label": "Marketo Engage",
        "family": "journeys", "category": "marketo",
        "market_demand": 0.75, "prerequisites": [],
        "modules": [
            _mod("Lead Lifecycle & Scoring", 1, EASY),
            _mod("Smart Campaigns & Engagement Programs", 2, MEDIUM),
            _mod("Marketo + AEP Integration", 3, HARD),
        ],
    },
    "offer_decisioning": {
        "label": "Offer Decisioning (OD / AJO Decisioning)",
        "family": "journeys", "category": "od",
        "market_demand": 0.80, "prerequisites": ["rtcdp"],
        "modules": [
            _mod("Decision Management Concepts", 1, MEDIUM),
            _mod("Offers, Collections & Ranking", 2, MEDIUM),
            _mod("Real-Time Decisioning Integration", 3, HARD),
        ],
    },
    "experience_solutions": {
        "label": "Experience Solutions / ES",
        "family": "aep", "category": "experience solutions",
        "market_demand": 0.60, "prerequisites": ["aep_platform"],
        "modules": [
            _mod("Experience Cloud Overview & Integration", 1, EASY),
            _mod("Cross-Solution Data Flows", 2, MEDIUM),
            _mod("Experience Cloud Admin & Governance", 3, MEDIUM),
        ],
    },
}


# ══════════════════════════════════════════════════════════════════════════════
# TEAM LEARNING JOURNEYS
# Directly from the Data Team and Journeys Team Learning Journey slides.
#
# Structure: role_id → { team, label, current_skills[], priority_map }
# priority_map: { 1: [skill_ids], 2: [...], ..., 5: [...] }
#   1 = Most viable next to learn
#   5 = Optional / good to have
# ══════════════════════════════════════════════════════════════════════════════

TEAM_LEARNING_JOURNEYS: dict[str, dict] = {

    # ── Data Team ─────────────────────────────────────────────────────────────
    "aep_da": {
        "label": "AEP Data Analyst (AEP-DA)",
        "team": "data",
        "current_skills": ["aep_platform", "rtcdp", "analytics_aa"],
        "priority_map": {
            1: ["data_engineering", "ajo", "rtcdp", "b2b_cdp"],
            2: ["aa_sdk", "cja"],
            3: ["target"],
            4: ["campaign_acc", "marketo"],
            5: ["aam", "experience_solutions"],
        },
    },
    "aed_de": {
        "label": "Analytics & Engineering — Data Engineer (AED-DE)",
        "team": "data",
        "current_skills": ["analytics_aa", "rtcdp", "experience_solutions"],
        "priority_map": {
            1: [],          # already strong in core
            2: [],
            3: [],
            4: ["aa_sdk", "cja", "campaign_acc", "ajo", "aam"],
            5: ["target", "marketo", "b2b_cdp"],
        },
    },
    "rtcdp_specialist": {
        "label": "RTCDP Specialist",
        "team": "data",
        "current_skills": ["rtcdp"],
        "priority_map": {
            1: ["analytics_aa"],
            2: ["ajo", "aa_sdk"],
            3: ["marketo", "b2b_cdp", "campaign_acc", "cja", "aam"],
            4: ["data_engineering", "target"],
            5: ["experience_solutions"],
        },
    },
    "aa_sdk_specialist": {
        "label": "Adobe Analytics SDK Specialist (AA-SDK)",
        "team": "data",
        "current_skills": ["analytics_aa", "aa_sdk"],
        "priority_map": {
            1: ["cja"],
            2: ["rtcdp", "target"],
            3: ["analytics_aa", "ajo", "aam", "data_engineering", "experience_solutions"],
            4: ["campaign_acc"],
            5: ["b2b_cdp", "marketo"],
        },
    },
    "es_specialist": {
        "label": "Experience Solutions Specialist (ES)",
        "team": "data",
        "current_skills": ["experience_solutions"],
        "priority_map": {
            1: ["data_engineering"],
            2: ["cja", "aa_sdk"],
            3: ["analytics_aa", "marketo", "rtcdp"],
            4: ["ajo", "campaign_acc", "target", "aam"],
            5: ["b2b_cdp"],
        },
    },

    # ── Journeys Team ─────────────────────────────────────────────────────────
    "ajo_specialist": {
        "label": "Adobe Journey Optimizer Specialist (AJO)",
        "team": "journeys",
        "current_skills": ["ajo"],
        "priority_map": {
            1: ["analytics_aa", "aa_sdk"],
            2: ["rtcdp"],
            3: ["cja"],
            4: ["b2b_cdp"],
            5: ["data_engineering", "aam", "target", "marketo", "experience_solutions"],
        },
    },
    "campaign_specialist": {
        "label": "Adobe Campaign Specialist",
        "team": "journeys",
        "current_skills": ["campaign_acc"],
        "priority_map": {
            1: ["ajo", "analytics_aa", "aa_sdk"],
            2: ["rtcdp"],
            3: ["cja"],
            4: ["b2b_cdp"],
            5: ["data_engineering", "aam", "target", "marketo", "experience_solutions"],
        },
    },
    "target_specialist": {
        "label": "Adobe Target Specialist",
        "team": "journeys",
        "current_skills": ["target"],
        "priority_map": {
            1: ["ajo"],
            2: ["rtcdp"],
            3: ["cja", "aa_sdk"],
            4: ["analytics_aa"],
            5: ["data_engineering", "aam", "campaign_acc", "marketo", "b2b_cdp", "experience_solutions"],
        },
    },
    "marketo_specialist": {
        "label": "Marketo Engage Specialist",
        "team": "journeys",
        "current_skills": ["marketo"],
        "priority_map": {
            1: ["b2b_cdp", "ajo"],
            2: ["rtcdp"],
            3: ["analytics_aa", "aa_sdk"],
            4: ["cja"],
            5: ["data_engineering", "aam", "target", "campaign_acc", "experience_solutions"],
        },
    },
}


# ══════════════════════════════════════════════════════════════════════════════
# ROLE → TARGET SKILLS   (also includes team-specific role mappings)
# ══════════════════════════════════════════════════════════════════════════════

ROLE_TARGET_SKILLS: dict[str, list[str]] = {
    # Generic roles (used when no team context is available)
    "data engineer":              ["data_foundations", "aep_platform", "data_engineering", "rtcdp"],
    "data architect":             ["aep_platform", "rtcdp", "data_engineering", "data_architecture"],
    "cdp specialist":             ["aep_platform", "rtcdp", "offer_decisioning"],
    "aep developer":              ["aep_platform", "rtcdp", "data_engineering"],
    "journey strategist":         ["rtcdp", "ajo", "offer_decisioning"],
    "campaign manager":           ["campaign_acc", "ajo", "marketo"],
    "personalization specialist": ["target", "offer_decisioning", "ajo"],
    "marketing ops":              ["marketo", "campaign_acc", "target"],
    "solutions architect":        ["data_architecture", "rtcdp", "ajo", "offer_decisioning"],
    "analytics engineer":         ["analytics_aa", "aa_sdk", "cja", "rtcdp"],
    "data analyst":               ["analytics_aa", "cja", "rtcdp"],

    # Data Team role mappings (from Learning Journey matrix)
    "aep_da":             [j for p in [1,2,3] for j in TEAM_LEARNING_JOURNEYS["aep_da"]["priority_map"][p]],
    "aep data analyst":   [j for p in [1,2,3] for j in TEAM_LEARNING_JOURNEYS["aep_da"]["priority_map"][p]],
    "aed_de":             TEAM_LEARNING_JOURNEYS["aed_de"]["priority_map"][4],
    "rtcdp specialist":   [j for p in [1,2] for j in TEAM_LEARNING_JOURNEYS["rtcdp_specialist"]["priority_map"][p]],
    "aa-sdk specialist":  [j for p in [1,2] for j in TEAM_LEARNING_JOURNEYS["aa_sdk_specialist"]["priority_map"][p]],
    "es specialist":      [j for p in [1,2] for j in TEAM_LEARNING_JOURNEYS["es_specialist"]["priority_map"][p]],

    # Journeys Team role mappings
    "ajo specialist":      [j for p in [1,2] for j in TEAM_LEARNING_JOURNEYS["ajo_specialist"]["priority_map"][p]],
    "campaign specialist": [j for p in [1,2] for j in TEAM_LEARNING_JOURNEYS["campaign_specialist"]["priority_map"][p]],
    "target specialist":   [j for p in [1,2] for j in TEAM_LEARNING_JOURNEYS["target_specialist"]["priority_map"][p]],
    "marketo specialist":  [j for p in [1,2] for j in TEAM_LEARNING_JOURNEYS["marketo_specialist"]["priority_map"][p]],
}

MARKET_DEMAND: dict[str, str] = {
    sid: ("Critical" if s["market_demand"] >= 0.90
          else "High"     if s["market_demand"] >= 0.70
          else "Stable")
    for sid, s in SKILLS.items()
}


# ── Lookup helpers ─────────────────────────────────────────────────────────────

def get_skill(skill_id: str) -> dict | None:
    return SKILLS.get(_normalize(skill_id))


def get_journey(role_id: str) -> dict | None:
    """Return the team learning journey entry for a specific role if known."""
    r = (role_id or "").strip().lower().replace(" ", "_").replace("-", "_")
    if r in TEAM_LEARNING_JOURNEYS:
        return TEAM_LEARNING_JOURNEYS[r]
    for k, v in TEAM_LEARNING_JOURNEYS.items():
        if k in r or r in k or v["label"].lower().replace(" ", "_") in r:
            return v
    return None


def _normalize(text: str) -> str:
    if not text:
        return ""
    t = text.strip().lower().replace("-", "_").replace(" ", "_")
    if t in SKILLS:
        return t
    aliases = {
        # RTCDP
        "cdp": "rtcdp", "real_time_cdp": "rtcdp", "real-time_cdp": "rtcdp",
        # AJO
        "journey_optimizer": "ajo", "adobe_journey_optimizer": "ajo",
        # Campaign
        "campaign": "campaign_acc", "acc": "campaign_acc", "acs": "campaign_acc",
        # Offer Decisioning
        "od": "offer_decisioning", "offer_decision": "offer_decisioning",
        "decisioning": "offer_decisioning",
        # AEP Platform
        "aep": "aep_platform", "experience_platform": "aep_platform",
        # Data
        "data": "data_foundations", "data_eng": "data_engineering",
        "data_arch": "data_architecture", "architect": "data_architecture",
        # Analytics
        "aa": "analytics_aa", "da": "analytics_aa",
        "adobe_analytics": "analytics_aa", "analytics": "analytics_aa",
        # CJA
        "customer_journey_analytics": "cja",
        # SDK
        "sdk": "aa_sdk", "web_sdk": "aa_sdk", "alloy": "aa_sdk", "tags": "aa_sdk",
        "launch": "aa_sdk",
        # B2B
        "b2b": "b2b_cdp", "b2b_edition": "b2b_cdp",
        # AAM
        "audience_manager": "aam", "adobe_audience_manager": "aam",
        # DE
        "de": "data_engineering",
        # ES
        "es": "experience_solutions",
    }
    if t in aliases:
        return aliases[t]
    for sid, s in SKILLS.items():
        if text.strip().lower() in (s["label"].lower(), s["category"].lower()):
            return sid
    return ""


def all_skill_ids() -> list[str]:
    return list(SKILLS.keys())


def role_targets(role: str) -> list[str]:
    if not role:
        return []
    r = role.strip().lower()
    if r in ROLE_TARGET_SKILLS:
        return ROLE_TARGET_SKILLS[r]
    for key, skills in ROLE_TARGET_SKILLS.items():
        if key in r or r in key:
            return skills
    return []


def next_skills_for_role(role_id: str, current_skills: list[str], max_priority: int = 2) -> list[str]:
    """
    Return the top-priority skills not yet in current_skills for the given role.
    Uses TEAM_LEARNING_JOURNEYS if the role matches, otherwise ROLE_TARGET_SKILLS.
    max_priority: include skills with priority <= this value (1-2 = core, 1-3 = extended).
    """
    journey = get_journey(role_id)
    if journey:
        known = {_normalize(s) for s in current_skills}
        result = []
        for p in range(1, max_priority + 1):
            for sid in journey["priority_map"].get(p, []):
                if sid and sid not in known and sid in SKILLS:
                    result.append(sid)
        return result

    targets = role_targets(role_id)
    known = {_normalize(s) for s in current_skills}
    return [s for s in targets if s not in known]
