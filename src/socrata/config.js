/**
 * NYC Open Data / Socrata (`tvpp-9vvx`) sync constants.
 *
 * This is a separate pipeline from src/hrpt/ — HRPT scrapes
 * hudsonriverpark.org into Cloudflare D1, this pulls the NYC Parks permit
 * dataset from Socrata into Supabase. See CLAUDE.md's "Storage is split"
 * section before assuming anything here should touch D1.
 *
 * Columns referenced below (event_location, event_borough, start_date_time,
 * end_date_time, event_name, event_type, permit_holder_name, organization)
 * are the exact fields the prototype's own permit-rendering code already
 * reads off raw Socrata rows (see permitDate/permitName/permitTypeBadge/
 * groupByField in public/TrueSpordo.html) — verified against the live
 * frontend, not guessed from the dataset docs (this sandbox has no network
 * access to data.cityofnewyork.us to double-check against a live schema
 * dump; see final report for the one-time spot-check the user should run).
 */

const SOCRATA_DATASET_ID = "tvpp-9vvx";
const SOCRATA_BASE_URL = `https://data.cityofnewyork.us/resource/${SOCRATA_DATASET_ID}.json`;
const SOCRATA_SOURCE_LABEL = "socrata";
const SOCRATA_SOURCE_URL = "https://data.cityofnewyork.us/City-Government/DPR-Permitted-Events/tvpp-9vvx";

// Same 90-day forward window public/TrueSpordo.html's loadFields() already
// queries (today() / daysFrom(90)) -- keep in sync if that ever changes.
const SYNC_WINDOW_DAYS = 90;

// Socrata's default/anonymous page size is small; page explicitly so a
// popular sport's citywide 90-day window is never silently truncated at
// whatever the platform default happens to be.
const PAGE_SIZE = 1000;

// Safety valve: if a single sport's window somehow needs more than this
// many pages (20,000 rows) in one run, stop, keep whatever was fetched so
// far, and log an explicit "possible truncation" anomaly rather than
// looping indefinitely against a misbehaving/unexpectedly huge response.
const MAX_PAGES_PER_SPORT = 20;

// Retry/backoff for 429 (rate limited) / 5xx responses.
const MAX_FETCH_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;

const FIELD_PERMIT_CACHE_TABLE = "field_permit_cache";
const FIELD_SYNC_META_TABLE = "field_sync_meta";

/**
 * Tracked sports — mirrors the `SPORTS` array in public/TrueSpordo.html
 * (id + query keyword) exactly, so the sync fetches precisely what
 * loadFields() used to fetch live, per sport. Keep these two lists in sync;
 * if SPORTS gains/loses an entry there, mirror it here.
 *
 * `altEventNameLike`: baseball permits also cover softball play on the same
 * fields — the frontend's loadFields() ORs in `event_name like '%SOFTBALL%'`
 * for baseball specifically; mirrored here the same way.
 */
const TRACKED_SPORTS = [
  { id: "soccer", eventNameLike: "SOCCER" },
  { id: "baseball", eventNameLike: "BASEBALL", altEventNameLike: "SOFTBALL" },
  { id: "basketball", eventNameLike: "BASKETBALL" },
  { id: "tennis", eventNameLike: "TENNIS" },
  { id: "cricket", eventNameLike: "CRICKET" },
  { id: "football", eventNameLike: "FOOTBALL" },
  { id: "lacrosse", eventNameLike: "LACROSSE" },
  { id: "rugby", eventNameLike: "RUGBY" },
];

const TRACKED_SPORT_IDS = new Set(TRACKED_SPORTS.map((s) => s.id));

export {
  SOCRATA_DATASET_ID,
  SOCRATA_BASE_URL,
  SOCRATA_SOURCE_LABEL,
  SOCRATA_SOURCE_URL,
  SYNC_WINDOW_DAYS,
  PAGE_SIZE,
  MAX_PAGES_PER_SPORT,
  MAX_FETCH_RETRIES,
  RETRY_BASE_DELAY_MS,
  FIELD_PERMIT_CACHE_TABLE,
  FIELD_SYNC_META_TABLE,
  TRACKED_SPORTS,
  TRACKED_SPORT_IDS,
};
