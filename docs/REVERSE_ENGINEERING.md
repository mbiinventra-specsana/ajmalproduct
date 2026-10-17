# MedArix RCM Simulator — Reverse Engineering Report

**Reference:** https://medarix-rcm-simulator.vercel.app/
**Date of analysis:** 2026-10-17
**Method:** interactive browser teardown, first as guest, then signed in with a
real student account (authenticated session). Network-tab / DevTools internals
were not accessible, so API endpoint paths and client storage keys below are
described behaviourally, not as verified paths.

> This document is an original functional analysis written from observed
> behaviour. It does not reproduce the reference site's source code or copy.

---

## 1. Overview

The MedArix RCM Simulator is a **training simulator for medical billing and
Revenue Cycle Management (RCM)**. Trainees work fictional patients, insurance,
claims, payments and A/R cases in a professional training environment. It has:

- A marketing-style demo dashboard (static showcase)
- A real authenticated app with role-based access (student / instructor)
- A catalogue of training cases with scored attempts
- Operational practice screens mirroring the RCM workflow
  (patients → insurance → eligibility → charges → claims → payments → A/R → denials)
- Gamification: levels, points, accuracy, progress tracking, assignments

---

## 2. Tech stack (observed / inferred)

| Layer | Finding |
|---|---|
| Frontend | Next.js (React) SPA, App-Router-style nested routes (e.g. `/training/attempt/new?caseId=12`) |
| Hosting | Vercel |
| Styling | Utility-class CSS consistent with Tailwind; no chart library (progress = CSS bars); icons are Unicode glyphs/emoji |
| State | Client-side React state + backend API |
| Backend | **Real authenticated API** (not static data): login returns a session; per-account training data; role-based 401/403 gating |
| Routing | Client-side navigation — sidebar persists, only main content swaps; per-page "Loading…" states |
| Reliability (at time of test) | Partial backend degradation: catalogue/patient/progress reads succeeded; several write endpoints and the case launcher hung or returned "Failed to load…" |

Framework evidence: Next.js default 404 page served for unknown paths; nested
route shapes; persistent sidebar with content swapping.

---

## 3. Sitemap — all reachable routes

| Route | Purpose |
|---|---|
| `/` | Demo dashboard (static showcase, not account-aware) |
| `/login?role=student` / `/login?role=instructor` | Role-tabbed login form (email + password) |
| `/student-dashboard` | Real account dashboard (greeting, level, stats, assignments, attempts) |
| `/instructor-dashboard` | Instructor home (403 for student role) |
| `/work-queue` | Work queue (guest: "Unauthorized. Please log in.") |
| `/patients` | Patient registry |
| `/insurance` | Payers / insurance records |
| `/eligibility` | Eligibility verification |
| `/charges` | Charge entry |
| `/claims` | Claim creation |
| `/payments` | Payment posting practice (EOB/ERA exercise) |
| `/ar` | A/R work queue with aging filters |
| `/denials` | Denial work queue |
| `/reports` | Training performance reports |
| `/training` | Case Center — training case catalogue |
| `/training/attempt/new?caseId=N` | Case player launcher (numeric internal IDs) |
| `/assignments` | Instructor assignment builder |
| `/progress` | "My Progress" |
| `/students` | Student CRUD shell (403 for student role) |
| `/cases/001`, `/cases/002` | Legacy 8-step case overview pages (ID is display-only; identical content) |

No footer/sitemap page. Logout is a button, not a route. Frontend shows
instructor nav links to everyone, but the API enforces roles (403s).

---

## 4. Feature inventory

### Patients (`/patients`)
- 9 fictional patients (e.g. PT-10005 Olivia Thompson … PT-10013) with DOB,
  gender, phone, Active status; View/Edit actions; "+ Add Patient"; search box.

### Insurance (`/insurance`)
- Stat cards: Payers / Insurance records / Active coverage (0 at time of test).
- "+ Add Payer" enabled; "+ Add Insurance" disabled until data loads.

### Eligibility (`/eligibility`)
- Stats: Insurance records / Verified / Active / Inactive.
- "+ Verify Eligibility" disabled; Verification History table.

### Charges (`/charges`)
- Stats: Total / Ready / Linked-to-claims / Total-billed.
- "+ Enter Charge" disabled; Charge History table.

### Claims (`/claims`)
- Stats: Total / Draft / Submitted / Total-billed.
- "+ Create Claim" disabled; Claim History; info box explaining charge→claim flow.

