# Outstanding Work / TODO

Ordered roughly by impact. Nothing here is silently broken in a way that would
surprise a user — see GAPS_AND_LIMITATIONS.md for what's already labeled.

## High priority
1. **Manual end-to-end test of per-track capstone tracking.** The
   `track_capstones` table/endpoints are new this session and curl-verified in
   isolation, but not yet walked through in the running app: enroll in a
   cross-skill track → finish all modules → pass the AI-evaluated capstone →
   confirm the "✓ capstone" badge appears and survives a page reload.
2. **Cross-skilling agent title/description mismatch.** The recommended
   *track* is always correct, but the LLM's generated title/description can
   describe a different-sounding track name than the one actually recommended
   (cosmetic only). Either post-validate the LLM's title against
   `recommended_track` and regenerate/rewrite if mismatched, or drop the LLM
   copy step for the title and template it directly from the track's real
   label.
3. **Finish the 13 topically-wrong URLs reverted to NULL** (7 rtcdp + 6
   analytics topics — see WORK_COMPLETED.md §3). These currently show no
   Experience League link at all. Options: find alternate real docs with
   stricter matching (2+ meaningful keyword overlap, not prefix/single-word),
   or accept they're unfixable via GitHub docs and note it in the lesson UI.
4. **Expand `manager_hierarchy` beyond the current 7 managers** if the org
   roster grows — anyone reporting to an unlisted manager currently falls
   back to team/role string matching for track resolution, which is weaker.

## Medium priority
5. **Wire manager/EXP "Projects" data to a real Project Board**, replacing the
   `memberProjects`/`projectIssues` sample fixture. Currently labeled
   accurately ("sample project data") but not real.
6. **Build a real org-wide L&D analytics endpoint** if leadership actually
   needs live skill-coverage/cohort/cert-compliance numbers — today only "DB
   Events" is real on that tab; the rest is an illustrative static cohort.
7. **Decide on a unified AI Safety / guardrail view** — currently Socratic-only
   by design. If you want the Reasoning agent's quality gate
   (`node_reasoning_judge`) rolled into the same admin tab, it needs its own
   panel (different rules, different pass/fail semantics — don't force it into
   the existing Socratic-specific scorecard).
8. **Code-split the frontend bundle.** `npm run build` currently emits one
   >1MB JS chunk. Not broken, but worth splitting (route-based or
   `React.lazy`) before any real production hosting.

## Lower priority / nice-to-have
9. **Add a frontend test runner** (Vitest is the natural fit given Vite) —
   there is currently no automated UI test coverage; verification has been
   manual build + backend integration tests only.
10. **Re-seed and re-verify `learning_tracks` keyword lists periodically** —
    the 6 tracks added this session (da/de/es/target/marketo/campaign) were
    seeded from the current curriculum topic titles; if curriculum content
    grows, the keyword/grounding lists should grow with it.
11. **Rotate any secrets that were ever committed** — `backend/.env` was
    tracked in the initial commit before being gitignored. If this repo is
    shared or made public, treat every value in that historical commit as
    compromised and rotate (Groq/Anthropic keys, IMS client secret, session
    secret, GitHub token, DB credentials).

## Explicitly out of scope (confirmed with user, not oversights)
- ALM Tier 2/3, Slack MCP, Workfront MCP integrations — not building these.
- Manager coverage beyond the current 7 — deliberately left unmapped for now.
