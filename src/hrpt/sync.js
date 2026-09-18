/**
 * HRPT permit-schedule sync: discover images -> read with vision -> map -> upsert.
 *
 * HRPT replaced its HTML permit tables with weekly JPG graphics (one per field),
 * so the old HTML-table parser reads nothing. This pipeline instead fetches the
 * week's schedule images and reads each with a vision model (see imageSource.js
 * and visionParser.js), then writes to the same `field_permit_cache` /
 * `field_sync_meta` tables as before.
 *
 * Integrity rules (unchanged from the table era):
 *   - A failed or empty fetch NEVER touches the cache. We only mutate a field's
 *     rows if we positively read that field's image AND resolved its id.
 *   - Per-field granularity: one field's read/mapping/write failure does not
 *     block other fields (partial success is logged, not swallowed).
 *   - Every anomaly (unmapped name, unparsed range, dropped run) is logged.
 *
 * Cost control: an image-set hash is stored each run; if nothing changed since
 * last time, the (paid) vision reads are skipped entirely.
 */

import {
  HRPT_PERMITS_URL,
  HRPT_SOURCE_LABEL,
  FIELD_PERMIT_CACHE_TABLE,
  FIELD_SYNC_META_TABLE,
  HRPT_MANIFEST_META_ID,
} from "./config.js";
import { resolveFieldId, NO_PERMIT_SCHEDULE_FIELDS } from "./fieldMap.js";
import { replaceFieldPermitWindow, upsertSyncMeta, getSyncMetaRow } from "./d1Client.js";
import { fetchWeekImages, weekIsoFromUrl, dateForDayIndex, sha256Hex } from "./imageSource.js";
import { readScheduleImage, DAY_KEYS } from "./visionParser.js";
import { parseExplicitRangeLabel, formatTime } from "./dateTime.js";

/**
 * @param {any} env Worker env (env.DB — D1 binding; env.ANTHROPIC_API_KEY — vision key)
 * @param {{ fetchImpl?, now?, log?, apiKey?, readImage? }} [opts] injection points for tests
 */
