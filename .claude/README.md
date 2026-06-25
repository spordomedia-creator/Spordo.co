# SPORDO Claude Code toolkit

Project-scoped Claude Code helpers for building SPORDO from prototype to production. Committed to the repo so they're shared and versioned.

> **Run Claude Code from inside this `Spordo.co/` directory** (the git repo root). Claude discovers `.claude/` from the working directory upward — if you launch from the parent folder these won't load.

## Slash commands — `.claude/commands/`

| Command | What it does |
| --- | --- |
| `/build-loop [focus]` | Run the autonomous prototype→production improvement loop (audit → research → plan → implement → review/ship, repeat), delegating to the engineer agents and gating each cycle on passing tests. Tracks progress in a `docs/loop/` ledger. Optional arg biases which slice it tackles first. |
| `/save [summary]` | Stage all changes, write a Conventional-Commit message, and push to `main`. Optional arg gives commit intent. |
| `/deploy [--dry-run]` | Validate the Worker (`wrangler deploy --dry-run`) then deploy. Canonical deploy is still pushing to `main` (GitHub Action). |

## Agents — `.claude/agents/`

Delegate focused work with the Task tool (or let Claude pick them by description).

| Agent | Owns |
| --- | --- |
| `frontend-engineer` | UI, build tooling, componentization, design-system extraction, a11y, perf, Capacitor. |
| `backend-engineer` | Supabase schema/RLS/auth, Worker API routes, Stripe, Loops, secrets. |
| `data-pipeline-engineer` | NYC Open Data ingestion, normalization, permit cache, scheduled sync, field DB. |
| `code-reviewer` | Read-only correctness + security review before shipping. |

## Skills — `.claude/skills/`

Loaded automatically when relevant.

| Skill | Provides |
| --- | --- |
| `spordo-architecture` | Target stack, conventions, ownership map, build-out order. The north star. |
| `nyc-open-data` | Socrata/SoQL reference: datasets `tvpp-9vvx` & `erm2-nwe9`, query patterns, gotchas. |

## Typical loop

Run `/build-loop` to drive the whole cycle automatically, or do it by hand:

1. Plan a slice (the `spordo-architecture` skill informs scope/ownership).
2. Delegate to the right engineer agent.
3. `code-reviewer` reviews the diff.
4. `/save` to commit + push → GitHub Action deploys. Use `/deploy` for manual/local pushes.
