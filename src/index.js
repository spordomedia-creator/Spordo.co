/**
 * SPORDO — Cloudflare Worker entrypoint.
 *
 * Static files live in ./public and are served by Cloudflare's static-asset
 * runtime via the ASSETS binding (configured in wrangler.jsonc). This Worker
 * runs only for requests that don't map directly to a static file, which lets
 * us route "/" to the main app without renaming the source file.
 */
import { runHrptSync } from "./hrpt/sync.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Serve the main app at the root path.
    if (url.pathname === "/" || url.pathname === "") {
      url.pathname = "/TrueSpordo.html";
      return env.ASSETS.fetch(new Request(url, request));
    }

    // Everything else falls through to the static-asset runtime.
    return env.ASSETS.fetch(request);
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