async function runHrptSync(env, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const now = opts.now || (() => new Date());
  const log = opts.log || console;
  const apiKey = opts.apiKey || (env && env.ANTHROPIC_API_KEY);
  const readImage = opts.readImage || readScheduleImage;

  const summary = {
    ok: false,
    fetchedAt: now().toISOString(),
    source: null,
    imagesFound: 0,
    imagesRead: 0,
    skippedUnchanged: false,
    fieldsWritten: 0,
    fieldsUnmapped: [],
    fieldsNoPermitSchedule: [],
    rowsInserted: 0,
    anomalies: [],
    reason: null,
  };

  // 1. Discover + fetch this week's schedule images.
  const { images, sundayIso, source, anomalies } = await fetchWeekImages({ fetchImpl, now });
  summary.source = source;
  summary.imagesFound = images.length;
  summary.anomalies.push(...anomalies);
  for (const a of anomalies) log.warn(`[hrpt-sync] ${a}`);
  if (images.length === 0) {
    summary.reason = "no schedule images could be fetched — cache left untouched";
    log.error(`[hrpt-sync] ${summary.reason}`);
    return summary;
  }

  // 2. Skip the (paid) vision reads when nothing changed since last run.
  const manifest = await sha256Hex(new TextEncoder().encode(images.map((i) => i.hash).sort().join("|")));
  let stored = null;
  try {
    stored = await getSyncMetaRow(env, { table: FIELD_SYNC_META_TABLE, fieldId: HRPT_MANIFEST_META_ID });
  } catch (err) {
    log.warn(`[hrpt-sync] could not read image-manifest meta (${err && err.message ? err.message : err}); proceeding as if changed`);
  }
  if (stored && stored.live_availability_status === manifest) {
    summary.ok = true;
    summary.skippedUnchanged = true;
    log.info(`[hrpt-sync] images unchanged since last run (${manifest.slice(0, 12)}…) — skipping vision reads`);
    return summary;
  }

  if (!apiKey) {
    summary.reason = "ANTHROPIC_API_KEY not configured — cannot read schedule images; cache left untouched";
    log.error(`[hrpt-sync] ${summary.reason}`);
    return summary;
  }

  // 3. Read each image, map its field, write its week.
  for (const image of images) {
    let parsed;
    try {
      parsed = await readImage(image, { apiKey, fetchImpl });
      summary.imagesRead += 1;
    } catch (err) {
      const msg = `vision read failed for ${image.url}: ${err && err.message ? err.message : err}`;
      summary.anomalies.push(msg);
      log.error(`[hrpt-sync] ${msg}`);
      continue;
    }

    const cleanName = parsed.field.replace(/\s+weekly schedule$/i, "").trim();
    const resolved = resolveFieldId(cleanName);
    if (!resolved) {
      const msg = `unmapped HRPT field name "${parsed.field}" (from ${image.url}) — no fieldMap entry; left untouched`;
      summary.anomalies.push(msg);
      summary.fieldsUnmapped.push(parsed.field);
      log.warn(`[hrpt-sync] ${msg}`);
      continue;
    }
    if (resolved.matchType === "alias") {
      log.info(`[hrpt-sync] resolved "${cleanName}" via provisional alias -> ${resolved.fieldId} (see fieldMap.js ALIASES)`);
    }

    // Dates come from the image's own filename week (robust to the run clock
    // being a bit ahead/behind of when HRPT posts the new week), falling back
    // to the run-computed Sunday.
    const weekStart = weekIsoFromUrl(image.url) || sundayIso;
    const maxDate = dateForDayIndex(weekStart, 6);

    const rows = [];
    DAY_KEYS.forEach((dayKey, dayIndex) => {
      const permit_date = dateForDayIndex(weekStart, dayIndex);
      for (const rangeText of parsed.days[dayKey] || []) {
        const range = parseExplicitRangeLabel(rangeText);
        if (!range) {
          const msg = `[${cleanName}] could not parse permitted range "${rangeText}" (${dayKey}); skipped`;
          summary.anomalies.push(msg);
          log.warn(`[hrpt-sync] ${msg}`);
          continue;
        }
        rows.push({
          field_id: resolved.fieldId,
          permit_date,
          start_time: formatTime(range.startMinutes),
          end_time: formatTime(range.endMinutes),
          event_name: "Permitted",
        });
      }
    });

    try {
      // Replace the whole week window even when rows is empty — a field with no
      // green blocks this week is a legitimate "fully available" result.
      const result = await replaceFieldPermitWindow(env, {
        table: FIELD_PERMIT_CACHE_TABLE,
        fieldId: resolved.fieldId,
        minDate: weekStart,
        maxDate,
        rows,
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
      log.info(`[hrpt-sync] ${cleanName} (${resolved.fieldId}): wrote ${result.inserted} permit block(s) for ${weekStart}..${maxDate}`);
    } catch (err) {
      const msg = `write failed for "${cleanName}" (${resolved.fieldId}): ${err && err.message ? err.message : err}`;
      summary.anomalies.push(msg);
      log.error(`[hrpt-sync] ${msg}`);
    }
  }

  // 4. Fields that never have a bookable schedule (see fieldMap.js) — write
  // their meta every successful run so the frontend shows "open play".
  for (const { fieldId, name } of NO_PERMIT_SCHEDULE_FIELDS) {
    try {
      await upsertSyncMeta(env, {
        table: FIELD_SYNC_META_TABLE,
        row: {
          field_id: fieldId,
          last_permit_sync_at: summary.fetchedAt,
          live_availability_status: "no_permit_schedule",
          permit_source_url: HRPT_PERMITS_URL,
        },
      });
      summary.fieldsNoPermitSchedule.push(name);
    } catch (err) {
      const msg = `no-permit-schedule meta write failed for "${name}" (${fieldId}): ${err && err.message ? err.message : err}`;
      summary.anomalies.push(msg);
      log.error(`[hrpt-sync] ${msg}`);
    }
  }

  // 5. Persist the image-set hash — only after a pass that actually wrote data,
  // so a failed run retries next time instead of being skipped as "unchanged".
  if (summary.fieldsWritten > 0) {
    try {
      await upsertSyncMeta(env, {
        table: FIELD_SYNC_META_TABLE,
        row: {
          field_id: HRPT_MANIFEST_META_ID,
          last_permit_sync_at: summary.fetchedAt,
          live_availability_status: manifest,
          permit_source_url: sundayIso,
        },
      });
    } catch (err) {
      summary.anomalies.push(`image-manifest hash write failed: ${err && err.message ? err.message : err}`);
    }
  }

  summary.ok = summary.fieldsWritten > 0;
  if (!summary.ok && !summary.reason) {
    summary.reason = "no fields were successfully written (all unmapped, unreadable, or write-failed)";
  }
  return summary;
}

export { runHrptSync, HRPT_SOURCE_LABEL };