### Payments (`/payments`)
- Standalone practice exercise: "Practice posting a fictional EOB/ERA".
- Sample claim CLM-2026-10482: Billed $125, Allowed $100, Insurance Paid $80,
  Adjustment $25, Patient Responsibility $20; "Post Payment" button.

### A/R (`/ar`)
- A/R Work Queue: Total / Insurance / Patient A/R ($0.00 at test), 91+ Days (0).
- Aging filters: All, 0–30, 31–60, 61–90, 91+.
- Table: Claim / Patient / Payer / Billed / Patient A/R / Total A/R / Age /
  Follow-Up / Action.

### Denials (`/denials`)
- Denial Work Queue: Open / In Progress / Appealed / Resolved cards.
- Table: Claim / Patient / Payer / Billed / Denial Code / Status / Appeal / Action.

### Reports (`/reports`)
- Training Performance: Assignments 11, Completed 4, Average 93%, Best 100%,
  Completion 36%; Recent Training Attempts table.

### Assignments (`/assignments`, instructor)
- Assignment builder: student multi-select, case checkboxes CASE-001…011,
  due date, summary.

### Students (`/students`, instructor)
- Student CRUD shell (403 "Forbidden. Instructor access required." for students).

---

## 5. Case simulator deep dive

### 5a. Legacy 8-step case (`/cases/001`)
"Clean Claim: Complete RCM Cycle" — fictional patient Sarah Johnson.
8 steps, 100 pts total:

| # | Step | Area | Pts |
|---|---|---|---|
| 01 | Review patient demographics | Registration | 10 |
| 02 | Verify insurance eligibility | Eligibility | 10 |
| 03 | Enter medical charge | Charge Entry | 10 |
| 04 | Create and validate claim | Claims | 15 |
| 05 | Submit simulated claim | Claims | 10 |
| 06 | Review payer response | Claim Status | 10 |
| 07 | Post insurance payment | Payments | 15 |
| 08 | Resolve remaining A/R | A/R | 20 |

The "Start Case" button was inert (clicks had no effect) — this page appears to
be a legacy static template; the case ID in the URL is display-only.

### 5b. Live case catalogue (`/training`)
11 single-topic cases, each with difficulty and category tags:

- CASE-001 Eligibility Verification (BEGINNER)
- CASE-002 … CASE-007 (BEGINNER → INTERMEDIATE range)
- CASE-008 Payment Posting
- CASE-009 A/R Follow-up
- CASE-010 Denial Management
- CASE-011 Medical Coding & Charge Entry (ADVANCED)

Category tags include ELIGIBILITY, CODING_CHARGE_ENTRY, DENIALS.

### 5c. Attempt flow
Catalogue (`/training`) → launcher (`/training/attempt/new?caseId=N`, numeric
internal IDs — e.g. CASE-011 maps to caseId=12) → scored attempt recorded per
account. Attempts carry STARTED/COMPLETED status and a percentage score;
per-case attempt counts and best scores are retained.

> Limitation: during this teardown the launcher hung and a direct launcher URL
> returned "Training Case Error — Invalid training attempt ID.", so the
> interactive question/answer flow, hints, timers and wrong-answer penalties
> could not be exercised live.

---

## 6. Data model & persistence

Persistence is **server-side and per-account** (data survives reloads and is
account-specific). Observed entities:

- **User profile** — name, role (Student), training-mode badge
- **Training cases** — id, code (CASE-001…), title, difficulty, category tags
- **Assignments** — 11 observed, statuses ASSIGNED / IN PROGRESS / COMPLETED,
  due dates
- **Training attempts** — 10 observed: case, category, status, score,
  started/completed timestamps
- **Patients** — 9 fictional records (id PT-10005…, name, DOB, gender, phone, status)
- **Operational records** — payers, insurance coverage, eligibility
  verifications, charges, claims, payments, A/R entries, denials

localStorage / IndexedDB keys and raw API endpoint paths could not be
inspected (no JS console / network tab in the test tooling) — stated as a
method limitation, not a finding of absence.

---

## 7. Gamification

- **Levels** — e.g. Beginner (real student); the demo page shows "Billing Executive"
- **Training Points** — 0 for the fresh student; 1,840 on the demo showcase
- **Accuracy** — average across completed attempts (93.3% observed), best 100%
- **Per-case attempts + best score** retained
- **Assignment statuses** — ASSIGNED / IN PROGRESS / COMPLETED / DUE
- **Progress bars** throughout
- **"Training Journey" stage map** — Patient & Insurance → Charge & Claims →
  Claim Processing → Payments & A/R → Denial Management
