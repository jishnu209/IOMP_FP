# Verification Checklist

Run through this before a demo, a handoff, or after pulling changes onto a new
machine. Check items off manually — nothing here runs automatically yet
(see TODO.md for CI/test-suite gaps).

## Environment
- [ ] `backend/.env` exists and is filled in (copy from `backend/.env.example`
      — never commit the real one)
- [ ] `DATABASE_URL` points at a reachable Postgres instance
- [ ] At least one of `GROQ_API_KEY` / `ANTHROPIC_API_KEY` is set
- [ ] `SESSION_SECRET` is a real random string, not the placeholder
- [ ] `GITHUB_TOKEN` set (optional, but avoids GitHub API rate-limit failures
      on live AdobeDocs content fetches — 30 req/min unauthenticated)

## Backend boots clean
- [ ] `cd backend && venv\Scripts\python.exe -m uvicorn main:app --reload` starts
      without exceptions
- [ ] Console shows `✓ All tables ready` (all `CREATE TABLE IF NOT EXISTS`
      statements ran)
- [ ] `http://127.0.0.1:8000/docs` loads the FastAPI Swagger UI
- [ ] `GET /api/tracks` returns the 11-track list (aep/rtcdp/analytics/ajo/cja
      + da/de/es/target/marketo/campaign)

## Frontend boots clean
- [ ] `npm install` completes with no errors
- [ ] `npm run dev` starts Vite on port 5173 (proxying `/api` to :8000)
- [ ] `npm run build` completes with **no errors** (warnings about chunk size
      are expected and fine)
- [ ] Browser loads `https://localhost:5173` (self-signed cert warning is
      expected — click through, or set `NEXUS_NO_SSL=1` for plain HTTP)

## Login paths
- [ ] Demo persona login (New Joiner / Experienced / Manager / Admin picker)
      works without any IMS config
- [ ] If `IMS_CLIENT_ID`/`IMS_CLIENT_SECRET` are set: real Adobe SSO login
      completes and returns a resolved profile (role/team/manager/track)
- [ ] A user's `profile.track` / `profile.track_label` resolves via their
      manager's Track Focus (check `manager_hierarchy` for their manager) —
      NOT silently defaulting to "rtcdp" for the wrong reason

## Cross-skilling / learning tracks
- [ ] Admin → Learning Tracks page loads without a 500 error
- [ ] Admin → Cross-Skilling Data (role_learning_journey, manager_hierarchy,
      role_aliases) all editable and saving
- [ ] EXP dashboard → "Choose a track to add" shows all 10 real tracks, none
      marked "Coming soon"
- [ ] AI Advisor recommendation matches the org matrix for a known
      role/manager combination (spot-check against role_learning_journey)
- [ ] Enrolling in a track → Study Cards / Practice Scenarios / Capstone all
      load real content for that track (not silently falling back to RTCDP)

## Skills
- [ ] A freshly-registered real user shows **no** skill levels until they
      either self-report or take a CAT assessment (i.e. all "None" initially
      — NOT inherited demo levels like "Expert")
- [ ] Self-report dropdown in Skill Development tab saves and persists across
      a page reload
- [ ] Manager's Skill Matrix reflects a team member's self-reported /
      assessed levels

## Capstone
- [ ] New Joiner: primary capstone flow (generate → submit → AI-evaluate →
      manager approve/reject) works end-to-end
- [ ] A 6+ month tenured user without a formally-approved capstone sees
      "Your primary capstone is done" (not stuck/locked)
- [ ] Completing a cross-skill track's capstone shows a "✓ capstone" badge
      on that track's pill, and it persists after reload
      (`GET /api/tracks/capstone?member=...`)

## Content integrity
- [ ] Spot-check 3–5 lessons per track — the "Read on Experience League" link
      actually leads to content matching the lesson title (not a 404, not a
      mismatched doc)
- [ ] Release notes tab loads real entries for AEP/AJO/CJA/WebSDK/Analytics,
      and "Read more" links resolve (not 404)

## Admin/Manager dashboard honesty
- [ ] Every "illustrative demo" / "sample" label is still present and
      accurate (i.e. nobody quietly removed the disclaimer without also
      making the data real)
- [ ] No hardcoded stat masquerading as live data (spot check: Active Users
      count, Direct Reports count, capstone status)

## Before sharing/pushing this repo
- [ ] `git status` — confirm no `.env` or other secret file is staged
- [ ] Check `git log -- backend/.env` — if secrets were ever committed
      historically, rotate them (API keys, session secret, IMS client secret)
