/**
 * Paginated, backing-off Socrata fetch for one tracked sport's date window.
 *
 * Good-citizen rules (per .claude/skills/nyc-open-data and the
 * data-pipeline-engineer mandate):
 *   - Send an app token (X-App-Token) when configured — anonymous requests
 *     share a low platform-wide rate limit.
 *   - Page with $limit/$offset until a page comes back short of PAGE_SIZE
 *     (i.e. we've reached the end) rather than assuming any fixed count
 *     covers a sport's full window.
 *   - Back off (retry with delay) on 429/5xx instead of hammering harder;
 *     give up after MAX_FETCH_RETRIES and surface the failure rather than
 *     silently returning a partial result as if it were complete.
 */

import { PAGE_SIZE, MAX_PAGES_PER_SPORT, MAX_FETCH_RETRIES, RETRY_BASE_DELAY_MS } from "./config.js";
import { buildSportPageUrl } from "./soql.js";

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch a single page, retrying on 429/5xx with exponential backoff.
 * Throws if every attempt fails (caller decides what that means for the
 * sport's cache — see sync.js).
 */
async function fetchPageWithRetry(url, { fetchImpl, headers, log, sleepImpl }) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_FETCH_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      log.warn(`[socrata-fetch] retrying (attempt ${attempt + 1}/${MAX_FETCH_RETRIES + 1}) after ${delay}ms: ${url}`);
      await sleepImpl(delay);
    }
    try {
      const resp = await fetchImpl(url, { headers });
      if (resp.ok) return resp;
      if (resp.status === 429 || resp.status >= 500) {
        lastErr = new Error(`HTTP ${resp.status}`);
        continue; // retryable
      }
      // Non-retryable (4xx other than 429): fail fast, don't burn through
      // the remaining retry budget on a request that will never succeed.
      throw new Error(`HTTP ${resp.status} (non-retryable)`);
    } catch (err) {
      if (err && err.message && err.message.includes("(non-retryable)")) throw err;
      lastErr = err;
      // A thrown network error is treated the same as a retryable HTTP
      // failure — only loop again if attempts remain.
    }
  }
  throw lastErr || new Error("fetch failed with no error captured");
}

/**
 * Fetch every page of one tracked sport's date window.
 *
 * @returns {{ rawRows: any[], pages: number, truncated: boolean }}
 * @throws if the very first page fails after retries (nothing usable was
 *   fetched — caller must not touch that sport's cache). A failure on a
 *   *later* page still throws (we don't have a way to know if the missed
 *   page contained rows that would've replaced/complemented what we
 *   already have) rather than silently caching a partial result as if it
 *   were the full window.
 */
async function fetchSportWindow(sport, { minDateIso, maxDateIso, fetchImpl, appToken, log, sleepImpl = defaultSleep }) {
  const headers = appToken ? { "X-App-Token": appToken } : {};
  if (!appToken) {
    log.warn(`[socrata-fetch] no SOCRATA_APP_TOKEN configured — sharing Socrata's low anonymous rate limit for sport=${sport.id}`);
  }

  const rawRows = [];
  let offset = 0;
  let page = 0;
  let truncated = false;

  while (page < MAX_PAGES_PER_SPORT) {
    const url = buildSportPageUrl(sport, { minDateIso, maxDateIso, offset, limit: PAGE_SIZE });
    const resp = await fetchPageWithRetry(url, { fetchImpl, headers, log, sleepImpl });
    const batch = await resp.json();
    if (!Array.isArray(batch)) {
      throw new Error(`unexpected non-array Socrata response for sport=${sport.id} at offset=${offset}`);
    }
    rawRows.push(...batch);
    page += 1;
    if (batch.length < PAGE_SIZE) {
      // Short page = last page.
      return { rawRows, pages: page, truncated: false };
    }
    offset += PAGE_SIZE;
  }

  truncated = true;
  log.error(
    `[socrata-fetch] sport=${sport.id} hit MAX_PAGES_PER_SPORT (${MAX_PAGES_PER_SPORT}) — window may be truncated, fetched ${rawRows.length} rows across ${page} pages`
  );
  return { rawRows, pages: page, truncated };
}

export { fetchSportWindow, fetchPageWithRetry };
