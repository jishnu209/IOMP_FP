# Nexus — Platform Workflow & Implementation

**Adobe Enablement Platform · IISc Capstone · Group 14**
*AI-powered adaptive learning for Adobe AEP Analytics APAC teams*

---

## 1. Platform Overview

Nexus is a Learning Experience Platform (LXP) layered on top of Adobe Experience League (EL) and Adobe Learning Manager (ALM). It adds intelligence, personalisation, and manager visibility that EL cannot provide on its own. The platform targets three personas — New Joiner (NJ), Experienced Employee (EXP), and Manager (MGR) — each with their own dashboard and feature set.

**Goal:** Reduce NJ time-to-autonomy from 41 days → 34 days (−18%).

---

## 2. User Workflow

### 2.1 New User Registration
- User submits an onboarding request (name, email, role, team, manager)
- Request is marked **pending** in the database
- Manager receives an in-app notification to approve or decline
- On **approve** → account is activated; welcome points (20 pts) awarded; user can log in
- On **decline** → user is notified via in-app notification
- Manager accounts are created and approved by the **Admin**

### 2.2 Login & Persona Routing
- User logs in → backend checks `capstone_completed` flag in the database
- `capstone_completed = false` → routed to **NJDash** (New Joiner dashboard)
- `capstone_completed = true` → routed to **EXPDash** (Experienced dashboard)
- Manager accounts always route to **MGRDash**
- Track is assigned by: team mapping first → role mapping fallback → default RTCDP

### 2.3 New Joiner Learning Flow
1. **Home** — shows welcome banner, program status (4–8 week window), Day X of 7-day capstone target, confidence progress bar, weekly tracker summary, utilization card
2. **Learning Path** — structured 9-module track (RTCDP or Analytics depending on role); modules unlock sequentially; Curriculum Agent tab for personalised guidance
3. **Safe Space** — private Socratic agent (manager-invisible); asks guiding questions, never gives answers; powered by Anthropic API (claude-sonnet-4-6)
4. **AI Tutor** — Reasoning agent for step-by-step concept scaffolding
5. **Study Cards** — AI-generated flashcards per module topic
6. **Practice Scenarios** — track-specific real-world implementation scenarios with AI coaching
7. **Knowledge Base** — RAG search across AEP/AJO/CJA/Analytics/WebSDK docs + AI synthesis
8. **Release Notes** — monthly product releases for all 5 Adobe products
9. **Community** — NJ-only cohort space (module doubts, onboarding tips, general)
10. **Weekly Tracker** — log project allocations, hours billed, weekly status
11. **Capstone** — unlocks only when: all modules done AND confidence ≥ 0.75

### 2.4 Capstone Gate
- Two conditions must both be true to unlock Capstone:
  - All non-capstone modules completed
  - Confidence score ≥ 0.75 (rolling score from Socratic sessions, module quizzes, self-assessments)
- Capstone period is tracked; 7-day target shown on home; red overdue warning if exceeded
- Manager reviews and grades the capstone (not AI-graded)
- On completion: 200 points awarded; NJ persona transitions to EXP on next login

### 2.5 Experienced Employee Flow (Post-Capstone)
1. **Home** — welcome banner, skills dashboard (unlocked), critical gap alert, cross-skill picker
2. **Learning Path** — shows primary track completion + multi-track switcher bar; "+ Add track" opens picker for AJO/CJA/Analytics/RTCDP
3. **Skill Development** — Adaptive CAT quiz per skill; skill gap heatmap vs. team average and market demand
4. **Cross-Skill Capstone** — separate capstone per cross-skill track; unlocks after all track modules complete
5. **AI Advisor** — cross-skilling agent; knows current track + active module; cannot change tracks; directs user to the Learning Path picker
6. All NJ tools (Flashcards, Practice, AI Tutor, Knowledge Base, Community, Tracker) remain available

### 2.6 Manager Flow
1. **Home** — team utilization table (quarterly CF util per member), project overview
2. **Team** — all direct reports: confidence scores, module progress, at-risk flags, bandwidth, intervention buttons
3. **Certs** — certification status per member (active/expiring/lapsed)
4. **Analytics** — ROI velocity chart (cohort vs. historical), hiring signals, skill matrix
5. **Projects** — all team project allocations with weekly update history
6. **Weekly Tracker** — full team tracker visibility
7. **Notifications** — approval requests, at-risk alerts, cert renewal nudges

