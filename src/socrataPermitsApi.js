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
 *
 * Paging: Supabase caps every PostgREST read at the project's "Max rows"
 * setting (1,000 by default) whatever `limit` asks for. This route used to
 * send one `limit=20000` request and got back the first 1,000 rows, which
 * for soccer was today only: on 2026-10-07 it served 1,000 of 28,848 cached
 * rows, so every soccer field's week view showed "Free" from tomorrow on.
 * It now asks for an exact count with the first page, then fetches the rest
 * in parallel, and joins the pages as raw bytes (see joinJsonArrays).
 *
 * Duplicates: the cache currently holds many permits twice (two sync runs
 * writing the same window at the same time). Rows pass through as-is here,
 * since dropping them would mean parsing every row; the frontend drops exact
 * duplicates in dedupePermits() (public/TrueSpordo.html).
 */

import { TRACKED_SPORT_IDS, FIELD_PERMIT_CACHE_TABLE, FIELD_SYNC_META_TABLE } from "./socrata/config.js";
import { nycDateIso } from "./nycTime.js";

// Rows asked for per page. Whatever the server actually returns for the first
// page becomes the page size, so any Max rows setting pages right. Asking
// above the default 1,000 changes nothing today (checked live: limit=10000
// comes back as 0-999 of 28,848), but if Max rows is ever raised, soccer
// drops from ~29 pages to 3 with no code change.
const PAGE_LIMIT = 10000;
// Each page is a subrequest, and the Workers Free plan allows 50 per request
// (the meta read is one more). 40 pages is 40,000 rows at the default cap;
// past that the response is served partial and flagged with
// X-Spordo-Truncated: true, never passed off as complete.
const MAX_PAGES = 40;
const PERMIT_COLUMNS =
  "event_location,event_borough,start_date_time,end_date_time,event_name,event_type,permit_holder_name,organization";
// Cron cadence is every 3h (see wrangler.jsonc); anything twice that old is
// flagged stale rather than silently served as if it were fresh.
const STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000;

async function handleSocrataPermitsRequest(env, { sport, now = new Date() }, fetchImpl = fetch) {
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

  // Only return current + upcoming permits. The sync's window delete only clears
  // [today, today+90], so rows for dates BEFORE today are never purged and pile
  // up. Without this floor, the ascending-order + PostgREST row cap would return
  // those stale past rows first and bury the fresh future data (observed live:
  // the cache served weeks-old permits while thousands of current ones existed).
  // "Today" is New York's date: start_date_time is NYC local time, and the UTC
  // date is already tomorrow from 8pm ET, which dropped tonight's bookings.
  const todayIso = nycDateIso(now);
  const permitsUrl =
    `${env.SUPABASE_URL}/rest/v1/${FIELD_PERMIT_CACHE_TABLE}` +
    `?source=eq.socrata&sport=eq.${encodeURIComponent(sport)}` +
    `&start_date_time=gte.${encodeURIComponent(todayIso + "T00:00:00.000")}` +
    `&select=${PERMIT_COLUMNS}` +
    // `id` breaks ties, so every page sees the same row order. By
    // start_date_time alone, rows sharing a start time can move across a
    // page boundary between requests (repeated on one page, missing from
    // the next).
    `&order=start_date_time.asc,id.asc`;

  const metaUrl =
    `${env.SUPABASE_URL}/rest/v1/${FIELD_SYNC_META_TABLE}` +
    `?source=eq.socrata&scope=eq.${encodeURIComponent("sport:" + sport)}&select=last_synced_at,status,rows_synced,rows_dropped&limit=1`;

  let firstResp, metaResp;
  try {
    [firstResp, metaResp] = await Promise.all([
      // count=exact puts the total row count in Content-Range, so the
      // remaining pages can all be requested at once.
      fetchImpl(`${permitsUrl}&offset=0&limit=${PAGE_LIMIT}`, { headers: { ...headers, Prefer: "count=exact" } }),
      fetchImpl(metaUrl, { headers }),
    ]);
  } catch (err) {
    return supabaseRequestFailed(err);
  }

  if (!firstResp.ok) {
    return supabaseReadFailed(firstResp);
  }

  const range = parseContentRange(firstResp.headers.get("Content-Range"));
  const pageResponses = [firstResp];
  let truncated;
  if (!range || range.total === null) {
    // PostgREST always sends the count when asked; without it there is no
    // telling how much is missing, so say so instead of guessing.
    truncated = "unknown";
    console.warn(`[socrata-permits-api] sport=${sport}: no row count in Content-Range; serving the first page only`);
  } else {
    const offsets = [];
    for (let offset = range.rows; range.rows > 0 && offset < range.total && offsets.length < MAX_PAGES - 1; offset += range.rows) {
      offsets.push(offset);
    }
    let rest;
    try {
      rest = await Promise.all(offsets.map((offset) => fetchImpl(`${permitsUrl}&offset=${offset}&limit=${range.rows}`, { headers })));
    } catch (err) {
      return supabaseRequestFailed(err);
    }
    const failed = rest.find((r) => !r.ok);
    if (failed) {
      return supabaseReadFailed(failed);
    }
    pageResponses.push(...rest);
    truncated = range.rows * pageResponses.length < range.total;
    if (truncated) {
      console.warn(`[socrata-permits-api] sport=${sport}: ${range.total} rows exceed ${MAX_PAGES} pages of ${range.rows}; serving a partial window`);
    }
  }

  let body;
  try {
    body = joinJsonArrays(await Promise.all(pageResponses.map(async (r) => new Uint8Array(await r.arrayBuffer()))));
  } catch (err) {
    return jsonResponse({ error: `Supabase read returned an unexpected body: ${err && err.message ? err.message : err}` }, 502);
  }

  const metaRows = metaResp.ok ? await metaResp.json() : [];
  const meta = metaRows[0] || null;

  const extraHeaders = { "X-Spordo-Truncated": String(truncated) };
  if (truncated !== false) {
    // A partial window must not stick in browser/edge caches for max-age;
    // the next request should get a fresh try at the whole thing.
    extraHeaders["Cache-Control"] = "no-store";
  }
  if (range && range.total !== null) {
    // Cached rows from today on, before the frontend drops duplicates.
    extraHeaders["X-Spordo-Total-Rows"] = String(range.total);
  }
  if (meta && meta.last_synced_at) {
    const ageMs = Date.now() - new Date(meta.last_synced_at).getTime();
    extraHeaders["X-Spordo-Synced-At"] = meta.last_synced_at;
    extraHeaders["X-Spordo-Stale"] = String(ageMs > STALE_THRESHOLD_MS);
  } else {
    // Not yet synced at all -- distinct from "synced but stale".
    extraHeaders["X-Spordo-Stale"] = "unknown";
  }

  return rawJsonResponse(body, 200, extraHeaders);
}

