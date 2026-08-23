/**
 * Slack webhook alerting for sync failures and silent data staleness.
 *
 * Built after a real 2026-08-22 incident: the HRPT scraper broke silently
 * for ~5 weeks (a live-page HTML change broke field-name detection) with
 * nothing watching it -- a user noticed the site showing wrong data before
 * anyone else did. That incident actually had TWO distinct failure modes,
 * both handled here:
 *
 *   1. A sync run completely fails (summary.ok === false) -- e.g. zero
 *      fields could be parsed/mapped. Unambiguous, always worth alerting.
 *   2. A sync run SUCCEEDS (writes real data, summary.ok === true) but the
 *      underlying SOURCE data doesn't actually reach today -- e.g. HRPT's
 *      own page frozen on an old week (confirmed live, same day: cached
 *      data stuck on Aug 9-16 while real dates had moved past Aug 22,
 *      even though last_permit_sync_at looked fresh every single run).
 *      This can't be detected from the sync summary alone -- it requires
 *      checking the actual cached data's date coverage after the fact
 *      (see d1Client.js getFieldCoverage / permitsApi.js's identical
 *      per-field check, which this mirrors at the whole-source level).
 *
 * Deliberately pure/testable: buildSyncFailureAlert and
 * buildStalenessAlert take plain data and return a message string or
 * null, with no fetch/env involved. sendSlackAlert is the only function
 * that touches the network, and takes a dependency-injected fetchImpl
 * (same pattern as src/hrpt/sync.js and src/socrata/fetchSocrata.js) so
 * it's testable without a real webhook.
 */

/**
 * POST a plain-text message to a Slack incoming webhook.
 * @param {string|undefined} webhookUrl from env.SLACK_ALERT_WEBHOOK_URL — a
 *   Wrangler secret, never hardcoded or committed. If unset, this no-ops
 *   (returns sent:false with a reason) rather than throwing, so a missing
 *   webhook never breaks the sync run it's reporting on.
 * @param {string} text
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 */
async function sendSlackAlert(webhookUrl, text, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  if (!webhookUrl) {
    return { sent: false, reason: "SLACK_ALERT_WEBHOOK_URL is not configured" };
  }
  try {
    const res = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      return { sent: false, reason: `Slack returned HTTP ${res.status}` };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: `fetch threw: ${err && err.message ? err.message : String(err)}` };
  }
}

/**
 * @param {string} sourceLabel e.g. "HRPT" or "Socrata"
 * @param {{ ok: boolean, reason?: string|null, anomalies?: string[], fieldsWritten?: number }} summary
 * @returns {string|null} an alert message, or null if the run succeeded.
 */
function buildSyncFailureAlert(sourceLabel, summary) {
  if (!summary || summary.ok) return null;
  // HRPT's summary uses fieldsWritten; Socrata's uses sportsSynced.length
  // (see src/socrata/sync.js) -- support both shapes rather than assuming one.
  const writtenCount = summary.fieldsWritten ?? summary.sportsSynced?.length ?? 0;
  const lines = [
    `:rotating_light: *${sourceLabel} sync failed* — ${summary.reason || "unknown reason"}`,
    `Written: ${writtenCount}`,
  ];
  if (summary.anomalies && summary.anomalies.length) {
    lines.push(`First anomaly: ${summary.anomalies[0]}`);
  }
  return lines.join("\n");
}

/**
 * @param {string} sourceLabel
 * @param {{ fieldId: string, latestDate: string|null }[]} coverage one
 *   entry per tracked field (see d1Client.js getFieldCoverage).
 * @param {string} todayStr YYYY-MM-DD
 * @param {number} [staleThresholdFraction] alert only when at least this
 *   fraction of tracked fields are stale (default 1.0 — ALL of them, since
 *   that's the signature of a source-wide freeze like the real incident,
 *   not just one field having a legitimately quiet week with no bookings
 *   that also happen to be the ones scoped past today — this intentionally
 *   does NOT fire for a single stale field, only a source-wide pattern).
 * @returns {string|null}
 */
function buildStalenessAlert(sourceLabel, coverage, todayStr, staleThresholdFraction = 1.0) {
  if (!coverage || coverage.length === 0) return null;
  const stale = coverage.filter((c) => !c.latestDate || c.latestDate < todayStr);
  if (stale.length / coverage.length < staleThresholdFraction) return null;
  const knownDates = stale.map((c) => c.latestDate).filter(Boolean).sort();
  const mostRecent = knownDates.length ? knownDates[knownDates.length - 1] : "never";
  return (
    `:warning: *${sourceLabel} source data looks stale* — ${stale.length}/${coverage.length} tracked fields ` +
    `have no cached data reaching today (${todayStr}). Most recent cached date across them: ${mostRecent}. ` +
    `This usually means the SOURCE page itself hasn't updated (not a sync failure) — check it directly.`
  );
}

export { sendSlackAlert, buildSyncFailureAlert, buildStalenessAlert };
