# CLAUDE.md

## What this is

SPORDO — NYC sports-field & court permit-availability tracker ("Know Before You Go"). Currently a single-file prototype (`public/TrueSpordo.html`, ~3.4MB, inlined CSS/JS/images, 137-entry `FIELD_DATABASE`) served as a Cloudflare Worker. Being migrated to production incrementally — see the `spordo-architecture` skill for the target stack and build-out order before making structural decisions.

## Commands

```bash
npm install
npm run dev                                        # wrangler dev, http://localhost:8787
npm test                                            # node --test src/**/*.test.js
npx wrangler d1 migrations apply spordo-hrpt --local   # required before local D1 tests will pass
npx wrangler deploy                                 # manual deploy (CI also deploys on push to main)
```

Local D1 (`wrangler dev`) and remote/production D1 are **separate stores that start independently empty** — a migration applied to one does nothing for the other. `D1_ERROR: no such table` in local dev means the `--local` migration step above was skipped, not a code bug.

## Toolkit

`.claude/` has agents (`frontend-engineer`, `backend-engineer`, `data-pipeline-engineer`, `code-reviewer`), skills (`spordo-architecture`, `nyc-open-data`), and commands (`/build-loop`, `/save`, `/deploy`) — see `.claude/README.md`. Route work to the matching agent rather than doing cross-domain work inline.

## Conventions

- **Secrets never in the repo or client.** Wrangler secrets / `.dev.vars` (gitignored) server-side only. The Supabase anon key is public-by-design; the service-role key never is.
- **Schema as code** — Supabase and D1 migrations are the source of truth, not a dashboard.
- **Preserve the prototype's visual design and ARIA work** when extracting/refactoring — don't regress it for the sake of restructuring.
- **Cache external data, don't hammer it live.** Sync server-side into `field_permit_cache`/`field_sync_meta`; the browser reads cache, never calls Socrata or hudsonriverpark.org directly.
- **Commit via `/save`, deploy/validate via `/deploy`.** `main` is always kept deployable; the GitHub Action ships every push.

## Storage is split — don't conflate the two

- **HRPT sync** (`src/hrpt/`) → **Cloudflare D1**, db `spordo-hrpt` (binding `env.DB`, `wrangler.jsonc`, schema in `migrations/0001_init.sql`).
- **Everything else** (Socrata sync, auth, the other 127 fields) → **Supabase**.
- Same table names (`field_permit_cache`, `field_sync_meta`) in two different backends by design. A fix to one does not apply to the other.

## HRPT scraper gotchas (hudsonriverpark.org)

Full reasoning lives in the code comments (`src/hrpt/tableGrid.js`, `src/hrpt/fieldMap.js`) — don't duplicate it here, but know these exist before assuming a parsing failure means the page changed again:

- Each table's `<thead>` has a full-width banner `<tr>` (a heading image) *before* the real header row — don't assume row 0 is the header.
- Live-page table captions always end in `" Schedule"`; field-name matching strips it. Two fields (Pier 40 Courtyard East/West) also drop the word "Field" — handled via explicit aliases.
- A benign, unfixed "block 0, found 10 tables" anomaly logs every run (likely a duplicate responsive-layout view) — doesn't lose data, not worth guess-fixing without more evidence.
- If HRPT sync writes 0 rows: check a local `--test-scheduled` run before suspecting infra. Both real incidents so far were parsing/mapping bugs, not Cloudflare/D1 problems.

## If git push / wrangler deploy fail in a sandboxed session

Some remote environments block both the local git proxy push *and* the GitHub App integration's write access, and have no authenticated `wrangler` CLI (egress policy blocks `api.cloudflare.com` directly) — this is structural, not a missing credential. Confirm with `git push` and a `mcp__github__push_files` test before assuming it's fixed.

**Working pattern**: fix + test in the sandbox, `git format-patch -1 HEAD --stdout > fix.patch`, send it to the user, they `git am` + push + `wrangler deploy` from their own authenticated machine. **Never use a manually-pasted personal access token to route around a blocked integration** — treat any token pasted into chat as compromised and tell the user to revoke it, regardless of whether it "worked before" in a different session.
