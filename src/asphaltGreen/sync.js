/**
 * Asphalt Green (Litwin Field, Upper East Side) public-hours sync -> D1.
 *
 * AG publishes when Litwin Field is OPEN TO THE PUBLIC (a few early-morning
 * windows a week) on a Salesforce Experience Cloud page
 * (https://account.asphaltgreen.org/s/public-hours). That's the inverse of
 * every other source we sync, which publish when a field is BOOKED — the
 * rest of Litwin's day is AG programs/rentals that AG doesn't publish.
 *
 * The page's calendar is fed by a guest-accessible Aura Apex action
 * (PublicCalendarController.getPublicBookings) that returns clean JSON
 * ({startTime, endTime, facilityName, ...}, UTC ISO strings, ~1 month out),
 * so we call that directly instead of scraping. Rows are written to the same
 * field_permit_cache/field_sync_meta tables HRPT uses, with
 * live_availability_status = "public_hours" so the frontend knows to draw
 * them as green "open" blocks rather than booked ones (see
 * loadExternalPermits in public/TrueSpordo.html).
 */
import { replaceFieldPermitWindow, upsertSyncMeta } from "../hrpt/d1Client.js";
import { FIELD_PERMIT_CACHE_TABLE, FIELD_SYNC_META_TABLE } from "../hrpt/config.js";

const AG_PUBLIC_HOURS_URL = "https://account.asphaltgreen.org/s/public-hours";
const AG_AURA_URL = "https://account.asphaltgreen.org/s/sfsites/aura?r=1&aura.ApexAction.execute=1";

// Aura requires the framework build id (fwuid) + app version in its context.
// They change when Salesforce ships a release (a few times a year), so each
// run reads the current values off the public page; these are only the
// fallback if that scrape fails. (Confirmed 2026-09-30 that AG's endpoint
// still answers with a stale fwuid, but that's not guaranteed.)
const FALLBACK_FWUID = "WUdfaXlIZDNDQ0lZLWNFZDMtVGZ3d2tVMjdnTGFERUU2S3FfSVdrcU92bkExNC4xOTIuODM4ODYwOA";
const FALLBACK_APP_VERSION = "1712_xZHiuQoc1HHcvGz4vs6mGA";

// The facility name must match AG's exactly — "Litwin Field" alone returns
// nothing (confirmed 2026-09-30).
const LITWIN_FACILITY_NAME = "Litwin Field - Full Field";

// Must equal the frontend's encodeId('Asphalt Green Litwin Field|MANHATTAN')
// for the EXTERNAL_ORGS entry, or /api/permits/:fieldId won't find the rows.
const LITWIN_FIELD_ID = encodeFieldId("Asphalt Green Litwin Field|MANHATTAN");

const PUBLIC_HOURS_STATUS = "public_hours";
const PUBLIC_HOURS_EVENT_NAME = "Open to public";
const TIME_ZONE = "America/New_York";

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

/** Same scheme as the frontend's encodeId(): base64 with +/= swapped for _. */
function encodeFieldId(s) {
  return btoa(unescape(encodeURIComponent(s))).replace(/[+/=]/g, "_");
}

/** Pull fwuid + app version out of the public page's bootstrap markup (URL-encoded in places). */
function parseAuraContext(html) {
  let text = html || "";
  try {
    text = decodeURIComponent(text);
  } catch {
    // Malformed %-sequence somewhere in the page — search the raw markup instead.
  }
  const fwuid = text.match(/"fwuid":"([^"]+)"/)?.[1] || null;
  const appVersion = text.match(/"APPLICATION@markup:\/\/siteforce:communityApp":"([^"]+)"/)?.[1] || null;
  return { fwuid, appVersion };
}

function buildAuraBody({ fwuid, appVersion, facilityName }) {
  const message = {
    actions: [
      {
        id: "1;a",
        descriptor: "aura://ApexActionController/ACTION$execute",
        callingDescriptor: "UNKNOWN",
        params: {
          namespace: "",
          classname: "PublicCalendarController",
          method: "getPublicBookings",
          params: { functionName: "Public Hours", facilityNames: facilityName },
          cacheable: true,
          isContinuation: false,
        },
      },
    ],
  };
  const context = {
    mode: "PROD",
    fwuid,
    app: "siteforce:communityApp",
    loaded: { "APPLICATION@markup://siteforce:communityApp": appVersion },
    dn: [],
    globals: {},
    uad: true,
  };
  return new URLSearchParams({
    message: JSON.stringify(message),
    "aura.context": JSON.stringify(context),
    "aura.pageURI": "/s/public-hours",
    "aura.token": "null",
  });
}

