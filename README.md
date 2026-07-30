# Nexus — Adobe Internal Learning Platform

An AI-agent-powered learning platform: a React (Vite) frontend with four
persona-routed dashboards (New Joiner, Experienced, Manager, Admin) backed by
a FastAPI service that runs 9 LangGraph agents (curriculum guidance,
cross-skilling recommendations, capstone review, practice, study aid,
reasoning, Socratic tutoring, team intel, and RAG/doc search) plus a
Postgres/pgvector-backed retrieval layer.

## Prerequisites
- Node.js 20+ / npm
- Python 3.11 (later versions have had wheel-compatibility issues with a few pinned backend packages)
- PostgreSQL 14+ (the `vector`/pgvector extension is recommended but not required — RAG falls back to in-memory cosine search without it)
- At least one of a Groq API key or an Anthropic API key (powers the AI agents)

## How to run

### 1. Clone
```bash
git clone <this-repo-url>
cd "Final Dashboard"
```

### 2. Backend
```bash
cd backend
python -m venv venv
venv\Scripts\Activate.ps1        # Windows PowerShell; use venv/bin/activate on macOS/Linux
pip install --upgrade pip
pip install -r requirements.txt
copy .env.example .env           # then fill in DATABASE_URL, GROQ_API_KEY/ANTHROPIC_API_KEY, SESSION_SECRET
```
Create the database once (in `psql`): `CREATE DATABASE nexus;`

Start the API:
```bash
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```
A successful boot ends with `✓ All tables ready` and serves Swagger docs at http://127.0.0.1:8000/docs — tables are created automatically, no separate migration step needed for a fresh DB.

Optional, for a fuller demo — seed real curriculum content (needs internet access):
```bash
python scripts/seed_curriculum.py
```

### 3. Frontend
In a second terminal, with the backend still running:
```bash
cd "Final Dashboard"
npm install
npm run dev
```
Vite prints a local URL (defaults to HTTPS with a self-signed cert on `https://localhost:5173` — click through the browser security warning, or set `NEXUS_NO_SSL=1` before `npm run dev` for plain HTTP). The dev server proxies `/api/*` to `http://localhost:8000`, so the backend must be running first.

### 4. Verify
- Backend logs show `✓ All tables ready`
- `npm run build` completes cleanly
- Demo persona login works without any Adobe IMS config
- Learning Path / dashboards load without console errors

Full step-by-step (fresh-machine installs, pgvector setup, `.env` reference, troubleshooting table) is in **[SETUP_GUIDE.md](SETUP_GUIDE.md)**.

## Project layout
```
src/                  React frontend (Vite). src/App.jsx is the main app shell.
backend/
  main.py             FastAPI app: endpoints, table creation, agent mounting
  ims_auth.py         Adobe SSO + profile/track resolution
  agents/             LangGraph agents (curriculum, crossskill, capstone, practice,
                      study_aid, reasoning, socratic, rag) + shared config/tools
  services/           Learning-path generation, skill recommendation
  rag/                PDF ingestion, RAG init helpers
  guardrails/         Input/output safety checks
  evaluation/         RAGAS-based groundedness/relevance scoring
  scripts/            One-off seed/migration scripts (see SETUP_GUIDE.md §4-5)
unwanted/             Superseded/dead code and scratch artifacts kept for
                      reference, excluded from git (see CLEANUP_NOTES.md)
```

## Other docs
- **[CHECKLIST.md](CHECKLIST.md)** — manual verification checklist
- **[TODO.md](TODO.md)** / **[GAPS_AND_LIMITATIONS.md](GAPS_AND_LIMITATIONS.md)** — known gaps and open work
- **[WORK_COMPLETED.md](WORK_COMPLETED.md)** — session-by-session change history
- **[nexus_workflow.md](nexus_workflow.md)** — agent/architecture/DB-schema overview
- **[CLEANUP_NOTES.md](CLEANUP_NOTES.md)** — what was reorganized/removed in the latest cleanup pass, and why
