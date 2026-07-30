"""
services — modular, reusable business services for the learning-agent platform.

  learning_path_service        generate an ordered learning path for a skill
  skill_recommendation_service spec-shaped cross-skilling recommendation

Quiz / curriculum / NBA services already live in agents/curriculum.py and are
reused as-is (not duplicated here).
"""

from .learning_path_service import generate_learning_path
from .skill_recommendation_service import recommend_skill

__all__ = ["generate_learning_path", "recommend_skill"]
