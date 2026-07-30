# Nexus Dashboard — Work Completed Log

Chronological record of everything fixed/built across this engagement. All items
below have been implemented, tested (where noted), and are in the working tree
(uncommitted — see `git status`).

## 1. RAG / Retrieval Architecture
- Gave LlamaIndex a real embed model backed by **pgvector** in the same Postgres
  instance, so the RAG retriever pushes top-k ANN search into SQL instead of
  loading the whole corpus into memory per query.
- Falls back transparently to in-memory cosine search if pgvector/extension is
  missing (see `backend/migrate_to_pgvector.py`, `agents/vector_store.py`).

## 2. Cross-Skilling Matrix
- Built the 5-role × priority-1–5 → tracks matrix from the org's learning
  journey picture into `role_learning_journey` (real DB table, admin-editable).
- Added `role_aliases` table so free-text HR job titles (e.g. "Data Analyst",
  "Senior Data Architect") resolve to canonical journey roles (`AEP - DA`,
  `AEP - DE`, `RTCDP`, `AA-SDK`, `ES`).
- **Manager-focus fallback**: if a learner's own title matches no journey role
  (e.g. "Associate Technical Consultant"), the agent now grounds on their
  **manager's Track Focus** instead — implements "roles depend on the manager
  you report to." (`agents/crossskill.py: _journey_role_from_manager_focus`,
  `_resolve_learning_track` in `backend/ims_auth.py`).
- Fixed `manager_hierarchy` reporting lines: Dhanesh → Pratul; Pratul +
  Ramkumar → Surya. Enriched Manjeet's track focus to explicitly reference
  DA/RTCDP (AEP-aligned) vs. Debashis's Engineering-Services/migration focus,
  so two Data Engineers under different managers get different
  recommendations (verified live).
- Removed AAM as a track entirely; folded B2B into RTCDP (segments) + AJO
  (B2B edition) rather than a standalone track.
- Renamed "AED - DE" → "AEP - DE" (canonical).

## 3. Curriculum Content Build-out
Real, **verified-fetching** Experience League content (never fabricated) added
for tracks that had none:

| Track | Topics seeded | Source repo(s) |
|---|---|---|
| rtcdp | 78 | AdobeDocs/experience-platform.en, platform-learn.en |
| analytics | 39 | AdobeDocs/analytics.en, analytics-learn.en |
| ajo (+ b2b) | 19 | AdobeDocs/journey-optimizer.en, journey-optimizer-b2b.en |
| da | 21 | AdobeDocs/experience-platform.en |
| de | 22 | AdobeDocs/experience-platform.en |
| campaign | 15 | AdobeDocs/campaign-classic.en |
| marketo | 15 | AdobeDocs/marketo.en |
| target | 15 | AdobeDocs/target.en |
| es | 11 | AdobeDocs/experience-platform.en |
| cja | 15 | AdobeDocs/analytics-platform.en |

Every URL was live-fetched and passed through `is_relevant_content()` before
being written to `curriculum_topics`.

### Bugs found/fixed during the build
- **`get_topic_content()` repo-selection bug**: the endpoint discarded
  `el_url_to_github_path()`'s own correct repo guess in favor of a fragile
  title-keyword heuristic. Fixed to prioritize the URL-derived repo first —
  recovered 26 topics across multiple tracks.
- **`ModuleLesson` track-blindness bug**: its fetch calls to
  `/api/curriculum/{id}` and `/api/content/{id}/{order}` were missing
  `?track=` entirely, so every track silently showed RTCDP's content (backend
  defaults to `track=rtcdp` when the param is absent). This was the direct
  cause of "CJA none are working." Fixed.
- **Stale/404 URL repair pass** (rtcdp + analytics, ~28 topics flagged):
  ran an automated search+verify+update script, then manually verified every
  match's real title/description (the automated keyword-overlap relevance
  check had false positives — e.g. matching "VISTA Rules" to a bot-traffic
  doc). Reverted 13 topically-wrong matches back to no URL rather than leave
  confidently-wrong content live. Final: rtcdp 71/78 URLs verified-correct,
  analytics 33/39 verified-correct; the remainder are genuinely unfixable via
  GitHub docs (developer.adobe.com-only content, certification landing pages).

## 4. Dashboard / Data-Integrity Audit
- Removed all hardcoded/fabricated dashboard data or explicitly labeled it:
  - Admin "L&D Analytics": only "DB Events" is real; everything else labeled
    "Illustrative demo cohort — not real org data."
  - Admin API status list: ALM Tier 2 previously showed `ok:true` with
    fabricated "2,000+ courses synced" stats — corrected, then (per user
    decision) **removed entirely** along with ALM Tier 3, Slack MCP, Workfront
    MCP (never implemented, no backend).
  - Admin Users tab: `activeUserCount` now fetched from `/api/admin/users`
    instead of a hardcoded "4".
  - Manager dashboard: "Direct reports" now `dbMembers.length` (was a
    hardcoded demo array length); `buildManagerContext` rebuilt from real
    dbMembers/teamSkills/liveSummary instead of fictional `TEAM`/`MEMBER_CERTS`;
    header changed from a false "live data from Adobe IMS" claim to "real team
    data + sample project data."
  - Deleted dead `ROI_DATA` array and other confirmed-unused code.
