"""
crossskill.py — Cross-Skilling Agent (LangGraph)
=================================================
Analyses a learner's skills across three lenses and recommends the
next skill or track to pursue.

Steps:
  1. Assess current skill state + load real org context (role-based learning
     journey priorities from role_learning_journey, manager's track focus from
     manager_hierarchy — both admin-uploaded, see backend/main.py's
     /api/admin/learning-journey and /api/admin/manager-hierarchy endpoints)
  2. Analyse gaps: role-journey gap (real, priority-ranked) + manager/team
     track-focus gap (real) + market demand gap
  3. Score and rank next tracks
  4. Select recommendation type (next_track / skill_bridge / certify_now)
  5. Generate structured guidance with timeline
  6. Validate recommendation against real AEP content

Previously this agent's "role gap" lens was a 5-entry hardcoded
role_track_map (analyst/engineer/architect/consultant/developer → tracks) and
its "team gap" lens read team_skill_matrix, which the frontend never actually
populated (always {}), making that whole lens permanently dead code. Both are
replaced here with real, admin-maintained data.
"""

from .config import (
    set_current_agent,
    GROQ_MODEL, ANTHROPIC_MODEL,
    groq_call, anthropic_call, get_db_url, get_db_conn, make_meta,
    PRODUCT_DISTINCTIONS, TESTOUT_PASS_THRESHOLD, QUIZ_QUESTION_COUNT,
    WEIGHT_MARKET, WEIGHT_TEAM, WEIGHT_ROLE, call_with_tools,
)

import os
import re
import json
import time
import requests

try:
    from langgraph.graph import StateGraph, END
    LANGGRAPH_AVAILABLE = True
except ImportError:
    LANGGRAPH_AVAILABLE = False

# Fallback/default track vocabulary — used for market-demand context and as a
# safety net when role_learning_journey has no rows yet (before an admin has
# uploaded the matrix) or the learner's role doesn't match any journey row.
# Real, role-specific recommendations come from role_learning_journey once
# it's populated via Admin > Cross-Skilling Data.
AVAILABLE_TRACKS = {
    "rtcdp":     {"name": "Real-Time CDP",              "demand": "Critical"},
    "ajo":       {"name": "Adobe Journey Optimizer",    "demand": "Critical"},
    "cja":       {"name": "Customer Journey Analytics", "demand": "High"},
    "analytics": {"name": "Adobe Analytics",             "demand": "Stable"},
    "aa-sdk":    {"name": "Adobe Analytics / Web SDK",   "demand": "High"},
    "target":    {"name": "Adobe Target",                "demand": "High"},
    "campaign":  {"name": "Adobe Campaign",               "demand": "Stable"},
    "marketo":   {"name": "Marketo Engage",               "demand": "Stable"},
    # B2B is not a standalone track — its real content lives inside "rtcdp"
    # (RTCDP B2B segments/accounts) and "ajo" (AJO B2B edition), per design.
    "da":        {"name": "Data Analytics",               "demand": "High"},
    "de":        {"name": "Data Engineering",              "demand": "Critical"},
    "es":        {"name": "Engineering Services",          "demand": "Stable"},
}

PROFICIENCY_RANK = {"novice": 0, "basic": 1, "intermediate": 2, "advanced": 3, "expert": 4}

# Job-title phrases that indicate the learner's OWN role already IS a given
# track's specialty — e.g. someone whose title contains "Data Engineer" already
# owns the "de" domain, so recommending them "de" as their next cross-skill is
# circular (same failure mode as recommending "Data Analytics" to an "Analytics
# Engineer"). Generic titles (Technical Consultant, Associate Consultant, etc.)
# match nothing here, so their team's own journey track is recommended normally.
ROLE_SPECIALTY_KEYWORDS = {
    "de":      ["data engineer", "data engineering"],
    "da":      ["data analyst", "data analytics", "analytics engineer", "analytics analyst"],
    "es":      ["engineering services", "es engineer", "es consultant"],
    "rtcdp":   ["cdp engineer", "cdp architect", "cdp consultant", "real-time cdp engineer"],
    "aa-sdk":  ["web sdk developer", "sdk developer", "aa-sdk engineer"],
}


def _role_specialty_tracks(role: str) -> set:
    """Track codes the learner's own job title already denotes mastery of —
    these are excluded from cross-skill candidates (see ROLE_SPECIALTY_KEYWORDS)."""
    r = (role or "").lower()
    if not r:
        return set()
    return {code for code, phrases in ROLE_SPECIALTY_KEYWORDS.items()
            if any(p in r for p in phrases)}


