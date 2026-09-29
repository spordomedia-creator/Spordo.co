# CLAUDE.md

## What this is

SPORDO — NYC sports-field & court permit-availability tracker ("Know Before You Go"). The frontend is `public/TrueSpordo.html` (~310KB HTML with inline JS; **CSS is external in `public/styles.css`, images external in `public/images/`**), served as a Cloudflare Worker via Workers Static Assets (`./public`). 137-entry `FIELD_DATABASE` inline. Being migrated to production incrementally — see the `spordo-architecture` skill for the target stack.

## PRODUCTION LOCATION & ACCOUNTS — read this first

- **This repo IS production.** `/Users/massimobianchi/Documents/Spordo.co` → GitHub `spordomedia-creator/Spordo.co` → Worker **`spordo-co`** on the **`spordomedia@gmail.com`** Cloudflare account → serves **spordo.org**. Edit `public/TrueSpordo.html` here.
- **`/Users/massimobianchi/Documents/spordo` is a STALE SIDE COPY — never edit or deploy it.** It's a divergent 3.5MB build (base64-inlined images) with its own worker `spordo-api` on a *different* Cloudflare account (`mbianchi@gcschool.org`). That whole build/account is being **retired**. If a handoff doc or chat points you there, stop — it's the wrong target. (This mismatch caused a full session of wasted work.)
- **Only `spordomedia@gmail.com` is used for Cloudflare.** Before `wrangler deploy`, confirm `npx wrangler whoami` shows `spordomedia@gmail.com` — logins have gotten swapped to the mbianchi account. If wrong: `npx wrangler logout && npx wrangler login` (sign out of Cloudflare in the browser first so it doesn't re-authorize mbianchi).
- **Auth is Supabase** (project `spordo` / `avwvtjsabmhqqeosqubw`), NOT the `spordo-api` custom-auth backend. Live features: signup, signin, forgot-password, reset, account panel, resend-verification, sign-out-all (all in `public/TrueSpordo.html`, built on `_sb = supabase.createClient(...)`). Auth emails go through **Resend** (custom SMTP set in Supabase → Authentication → Emails); Supabase **Site URL = https://spordo.org**.

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

## HRPT sync — reads weekly schedule IMAGES with vision (not HTML tables)

HRPT replaced its HTML permit tables with weekly JPG graphics, so the old HTML-table parser was deleted (PR #18). Current pipeline (`src/hrpt/`):

- `imageSource.js` scrapes the permits page for the week's `Field_Schedules` JPG URLs (fallback: constructs them from the week's Sunday) and fetches bytes + a sha-256 per image.
- `visionParser.js` reads each image with the Anthropic vision API (`claude-haiku-4-5`) → `{field, days:{sunday..saturday:[ranges]}}`. **Requires the `ANTHROPIC_API_KEY` worker secret.**
- `sync.js` maps field names (`fieldMap.js`), writes booked blocks to D1, and stores an image-set hash so it only calls (paid) vision when an image actually changed. A failed/empty read never overwrites the cache.
- Runs on cron **`0 */3 * * *` (HRPT)**; Socrata runs on **`15 */3 * * *`** — separate ticks so each gets its own Cloudflare subrequest budget (bundling them overflowed the 50/invocation cap). Dispatch is by `event.cron` in `src/index.js`.
- To test a run: `npx wrangler dev --remote --test-scheduled`, then `curl "http://localhost:PORT/__scheduled?cron=0%20*/3%20*%20*%20*"`.

## HRPT data is displayed via the same grid as everything else

- `GET /api/permits/:fieldId` (`src/permitsApi.js`) reads D1 server-side and returns `{meta, permits}` — the browser can't reach D1 directly, so this route exists for that. The read floors on today's date + a horizon so stale past rows don't bury current data.
- HRPT fields render through the **same** `renderSchdWeek`/`renderSchdMonth` grid every other field uses (`public/TrueSpordo.html`), adapting D1 rows into the Socrata permit shape (`start_date_time`/`end_date_time`/`event_name`). Cached per field via `f._permitsLoaded`.
- External non-NYC-Parks fields with a published seasonal schedule (e.g. Brooklyn Bridge Park's Pier 5, in `EXTERNAL_ORGS` + `BBP_PIER5_SCHEDULES`) are transcribed by hand and rendered as booked blocks with a season banner + disclaimer. A source-stale notice covers HRPT weeks HRPT hasn't posted yet.

## CI (`.github/workflows/deploy.yml`)

- Needs Node **22+** (`wrangler` `^4.20.0` requires it) — Node 20 makes `cloudflare/wrangler-action` silently fall back to an ancient wrangler that can't read `wrangler.jsonc`'s `main` field.
- Needs repo secrets `CLOUDFLARE_API_TOKEN` (the **"Edit Cloudflare Workers"** dashboard template — covers D1 too) and `CLOUDFLARE_ACCOUNT_ID`, or every deploy fails with "must set a CLOUDFLARE_API_TOKEN". Both were missing from repo creation until fixed this session — check `Settings → Secrets and variables → Actions` if CI ever regresses.
- A GitHub PAT needs the **`workflow`** scope specifically to push changes to files under `.github/workflows/` — a `repo`-only-scoped token gets rejected with "refusing to allow a Personal Access Token to create or update workflow ... without `workflow` scope".

## If git push / wrangler deploy fail in a sandboxed session

Some remote environments block both the local git proxy push *and* the GitHub App integration's write access, and have no authenticated `wrangler` CLI (egress policy blocks `api.cloudflare.com` directly) — this is structural, not a missing credential. Confirm with `git push` and a `mcp__github__push_files` test before assuming it's fixed.

**Working pattern**: fix + test in the sandbox, `git format-patch -1 HEAD --stdout > fix.patch`, send it to the user, they `git am` + push + `wrangler deploy` from their own authenticated machine. **Never use a manually-pasted personal access token to route around a blocked integration** — treat any token pasted into chat as compromised and tell the user to revoke it, regardless of whether it "worked before" in a different session.
