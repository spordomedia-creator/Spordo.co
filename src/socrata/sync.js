/**
 * NYC Open Data / Socrata (`tvpp-9vvx`) permit sync: fetch -> normalize ->
 * upsert, one tracked sport at a time.
 *
 * Mirrors src/hrpt/sync.js's shape and integrity rules (per
 * data-pipeline-engineer mandate), adapted for a Supabase backend and a
 * per-sport (not per-field) sync unit — see supabaseClient.js and
 * normalize.js doc comments for why.
 *
 * Integrity rules:
 *   - A failed fetch for a sport (after retries) NEVER touches that
 *     sport's field_permit_cache / field_sync_meta rows. Only a
 *     successfully fetched window (even if it legitimately contains zero
 *     matching permits) replaces the cache.
 *   - Per-sport granularity: one sport's fetch/write failure does not
 *     block any other sport in the same run (partial success is logged,
 *     not silently swallowed).
 *   - Every anomaly (dropped row, truncated page cap, failed sport) is
 *     logged explicitly via `log.warn`/`log.error`, never silently
 *     dropped — see field_sync_meta.rows_dropped for the persisted count.
 */

import {
  TRACKED_SPORTS,
  FIELD_PERMIT_CACHE_TABLE,
  FIELD_SYNC_META_TABLE,
  SYNC_WINDOW_DAYS,
  SOCRATA_SOURCE_LABEL,
  SOCRATA_SOURCE_URL,
} from "./config.js";
import { isoDateOnly, daysFromIsoDate } from "./soql.js";
import { fetchSportWindow } from "./fetchSocrata.js";
import { normalizeRows } from "./normalize.js";
import { replaceSportPermitWindow, upsertSyncMeta } from "./supabaseClient.js";

/**
 * @param {any} env Worker environment (env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, env.SOCRATA_APP_TOKEN)
 * @param {{
 *   fetchImpl?: typeof fetch,             fetch used for Socrata itself
 *   supabaseFetchImpl?: typeof fetch,     fetch used for Supabase PostgREST calls (defaults to fetchImpl, then global fetch) -- split out so tests can mock each independently
 *   now?: () => Date,
 *   log?: { info: Function, warn: Function, error: Function },
 *   sleepImpl?: (ms: number) => Promise<void>,
 * }} [opts]
 */
async function runSocrataSync(env, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const supabaseFetchImpl = opts.supabaseFetchImpl || opts.fetchImpl || fetch;
  const now = opts.now || (() => new Date());
  const log = opts.log || console;
  const sleepImpl = opts.sleepImpl;
  const appToken = env.SOCRATA_APP_TOKEN;

  const referenceDate = now();
  const minDateIso = isoDateOnly(referenceDate);
  const maxDateIso = daysFromIsoDate(referenceDate, SYNC_WINDOW_DAYS);
  const fetchedAt = referenceDate.toISOString();

  const summary = {
    ok: false,
    fetchedAt,
    window: { minDateIso, maxDateIso },
    sportsSynced: [],
    sportsFailed: [],
    rowsInserted: 0,
    rowsDropped: 0,
    anomalies: [],
    reason: null,
  };

  for (const sport of TRACKED_SPORTS) {
    let fetchResult;
    try {
      fetchResult = await fetchSportWindow(sport, {
        minDateIso,
        maxDateIso,
        fetchImpl,
        appToken,
        log,
        ...(sleepImpl ? { sleepImpl } : {}),
      });
    } catch (err) {
      const msg = `fetch failed for sport=${sport.id}: ${err && err.message ? err.message : err} — this sport's cache was left untouched this run`;
      summary.anomalies.push(msg);
      summary.sportsFailed.push(sport.id);
      log.error(`[socrata-sync] ${msg}`);
      continue;
    }

    if (fetchResult.truncated) {
      summary.anomalies.push(`sport=${sport.id} window possibly truncated at MAX_PAGES_PER_SPORT (fetched ${fetchResult.rawRows.length} rows)`);
    }

    const { rows, drops } = normalizeRows(fetchResult.rawRows, sport.id);
    if (drops.length > 0) {
      const msg = `sport=${sport.id}: dropped ${drops.length} of ${fetchResult.rawRows.length} fetched row(s) (missing required fields)`;
      summary.anomalies.push(msg);
      log.warn(`[socrata-sync] ${msg}`);
    }

    try {
      const result = await replaceSportPermitWindow(env, {
        table: FIELD_PERMIT_CACHE_TABLE,
        sport: sport.id,
        minDateIso,
        maxDateIso,
        rows,
        fetchImpl: supabaseFetchImpl,
      });

      await upsertSyncMeta(env, {
        table: FIELD_SYNC_META_TABLE,
        row: {
          source: SOCRATA_SOURCE_LABEL,
          scope: `sport:${sport.id}`,
          last_synced_at: fetchedAt,
          status: "synced",
          rows_synced: rows.length,
          rows_dropped: drops.length,
          error_message: null,
          source_url: SOCRATA_SOURCE_URL,
        },
        fetchImpl: supabaseFetchImpl,
      });

      summary.sportsSynced.push(sport.id);
      summary.rowsInserted += result.inserted;
      summary.rowsDropped += drops.length;
      log.info(`[socrata-sync] sport=${sport.id}: wrote ${result.inserted} permit row(s) for ${minDateIso}..${maxDateIso}`);
    } catch (err) {
      const msg = `write failed for sport=${sport.id}: ${err && err.message ? err.message : err}`;
      summary.anomalies.push(msg);
      summary.sportsFailed.push(sport.id);
      log.error(`[socrata-sync] ${msg}`);
      // Do not throw: keep processing remaining sports so one sport's DB
      // error doesn't abort the whole run.
    }
  }

  summary.ok = summary.sportsSynced.length > 0;
  if (!summary.ok && !summary.reason) {
    summary.reason = "no sports were successfully synced (all fetch-failed or write-failed)";
  }
  return summary;
}

export { runSocrataSync, SOCRATA_SOURCE_LABEL };