# Canonical role_learning_journey role code → the track code that IS that
# journey's own domain. Whichever journey ends up grounding a recommendation
# (via the learner's role, their manager/team focus, or their active track)
# implies the learner is already embedded in this track — e.g. someone whose
# team focus is RTCDP is "RTCDP people" regardless of their own job title, so
# recommending RTCDP itself back to them is circular in the same way
# recommending "de" to a Data Engineer is. Excluded like own_track/specialty.
ROLE_HOME_TRACK = {
    "RTCDP":    "rtcdp",
    "AEP - DA": "da",
    "AEP - DE": "de",
    "AA-SDK":   "aa-sdk",
    "ES":       "es",
}


def _journey_home_track(role_journey: list):
    """The track code implied by whichever canonical role this journey matched
    (role_journey rows all share one 'role' value — see _fetch_role_journey)."""
    if not role_journey:
        return None
    matched_role = role_journey[0].get("role", "")
    nk = _norm_role_key(matched_role)
    for code, track in ROLE_HOME_TRACK.items():
        if _norm_role_key(code) == nk:
            return track
    return None


def _norm_track(code: str) -> str:
    return (code or "").strip().lower().replace(" ", "-")


def _norm_role_key(s: str) -> str:
    """Alnum-only, uppercased — lets 'AEP - DA', 'AEP DA', and 'aep_da' all match."""
    return "".join(ch for ch in (s or "").upper() if ch.isalnum())


def _resolve_role_alias(role: str):
    """Map a free-text HR/profile role (e.g. 'Data Analyst') to a canonical
    role_learning_journey code (e.g. 'AEP - DA') via the admin-editable
    role_aliases table. Case-insensitive exact match. None if no alias exists —
    the caller then falls back to substring matching."""
    if not role:
        return None
    try:
        conn = get_db_conn()
        with conn.cursor() as cur:
            cur.execute("SELECT canonical_role FROM role_aliases "
                        "WHERE LOWER(alias)=LOWER(%s) LIMIT 1", (role.strip(),))
            row = cur.fetchone()
        conn.close()
        return row[0] if row else None
    except Exception as e:
        # Table may not exist yet on a fresh DB — degrade to substring matching.
        print(f"[crossskill] role alias lookup skipped: {e}")
        return None


def _fetch_role_journey(role: str) -> list:
    """Real, priority-ordered track list for a role from role_learning_journey.
    Resolution order: (1) admin-maintained alias → exact canonical match, then
    (2) alnum-normalised bidirectional substring match — since the journey matrix
    uses org-specific short codes (e.g. 'AEP - DA') that a directory Excel's Role
    column may not spell identically."""
    if not role:
        return []
    try:
        import psycopg2.extras
        conn = get_db_conn()
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT role, priority, target_proficiency, tracks, notes FROM role_learning_journey ORDER BY role, priority")
            rows = cur.fetchall()
        conn.close()
    except Exception as e:
        print(f"[crossskill] role journey fetch error: {e}")
        return []
    if not rows:
        return []
    all_roles = sorted({r["role"] for r in rows})

    # (1) Admin-maintained alias → exact canonical match (most reliable).
    alias_role = _resolve_role_alias(role)
    if alias_role:
        exact = next((r for r in all_roles
                      if _norm_role_key(r) == _norm_role_key(alias_role)), None)
        if exact:
            return [dict(r) for r in rows if r["role"] == exact]

    # (2) Fall back to alnum-normalised bidirectional substring containment.
    norm_role = _norm_role_key(role)
    matched_role = next(
        (r for r in all_roles
         if _norm_role_key(r) == norm_role
         or norm_role in _norm_role_key(r)
         or _norm_role_key(r) in norm_role),
        None,
    )
    if not matched_role:
        return []
    return [dict(r) for r in rows if r["role"] == matched_role]


