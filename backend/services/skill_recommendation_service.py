"""
skill_recommendation_service.py — Cross-Skilling recommendation (spec-shaped)
=============================================================================
The existing agents/crossskill.py ranks TRACKS across 3 lenses. This service
adapts that idea to the spec's exact request/response contract and adds the
upskill-vs-cross-skill decision + a next_action, using the Adobe skill map.

Request (from the spec):
    current_skills:     ["rtcdp", ...]        (ids or labels)
    current_level:      beginner|intermediate|advanced
    target_role:        "Data Architect"
    career_goal:        free text
    preferred_direction: upskill|cross-skill|either

Response (from the spec):
    {
      "recommended_skill": "...",
      "recommendation_type": "upskill|cross-skill",
      "reason": "...",
      "current_level": "...",
      "target_level": "...",
      "confidence": "low|medium|high",
      "supporting_signals": [...],
      "next_action": "start_learning_path|take_diagnostic_quiz|review_prerequisite"
    }

Scoring reuses the configured weights (market / team / role) from config so the
one place to tune weighting stays authoritative. LLM is used only to phrase the
`reason`; the CHOICE is deterministic and explainable.
"""

from __future__ import annotations

from agents import domain_data as D
from agents.config import (
    WEIGHT_MARKET, WEIGHT_TEAM, WEIGHT_ROLE, GROQ_MODEL, groq_call,
)

_LEVEL_NEXT = {"beginner": "intermediate", "intermediate": "advanced", "advanced": "advanced"}
_DEMAND_SCORE = {"Critical": 1.0, "High": 0.7, "Stable": 0.4}


def _known_skill_ids(current_skills: list[str]) -> set[str]:
    out = set()
    for s in current_skills or []:
        sid = D._normalize(s)
        if sid:
            out.add(sid)
    return out


def _reason_text(skill_label, rec_type, role, signals) -> str:
    """Phrase the recommendation reason with the LLM; fall back to a template."""
    try:
        prompt = (
            f"In 2 sentences, explain why '{skill_label}' is the best next "
            f"{'upskilling' if rec_type == 'upskill' else 'cross-skilling'} choice "
            f"for someone targeting the role '{role or 'Adobe practitioner'}'. "
            f"Supporting signals: {', '.join(signals)}. Be specific to Adobe Experience "
            f"Platform / Journeys. No preamble."
        )
        txt = groq_call(
            [{"role": "user", "content": prompt}],
            "You are a concise Adobe careers advisor. Reply with 2 sentences only.",
            max_tokens=120,
        ).strip()
        if txt:
            return txt
    except Exception as e:
        print(f"[skill_rec] reason llm fallback ({e})")
    return (
        f"{skill_label} builds directly on your current foundation and is a strong "
        f"{'deepening' if rec_type == 'upskill' else 'adjacent'} move toward "
        f"{role or 'your target role'}."
    )


def recommend_skill(
    current_skills: list[str],
    current_level: str = "beginner",
    target_role: str = "",
    career_goal: str = "",
    preferred_direction: str = "either",
) -> dict:
    known = _known_skill_ids(current_skills)
    role_needs = D.role_targets(target_role)
    role_need_set = set(role_needs)
    families_known = {D.SKILLS[k]["family"] for k in known if k in D.SKILLS}

    candidates = []
    for sid, spec in D.SKILLS.items():
        if sid in known:
            continue  # already have it

        prereqs = set(spec.get("prerequisites", []))
        prereqs_met = prereqs.issubset(known) if prereqs else True

        # upskill = same family as something known; cross-skill = new family
        is_upskill = spec["family"] in families_known if families_known else False
        rec_type = "upskill" if is_upskill else "cross-skill"

        # direction preference filter
        if preferred_direction == "upskill" and rec_type != "upskill":
            continue
        if preferred_direction == "cross-skill" and rec_type != "cross-skill":
            continue

        market = _DEMAND_SCORE.get(D.MARKET_DEMAND.get(sid, "Stable"), 0.4)
        role_fit = 1.0 if sid in role_need_set else 0.0
        # "team gap" proxy: role needs it AND prereqs are met (ready to fill now)
        team_gap = 1.0 if (sid in role_need_set and prereqs_met) else 0.0

        score = market * WEIGHT_MARKET + team_gap * WEIGHT_TEAM + role_fit * WEIGHT_ROLE
        # small penalty if prerequisites are NOT met (still allowed, ranked lower)
        if not prereqs_met:
            score *= 0.6

        candidates.append({
            "skill_id": sid,
            "label": spec["label"],
            "rec_type": rec_type,
            "score": round(score, 3),
            "market": D.MARKET_DEMAND.get(sid, "Stable"),
            "role_fit": bool(role_fit),
            "prereqs_met": prereqs_met,
            "missing_prereqs": sorted(prereqs - known),
        })

    if not candidates:
        return {
            "recommended_skill": None,
            "recommendation_type": preferred_direction if preferred_direction != "either" else "upskill",
            "reason": "You already cover the available skills for this direction. Consider certification or mentoring.",
            "current_level": current_level,
            "target_level": _LEVEL_NEXT.get(current_level, "advanced"),
            "confidence": "low",
            "supporting_signals": ["all mapped skills already held"],
            "next_action": "take_diagnostic_quiz",
        }

    candidates.sort(key=lambda c: c["score"], reverse=True)
    top = candidates[0]

    # Build supporting signals in the spec's style
    signals = [f"current level: {current_level}"]
    if target_role:
        signals.append(f"target role: {target_role}")
    if top["role_fit"]:
        signals.append("required by target role")
    signals.append(f"market demand: {top['market']}")
    if known:
        signals.append(f"completed skills: {', '.join(sorted(known))}")

    # confidence: high if role-fit + prereqs met + strong market
    if top["role_fit"] and top["prereqs_met"] and top["market"] in ("Critical", "High"):
        confidence = "high"
    elif top["prereqs_met"]:
        confidence = "medium"
    else:
        confidence = "low"

    # next action
    if not top["prereqs_met"]:
        next_action = "review_prerequisite"
    elif current_level == "beginner":
        next_action = "start_learning_path"
    else:
        next_action = "take_diagnostic_quiz"

    return {
        "recommended_skill": top["label"],
        "recommended_skill_id": top["skill_id"],
        "recommendation_type": top["rec_type"],
        "reason": _reason_text(top["label"], top["rec_type"], target_role, signals),
        "current_level": current_level,
        "target_level": _LEVEL_NEXT.get(current_level, "advanced"),
        "confidence": confidence,
        "supporting_signals": signals,
        "next_action": next_action,
        "missing_prerequisites": top["missing_prereqs"],
        "ranked_alternatives": candidates[1:4],
        "meta": {"type": "service", "name": "skill_recommendation", "model": GROQ_MODEL,
                 "weights": {"market": WEIGHT_MARKET, "team": WEIGHT_TEAM, "role": WEIGHT_ROLE}},
    }
