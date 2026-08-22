/**
 * SPORDO — Cloudflare Worker entrypoint.
 *
 * Static files live in ./public and are served by Cloudflare's static-asset
 * runtime via the ASSETS binding (configured in wrangler.jsonc). This Worker
 * runs only for requests that don't map directly to a static file, which lets
 * us route "/" to the main app without renaming the source file.
 */
import { runHrptSync } from "./hrpt/sync.js";
import { handlePermitsRequest } from "./permitsApi.js";
import { runSocrataSync } from "./socrata/sync.js";
import { handleSocrataPermitsRequest } from "./socrataPermitsApi.js";

const PERMITS_API_PREFIX = "/api/permits/";
const SOCRATA_PERMITS_API_PATH = "/api/permits";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Serve the main app at the root path.
    if (url.pathname === "/" || url.pathname === "") {
      url.pathname = "/TrueSpordo.html";
      return env.ASSETS.fetch(new Request(url, request));
    }

    // Cached-permit read API for the field-detail page (see permitsApi.js).
    if (url.pathname.startsWith(PERMITS_API_PREFIX)) {
      const fieldId = decodeURIComponent(url.pathname.slice(PERMITS_API_PREFIX.length));
      return handlePermitsRequest(env, fieldId);
    }

    // Cached-permit read API for the field-list view (see
    // socrataPermitsApi.js). Distinct from PERMITS_API_PREFIX above: this is
    // an exact-path + query-string route (?sport=<id>), not a path param,
    // and reads Socrata-sourced rows from Supabase instead of HRPT rows
    // from D1 — see src/socrata/ and CLAUDE.md's storage-split note.
    if (url.pathname === SOCRATA_PERMITS_API_PATH) {
      const sport = url.searchParams.get("sport");
      return handleSocrataPermitsRequest(env, { sport });
    }

    // Everything else falls through to the static-asset runtime first (real
    // files like spordo-icon.png). If nothing matches and the path has no
    // file extension, it's a client-side route (e.g. /soccer,
    // /soccer/field/<id>) -- serve the app instead of 404ing, so a hard
    // refresh or direct link works instead of breaking. Paths with a file
    // extension (favicon.ico, etc.) still get a real 404 when missing.
    const assetResponse = await env.ASSETS.fetch(request);
    if (assetResponse.status === 404 && !url.pathname.includes(".")) {
      const fallbackUrl = new URL(request.url);
      fallbackUrl.pathname = "/TrueSpordo.html";
      return env.ASSETS.fetch(new Request(fallbackUrl, request));
    }
    return assetResponse;
  },

  // Cron Trigger entrypoint (see wrangler.jsonc `triggers.crons`). Each
  // scheduled invocation runs every registered sync job: HRPT (-> D1) and
  // Socrata (-> Supabase). The two sources are intentionally decoupled
  // (separate fetch targets, separate storage backends — see CLAUDE.md's
  // "Storage is split" note) and run independently so a failure/slowdown
  // in one never blocks or delays the other.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runHrptSync(env).then((summary) => {
        if (!summary.ok) {
          console.error("[scheduled] HRPT sync did not complete successfully:", summary.reason, summary);
        } else {
          console.log("[scheduled] HRPT sync complete:", summary);
        }
      })
    );
    ctx.waitUntil(
      runSocrataSync(env).then((summary) => {
        if (!summary.ok) {
          console.error("[scheduled] Socrata sync did not complete successfully:", summary.reason, summary);
        } else {
          console.log("[scheduled] Socrata sync complete:", summary);
        }
      })
    );
  },
};
