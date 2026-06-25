---
name: spordo-architecture
description: SPORDO's production architecture, tech stack, conventions, and migration path from the prototype. Load when planning features, making architectural or tech-stack decisions, onboarding to the codebase, or deciding which part of the system a task belongs to.
---

# SPORDO — Production Architecture

SPORDO is an NYC sports-field & court **permit-availability tracker** ("Know Before You Go"). This skill is the north star for building the production system out of the prototype.

## The prototype (current reality)

- One file: `public/TrueSpordo.html` (~3.4MB) — inlined design tokens, CSS, ~50 vanilla-JS functions, base64 images, and a 137-entry `FIELD_DATABASE`.
- `public/sp-live-test.html` — test harness for the `sp-live` live-status widget (currently a TEST stand-in).
- Deployed as a Cloudflare Worker serving static assets (`src/index.js`, `wrangler.jsonc`).
- Integrations: Leaflet (maps, live), Supabase (auth + permit cache, live), Loops (waitlist, **stubbed**), Stripe (donations, **UI-only**), Capacitor (mobile, **scaffolded**).

## Target stack (recommended defaults — confirm major shifts with the user)

| Layer | Choice | Notes |
| --- | --- | --- |
| Hosting | **Cloudflare Workers** + static assets | Already set up. Add `/api/*` routes + Cron Triggers. |
| Build | **Vite + TypeScript** | Extract the monolith incrementally; keep shippable. |
| Maps | **Leaflet** | Keep; lazy-load. |
| DB / Auth | **Supabase** (Postgres + Auth) | Schema as migrations; RLS on every table. |
| Sync | **Cloudflare Cron** or Supabase scheduled Edge Function | Server-side ingest of NYC Open Data → cache. |
| Payments | **Stripe** | Checkout + webhooks + customer portal. |
| Email | **Loops** | Waitlist + referrals. |
| Mobile | **Capacitor** | Wrap the web app; keep storage abstraction. |
| CI/CD | **GitHub Actions** → Cloudflare | `.github/workflows/deploy.yml`, deploy on push to `main`. |

## Who owns what (route work to the right agent)

- **frontend-engineer** — UI, app shell, build tooling, componentization, design-system extraction, a11y, perf, Capacitor.
- **backend-engineer** — Supabase schema/RLS/auth, Worker API routes, Stripe, Loops, secrets.
- **data-pipeline-engineer** — NYC Open Data ingestion, normalization, `field_permit_cache` / `field_sync_meta`, scheduled sync, the field database, freshness.
- **code-reviewer** — read-only correctness + security review before shipping.

## Conventions

- **Secrets never in the repo or client.** Use Wrangler secrets / `.dev.vars` (gitignored) and Supabase service-role only server-side. The Supabase *anon* key is public-by-design.
- **Schema as code** — Supabase migrations are the source of truth, not the dashboard.
- **Preserve the prototype's design** — the visual design and ARIA work are good; don't regress them.
- **Cache, don't hammer** — serve permit data from `field_permit_cache`; sync from Socrata server-side.
- **Ship incrementally** — keep `main` deployable; the GitHub Action ships every push.
- **Commit via `/save`**; deploy/validate via `/deploy`.

## Suggested build-out order

1. Externalize design tokens + base64 images; shrink the payload. *(frontend)*
2. Stand up Supabase migrations + RLS; move `FIELD_DATABASE` into the DB. *(backend + data)*
3. Build the server-side permit sync job → populate the cache; wire the live card. *(data)*
4. Introduce Vite/TS and decompose the monolith view-by-view. *(frontend)*
5. Stripe donations end-to-end + Loops waitlist. *(backend)*
6. Capacitor mobile wrapper. *(frontend)*

Reassess priorities with the user — this is a default sequence, not a contract.
