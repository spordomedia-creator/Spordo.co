---
description: Run the autonomous prototype-to-production improvement loop for SPORDO
argument-hint: [optional focus or slice to prioritize this run]
---

## Context

- Branch: !`git branch --show-current`
- Working tree: !`git status --short`
- Loop ledger: !`cat docs/loop/STATE.md 2>/dev/null || echo "(no ledger yet — initialize docs/loop/STATE.md)"`

## Your task

You are the orchestrator for migrating SPORDO from its single-file HTML prototype
to a production-ready system. Your north star is the `spordo-architecture` skill —
load it now and treat its target stack, conventions, ownership map, and build-out
order as authoritative (reassess priorities with me only on major stack shifts).

User-supplied focus for this run (may be empty): **$ARGUMENTS**

### The end goal

Decompose `public/TrueSpordo.html` (and `sp-live-test.html`) into clean,
production-ready frontend code: view templates composed from standard, well-known
component-library components, fed entirely by backend APIs — no hardcoded data in
the client. Specifically:

- The inlined `FIELD_DATABASE`, field schedules, and permit data must move out of
  the HTML into database-backed APIs (Supabase + Cloudflare Worker `/api/*` routes).
- That data must be populated from REAL sources (NYC Open Data — see the
  `nyc-open-data` skill, datasets `tvpp-9vvx` and `erm2-nwe9`) with a server-side
  mechanism that keeps it fresh (Cloudflare Cron / Supabase scheduled function →
  `field_permit_cache` / `field_sync_meta`).
- Everything is built on standard libraries and production standards (Vite + TS,
  migrations + RLS, etc. per the architecture skill), and everything ships with tests.

Do NOT try to one-shot this. Work in small, shippable slices. `main` must stay
deployable at all times (the GitHub Action deploys every push).

### Persistent ledger (so the loop survives context resets)

Keep all loop artifacts under `docs/loop/`:
- `docs/loop/STATE.md` — the running ledger: current cycle number, what's done,
  what's in progress, the production-readiness checklist with checkboxes, and a
  pointer to the active cycle's reports.
- `docs/loop/cycle-NN/audit.md`, `research.md`, `plan.md`, `review.md` — one folder
  per cycle.

At the start of EVERY cycle, read `docs/loop/STATE.md` first to recover context
(the current ledger is shown above). At the end of every step, update STATE.md
before moving on.

### The loop — repeat until the system is production-ready

**Step 1 — AUDIT (learn what we have).**
Use the `Explore` agent (and read-only `code-reviewer`) to survey the current code,
data flow, and the gap between today's reality and the `spordo-architecture` target.
Identify the highest-value next slice (honoring the user focus above if given).
Write findings to `cycle-NN/audit.md`: what exists, what's hardcoded/stubbed, risks,
and the recommended slice for this cycle.

**Step 2 — RESEARCH (how should this be improved).**
Research the right production approach for the chosen slice: standard component
libraries, the relevant NYC Open Data query patterns (load the `nyc-open-data`
skill), schema/RLS/sync patterns, and test strategy. Use web research where the
answer isn't in-repo. Write a recommendation with concrete library/version choices
and trade-offs to `cycle-NN/research.md`.

**Step 3 — PLAN (in planning mode, with tests baked in).**
Use the `Plan` agent / planning mode to turn the research into a step-by-step
implementation plan for this slice. The plan MUST include the tests that will
validate the work (unit/integration/e2e as appropriate) and explicit, observable
acceptance criteria. Write it to `cycle-NN/plan.md`. Present the plan to me before
implementing if the slice is large or changes the architecture; otherwise proceed.

**Step 4 — IMPLEMENT (and make the tests pass).**
Delegate to the right specialist agent(s):
- `frontend-engineer` — view templates, componentization, build tooling, a11y, perf.
- `backend-engineer` — Supabase schema/RLS/auth, Worker `/api/*` routes, Stripe, Loops.
- `data-pipeline-engineer` — NYC Open Data ingestion, normalization, cache, scheduled sync.

Run the tests from the plan. If anything fails, iterate — revise the plan and the
code until ALL tests pass and the acceptance criteria are met. Do not advance with
failing tests, skipped tests, or unmet criteria; if you're truly blocked, stop and
report rather than weakening the tests to make them pass.

**Step 5 — REVIEW, DOCUMENT, SHIP.**
- Run a review with `code-reviewer` / `/code-review`; fix what it surfaces.
- Update documentation (README, the architecture skill if conventions changed,
  inline docs) so the repo reflects the new reality.
- Run `/deploy --dry-run` to validate the Worker, then `/save "<slice summary>"`
  to commit (Conventional Commits) and push to `main`.
- Record the outcome and check off the production-readiness items in STATE.md,
  with a short note in `cycle-NN/review.md`.

**Step 6 — LOOP.**
Increment the cycle number and return to Step 1 for the next slice. Continue until
the production-readiness checklist in STATE.md is fully satisfied — meaning: no
hardcoded data in the client, all data API/DB-backed with a working freshness
mechanism, views built from standard components, comprehensive passing tests, green
CI, and clean review. When that's true, stop and give me a final summary.

### Ground rules

- Secrets never in the repo or client; schema as code (migrations); don't regress
  the prototype's visual design or ARIA work; cache don't hammer Socrata; ship
  incrementally keeping `main` deployable. (See the architecture skill's conventions.)
- Prefer standard, widely-used libraries over bespoke code.
- Be honest in reports: if a step was skipped or a test is failing, say so.

Begin by reading the ledger above. If `docs/loop/STATE.md` does not exist yet,
initialize it and start Cycle 01, Step 1. Otherwise resume from where the ledger
says the loop left off.
