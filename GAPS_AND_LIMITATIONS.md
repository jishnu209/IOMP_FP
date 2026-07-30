# Known Gaps & Limitations

Honest inventory of what is NOT real / NOT wired / NOT finished, as of this
writing. Nothing here is hidden in the UI — every item below is either
labeled in-app ("illustrative demo", "sample", "simulated") or documented here
because it hasn't been surfaced yet.

## Integrations — genuinely not built
| Item | Status | Note |
|---|---|---|
| ALM Tier 2 (course catalogue sync) | Not implemented | Removed from UI, not stubbed |
| ALM Tier 3 (progress/cert sync) | Not implemented | Removed from UI, not stubbed |
| Slack MCP | Not implemented | Removed from UI, not stubbed |
| Workfront MCP | Not implemented | Removed from UI, not stubbed |
| Adobe IMS / SSO | Simulated | Demo login picker doesn't carry a real IMS session; real IMS requires `IMS_CLIENT_ID`/`IMS_CLIENT_SECRET` configured (see SETUP_GUIDE.md) |

## Data that is illustrative / sample, not live org data
| Location | What's fake | What's real |
|---|---|---|
| Admin → L&D Analytics | Active Learners, Avg Confidence, At Risk, Skill Heatmap, Cohort Progress, Certification Compliance — all from a static demo cohort (`TEAM`, `MEMBER_CERTS` constants) | "DB Events" KPI (from `/api/stats`) |
| Manager → Team Intelligence Agent context | Client project/issue data (`memberProjects`, sector/status) is a fixed sample fixture, not wired to a live Project Board | Team roster, module progress, points, skill assessments, at-risk flags — all real, DB-backed |
| Manager Assistant chat | Same as above — tells the manager explicitly "sample project/issue data" in its own greeting | — |

These are all labeled in-app; no code change needed unless you want a real
Project Board data source wired in (see TODO.md).

## Cross-skilling agent — one known cosmetic issue
The **recommended track code** (`recommended_track`) is always correct and is
what the learner is actually enrolled into — the scoring/ranking pipeline
(`node_score_and_rank` → `node_select_rec_type`) decides this deterministically
and the LLM cannot override it (`node_generate_guidance` force-overwrites the
LLM's own JSON field with the pipeline's decision). However, the LLM-generated
**title/description text** occasionally produces an internally-inconsistent
sentence (e.g. "Advance with Adobe Analytics" as the title for a recommendation
whose track is actually `da`). This is cosmetic — the enrollment and gap
scoring are unaffected — but it can look confusing. Not yet fixed.

## AI Safety tab — scoped to Socratic only, by design (not a bug)
The tab measures 4 Socratic-specific guardrail rules (1 question, no direct
answer, <55 words, genuinely Socratic). The Reasoning/AI Tutor agent has its
own, different, rule-based quality gate (`node_reasoning_judge` in
`reasoning.py` — checks step-structure/checkpoint presence) but its results
are only shown inline per-message in the tutor chat, not rolled into this
admin tab. If you want a unified guardrail dashboard across both agents, that
is unbuilt (see TODO.md).

## Manager hierarchy coverage
Only 7 managers have rows in `manager_hierarchy` (Pratul, Manjeet, Dhanesh,
Ramkumar, Shamshul, Debashis, Surya). Any employee whose manager isn't one of
these 7 falls back to team/role string matching for track resolution, not the
manager-focus rule. This was a deliberate scope decision earlier in the
engagement (the user said to leave the other managers unmapped for now) — not
an oversight, but worth expanding if the org roster grows.

## Per-track capstone — newly built, not yet load-tested
`track_capstones` (table + endpoints) was added in this session. It works in
isolated testing (curl-verified) but has not been exercised through a full
real multi-track user journey in the running app (enroll → complete modules →
pass a cross-skill capstone → see the ✓ badge persist across a reload). Do a
manual pass before relying on it for a demo.

## Frontend bundle size
`npm run build` emits a single JS chunk >1MB (292KB gzipped) with a vite
warning to code-split. Not a functional issue, but will matter for real
production hosting / cold-load time.

## No automated test suite for the frontend
`backend/tests/` has an offline smoke test for the learning-agent endpoints,
but there is no frontend test runner (no Jest/Vitest/Playwright configured).
All frontend verification in this engagement was manual build + targeted
backend integration tests, not full end-to-end UI tests.

## Environment / secrets
- `.env` is gitignored (correct) but also currently shows as deleted in
  `git status` (`D backend/.env`) — meaning it was tracked at some point in
  this repo's history. If this repo is ever made public or shared, check
  `git log` for any commit that included real secrets and rotate them.
- `SESSION_SECRET` in `.env.example` defaults to a placeholder
  (`change-me-to-a-long-random-string`) — must be set to a real random value
  before any non-local deployment.
