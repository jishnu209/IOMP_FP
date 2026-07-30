# New Laptop Setup Guide — Nexus Dashboard

Step-by-step for getting this project running from a completely fresh Windows
machine. Follow in order — later steps assume earlier ones are done.

---

## 0. What you're installing (overview)

| Component | Purpose | Required? |
|---|---|---|
| Git | clone/manage the repo | Yes |
| Node.js 20+ / npm | frontend (React + Vite) | Yes |
| Python 3.11 | backend (FastAPI) | Yes |
| PostgreSQL 14+ | all app data | Yes |
| `vector` Postgres extension (pgvector) | fast RAG retrieval | Recommended, not required |
| GitHub personal access token | raises AdobeDocs fetch rate limit | Optional |
| Groq and/or Anthropic API key | powers the AI agents | Yes (at least one) |
| Adobe IMS OAuth client | real Adobe SSO login | Optional (demo login works without it) |

---

## 1. Install prerequisites

### Git
Download from https://git-scm.com/download/win and install with defaults.

### Node.js
Install Node **20 LTS or newer** from https://nodejs.org (this project was
built against Node 24, but 20+ works). Verify:
```bash
node --version
npm --version
```

### Python
Install **Python 3.11** from https://www.python.org/downloads/ (check "Add
python.exe to PATH" during install). This project pins several packages
(`llama-index-*`, `langgraph`, `pgvector`, `asyncpg`) to versions validated
against 3.11 — Python 3.13 has been observed to have missing/incompatible
wheels for some of these, so avoid it for this project's venv. Verify:
```bash
python --version
```

### PostgreSQL
Install PostgreSQL 14+ from https://www.postgresql.org/download/windows/
(the EDB installer is simplest). During setup:
- Set and remember a password for the `postgres` superuser.
- Default port `5432` is fine unless something else is using it.
- Install **Stack Builder** components if offered — not required for this
  project, can skip.

After install, open **SQL Shell (psql)** (installed alongside Postgres) and
create the app database:
```sql
CREATE DATABASE nexus;
```

### pgvector extension (recommended, not required)
The RAG retriever works without this (falls back to in-memory cosine search),
but is much faster with it. Easiest path on Windows: use the prebuilt
extension bundled with recent PostgreSQL installers, or build from
https://github.com/pgvector/pgvector (requires Visual Studio Build Tools — if
that's friction, skip this step and revisit later; nothing breaks without it).
Once available:
```sql
\c nexus
CREATE EXTENSION IF NOT EXISTS vector;
```

---

## 2. Clone the repository

```bash
git clone <repo-url> "NEXUS DASHBOARD"
cd "NEXUS DASHBOARD/Final Dashboard"
```

