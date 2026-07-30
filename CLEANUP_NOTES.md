# Cleanup & Restructuring Notes — 2026-07-30

This pass audited the whole repo (frontend `src/`, backend `backend/`, and root
docs), verified what's actually wired into the running app via grep/import
checks, and reorganized it into something clean enough to `git init` and push.
**Nothing was deleted that wasn't 100% regenerable or provably dead** —
everything else was moved into `unwanted/`, which is already excluded by
`.gitignore`, so it stays on disk for reference but never gets committed.

## How the audit was done
For every file in question, checked whether anything in the *live* code path
(`src/App.jsx`, `backend/main.py`, `backend/routes_learning.py`, the 9 named
active agents from the prior session's handoff) actually imports/calls it.
No verdict was made on "looks unused" alone — each one below has a grep result
behind it.

## Moved to `unwanted/`

| Item | Why |
|---|---|
| `src/agents/capstone.js`, `crossskill.js`, `curriculum.js`, `index.js`, `llm.js`, `rag.js`, `reasoning.js`, `socratic.js` | Frontend "mock agent" scaffolding from before the real backend agents (`backend/agents/*.py`) existed. Grepped all of `src/` — zero imports of these files anywhere. `src/lib/ai.js` and `src/agents/practice.js` **are** actually imported by `App.jsx` and were kept. |
| `README.md` → `unwanted/README.md.old` | The old README described a "drop-in bundle" (`DELIVERABLES.md`, `main.py.patch`, `components/LearningAgents.jsx`, `lib/learning_api.js`) — none of those files exist in the repo anymore (that sub-tab was already removed in a prior session per HANDOFF.md item 6). Replaced with a new `README.md` that matches the actual repo. |
| `HOW_TO_RUN.md` → `unwanted/HOW_TO_RUN.md.old` | A thinner, older duplicate of `SETUP_GUIDE.md` (no DB/pgvector/env details) — fully superseded, kept only to avoid two contradictory quick-start docs. |
| `backend/write_agents.py` | A dev-time scratch generator that re-emits agent source files as string literals. Not imported anywhere, not referenced by any doc — a one-time authoring tool, not part of the app. |
| `backend/agents/router.py`, `backend/agents/orchestrator.py` | Leftover from an earlier "single orchestrator" design. Only referenced each other and `backend/tests/offline_smoke_test.py` — never imported by `main.py` or `routes_learning.py`. The current app routes per-agent directly from `App.jsx`/`routes_learning.py` instead. |
| `backend/tests/offline_smoke_test.py` | Its only real job was exercising `orchestrator.py`'s blocked-input path. Since that module moved to `unwanted/`, the test has nothing left to test — moved alongside it rather than left broken in `backend/tests/`. |

## Reorganized (not removed)

| Item | Change | Why |
|---|---|---|
| `backend/add_el_urls.py`, `build_embeddings_index.py`, `coverage_audit.py`, `migrate_capstone_review_history.py`, `migrate_capstone_submissions.py`, `migrate_to_pgvector.py`, `migrate_tracker.py`, `seed_curriculum.py`, `seed_curriculum_new_tracks.py` | Moved into new `backend/scripts/` | These are real, still-referenced one-off maintenance scripts (seeding, migrations) — `SETUP_GUIDE.md` tells you to run them by hand. They just didn't need to sit loose in `backend/` alongside the actual running app (`main.py`, `agents/`, `services/`). |

**Fixed as part of that move:** every moved script does
`load_dotenv(Path(__file__).parent / ".env")`, and `migrate_to_pgvector.py`
also does `sys.path.insert(0, str(Path(__file__).parent))` to import the
`agents` package — both assumed the script sat directly in `backend/`. Moving
them one level deeper without updating this would have silently broken `.env`
loading and the `agents` import. Changed both to `.parent.parent` in all nine
scripts, and updated the run instructions in `SETUP_GUIDE.md` (§4, §5, §9)
from `python seed_curriculum.py` to `python scripts/seed_curriculum.py`, etc.

> **Not independently re-verified by running them** — there was no working
> Python interpreter in this environment (`backend/venv` points at a Python
> install path from a different machine, `sallamshetti`'s, and no system
> Python was available to `py_compile` against). The path fix is a mechanical,
> low-risk change, but re-run each script once after pulling this to confirm
> before relying on it for a real migration.

## Deleted outright (regenerable, never meant to be tracked)

| Item | Why |
|---|---|
| `backend/server_boot.log` | Runtime log output, already `.gitignore`d (`*.log`). |
| `backend/__pycache__/`, `backend/agents/__pycache__/`, and other `__pycache__/` dirs | Compiled bytecode caches, already `.gitignore`d, regenerate automatically. |
| `src/components/` | The directory existed but was completely empty — nothing to preserve. |

## Left alone (checked, confirmed still active)
- `backend/agents/curriculum_rag.py` — imported by `curriculum.py` for quiz grounding.
- `backend/agents/curriculum_routes.py` — mounted in `main.py`.
- `backend/agents/domain_data.py` — imported by both `services/*.py` modules.
- `backend/agents/vector_store.py` — imported by `main.py`, `rag/pdf_ingestion.py`, and `backend/scripts/migrate_to_pgvector.py` / `build_embeddings_index.py`.
- `backend/agents/llm_calls.py` — pulled in via `agents/__init__.py` at package-import time, which runs as soon as `main.py` imports the `agents` package.
- `CHECKLIST.md`, `TODO.md`, `GAPS_AND_LIMITATIONS.md`, `WORK_COMPLETED.md`, `nexus_workflow.md` — all current, cross-reference each other correctly, no stale paths found. Left as-is.
- `Nexus_Agentic_Architecture.pptx` — not referenced by any doc, but it's a real artifact (not code), left where it is for the user to decide on.

## What's still in `unwanted/` from before this pass
`platform-v5.jsx`, several `screenshot-*.png`, and `vite.*.log` files were
already there from an earlier cleanup session — left untouched, already
covered by `.gitignore` (`unwanted/`, `screenshot-*.png`, `vite.*.log`).

## Follow-up pass (same day, on request)
- **`.tmp-chrome*` directories** (15 folders, ~103 MB — leftover Chrome
  browser-automation profile caches from prior Claude Code sessions, not
  project files) → moved into `unwanted/tmp-chrome-caches/`. Root-level `mv`
  hit Windows ACL "Permission denied" errors on a few of these (locked
  Crashpad/cache files), so the move was redone with PowerShell
  `Move-Item -Force`, which succeeded for all 15.
- **Checked for fork/prior-owner provenance** before a push to a new GitHub
  account (`jishnu209`): no `.git` directory exists anywhere in the tree, no
  references to any other person's name anywhere in the codebase, and
  `package.json` has no `author`/`repository`/`homepage` fields pointing
  elsewhere (`"name": "dashboard"` only). **This project has no git history
  at all yet** — it was never actually connected to a GitHub repo, so there
  is nothing to strip before a fresh `git init` + push.

## Git setup (still pending — do this yourself)
No git repo exists yet in this project (`git init` was never run). Once
you're happy with this structure: `git init`, review `git status` once to
make sure nothing under `unwanted/`, `venv/`, or `.env` shows up as tracked,
then commit and push to `jishnu209`'s GitHub.

## Net result
- `src/agents/` now only contains the two files actually used (`practice.js`)
  plus `src/lib/ai.js` stays where it was.
- `backend/` root now only has files that are actually part of the running
  app (`main.py`, `ims_auth.py`, `routes_learning.py`, `requirements.txt`,
  `.env`/`.env.example`) plus the `agents/`, `services/`, `rag/`,
  `guardrails/`, `evaluation/`, `data/`, `scripts/`, `tests/` subfolders.
- Root now has one accurate `README.md` instead of two contradictory ones.
- Nothing that was still in active use was moved or deleted.
