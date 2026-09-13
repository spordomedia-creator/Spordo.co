/**
 * GET /api/permits/:fieldId — serves cached permit data from D1 to the
 * frontend. Currently only ever has real rows for HRPT fields (the only
 * source synced into D1 so far — see CLAUDE.md's storage-split note); an
 * unrecognized or not-yet-synced field_id just comes back with meta: null
 * and permits: [], which the frontend already treats as "not available"
 * rather than an error.
 */

const PERMIT_HORIZON_DAYS = 14;
const MAX_PERMITS_RETURNED = 50;

async function handlePermitsRequest(env, fieldId) {
  if (!env.DB) {
    return jsonResponse({ error: "DB (D1 binding) is not configured" }, 500);
  }
  if (!fieldId) {
    return jsonResponse({ error: "missing field id" }, 400);
  }

  const today = new Date();
  const todayStr = today.toISOString().split("T")[0];
  const horizon = new Date(today.getTime() + PERMIT_HORIZON_DAYS * 86400000);
  const horizonStr = horizon.toISOString().split("T")[0];

  const [metaResult, permitsResult, coverageResult] = await Promise.all([
    env.DB.prepare(
      `SELECT field_id, last_permit_sync_at, live_availability_status, permit_source_url
       FROM field_sync_meta WHERE field_id = ?`
    )
      .bind(fieldId)
      .first(),
    env.DB.prepare(
      `SELECT permit_date, start_time, end_time, event_name
       FROM field_permit_cache
       WHERE field_id = ? AND permit_date >= ? AND permit_date <= ?
       ORDER BY permit_date ASC, start_time ASC
       LIMIT ?`
    )
      .bind(fieldId, todayStr, horizonStr, MAX_PERMITS_RETURNED)
      .all(),
    // Separate from the windowed query above: this tells us how far the
    // SOURCE's own data actually reaches, regardless of our query window.
    // Confirmed live (2026-08-22): a sync can run successfully and stamp
    // last_permit_sync_at as fresh even when the upstream page itself is
    // stuck showing a stale week (HRPT's own site, not a sync failure) --
    // last_permit_sync_at freshness alone can't detect that, only checking
    // the actual latest cached permit_date against today can.
    env.DB.prepare(`SELECT MAX(permit_date) AS latest_date FROM field_permit_cache WHERE field_id = ?`)
      .bind(fieldId)
      .first(),
  ]);

  const latestDate = coverageResult?.latest_date || null;
  // Only meaningful for a field that's actually on a real schedule and has
  // been synced at least once -- a field with no meta row (never synced)
  // or a confirmed no_permit_schedule field isn't "stale", it's a
  // different, already-handled state.
  const sourceDataStale =
    !!metaResult &&
    metaResult.live_availability_status !== "no_permit_schedule" &&
    (!latestDate || latestDate < todayStr);

  return jsonResponse({
    meta: metaResult ? { ...metaResult, source_data_stale: sourceDataStale, latest_permit_date: latestDate } : null,
    permits: permitsResult?.results || [],
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      // Only cache successful responses. Cloudflare's edge respects
      // Cache-Control on ANY response, including errors -- caching a 4xx/5xx
      // here means a transient failure (e.g. a missing secret) gets served
      // back to everyone hitting this field for up to max-age after the
      // underlying cause is already fixed, masking the recovery. Confirmed
      // live (2026-09-13): after fixing a missing SUPABASE_SERVICE_ROLE_KEY
      // and redeploying, some sports kept 500ing for several minutes purely
      // because the earlier error response was still cached at the edge.
      // Cache is already refreshed server-side every 3h (see wrangler.jsonc
      // triggers.crons) — a short client-side cache on successes keeps
      // repeat page loads cheap without serving noticeably stale data.
      "Cache-Control": status >= 200 && status < 300 ? "public, max-age=300" : "no-store",
    },
  });
}

export { handlePermitsRequest, PERMIT_HORIZON_DAYS };
