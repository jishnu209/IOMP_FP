"""
guardrails — reusable input/output validation for every agent.

Usage:
    from guardrails import check_input, check_output, blocked_response

    gate = check_input(user_query)
    if not gate["ok"]:
        return gate["blocked"]            # spec-shaped {status, reason, safe_response}

    ... run agent ...

    verdict = check_output(answer, agent="rag", expect_citations=True, grounded=grounded)
    answer = verdict["answer"]            # possibly annotated
"""

from .policy import blocked_response, in_scope, is_injection, is_unsafe
from .input_guardrails import check_input
from .output_guardrails import check_output

__all__ = [
    "check_input",
    "check_output",
    "blocked_response",
    "in_scope",
    "is_injection",
    "is_unsafe",
]