---

## 3. Learning Track System

### 3.1 Four Tracks
| Track | Modules | Content |
|---|---|---|
| RTCDP / AEP | 9 modules | Profiles, Segmentation, Destinations, Identity, Monitoring |
| Adobe Analytics | 9 modules | Analysis Workspace, eVars, Report Suites, Attribution IQ, Data Warehouse |
| Adobe Journey Optimizer (AJO) | 9 modules | Journey canvas, Email/Push/SMS, Decision Management, Frequency Capping |
| Customer Journey Analytics (CJA) | 9 modules | Connections, Data Views, Cross-channel analysis, Stitching, Guided Analysis |

### 3.2 Track Routing Logic
- Team mapping: `TEAM_TRACK_MAP` → e.g., Analytics APAC team → analytics track
- Role mapping: `ROLE_TRACK_MAP` → Analytics Analyst/Engineer → analytics; all others → rtcdp
- `getModulesForTrack(t)` and `getLessonContentForTrack(t)` helper functions used everywhere

### 3.3 Multi-Track Enrollment
- EXP users can enroll in parallel tracks
- `enrolled_tracks` JSON column in `onboarding_requests` persisted to DB
- Track switcher pill bar at top of Learning Path; progress badge (N/9) per pill
- `+ Add track` opens full-screen picker overlay showing available tracks not yet enrolled

### 3.4 Module Test-Out
- In each lesson: Module Quiz generates 10 AI MCQ via Groq
- Score ≥ 90% → `TestOutModal` appears offering to mark module mastered
- 50 points awarded on test-out
- Distinct from the 0.75 capstone confidence gate

---

## 4. Lesson Architecture

Each lesson opens in a new tab at `?lesson=N&track=T`.

**ContentPane tabs:**
- **Lesson** — topic list + objective, activity, output, checkpoint; video metadata where available
- **Study Notes** — AI-generated structured notes via Groq (summary, key concepts, terms, steps, warnings, takeaways); cached per topic
- **Module Quiz** — 10 Groq-generated MCQ; score updates live confidence (±0.03/0.02); ≥90% triggers test-out
- **Source Docs** — raw AdobeDocs markdown rendered + Experience League fallback links

Tab resets to Lesson on each new topic selection.

---

## 5. AI Agents

| Agent | Used by | How it works | Guardrail |
|---|---|---|---|
| **Socratic** | NJ (Safe Space) | Anthropic API; questions only, never answers; manager-invisible; maintains conversation history | Full LLM-as-judge via Anthropic |
| **Reasoning** | NJ, EXP (AI Tutor) | Groq; step-by-step scaffolding; "what comes next?" pauses | judgeGenericResponse + AEP terms |
| **Curriculum Agent** | NJ, EXP (Learning Path) | Groq; knows track, all modules with status, confidence%; product distinctions hardcoded (AJO ≠ Analytics ≠ CJA ≠ CDP ≠ WebSDK); cannot change tracks | judgeGenericResponse |
| **AI Advisor** | EXP | Groq; cross-skilling guidance; receives current track + active module in context; cannot claim to change tracks | judgeGenericResponse |
| **Capstone** | NJ, EXP | Groq; generates tasks from all completed module titles; mentor guidance | judgeGenericResponse |
| **Practice Scenarios** | NJ, EXP | Groq; track-specific scenarios (AJO scenarios for AJO track); cached per track+module | judgeGenericResponse |
| **Flashcards** | NJ, EXP | Groq; 5 cards per topic; fallback set if generation fails | judgeGenericResponse |
| **AI Notes** | NJ, EXP (Lesson) | Groq; structured notes per topic; cached | — |
| **RAG / KB** | NJ, EXP | pgvector + Groq; search docs, synthesise answer; track-aware AI prompt | — |

**judgeGenericResponse:** Checks AEP_TERMS whitelist (20 domain terms), response length, refusal patterns. Fire-and-forget (non-blocking). Logs to `guardrail_logs` table.

---

## 6. Utilization Tracking

- **System-calculated available hours:** `(working days − APAC holidays) × 8h/day`
  - Weekends are never counted (loop is Mon–Fri only)
  - `APAC_HOLIDAYS_2026` — hardcoded Set of 19 India + Singapore public holidays
  - `getQuarterAvailableHours(qtr, yr)` sums all weeks in the quarter