- Release notes: replaced the hardcoded, frozen `RELEASE_NOTES` object with a
  real backend-fed system (`release_notes_cache` table, `fetch_release_notes()`
  parses live AdobeDocs release-notes pages for AEP/AJO/CJA/WebSDK/Analytics,
  24h cache-refresh-on-read). Fixed two dead source URLs (AJO, WebSDK — both
  were 404; corrected to `.../using/whats-new/release-notes` and
  `.../web-sdk/release-notes`), in the backend source table, the cached DB
  rows, and the frontend fallback map.
- Community/forum feature: replaced fabricated posts (fake names, fake "2h
  ago" timestamps, no backend) with a real system — `community_threads` /
  `community_replies` tables, `GET/POST /api/community/threads`, real
  points (`posts*15 + replies*5`), real consecutive-day streaks.
- Learning Tracks admin page: fixed a 500 ("relation learning_tracks does not
  exist") — the GET endpoint queried the table without ever creating it; now
  calls the same `_ensure_tracks_table()` guard the POST endpoint used.
- **Reasoning-agent vocabulary gap**: the `learning_tracks` table (drives the
  on-topic/grounding keyword check for the AI Tutor) only had defaults for 5
  of 11 tracks (aep/rtcdp/analytics/ajo/cja) — DA/DE/ES/Target/Marketo/Campaign
  were silently missing, so learners in those tracks could get incorrectly
  flagged "off-topic." Added real keyword/grounding entries for all 6, sourced
  from each track's actual seeded topic titles.

## 5. Profile / Skills / Track Resolution (real-user correctness)
- **Skills leak fixed**: real registered users were silently inheriting the
  hardcoded demo persona's skill levels (`PROFILES.exp.skills`) because the
  login-merge spread the demo profile first. Real users now start from `[]`
  and only ever show levels from their own assessments (`skill_assessments`
  table via `/api/skills/me`).
- **Self-report skill editor added**: a dropdown per skill (None / Developing
  / Proficient / Expert) that saves directly to `/api/skills/assess`
  (`theta: null`, distinguishing a self-report from a CAT-quiz result) —
  previously the *only* way to set a skill level was the adaptive CAT quiz.
- **Track resolution grounded in real org data**: `getTrack()` previously
  fell through to a hardcoded `"rtcdp"` default for any team/role string not
  in its two small lookup maps (e.g. team="Data" matched nothing). Added
  `_resolve_learning_track()` in `ims_auth.py`, which resolves a learner's
  primary track from their **manager's Track Focus** first (authoritative),
  then team, then role, then default. Surfaced as `profile.track` /
  `profile.track_label`, consumed by `getTrack(profile)` and shown in the
  profile card (e.g. "Real-Time CDP · Year 1" instead of "Data · Year 1").

## 6. Cross-Skill Track Catalogue & Capstone Tracking
- The "Choose a track to add" picker was hardcoded to 5 tracks (1 marked
  "Coming soon"), even though 10 tracks have real, verified curriculum
  content. Expanded `CROSS_SKILL_TRACKS` to all 10 (rtcdp, da, de, ajo, cja,
  analytics, target, marketo, campaign, es), all `available:true`.
- **"Primary capstone done" logic for 6+-month employees**: `classify_persona`
  already promotes ≥6-month employees to the "exp" persona; the UI now
  treats the primary onboarding capstone as done for them too
  (`primaryDone = capstone_completed || persona==="exp" || tenure matches
  6+/Year pattern`), with a clear "Your primary capstone is done" message and
  direct actions ("Ask AI Advisor" / "Pick a track") instead of a dead end.
- **Per-track capstone persistence** (new): cross-skill ("solitaire") track
  capstones previously completed with `persist={false}` and were recorded
  nowhere. Added `track_capstones` table + `POST /api/tracks/capstone/complete`
  + `GET /api/tracks/capstone`; each additional track's capstone completion is
  now tracked independently and shown as a "✓ capstone" badge on the track
  switcher pills.

## 7. Verification Performed
- Live-tested every fixed release-notes URL (curl, 200 confirmed).
- Live-ran the cross-skilling agent for the real directory record
  (`lnandiwada@adobe.com` → Associate Technical Consultant, reports to
  Dhanesh) and confirmed it grounds via manager → RTCDP journey → recommends
  DA (priority 1), matching the org matrix.
- Live-ran the agent for a simulated Data Engineer under Manjeet vs. under
  Debashis and confirmed differentiated recommendations (DA/RTCDP vs. ES).
- `npm run build` — clean, no errors, after every frontend change in this
  session.
- Backend `create_all_tables()` — all new tables (`track_capstones`,
  `learning_tracks`, `community_*`, `release_notes_cache`) create cleanly on a
  fresh DB.