(Adjust the path/branch to match wherever this repo actually lives — ask
whoever gave you access if you don't have the URL.)

---

## 3. Backend setup

```bash
cd backend
python -m venv venv
```

Activate the venv (PowerShell):
```powershell
venv\Scripts\Activate.ps1
```
If PowerShell blocks the script with an execution-policy error, run once
(as the current user, not admin):
```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

Install dependencies:
```bash
pip install --upgrade pip
pip install -r requirements.txt
```

This installs FastAPI, LangGraph, LlamaIndex + pgvector bindings, psycopg2,
fastembed, openpyxl, and everything else the backend needs. It can take a few
minutes the first time (LlamaIndex/embedding packages are large).

### Configure environment variables
```bash
copy .env.example .env
```
Open `.env` in an editor and fill in:

```ini
# Required
DATABASE_URL=postgresql://postgres:<your-password>@localhost:5432/nexus
GROQ_API_KEY=<your key>          # get one free at https://console.groq.com
# and/or
ANTHROPIC_API_KEY=<your key>     # https://console.anthropic.com

# Recommended
GITHUB_TOKEN=<a GitHub PAT with no scopes needed — just raises the 30/min
              anonymous search-API limit for live AdobeDocs content fetches>

# Session (required for any non-toy use)
SESSION_SECRET=<a long random string — e.g. output of `openssl rand -hex 32`>

# Optional — real Adobe SSO login (demo login picker works without this)
IMS_CLIENT_ID=
IMS_CLIENT_SECRET=
IMS_REDIRECT_URI=http://localhost:5173/api/auth/callback
FRONTEND_URL=http://localhost:5173
IMS_ADMIN_EMAILS=you@adobe.com
IMS_MANAGER_EMAILS=
```

**Never commit `.env`.** It's gitignored, but double-check `git status` before
any commit/push.

### Start the backend
```bash
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```
You should see:
```
✅ Using installed langgraph package
✅ Loaded agents/ package (separate files)
✅ Nexus agents: 6/6 graphs loaded from agents/ package
✅ Mounted curriculum_router + learning_router
✓ All tables ready
INFO:     Uvicorn running on http://127.0.0.1:8000
```
`✓ All tables ready` means every table (curriculum, community, release notes,
skills, capstone, tracks, etc.) was created automatically — there is no
separate "run migrations" step for a fresh DB.

Confirm it's alive: open http://127.0.0.1:8000/docs — should show the FastAPI
Swagger UI.

---

## 4. Seed real curriculum content (optional but recommended for a full demo)

The DB starts empty of curriculum content. To populate it with real,
verified-fetching Experience League lessons:
```bash
python scripts/seed_curriculum.py
```
This is the same script used throughout development — it pulls from the
AdobeDocs GitHub repos live, so it needs internet access and benefits from
`GITHUB_TOKEN` being set (avoids rate-limit failures on a fresh, larger run).

To also populate the org's cross-skilling matrix / manager hierarchy from the
source Excel files (if you have them):
```bash
# See backend/data/role_learning_journey.xlsx and manager_hierarchy.xlsx —
# load these once via the admin UI upload, or write a one-off script mirroring
# the pattern in scripts/seed_curriculum.py.
```

## 5. Optional: pgvector index build
If you enabled the `vector` extension in step 1:
```bash
python scripts/migrate_to_pgvector.py
```
Skip this if you didn't set up pgvector — the RAG retriever falls back to an
in-memory cosine path automatically.

---

## 6. Frontend setup

Open a **second terminal** (keep the backend running in the first):
```bash
cd "NEXUS DASHBOARD/Final Dashboard"
npm install
npm run dev
```
Vite will print a URL, typically:
```
https://localhost:5173
```
Open it in a browser. The dev server uses a **self-signed HTTPS cert** by
default (needed for some browser APIs) — your browser will show a security
warning; click through ("Advanced → Proceed"). If you'd rather use plain
HTTP for local dev:
```bash
NEXUS_NO_SSL=1 npm run dev
```
(PowerShell: `$env:NEXUS_NO_SSL=1; npm run dev`)

The frontend proxies all `/api/*` requests to `http://localhost:8000` (see
`vite.config.js`) — so the backend must already be running.

---

## 7. Verify everything works

Run through **CHECKLIST.md** at minimum:
- Backend boots with `✓ All tables ready`
- `npm run build` completes cleanly
- Demo persona login works (no IMS config needed)
- Admin → Learning Tracks page loads without error
- EXP dashboard → Learning Path shows real lesson content

---

## 8. Common problems

| Symptom | Likely cause | Fix |
|---|---|---|
| `psycopg2.OperationalError: could not connect` | Postgres not running, or wrong `DATABASE_URL` | Check the Postgres service is started (Windows Services app → "postgresql-x64-14"); verify password/port |
| `ModuleNotFoundError` on backend start | venv not activated, or `pip install -r requirements.txt` didn't finish | Re-activate venv, re-run install, watch for red error lines |
| Backend runs but agents show `sequential` engine instead of `langgraph` | `langgraph` package failed to install (rare, usually a Python-version mismatch) | Confirm `python --version` is 3.11.x inside the venv |
| Frontend shows a blank page / console errors about `/api/*` 404s | Backend not running, or wrong port | Confirm backend is on :8000 and `vite.config.js` proxy target matches |
| `UnicodeEncodeError` when running a backend script directly (not via uvicorn) | Windows console codepage doesn't support the ✅ emoji in print statements | Prefix the command: `set PYTHONIOENCODING=utf-8` (cmd) or `$env:PYTHONIOENCODING="utf-8"` (PowerShell) |
| GitHub content fetches fail/slow during seeding | Hit the 30 req/min anonymous GitHub search API limit | Set `GITHUB_TOKEN` in `.env` (no special scopes needed) |
| `npm install` fails | Corrupted `node_modules` or npm cache | `rmdir /s /q node_modules`, then `npm cache clean --force`, then retry |
| PowerShell blocks `venv\Scripts\Activate.ps1` | Execution policy | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` (once, as your user) |

---

## 9. Where things live (quick reference)

```
Final Dashboard/
├─ src/App.jsx              ← entire React frontend (one large file)
├─ vite.config.js           ← dev server + proxy config
├─ package.json             ← frontend deps/scripts
└─ backend/
   ├─ main.py               ← FastAPI app, most endpoints, table creation
   ├─ ims_auth.py           ← Adobe SSO + profile/track resolution
   ├─ agents/               ← LangGraph agents (crossskill, reasoning, capstone, etc.)
   ├─ services/, rag/       ← RAG pipeline, learning-path generation
   ├─ requirements.txt      ← backend deps
   ├─ .env.example          ← copy to .env and fill in
   └─ scripts/              ← one-off seed/migration scripts
      ├─ seed_curriculum.py     ← populates real lesson content from AdobeDocs
      └─ migrate_to_pgvector.py← optional pgvector index build
```