def _journey_role_from_manager_focus(manager_focus: str):
    """Map a manager's Track Focus (from manager_hierarchy) to a canonical
    role_learning_journey role code. Implements the user's stated rule:
    "the roles depend on the mgr they report to" — so when a learner's own job
    title doesn't match a journey row, we ground on their manager's team focus
    instead (e.g. someone reporting to Dhanesh, whose focus is RTCDP, is treated
    as the RTCDP journey; Manjeet -> DE, Shamshul -> AA, etc).

    Uses \\b word-boundary regex, not plain substring/padding checks — the real
    manager_hierarchy data stores bare short codes ("DE", "AA", "ES") with no
    surrounding space/paren/comma, which a padding-based check like " de " or
    "de," can never match. That bug meant only RTCDP (whose bare token has no
    padding requirement) ever resolved via this path; DE/DA/ES/AA all silently
    fell through to the ungrounded fallback. Priority-ordered so the most
    specific token wins for compound focus text (e.g. "Data (RTCDP, DA)")."""
    if not manager_focus:
        return None
    f = manager_focus.lower()
    # (regex pattern, canonical journey role) — order matters for compound text.
    rules = [
        (r"data architect", "AEP - DA"),
        (r"data engineer",  "AEP - DE"),
        (r"engineering services", "ES"),
        (r"real-time cdp",  "RTCDP"),
        (r"web sdk",        "AA-SDK"),
        (r"\bda\b",         "AEP - DA"),
        (r"\bde\b",         "AEP - DE"),
        (r"\bes\b",         "ES"),
        (r"\baa[\s-]?sdk\b","AA-SDK"),
        (r"\baa\b",         "AA-SDK"),
        (r"\banalytics\b",  "AA-SDK"),
        (r"\bsdk\b",        "AA-SDK"),
        (r"\brtcdp\b",      "RTCDP"),
        (r"\bcdp\b",        "RTCDP"),
    ]
    for pattern, role in rules:
        if re.search(pattern, f):
            return role
    return None


def _fetch_manager_track_focus(manager_name: str):
    """The real track/area a learner's manager's team specializes in, from
    manager_hierarchy — a concrete substitute for the old (always-empty)
    team_skill_matrix lens."""
    if not manager_name:
        return None
    try:
        conn = get_db_conn()
        with conn.cursor() as cur:
            cur.execute("SELECT track_focus FROM manager_hierarchy WHERE manager_name ILIKE %s LIMIT 1", (manager_name,))
            row = cur.fetchone()
        conn.close()
        return row[0] if row else None
    except Exception as e:
        print(f"[crossskill] manager lookup error: {e}")
        return None


def _tracks_mentioned_in_text(text: str) -> list:
    """Match AVAILABLE_TRACKS names/codes that appear in a free-text field
    (e.g. a manager's 'Track Focus' notes like 'Data (RTCDP, DA)').
    Word-boundary matching, not a raw substring check — several codes are
    short enough (da, de, es, aa) to false-positive-match inside unrelated
    words otherwise (e.g. "da" inside "data", "de" inside "median")."""
    import re
    if not text:
        return []
    hay = text.lower()
    found = []
    for code, info in AVAILABLE_TRACKS.items():
        code_pat = re.escape(code.lower())
        name_pat = re.escape(info["name"].lower())
        if re.search(rf"\b{code_pat}\b", hay) or re.search(rf"\b{name_pat}\b", hay):
            found.append(code)
    return found

# ── Node 1: Assess current skill state + load real org context ────────────────

