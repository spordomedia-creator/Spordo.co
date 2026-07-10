/**
 * HRPT permit-schedule sync: fetch -> parse -> map -> upsert.
 *
 * This is a separate pipeline from the (not-yet-built) NYC Open Data /
 * Socrata (tvpp-9vvx) sync — HRPT doesn't publish to Open Data, so it has
 * its own fetch target, parser, and field-name mapping, but writes to the
 * same `field_permit_cache` / `field_sync_meta` tables.
 *
 * Integrity rules (per data-pipeline-engineer mandate):
 *   - A failed or empty fetch NEVER touches field_permit_cache /
 *     field_sync_meta. We only mutate a field's cache if we positively
 *     parsed that field's table AND resolved a date window for it this run.
 *   - Per-field granularity: one field's parse failure/unmapped name does
 *     not block other fields in the same run (partial success is logged,
 *     not silently swallowed).
 *   - Every anomaly (unmapped name, unparsed row/column, dropped run) is
 *     logged explicitly via `log.warn`/`log.error`, never silently dropped.
 */

import { HRPT_PERMITS_URL, HRPT_FETCH_HEADERS, HRPT_SOURCE_LABEL, FIELD_PERMIT_CACHE_TABLE, FIELD_SYNC_META_TABLE } from "./config.js";
import { parseHrptPermitsHtml } from "./parser.js";
import { resolveFieldId } from "./fieldMap.js";
import { replaceFieldPermitWindow, upsertSyncMeta } from "./d1Client.js";

/**
 * @param {any} env Worker environment (env.DB — the D1 binding configured in wrangler.jsonc)
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   now?: () => Date,
 *   log?: { info: Function, warn: Function, error: Function },
 * }} [opts]
 */
async function runHrptSync(env, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const now = opts.now || (() => new Date());
  const log = opts.log || console;

  const summary = {
    ok: false,
    fetchedAt: now().toISOString(),
    fieldsWritten: 0,
    fieldsUnmapped: [],
    fieldsSkippedNoWindow: [],
    rowsInserted: 0,
    anomalies: [],
    reason: null,
  };

  let resp;
  try {
    resp = await fetchImpl(HRPT_PERMITS_URL, { headers: HRPT_FETCH_HEADERS });
  } catch (err) {
    summary.reason = `fetch threw: ${err && err.message ? err.message : err}`;
    log.error(`[hrpt-sync] ${summary.reason}`);
    return summary;
  }

  if (!resp.ok) {
    summary.reason = `fetch returned HTTP ${resp.status}`;
    log.error(`[hrpt-sync] ${summary.reason}`);
    return summary;
  }

  const html = await resp.text();
  if (!html || html.length < 200) {
    summary.reason = `fetch returned a suspiciously short body (${html ? html.length : 0} bytes)`;
    log.error(`[hrpt-sync] ${summary.reason}`);
    return summary;
  }

  const { rows, fieldsFound, anomalies } = parseHrptPermitsHtml(html, { referenceDate: now() });
  summary.anomalies.push(...anomalies);
  for (const a of anomalies) log.warn(`[hrpt-sync] ${a}`);

  if (fieldsFound.length === 0) {
    summary.reason = "parser found zero field table blocks — page structure likely changed or request was blocked; aborting without touching cache";
    log.error(`[hrpt-sync] ${summary.reason}`);
    return summary;
  }

  const rowsByFieldName = new Map();
  for (const row of rows) {
    if (!rowsByFieldName.has(row.field_name_on_page)) rowsByFieldName.set(row.field_name_on_page, []);
    rowsByFieldName.get(row.field_name_on_page).push(row);
  }

  for (const field of fieldsFound) {
    const { fieldNameOnPage, dateWindow } = field;

    if (!dateWindow) {
      // Already logged by the parser; this field is left untouched this run.
      summary.fieldsSkippedNoWindow.push(fieldNameOnPage);
      continue;
    }

    const resolved = resolveFieldId(fieldNameOnPage);
    if (!resolved) {
      const msg = `unmapped HRPT field name "${fieldNameOnPage}" — no entry in fieldMap.js; this field's cache was left untouched this run`;
      summary.anomalies.push(msg);
      summary.fieldsUnmapped.push(fieldNameOnPage);
      log.warn(`[hrpt-sync] ${msg}`);
      continue;
    }
    if (resolved.matchType === "alias") {
      log.info(`[hrpt-sync] resolved "${fieldNameOnPage}" via provisional alias -> ${resolved.fieldId} (see fieldMap.js ALIASES)`);
    }

    const fieldRows = (rowsByFieldName.get(fieldNameOnPage) || []).map((r) => ({
      field_id: resolved.fieldId,
      permit_date: r.permit_date,
      start_time: r.start_time,
      end_time: r.end_time,
      event_name: r.event_name,
    }));

    try {
      const result = await replaceFieldPermitWindow(env, {
        table: FIELD_PERMIT_CACHE_TABLE,
        fieldId: resolved.fieldId,
        minDate: dateWindow.minDate,
        maxDate: dateWindow.maxDate,
        rows: fieldRows,
      });

      await upsertSyncMeta(env, {
        table: FIELD_SYNC_META_TABLE,
        row: {
          field_id: resolved.fieldId,
          last_permit_sync_at: summary.fetchedAt,
          live_availability_status: "synced",
          permit_source_url: HRPT_PERMITS_URL,
        },
      });

      summary.fieldsWritten += 1;
      summary.rowsInserted += result.inserted;
      log.info(
        `[hrpt-sync] ${fieldNameOnPage} (${resolved.fieldId}): wrote ${result.inserted} booked row(s) for ${dateWindow.minDate}..${dateWindow.maxDate}`
      );
    } catch (err) {
      const msg = `write failed for "${fieldNameOnPage}" (${resolved.fieldId}): ${err && err.message ? err.message : err}`;
      summary.anomalies.push(msg);
      log.error(`[hrpt-sync] ${msg}`);
      // Do not throw: keep processing remaining fields so one field's DB
      // error doesn't abort the whole run.
    }
  }

  summary.ok = summary.fieldsWritten > 0;
  if (!summary.ok && !summary.reason) {
    summary.reason = "no fields were successfully written (all unmapped, windowless, or write-failed)";
  }
  return summary;
}

export { runHrptSync, HRPT_SOURCE_LABEL };
