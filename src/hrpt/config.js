/**
 * HRPT sync constants. This is a separate data source from the NYC Open
 * Data / Socrata (`tvpp-9vvx`) sync — HRPT doesn't publish to Open Data, so
 * it gets its own fetch target, parser, and mapping layer.
 */

const HRPT_PERMITS_URL = "https://hudsonriverpark.org/visit/events/permits/fields/";

// Headers confirmed (this session, via a real Cloudflare Worker deployed to
// a live account) to get a 200 with real schedule markup — a bare
// `fetch()` with no UA/Accept headers was NOT separately verified, so keep
// these until proven unnecessary.
const HRPT_FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const HRPT_SOURCE_LABEL = "hrpt";

const FIELD_PERMIT_CACHE_TABLE = "field_permit_cache";
const FIELD_SYNC_META_TABLE = "field_sync_meta";

export {
  HRPT_PERMITS_URL,
  HRPT_FETCH_HEADERS,
  HRPT_SOURCE_LABEL,
  FIELD_PERMIT_CACHE_TABLE,
  FIELD_SYNC_META_TABLE,
};