def node_assess_skills(state: dict) -> dict:
    """
    Build a clear picture of what the learner knows, plus their real
    role-journey priorities and manager's track focus.
    """
    completed  = set(state.get("completed_tracks", []))
    enrolled   = set(state.get("enrolled_tracks", []))
    skills     = state.get("skills", {})  # {skill_name: level}

    role_journey  = _fetch_role_journey(state.get("learner_role", ""))
    manager_focus = _fetch_manager_track_focus(state.get("manager_name", ""))

    # Fallback grounding via the manager's team focus. If the learner's own job
    # title didn't match any journey row (common for generic titles like
    # "Associate Technical Consultant"), ground on the manager's track focus —
    # "the roles depend on the mgr they report to". This is what makes someone
    # reporting to Dhanesh (RTCDP focus) get the RTCDP journey.
    grounded_via = "role" if role_journey else None
    if not role_journey and manager_focus:
        mgr_role = _journey_role_from_manager_focus(manager_focus)
        if mgr_role:
            role_journey = _fetch_role_journey(mgr_role)
            if role_journey:
                grounded_via = "manager"
    # Final fallback: the learner's OWN active track. Job titles like "Associate
    # Technical Consultant" match no journey row, and a learner may not be in the
    # HR directory (so role/manager both come back empty) — but their active
    # track code (da/de/rtcdp/es/aa-sdk) maps directly to a journey role. Without
    # this, such a learner silently got ungrounded, generic recommendations
    # instead of their real skill-map priorities.
    if not role_journey:
        active_track = _norm_track(state.get("active_track", "")) or state.get("active_track", "")
        if active_track:
            role_journey = _fetch_role_journey(active_track)
            if role_journey:
                grounded_via = "active_track"

    # Track universe: AVAILABLE_TRACKS plus anything the role journey itself
    # references (covers org-specific codes not in the static fallback dict).
    all_tracks = dict(AVAILABLE_TRACKS)
    for row in role_journey:
        for t in (row.get("tracks") or []):
            code = _norm_track(t)
            if code and code not in all_tracks:
                all_tracks[code] = {"name": t, "demand": "Stable"}

    # Exclude the learner's OWN current active track — recommending someone their
    # already-active track as the "next cross-skill" is nonsensical, and without
    # this it could win purely on demand score for a learner with no completed/
    # enrolled history yet.
    own_track = _norm_track(state.get("active_track", "")) or (state.get("active_track") or "")

    # Exclude tracks the learner's own job title already denotes mastery of —
    # e.g. a "Data Engineer" on an AEP-DE team shouldn't be told to learn "de";
    # they should get the team's OTHER journey tracks (DA/ES/RTCDP) instead.
    specialty_tracks = _role_specialty_tracks(state.get("learner_role", ""))

    # Exclude the "home" track of whichever journey grounded this recommendation
    # (role, manager/team focus, or active-track fallback) — someone whose team
    # focus IS RTCDP is "RTCDP people" regardless of their own job title, so
    # recommending RTCDP itself back to them is circular, same as the specialty
    # exclusion above but triggered by team/journey identity instead of title.
    home_track = _journey_home_track(role_journey)
    exclude_tracks = specialty_tracks | ({home_track} if home_track else set())

    # Tracks already shown to this learner earlier in the same session (the
    # frontend's "Show me something else" button) — without this, retrying
    # just re-serves the same deterministic top-scored track every time.
    seen_tracks = {_norm_track(t) for t in (state.get("exclude_tracks") or [])}

    def _excluded(t):
        return (t in completed or t in enrolled or t == own_track
                or t in exclude_tracks or t in seen_tracks)

    available = [{"track": t, **info} for t, info in all_tracks.items() if not _excluded(t)]
    # Safety net: never let the specialty/home-track/seen exclusions empty the
    # whole candidate pool — fall back progressively rather than returning zero
    # recommendations once every track has been shown.
    if not available and (exclude_tracks or seen_tracks):
        available = [{"track": t, **info} for t, info in all_tracks.items()
                     if t not in completed and t not in enrolled and t != own_track
                     and t not in exclude_tracks]
    if not available:
        available = [{"track": t, **info} for t, info in all_tracks.items()
                     if t not in completed and t not in enrolled and t != own_track]

    return {
        **state,
        "available_tracks": available,
        "all_tracks_universe": all_tracks,
        "role_journey": role_journey,
        "manager_track_focus": manager_focus,
        "grounded_via": grounded_via,
        "role_specialty_excluded": sorted(exclude_tracks),
        "skill_summary": {
            "completed_tracks": list(completed),
            "enrolled_tracks":  list(enrolled),
            "skill_levels":     skills,
        },
    }

# ── Node 2: Analyse gaps (3 real lenses) ───────────────────────────────────────

def node_analyse_gaps(state: dict) -> dict:
    """
    Three-lens gap analysis, now all grounded in real data:
    - Role gap:    tracks from role_learning_journey the learner hasn't
                   completed yet, ranked by that matrix's own priority (1-5)
    - Team gap:    tracks mentioned in the learner's manager's Track Focus
                   (manager_hierarchy) not yet completed
    - Market gap:  Critical-demand tracks not yet completed
    """
    completed     = set(state.get("completed_tracks", []))
    available     = state.get("available_tracks", [])
    role_journey  = state.get("role_journey", [])
    manager_focus = state.get("manager_track_focus")

    # Market gap
    market_gaps = [t for t in available if t.get("demand") == "Critical"]

    # Role gap — every (track, priority) pair from the matched role's journey,
    # for tracks not already completed. Lower priority number = more urgent.
    role_gaps = []
    for row in role_journey:
        for t in (row.get("tracks") or []):
            code = _norm_track(t)
            if code in completed:
                continue
            role_gaps.append({
                "track": code, "priority": row["priority"],
                "target_proficiency": row.get("target_proficiency"),
                **AVAILABLE_TRACKS.get(code, {"name": t, "demand": "Stable"}),
            })

    # Team gap — tracks named in the manager's track-focus text
    team_gaps = []
    if manager_focus:
        for code in _tracks_mentioned_in_text(manager_focus):
            if code not in completed:
                team_gaps.append({"track": code, "team_focus": manager_focus,
                                  **AVAILABLE_TRACKS.get(code, {"name": code, "demand": "Stable"})})

    return {
        **state,
        "market_gaps": market_gaps,
        "team_gaps":   team_gaps,
        "role_gaps":   role_gaps,
    }

