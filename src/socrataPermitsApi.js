/**
 * GET /api/permits?sport=<id> — serves cached NYC Open Data / Socrata
 * (`tvpp-9vvx`) permit rows to the frontend from Supabase, instead of the
 * browser calling Socrata directly (see public/TrueSpordo.html loadFields()
 * and CLAUDE.md's "Cache external data, don't hammer it live" convention).
 *
 * Response shape is deliberately a bare JSON array of permit objects using
 * the SAME field names Socrata's raw JSON already used (event_location,
 * event_borough, start_date_time, end_date_time, event_name, event_type,
 * permit_holder_name, organization) — this is what src/socrata/sync.js
 * stores column-for-column in field_permit_cache, so no reshaping happens
 * here. That keeps `S.rawPermits = await res.json()` and everything
 * downstream (groupByField(), mergeExternalFields(), the borough
 * re-filter in selectBorough(), etc.) working unmodified — only the fetch
 * target changed.
 *
 * Borough filtering intentionally stays client-side (unchanged behavior):
 * the original direct-to-Socrata query was never borough-scoped either —
 * loadFields() always fetched the full citywide sport window into
 * S.rawPermits and let groupByField(S.rawPermits, S.borough) do the
 * filtering, so that selectBorough() can re-slice already-fetched data
 * without a network round-trip. Mirroring that here (rather than adding a
 * server-side borough filter) avoids a behavior change: if this route
 * filtered server-side, a borough switch after the initial load would
 * silently see fewer fields than it does today.
 */

import { TRACKED_SPORT_IDS, FIELD_PERMIT_CACHE_TABLE, FIELD_SYNC_META_TABLE } from "./socrata/config.js";

const MAX_PERMITS_RETURNED = 20000; // generous cap; MAX_PAGES_PER_SPORT already bounds sync-time ingestion
// Cron cadence is every 3h (see wrangler.jsonc); anything twice that old is
// flagged stale rather than silently served as if it were fresh.
const STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000;

async function handleSocrataPermitsRequest(env, { sport }, fetchImpl = fetch) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ error: "Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)" }, 500);
  }
  if (!sport || !TRACKED_SPORT_IDS.has(sport)) {
    return jsonResponse({ error: `unknown or missing sport (expected one of: ${[...TRACKED_SPORT_IDS].join(", ")})` }, 400);
  }

  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  };

  const permitsUrl =
    `${env.SUPABASE_URL}/rest/v1/${FIELD_PERMIT_CACHE_TABLE}` +
    `?source=eq.socrata&sport=eq.${encodeURIComponent(sport)}` +
    `&select=event_location,event_borough,start_date_time,end_date_time,event_name,event_type,permit_holder_name,organization` +
    `&order=start_date_time.asc&limit=${MAX_PERMITS_RETURNED}`;

  const metaUrl =
    `${env.SUPABASE_URL}/rest/v1/${FIELD_SYNC_META_TABLE}` +
    `?source=eq.socrata&scope=eq.${encodeURIComponent("sport:" + sport)}&select=last_synced_at,status,rows_synced,rows_dropped&limit=1`;

  let permitsResp, metaResp;
  try {
    [permitsResp, metaResp] = await Promise.all([fetchImpl(permitsUrl, { headers }), fetchImpl(metaUrl, { headers })]);
  } catch (err) {
    return jsonResponse({ error: `Supabase request failed: ${err && err.message ? err.message : err}` }, 502);
  }

  if (!permitsResp.ok) {
    return jsonResponse({ error: `Supabase read failed (${permitsResp.status}): ${await safeText(permitsResp)}` }, 502);
  }

  const permits = await permitsResp.json();
  const metaRows = metaResp.ok ? await metaResp.json() : [];
  const meta = metaRows[0] || null;

  const extraHeaders = {};
  if (meta && meta.last_synced_at) {
    const ageMs = Date.now() - new Date(meta.last_synced_at).getTime();
    extraHeaders["X-Spordo-Synced-At"] = meta.last_synced_at;
    extraHeaders["X-Spordo-Stale"] = String(ageMs > STALE_THRESHOLD_MS);
  } else {
    // Not yet synced at all -- distinct from "synced but stale".
    extraHeaders["X-Spordo-Stale"] = "unknown";
  }

  return jsonResponse(permits, 200, extraHeaders);
}

async function safeText(resp) {
  try {
    return await resp.text();
  } catch {
    return "<no body>";
  }
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      // Cache is refreshed server-side every 3h (see wrangler.jsonc
      // triggers.crons) -- a short client-side cache keeps repeat
      // sport-switches cheap without serving noticeably stale data.
      "Cache-Control": "public, max-age=300",
      ...extraHeaders,
    },
  });
}

export { handleSocrataPermitsRequest, STALE_THRESHOLD_MS };
