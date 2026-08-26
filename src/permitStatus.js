/**
 * Pure classification of an external field's permit-sync state, given the
 * `meta` object returned by GET /api/permits/:fieldId (see permitsApi.js).
 *
 * This mirrors the branching in public/TrueSpordo.html's loadExternalPermits()
 * / renderSchdBody() (search for `_notSynced` / `_noPermitSchedule` /
 * `_sourceStale`). It's duplicated here as a standalone, unit-testable pure
 * function because the HTML file is a non-module inline `<script>` (its
 * functions are attached to `window` for onclick handlers) and isn't
 * importable by node --test — keep the two in sync by hand if either
 * branch changes.
 *
 * States, in priority order:
 *  - "not_synced": no field_sync_meta row at all (meta === null). This
 *    field_id has never been synced into D1 -- either it's not on the HRPT
 *    pipeline, or its EXTERNAL_ORGS name doesn't match a real HRPT table.
 *    Rendering the normal grid here would fabricate an all-"Free" schedule
 *    from an empty permits array (confirmed live on "Pier 40 — Field C").
 *  - "no_schedule": confirmed via source research that this field has no
 *    bookable schedule at all (open/drop-in play).
 *  - "stale": synced successfully, but the source's own data doesn't reach
 *    today (the upstream page itself is frozen on an old week).
 *  - "ok": real, current data -- safe to render the normal grid.
 */
function classifyExternalFieldStatus(meta) {
  if (meta === null || meta === undefined) return "not_synced";
  if (meta.live_availability_status === "no_permit_schedule") return "no_schedule";
  if (meta.source_data_stale === true) return "stale";
  return "ok";
}

export { classifyExternalFieldStatus };