- **Billable hours:** logged per project per week via inline `ProjectBillingForm` on project cards in Weekly Tracker
- **CF Utilization = total billable hours / available hours × 100%**
- Quarterly view: Q1=Jan–Mar, Q2=Apr–Jun, Q3=Jul–Sep, Q4=Oct–Dec
- **WeekCalendar widget** — shows Mon–Fri tiles; holidays highlighted amber
- **Individual view:** `UtilizationSummaryCard` on NJ + EXP home
- **Manager view:** `TeamUtilizationSection` on MGRDash home — all direct reports, quarterly aggregated

---

## 7. Points, Badges & Leaderboard

### Points (awarded automatically)
| Milestone | Points |
|---|---|
| Welcome (account activated) | 20 |
| Module completed | 50 |
| Test-out passed | 50 |
| Weekly tracker entry | 10 |
| Capstone completed | 200 |

### Dynamic Badges (9 conditions)
First Module · Halfway There · All Modules · Capstone Champion · 100+ Points · 500+ Points · Test-out Pass · Consistent Tracker (4+ updates) · 8-Week Streak

### Leaderboard
- `TeamLeaderboardWidget` — top 5 by manager; 60s auto-refresh
- Scoped by reporting manager (each team has its own leaderboard)
- Medal icons 🥇🥈🥉; current user highlighted

---

## 8. Database Tables (19 total, all created on startup)

`onboarding_requests` · `manager_accounts` · `llm_logs` · `telemetry` · `guardrail_logs` · `session_summaries` · `confidence_scores` · `bw_logs` · `user_module_progress` *(UNIQUE: member+module+track — supports multi-track)* · `module_test_outs` · `points_ledger` · `notifications` · `skill_assessments` · `project_allocations` · `allocation_updates` *(+billable_hours, +week_of)* · `user_utilization` · `conversation_messages` · `generated_content_cache` · `doc_embeddings`

---

## 9. Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Frontend | React + Vite | Single-file App.jsx (~8,900 lines), all inline styles |
| Backend | FastAPI (Python) | Single-file main.py (~2,750 lines), all API endpoints |
| Primary DB | PostgreSQL | All structured data; 19 tables |
| Vector store | pgvector | Document embeddings for RAG knowledge base |
| Primary LLM | Groq (LLaMA 3.3 70B) | All agents except Socratic |
| Socratic LLM | Anthropic (claude-sonnet-4-6) | Safe Space Socratic agent only |
| Embeddings | fastembed (local) | No external embedding API needed |

---

## 10. What's Not Yet Implemented

| Gap | Why not done |
|---|---|
| MGR cert tracking (automated ALM sync) | Requires ALM Tier 3 OAuth setup (product decision) |
| At-risk behavioral panel in MGRDash | Behavioral telemetry exists; MGR UI panel not yet wired |
| Socratic agent for EXP cross-skilling | EXP has AI Tutor + AI Advisor; Socratic tab not yet added to EXPDash |

### Open Product Decisions (L&D to resolve)
- Capstone grader: mentor vs. manager? What happens on repeated failure?
- New joiner manager approval: full track approval or awareness notification only?
- Role sub-tracks: AEP Admin, AEP Developer, Campaign Manager need separate curriculum
- Cohort recognition: "first in cohort to complete capstone" — candidate feature, not designed

---

## 11. Extra Features Built Beyond Original Spec

- **Release Notes** — monthly product releases for AEP, AJO, CJA, Adobe Analytics, WebSDK (with product/month/search filters)
- **Knowledge Base** — RAG-powered search + AI synthesis; product tag filter; topics sorted by current track
- **Community product tags** — AJO / CJA / Analytics / RTCDP filter on EXP community threads
- **Track-specific capstones** — separate capstone per cross-skill track (not just NJ onboarding capstone)
- **Track-specific practice scenarios** — AJO scenarios for AJO track; not generic AEP
- **Curriculum Agent product knowledge** — explicit product distinctions baked into system prompt
- **APAC holiday calendar** — system knows 19 public holidays; WeekCalendar widget
- **ProjectBillingForm** — inline hours + status + comment logging on project cards (no separate form)
- **Admin Data Explorer** — all 10 data categories per member in a single admin view
- **Quarterly utilization** — system-calculated (not manual entry); holidays + weekends excluded

---

*Document prepared by: Nexus Platform Team (Group 14) · IISc Advanced Certification in Agentic AI*
*Contact: lnandiwada@adobe.com · July 2026*