# ── Node 3: Score and rank ─────────────────────────────────────────────────────

def node_score_and_rank(state: dict) -> dict:
    """
    Weighted scoring of available tracks: market_demand + team_gap + role_fit,
    same WEIGHT_MARKET/WEIGHT_TEAM/WEIGHT_ROLE split as before, but role_fit is
    now the track's real priority rank (1=highest) from role_learning_journey
    instead of a boolean "is this role generically associated with this track."
    """
    available   = state.get("available_tracks", [])
    market_gaps = {t["track"] for t in state.get("market_gaps", [])}
    team_gaps   = {t["track"] for t in state.get("team_gaps", [])}
    role_gaps   = {g["track"]: g["priority"] for g in state.get("role_gaps", [])}

    scored = []
    for t in available:
        track  = t["track"]
        demand = t.get("demand", "Stable")
        market_score = {"Critical": 1.0, "High": 0.7, "Stable": 0.3}.get(demand, 0.3)
        team_score   = 1.0 if track in team_gaps else 0.0
        # Priority 1 → 1.0, priority 5 → 0.2; not in the role journey at all → 0.0
        role_score   = (1.0 - (role_gaps[track] - 1) / 4.0) if track in role_gaps else 0.0

        total = market_score * WEIGHT_MARKET + team_score * WEIGHT_TEAM + role_score * WEIGHT_ROLE

        scored.append({
            **t,
            "score":        round(total, 3),
            "market_score": market_score,
            "team_score":   team_score,
            "role_score":   role_score,
            "role_priority": role_gaps.get(track),
        })

    # Tie-break: when scores are equal (most commonly an ungrounded learner —
    # no role_journey match — where role_score is 0 for every track and several
    # share the same demand tier), Python's stable sort would otherwise always
    # keep AVAILABLE_TRACKS' declaration order, which put "rtcdp" first — so
    # EVERY ungrounded learner silently got the same "rtcdp" recommendation
    # regardless of role. Break ties alphabetically by track code instead, so
    # the result is still deterministic but not systematically biased to one
    # hardcoded track.
    ranked = sorted(scored, key=lambda x: (-x["score"], x["track"]))
    return {**state, "ranked_tracks": ranked}

# ── Node 4: Select recommendation type ───────────────────────────────────────

def node_select_rec_type(state: dict) -> dict:
    """
    Decide whether to recommend:
    - next_track:    full track enrolment
    - skill_bridge:  specific modules from another track
    - certify_now:   learner has enough knowledge to certify
    """
    ranked     = state.get("ranked_tracks", [])
    completed  = set(state.get("completed_tracks", []))
    skills     = state.get("skills", {})
    certs      = state.get("certifications", [])

    if not ranked:
        return {**state, "rec_type": "next_track", "recommended_track": None}

    top        = ranked[0]
    track      = top["track"]

    # If the learner has high skills in a track but no cert → certify_now
    track_skill = skills.get(track, 0)
    already_certified = any(track in c.lower() for c in certs)

    if track_skill >= 2.5 and not already_certified:
        rec_type = "certify_now"
    elif len(completed) >= 2:
        # Experienced learner — bridge specific modules
        rec_type = "skill_bridge"
    else:
        rec_type = "next_track"

    return {**state, "rec_type": rec_type, "recommended_track": track}

# ── Tool-calling: real data the model can pull on demand ──────────────────────
# Previously every fact the model might need was pre-computed in Python and
# stuffed into one context string, whether relevant or not — including a
# generic self-assessed SKILLS list (see main.py's buildPrompt) that had
# nothing to do with the role-based skill map, which confused the model into
# asking the learner to re-state their track instead of using the real
# recommendation already computed. These tools expose the SAME real, already-
# scored data (ranked_tracks, role_learning_journey, generate_learning_path)
# as callable functions, so the model fetches exactly what a question needs.