- No badges or streaks observed.

---

## 8. UI/UX notes

- Dark-navy left sidebar with grouped nav (Workspace, Patients, Billing,
  Revenue Cycle, Training); light grey-blue content area; teal accent colour.
- Card-based stat blocks; tables with search boxes; pill filter buttons.
- Inline red error banners ("Failed to load…", "Forbidden…"); per-page
  "Loading…" placeholders.
- Persistent **"TRAINING MODE — Fictional data only"** badge.
- No modals, toasts or drawers observed.
- Minor inconsistency: `/training` greets "Good afternoon, Student" (local time,
  generic name) while `/` and `/student-dashboard` greet with the real name in
  a different timezone — two different greeting implementations.

---

## 9. Guest vs logged-in differences

1. `/` is a **static demo showcase** — shows the fictional "M AJMAL" persona
   (18/20 cases, Billing Executive, 1,840 pts, 92%) identically before and
   after login, including "Login as Student/Instructor" links. Real account
   data lives on `/student-dashboard`.
2. `/work-queue`: guest sees "Unauthorized. Please log in."; logged-in saw a
   load failure with empty stats.
3. `/training`: guest sees "Failed to load training cases"; logged-in sees the
   11 cases with progress.
4. Role gating only appears when logged in: `/instructor-dashboard` and
   `/students` return "Forbidden. Instructor access required." for students.
5. Login flow: `/login?role=student|instructor` with Student/Instructor toggle
   tabs, email + password; successful student login redirects to
   `/student-dashboard`.

---

## 10. Bugs & inconsistencies found (avoid these in the new build)

1. **Pages disagree on completion stats:** `/training` reported 6 of 11 (55%),
   `/progress` 4 of 10 (40%), `/reports` 36% — while the attempts table showed
   6 distinct completed cases averaging 93.3% (matching the displayed
   average). Root cause unknown; likely inconsistent queries/counting across
   pages. → New build: single source of truth for progress stats.
2. **`/student-dashboard` stats fell back to zeros** (0/11 cases, 0% accuracy,
   0 points, "No training attempts yet") while `/training` and `/progress`
   showed real data — suggesting its stats fail to load and silently default
   to zero. → New build: surface load errors instead of fake zeros.
3. **Demo data leaks into the authenticated app:** `/` keeps showing the
   fictional "M AJMAL" showcase after login. → New build: the home page
   should be account-aware or clearly labelled demo.
4. **Inert buttons:** legacy `/cases/001` "Start Case" does nothing; several
   "+ Add …" buttons disabled without explanation. → New build: no dead
   controls — every button works or explains why it can't.
5. **Two greeting implementations** with different timezones/names. → New
   build: one greeting component, one timezone rule.
6. **Frontend shows instructor nav to everyone** (API 403s instead). Better to
   hide unauthorized nav items client-side too.

---

## 11. Architecture assessment & blueprint for the new project

**Assessed architecture:** Next.js React SPA (likely App Router) on Vercel,
backed by a real authenticated REST-style API serving accounts, case
catalogue, assignments, attempts, and operational records
(patients/insurance/charges/claims/payments/A-R/denials). The `/cases/[id]`
pages are a legacy static template. The live training loop is:
catalogue → attempt launcher (numeric internal case IDs) → scored attempts
persisted per account. The API enforces roles; the frontend does not fully.

**Suggested blueprint for the new build** (to be confirmed with the product owner):

- **Frontend:** React SPA (Next.js or Vite) with file-based routes mirroring the
  RCM workflow; one design system (sidebar + cards + tables).
- **Backend:** authenticated REST API; entities as in §6; single progress-stats
  service (fixes bug #1); role-based access enforced in both API and nav.
- **Training engine:** case catalogue (code, difficulty, category tags) →
  attempt launcher → per-step questions with scoring → attempt record
  (status, score, timestamps); best-score retention.
- **Gamification:** levels, points, accuracy, journey stage map (as §7).
- **Data honesty:** fictional training data clearly badged; no fake zeros on
  load failure; no dead buttons.
- **Home:** account-aware dashboard (no static demo leaking into the app).

---

*End of report.*
