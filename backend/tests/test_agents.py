"""Agent wiring — the LangGraph graphs are compiled and provider keys are read.

We deliberately DON'T invoke the LLM agents here (slow, costs tokens, and the
output is non-deterministic). The status endpoint is the fast, deterministic
proxy for "the agents loaded and are ready to serve."
"""


def test_agents_status_graphs_loaded(client):
    r = client.get("/api/agents/status")
    assert r.status_code == 200
    j = r.json()
    # At least the core graphs should be compiled.
    assert isinstance(j.get("graphs_compiled"), list)
    assert len(j["graphs_compiled"]) >= 5
    for g in ("rag", "reasoning", "curriculum", "capstone", "practice"):
        assert g in j["graphs_compiled"], f"{g} graph not compiled"


def test_agents_status_provider_keys(client):
    j = client.get("/api/agents/status").json()
    keys = j.get("provider_keys_configured", {})
    for p in ("openai", "anthropic", "groq"):
        assert p in keys
    # OpenAI is the primary provider and RAGAS requires it — it must be present.
    assert keys["openai"] is True


def test_ai_safety_ragas_thresholds(client):
    """RAGAS threshold config is surfaced (the AI Safety dashboard reads this)."""
    j = client.get("/api/admin/ai-safety").json()
    t = j.get("ragas_thresholds", {})
    assert "good" in t and "warn" in t
    assert 0 < t["warn"] < t["good"] <= 1