/** Returns the bookings array, or throws with a reason if Aura didn't answer SUCCESS. */
function parseAuraResponse(text) {
  // Aura sometimes prefixes JSON with a "*/" anti-hijacking guard.
  const body = JSON.parse(String(text).replace(/^\s*\*\/\s*/, ""));
  const action = body?.actions?.[0];
  if (!action || action.state !== "SUCCESS") {
    const err = action?.error?.[0]?.message || body?.event?.descriptor || "no SUCCESS action";
    throw new Error(`Aura call failed: ${err}`);
  }
  const rows = action.returnValue?.returnValue;
  if (!Array.isArray(rows)) throw new Error("Aura returnValue is not an array");
  return rows;
}

/** UTC ISO string -> { date: "YYYY-MM-DD", time: "HH:MM" } in New York local time. */
function toNewYorkParts(iso) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** AG bookings -> field_permit_cache rows (one per public-hours window). */
function toPermitRows(bookings, fieldId) {
  return bookings
    .filter((b) => b && b.startTime && b.endTime && b.functionName === "Public Hours")
    .map((b) => {
      const start = toNewYorkParts(b.startTime);
      const end = toNewYorkParts(b.endTime);
      return {
        field_id: fieldId,
        permit_date: start.date,
        start_time: start.time,
        end_time: end.time,
        event_name: PUBLIC_HOURS_EVENT_NAME,
      };
    })
    .sort((a, b) => (a.permit_date + a.start_time).localeCompare(b.permit_date + b.start_time));
}

async function fetchLitwinPublicHours(fetchImpl = fetch) {
  let ctx = { fwuid: null, appVersion: null };
  try {
    const page = await fetchImpl(AG_PUBLIC_HOURS_URL, { headers: FETCH_HEADERS });
    if (page.ok) ctx = parseAuraContext(await page.text());
  } catch (e) {
    console.warn("[ag] public-hours page fetch failed; using fallback Aura context:", e.message);
  }

  const res = await fetchImpl(AG_AURA_URL, {
    method: "POST",
    headers: { ...FETCH_HEADERS, "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: buildAuraBody({
      fwuid: ctx.fwuid || FALLBACK_FWUID,
      appVersion: ctx.appVersion || FALLBACK_APP_VERSION,
      facilityName: LITWIN_FACILITY_NAME,
    }),
  });
  if (!res.ok) throw new Error(`Aura HTTP ${res.status}`);
  return parseAuraResponse(await res.text());
}

/**
 * One sync run. Never throws — returns a summary with ok:false + reason so
 * src/index.js can alert on it, same contract as the HRPT/Socrata syncs.
 *
 * Zero windows is treated as a failure, not "no public hours": AG has
 * always published some, so an empty answer most likely means the facility
 * was renamed or the endpoint changed. Keeping the old rows and alerting
 * beats silently wiping the calendar (the HRPT lesson — see alerting.js).
 */
async function runAsphaltGreenSync(env, { fetchImpl = fetch, now = new Date() } = {}) {
  try {
    const bookings = await fetchLitwinPublicHours(fetchImpl);
    const rows = toPermitRows(bookings, LITWIN_FIELD_ID);
    if (!rows.length) {
      return { ok: false, reason: "no_public_hours_returned", fieldId: LITWIN_FIELD_ID };
    }

    const today = toNewYorkParts(now.toISOString()).date;
    const maxDate = rows[rows.length - 1].permit_date;
    const futureRows = rows.filter((r) => r.permit_date >= today);
    await replaceFieldPermitWindow(env, {
      table: FIELD_PERMIT_CACHE_TABLE,
      fieldId: LITWIN_FIELD_ID,
      minDate: today,
      maxDate: maxDate < today ? today : maxDate,
      rows: futureRows,
    });
    await upsertSyncMeta(env, {
      table: FIELD_SYNC_META_TABLE,
      row: {
        field_id: LITWIN_FIELD_ID,
        last_permit_sync_at: now.toISOString(),
        live_availability_status: PUBLIC_HOURS_STATUS,
        permit_source_url: AG_PUBLIC_HOURS_URL,
      },
    });
    return { ok: true, fieldId: LITWIN_FIELD_ID, windows: futureRows.length, through: maxDate };
  } catch (e) {
    return { ok: false, reason: e.message, fieldId: LITWIN_FIELD_ID };
  }
}

export {
  runAsphaltGreenSync,
  parseAuraContext,
  parseAuraResponse,
  toPermitRows,
  toNewYorkParts,
  encodeFieldId,
  LITWIN_FIELD_ID,
  PUBLIC_HOURS_STATUS,
};
