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

const PERMITS_API_PREFIX = "/api/permits/";

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
  // scheduled invocation runs every registered sync job; today that's just
  // HRPT. The NYC Open Data / Socrata sync (tvpp-9vvx) is a separate,
  // not-yet-built job that will get its own module under src/ and its own
  // call here — the two sources are intentionally decoupled since HRPT
  // doesn't publish to Open Data.
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
  },
};
