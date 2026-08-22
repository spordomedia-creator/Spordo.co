/**
 * Normalize a raw Socrata `tvpp-9vvx` row into the shape stored in
 * Supabase's `field_permit_cache` (see supabase/migrations for the DDL).
 *
 * Deliberately kept row-level (one cached row per raw permit), not
 * aggregated into a canonical `field_id` the way HRPT's D1 cache is —
 * Socrata's ~127 non-HRPT fields don't have a reliable name-to-field_id
 * mapping yet (that's flagged as future work, out of scope for this sync;
 * see data-pipeline-engineer's broader mandate). Storing the raw
 * event_location/event_borough string lets the existing frontend
 * `groupByField()` keep doing that grouping client-side, unchanged.
 *
 * Integrity rule: a row is only dropped (not silently kept with garbage
 * data) when it's missing `start_date_time` — that field is required both
 * for the delete+insert window scoping in supabaseClient.js and for the
 * frontend's date filtering/sort. Every other field degrades gracefully
 * with the same fallback the frontend itself already uses.
 */

/**
 * @param {any} raw one row from the Socrata JSON response
 * @param {string} sportId tracked sport id this row was fetched under
 * @returns {{ row: object } | { dropped: true, reason: string }}
 */
function normalizePermitRow(raw, sportId) {
  const startDateTime = trimOrNull(raw.start_date_time);
  if (!startDateTime) {
    return { dropped: true, reason: "missing start_date_time" };
  }

  return {
    row: {
      source: "socrata",
      sport: sportId,
      event_location: trimOrNull(raw.event_location) || "NYC Parks Field",
      event_borough: trimOrNull(raw.event_borough),
      start_date_time: startDateTime,
      end_date_time: trimOrNull(raw.end_date_time),
      event_name: trimOrNull(raw.event_name),
      event_type: trimOrNull(raw.event_type),
      permit_holder_name: trimOrNull(raw.permit_holder_name),
      organization: trimOrNull(raw.organization),
    },
  };
}

/**
 * Normalize a page of raw rows, separating kept rows from drop reasons so
 * the caller can log every drop explicitly (never a silent truncation).
 */
function normalizeRows(rawRows, sportId) {
  const rows = [];
  const drops = [];
  for (const raw of rawRows) {
    const result = normalizePermitRow(raw, sportId);
    if (result.dropped) {
      drops.push(result.reason);
    } else {
      rows.push(result.row);
    }
  }
  return { rows, drops };
}

function trimOrNull(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

export { normalizePermitRow, normalizeRows };
