"""
Nexus Agent Package
===================
Lazy imports to avoid circular import issues.
Call build_all_graphs() to compile all LangGraph graphs.
"""

def build_all_graphs():
    """Compile all agent graphs and return as dict."""
    graphs = {}
    try:
        from .curriculum  import build_curriculum_graph
        graphs["curriculum"] = build_curriculum_graph()
    except Exception as e:
        print(f"[agents] curriculum graph failed: {e}")
    try:
        from .reasoning   import build_reasoning_graph
        graphs["reasoning"]  = build_reasoning_graph()
    except Exception as e:
        print(f"[agents] reasoning graph failed: {e}")
    try:
        from .crossskill  import build_crossskill_graph
        graphs["crossskill"] = build_crossskill_graph()
    except Exception as e:
        print(f"[agents] crossskill graph failed: {e}")
    try:
        from .capstone    import build_capstone_graph
        graphs["capstone"]   = build_capstone_graph()
    except Exception as e:
        print(f"[agents] capstone graph failed: {e}")
    try:
        from .practice    import build_practice_graph
        graphs["practice"]   = build_practice_graph()
    except Exception as e:
        print(f"[agents] practice graph failed: {e}")
    try:
        from .rag         import build_rag_graph
        graphs["rag"]        = build_rag_graph()
    except Exception as e:
        print(f"[agents] rag graph failed: {e}")
    return graphs


def get_llm_calls():
    """Return LLM call functions."""
    from .llm_calls import (
        call_socratic,
        call_session_evaluator,
        call_study_notes,
        call_flashcards,
    )
    return call_socratic, call_session_evaluator, call_study_notes, call_flashcards


# Build graphs immediately on import
GRAPHS = build_all_graphs()
call_socratic, call_session_evaluator, call_study_notes, call_flashcards = get_llm_calls()

__all__ = [
    "GRAPHS",
    "call_socratic",
    "call_session_evaluator",
    "call_study_notes",
    "call_flashcards",
    "build_all_graphs",
]
