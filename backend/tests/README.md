# Backend tests

Fast, self-contained pytest suite covering the critical paths. Runs in-process
against the FastAPI app (`TestClient`) using the local Postgres. Every test row
is prefixed `pytest_` and cleaned up automatically, so real data is never touched.

## Run

```bash
cd backend
pip install pytest            # once
python -m pytest              # all tests
python -m pytest tests/test_community.py -v
```

Requires `DATABASE_URL` (from `backend/.env`) to point at a reachable Postgres,
and `OPENAI_API_KEY` set for the provider-key assertion.

## Coverage

- `test_agents.py` — the LangGraph graphs compile/load, provider keys are read,
  RAGAS thresholds are surfaced. (LLM agents are not invoked — slow/non-deterministic.)
- `test_community.py` — visibility scoping (private / team / public),
  author-only edit & delete (403 for others), mention notifications, and
  quality-based kudos scoring.
- `test_remediation.py` — on-track learners get an empty plan; struggling
  learners get a plan ranked hardest-first; passed test-outs aren't flagged.