/**
 * PostgREST Content-Range -> { rows, total }: rows in this response, and the
 * total matching rows (null if not counted). Shapes: "0-999/28848" (counted),
 * "0-999/" + "*" (not counted), and "*" + "/0" for an empty result. Returns
 * null if the header is missing or unreadable.
 */
function parseContentRange(header) {
  const m = /^\s*(?:(\d+)-(\d+)|\*)\/(\d+|\*)\s*$/.exec(header || "");
  if (!m) return null;
  return {
    rows: m[1] === undefined ? 0 : Number(m[2]) - Number(m[1]) + 1,
    total: m[3] === "*" ? null : Number(m[3]),
  };
}

const JSON_OPEN = 0x5b; // [
const JSON_CLOSE = 0x5d; // ]
const JSON_COMMA = 0x2c; // ,

function isJsonWhitespace(byte) {
  return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;
}

/**
 * Join JSON-array bodies (as bytes) into one JSON array without parsing them.
 * Parsing and re-serializing soccer's several MB of rows costs tens of
 * milliseconds of CPU, and the Workers Free plan allows 10 ms per request;
 * copying bytes costs next to nothing.
 */
function joinJsonArrays(bodies) {
  const inners = [];
  for (const bytes of bodies) {
    let start = 0;
    let end = bytes.length;
    while (start < end && isJsonWhitespace(bytes[start])) start++;
    while (end > start && isJsonWhitespace(bytes[end - 1])) end--;
    if (end - start < 2 || bytes[start] !== JSON_OPEN || bytes[end - 1] !== JSON_CLOSE) {
      throw new Error("page body is not a JSON array");
    }
    start++;
    end--;
    while (start < end && isJsonWhitespace(bytes[start])) start++;
    while (end > start && isJsonWhitespace(bytes[end - 1])) end--;
    if (start < end) inners.push(bytes.subarray(start, end));
  }
  const out = new Uint8Array(2 + inners.reduce((n, inner) => n + inner.length, 0) + Math.max(inners.length - 1, 0));
  let pos = 0;
  out[pos++] = JSON_OPEN;
  inners.forEach((inner, i) => {
    if (i > 0) out[pos++] = JSON_COMMA;
    out.set(inner, pos);
    pos += inner.length;
  });
  out[pos] = JSON_CLOSE;
  return out;
}

function supabaseRequestFailed(err) {
  return jsonResponse({ error: `Supabase request failed: ${err && err.message ? err.message : err}` }, 502);
}

async function supabaseReadFailed(resp) {
  return jsonResponse({ error: `Supabase read failed (${resp.status}): ${await safeText(resp)}` }, 502);
}

async function safeText(resp) {
  try {
    return await resp.text();
  } catch {
    return "<no body>";
  }
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return rawJsonResponse(JSON.stringify(body), status, extraHeaders);
}

function rawJsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/json",
      // Only cache successful responses. Cloudflare's edge respects
      // Cache-Control on ANY response, including errors -- caching a 4xx/5xx
      // here means a transient failure (e.g. a missing secret) gets served
      // back to everyone requesting this sport for up to max-age after the
      // underlying cause is already fixed, masking the recovery. Confirmed
      // live (2026-09-13): after fixing a missing SUPABASE_SERVICE_ROLE_KEY
      // and redeploying, some sports kept 500ing for several minutes purely
      // because the earlier error response was still cached at the edge.
      // Cache is refreshed server-side every 3h (see wrangler.jsonc
      // triggers.crons) -- a short client-side cache on successes keeps
      // repeat sport-switches cheap without serving noticeably stale data.
      "Cache-Control": status >= 200 && status < 300 ? "public, max-age=300" : "no-store",
      ...extraHeaders,
    },
  });
}

export { handleSocrataPermitsRequest, STALE_THRESHOLD_MS, PAGE_LIMIT, MAX_PAGES, parseContentRange, joinJsonArrays };