def _crossskill_tools() -> list:
    return [
        {"type": "function", "function": {
            "name": "get_full_ranking",
            "description": "Get the complete list of candidate tracks for this learner, ranked by real score (market demand + team gap + role-journey priority). Use this to discuss alternatives to the top recommendation or answer 'what about X track'.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        }},
        {"type": "function", "function": {
            "name": "get_track_details",
            "description": "Get details for one specific track: its full name, market demand, role-journey priority (1=highest) and target proficiency for this learner's role, and whether they've already completed/enrolled in it.",
            "parameters": {"type": "object", "properties": {
                "track_code": {"type": "string", "description": "Track code, e.g. rtcdp, ajo, cja, analytics, aa-sdk, target, campaign, marketo, da, de, es"},
            }, "required": ["track_code"]},
        }},
        {"type": "function", "function": {
            "name": "get_learning_path",
            "description": "Get the real, ordered module-by-module learning path for a track (what the learner would actually study, in order). Use this when the learner asks what a track involves or wants a concrete plan.",
            "parameters": {"type": "object", "properties": {
                "track_code": {"type": "string", "description": "Track code to build the path for"},
            }, "required": ["track_code"]},
        }},
        {"type": "function", "function": {
            "name": "get_learner_context",
            "description": "Get this learner's real profile context: role, manager, tenure, team, bandwidth %, which tracks they've completed/enrolled in, and their manager's team track focus. Use this to ground 'why does this help me/my team' answers in real facts instead of guessing.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        }},
    ]


def _crossskill_tool_executor(state: dict):
    """Build a tool executor closure bound to this learner's already-computed
    state (ranked_tracks, role_journey, etc.) — no extra DB round-trips needed
    for the ranking/context tools; get_learning_path calls the real service."""
    ranked = state.get("ranked_tracks", [])
    by_track = {t["track"]: t for t in ranked}
    role_journey = state.get("role_journey", [])

    def executor(name: str, args: dict):
        if name == "get_full_ranking":
            return [{"track": t["track"], "name": t.get("name", t["track"]),
                     "score": t.get("score"), "demand": t.get("demand"),
                     "role_priority": t.get("role_priority")} for t in ranked[:8]]
        if name == "get_track_details":
            code = _norm_track(args.get("track_code", ""))
            t = by_track.get(code)
            if not t:
                return {"error": f"'{code}' is not an available track for this learner (already completed/enrolled, or unknown code)."}
            row = next((r for r in role_journey if code in [_norm_track(x) for x in (r.get("tracks") or [])]), None)
            return {
                "track": code, "name": t.get("name", code), "demand": t.get("demand"),
                "role_priority": t.get("role_priority"),
                "target_proficiency": row.get("target_proficiency") if row else None,
                "already_completed": code in set(state.get("completed_tracks", [])),
                "already_enrolled": code in set(state.get("enrolled_tracks", [])),
            }
        if name == "get_learning_path":
            code = _norm_track(args.get("track_code", ""))
            try:
                from services import generate_learning_path
                path = generate_learning_path(code, include_prerequisites=True)
                return {"track": code, "learning_path": path}
            except Exception as e:
                return {"error": f"Could not build learning path for '{code}': {e}"}
        if name == "get_learner_context":
            return {
                "role": state.get("learner_role"), "manager": state.get("manager_name"),
                "tenure_months": state.get("tenure_months"), "team": state.get("team_name"),
                "bandwidth_pct": state.get("bandwidth_pct"),
                "completed_tracks": state.get("completed_tracks", []),
                "enrolled_tracks": state.get("enrolled_tracks", []),
                "manager_track_focus": state.get("manager_track_focus"),
                "grounded_via": state.get("grounded_via"),
            }
        return {"error": f"Unknown tool '{name}'"}

    return executor


# ── Node 5: Generate guidance ─────────────────────────────────────────────────

GUIDANCE_SYSTEM = """You are the Nexus Cross-Skilling Agent.
Generate specific, actionable guidance for a learner's next skill step.
Be concrete — mention real AEP products, capabilities, and learning paths.
Ground your reasoning in the role-based learning journey priority and target
proficiency given to you — don't invent generic advice when a real priority
and proficiency target are provided. You have tools available to look up the
full ranking, details on any specific track, a real learning path, or the
learner's own profile context — use them instead of guessing.

{product_distinctions}

Respond ONLY with valid JSON — no other text.

JSON format:
{{
  "recommendation_type": "next_track|skill_bridge|certify_now",
  "recommended_track":   "track code, e.g. rtcdp, ajo, cja, analytics, aa-sdk, target, campaign, marketo, da, de, es",
  "title":               "short recommendation title",
  "why_this_skill":      "2-3 sentences: why this matters for their role + team",
  "what_youll_learn":    ["capability 1", "capability 2", "capability 3"],
  "estimated_weeks":     4,
  "demand_signal":       "Critical|High|Stable",
  "first_step":          "exactly what to do first",
  "team_impact":         "how this fills a gap on the team"
}}
"""

def node_generate_guidance(state: dict) -> dict:
    ranked    = state.get("ranked_tracks", [])
    rec_type  = state.get("rec_type", "next_track")
    top_track = state.get("recommended_track", "")
    role      = state.get("learner_role", "Analyst")
    team      = state.get("team_name", "AEP Analytics APAC")
    bw        = state.get("bandwidth_pct", 80)  # B.N %
    manager_focus = state.get("manager_track_focus")
    tenure_months = state.get("tenure_months")

    if not ranked:
        return {
            **state,
            "guidance_result": {
                "recommendation_type": "next_track",
                "recommended_track":   None,
                "title":               "All tracks completed",
                "why_this_skill":      "You have completed all available tracks.",
                "what_youll_learn":    [],
                "estimated_weeks":     0,
                "demand_signal":       "Stable",
                "first_step":          "Pursue certification in your strongest track.",
                "team_impact":         "Consider mentoring newer team members.",
            },
        }

    top  = next((t for t in ranked if t["track"] == top_track), ranked[0])
    weeks = max(4, int(9 * (1 - bw / 100) + 4))  # more BW → fewer weeks

    context = (
        f"Role: {role}\n"
        f"Tenure: {f'{tenure_months} months' if tenure_months is not None else 'not on file'}\n"
        f"Team: {team}\n"
        f"Manager's team track focus: {manager_focus or 'not on file'}\n"
        f"Recommended track: {top.get('name', top_track)}\n"
        f"Recommendation type: {rec_type}\n"
        f"Market demand: {top.get('demand', 'Stable')}\n"
        f"Role-journey priority: {top.get('role_priority') or 'not in role journey'} (1=most viable next track, 5=optional)\n"
        f"Target proficiency for this track at this role: {top.get('target_proficiency') or 'not specified'}\n"
        f"Estimated bandwidth available: {bw}%\n"
        f"Estimated weeks: {weeks}\n"
        f"Completed tracks: {state.get('completed_tracks', [])}"
    )

    try:
        resp = call_with_tools(
            [{"role": "user", "content": context}],
            GUIDANCE_SYSTEM.format(product_distinctions=PRODUCT_DISTINCTIONS),
            _crossskill_tools(), _crossskill_tool_executor(state),
            max_tokens=600, max_rounds=3, agent="CrossSkilling",
        )
        raw    = resp["content"].strip().strip("```json").strip("```").strip()
        result = json.loads(raw)
    except Exception as e:
        print(f"[crossskill] guidance error: {e}")
        result = {
            "recommendation_type": rec_type,
            "recommended_track":   top_track,
            "title":               f"Start {top.get('name', top_track)}",
            "why_this_skill":      f"{top.get('name', top_track)} is in {top.get('demand','High')} demand.",
            "what_youll_learn":    ["Core capabilities", "Real-world implementation", "Certification prep"],
            "estimated_weeks":     weeks,
            "demand_signal":       top.get("demand", "High"),
            "first_step":          f"Enrol in the {top.get('name', top_track)} learning track.",
            "team_impact":         "Fills a gap in the team skill matrix.",
        }

    # The scoring pipeline (node_score_and_rank / node_select_rec_type) already
    # decided which track and rec_type are correct — the LLM's only job is to
    # write compelling copy about that decision, not re-decide it. Observed in
    # testing: the model sometimes echoes a different (plausible-sounding but
    # wrong) track in its own JSON despite being told the recommended one,
    # which would otherwise silently show the learner a track that doesn't
    # match what was actually scored/ranked.
    result["recommended_track"]   = top_track
    result["recommendation_type"] = rec_type
    result.setdefault("demand_signal", top.get("demand", "Stable"))

    return {**state, "guidance_result": result}

# ── Node 6: Validate ──────────────────────────────────────────────────────────

def node_validate(state: dict) -> dict:
    result       = state.get("guidance_result", {})
    rec_track    = _norm_track(result.get("recommended_track", ""))
    completed    = set(state.get("completed_tracks", []))
    known_tracks = set(state.get("all_tracks_universe", AVAILABLE_TRACKS).keys())
    issues       = []

    if rec_track and rec_track in completed:
        issues.append(f"Recommended track {rec_track} is already completed")

    if rec_track and rec_track not in known_tracks:
        issues.append(f"Unknown track: {rec_track}")

    return {**state, "validation_ok": len(issues) == 0, "validation_issues": issues}

# ── Build Graph ────────────────────────────────────────────────────────────────

def build_crossskill_graph():
    if not LANGGRAPH_AVAILABLE:
        return None

    g = StateGraph(dict)
    g.add_node("assess",     node_assess_skills)
    g.add_node("analyse",    node_analyse_gaps)
    g.add_node("score",      node_score_and_rank)
    g.add_node("rec_type",   node_select_rec_type)
    g.add_node("guidance",   node_generate_guidance)
    g.add_node("validate",   node_validate)

    g.set_entry_point("assess")
    g.add_edge("assess",   "analyse")
    g.add_edge("analyse",  "score")
    g.add_edge("score",    "rec_type")
    g.add_edge("rec_type", "guidance")
    g.add_edge("guidance", "validate")
    g.add_edge("validate", END)

    return g.compile()

# ── Callable entry point ───────────────────────────────────────────────────────

def run_crossskill(context: dict, graph=None) -> dict:
    """
    Run the cross-skilling agent.

    Args:
        context: dict with completed_tracks, enrolled_tracks, skills,
                 learner_role, manager_name, bandwidth_pct, certifications.
                 learner_role and manager_name drive real lookups against
                 role_learning_journey and manager_hierarchy respectively
                 (both admin-uploaded — see /api/admin/learning-journey and
                 /api/admin/manager-hierarchy in backend/main.py).
        graph: compiled LangGraph graph (optional)

    Returns:
        {guidance, ranked_tracks, validation_ok, meta}
    """
    set_current_agent("CrossSkilling")
    start = time.time()
    state = {**context}

    if graph is not None:
        try:
            final = graph.invoke(state)
        except Exception as e:
            print(f"[crossskill] graph error: {e}, running inline")
            graph = None

    if graph is None:
        state = node_assess_skills(state)
        state = node_analyse_gaps(state)
        state = node_score_and_rank(state)
        state = node_select_rec_type(state)
        state = node_generate_guidance(state)
        state = node_validate(state)
        final = state

    return {
        "guidance":          final.get("guidance_result", {}),
        "ranked_tracks":     final.get("ranked_tracks", []),
        "rec_type":          final.get("rec_type", "next_track"),
        "role_journey_matched": bool(final.get("role_journey")),
        "manager_track_focus":  final.get("manager_track_focus"),
        "grounded_via":         final.get("grounded_via"),
        "validation_ok":     final.get("validation_ok", True),
        "validation_issues": final.get("validation_issues", []),
        "meta": {
            "type":             "agent",
            "name":             "crossskill",
            "engine":           "langgraph" if LANGGRAPH_AVAILABLE else "sequential",
            "model":            GROQ_MODEL,
            "steps_executed":   6,
            "latency_ms":       round((time.time() - start) * 1000),
            "recommended_track": final.get("recommended_track", ""),
            "rec_type":          final.get("rec_type", ""),
            "grounded_in_role_journey": bool(final.get("role_journey")),
        },
    }


CHAT_SYSTEM = """You are the Nexus Cross-Skilling Agent, chatting with a learner
about their upskilling options.

You have tools to look up this learner's REAL ranked track recommendations,
details on any specific track, a real learning path for a track, and their own
profile context (role, manager, completed/enrolled tracks). ALWAYS use a tool
before answering a question about "what should I learn", "why does X help",
"what's involved in Y", or anything about their recommendation — never guess
or ask the learner to repeat information you can look up yourself.

CRITICAL: You CANNOT change a learner's enrolled track yourself. If they want
to switch, tell them: "Go to Learning Path → choose a cross-skill track" (the
UI where tracks are actually added). You only advise; you don't take actions
on their account.

{product_distinctions}

Be concrete and specific — real AEP product names, real learning-path steps.
Keep responses under 100 words unless the learner asked for a full learning
path (then list the modules). No markdown headers, plain conversational text.
"""


def run_crossskill_chat(messages: list, context: dict) -> dict:
    """Free-text follow-up conversation about the learner's cross-skilling
    recommendation, using the SAME real ranking/role-journey data as
    run_crossskill (computed once via the deterministic scoring pipeline) but
    exposed as tools the model calls on demand — this is what actually fixed
    the bug where chat replies didn't know the already-computed recommendation
    (previously a generic self-assessed skills list was stuffed into the
    prompt instead, which confused the model into asking the learner to
    re-state their track). Returns {"response": str}."""
    set_current_agent("CrossSkilling")
    state = {**context}
    state = node_assess_skills(state)
    state = node_analyse_gaps(state)
    state = node_score_and_rank(state)
    state = node_select_rec_type(state)

    try:
        resp = call_with_tools(
            messages,
            CHAT_SYSTEM.format(product_distinctions=PRODUCT_DISTINCTIONS),
            _crossskill_tools(), _crossskill_tool_executor(state),
            max_tokens=500, max_rounds=4, agent="CrossSkilling",
        )
        return {"response": resp["content"] or "I couldn't generate a response — please try rephrasing your question."}
    except Exception as e:
        print(f"[crossskill] chat error: {e}")
        return {"response": f"I'm having trouble reaching the advisor right now: {e}"}
