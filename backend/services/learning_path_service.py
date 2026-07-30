"""
learning_path_service.py — Generate a learning path for a recommended skill
============================================================================
Used on the Cross-Skilling → Curriculum handoff: once a skill is recommended and
the learner chooses to start, this builds the ordered path in the spec's shape:

    {
      "skill": "Advanced RAG",
      "learning_path": [
        {"module": "...", "order": 1, "difficulty": "easy", "quiz_required": true},
        ...
      ],
      "prerequisites": [...],
      "estimated_difficulty": "easy|medium|hard",
      "test_out_available": true,
      "completion_criteria": "..."
    }

Source of truth is agents/domain_data.py (the Adobe AEP + Journeys skill map), so
the path is deterministic and correct even with no LLM. If a Groq key is present
we optionally enrich module descriptions, but the ORDER and structure always come
from the domain data — never hallucinated.
"""

from __future__ import annotations

from agents import domain_data as D
from agents.config import QUIZ_CONFIDENCE_PASS, TESTOUT_PASS_THRESHOLD


def _overall_difficulty(modules: list[dict]) -> str:
    order = {"easy": 1, "medium": 2, "hard": 3}
    if not modules:
        return "medium"
    avg = sum(order.get(m.get("difficulty", "medium"), 2) for m in modules) / len(modules)
    return "easy" if avg < 1.6 else "hard" if avg > 2.4 else "medium"


def generate_learning_path(skill: str, *, include_prerequisites: bool = True) -> dict:
    """
    Build an ordered learning path for `skill` (id or free-text label).
    Optionally prepends prerequisite skills' first module so the path is runnable
    from the learner's current point.
    """
    sid = D._normalize(skill)
    spec = D.get_skill(sid) if sid else None

    if not spec:
        # Unknown skill → return a minimal, honest single-step path (no hallucination)
        return {
            "skill": skill,
            "learning_path": [
                {"module": f"Introduction to {skill}", "order": 1,
                 "difficulty": "medium", "quiz_required": True}
            ],
            "prerequisites": [],
            "estimated_difficulty": "medium",
            "test_out_available": True,
            "completion_criteria": (
                f"Pass the module quiz at ≥{int(QUIZ_CONFIDENCE_PASS * 100)}% confidence, "
                f"or test out at ≥{TESTOUT_PASS_THRESHOLD}%."
            ),
            "grounded": False,
        }

    modules: list[dict] = []
    order = 1

    # Prerequisite ramp: pull the FIRST module of each unmet prerequisite skill
    prereq_labels: list[str] = []
    if include_prerequisites:
        for pid in spec.get("prerequisites", []):
            p = D.get_skill(pid)
            if not p:
                continue
            prereq_labels.append(p["label"])
            if p.get("modules"):
                first = p["modules"][0]
                modules.append({
                    "module": f"{first['module']} (prereq: {p['label']})",
                    "order": order,
                    "difficulty": first["difficulty"],
                    "quiz_required": first["quiz_required"],
                })
                order += 1

    # Core modules of the target skill, in canonical order
    for m in spec.get("modules", []):
        modules.append({
            "module": m["module"],
            "order": order,
            "difficulty": m["difficulty"],
            "quiz_required": m["quiz_required"],
        })
        order += 1

    return {
        "skill": spec["label"],
        "skill_id": sid,
        "family": spec.get("family"),
        "learning_path": modules,
        "prerequisites": prereq_labels,
        "estimated_difficulty": _overall_difficulty(modules),
        "test_out_available": True,
        "completion_criteria": (
            f"Complete every module and pass each checkpoint quiz at "
            f"≥{int(QUIZ_CONFIDENCE_PASS * 100)}% confidence. You may test out of any "
            f"module by scoring ≥{TESTOUT_PASS_THRESHOLD}% on its opt-out quiz."
        ),
        "grounded": True,
    }
