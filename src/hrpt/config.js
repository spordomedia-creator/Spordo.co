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

// ── Image-based schedule reading ──────────────────────────────────────────
// HRPT replaced its HTML permit tables (mid-2026) with weekly JPG graphics —
// one per field, uploaded to WordPress with the week's Sunday date baked into
// the filename, e.g. .../2026/09/9-13_2026_Field_Schedules.jpg (then …2…9).
// The tables are gone, so the old HTML-table parser reads nothing; we now read
// each image with a vision model instead (see visionParser.js / imageSource.js).
const HRPT_IMAGE_UPLOAD_BASE = "https://hudsonriverpark.org/app/uploads";
// Constructed-URL fallback probes base (no suffix) + 2..N when page scraping
// yields nothing. HRPT publishes 9 field images; probe a little past that.
const HRPT_IMAGE_MAX_INDEX = 12;
// Matches any Field_Schedules image URL on the page (optional -WxH size suffix).
const HRPT_IMAGE_URL_RE = /https?:\/\/[^\s"'()]+?Field_Schedules\d*(?:-\d+x\d+)?\.jpe?g/gi;

// Anthropic vision — reads a schedule graphic into structured permit blocks.
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"; // cheapest vision-capable model
const ANTHROPIC_MAX_TOKENS = 1024;

// Synthetic field_sync_meta key holding the last-seen image-set hash, so a run
// only calls the vision API when an image actually changed (cost control).
const HRPT_MANIFEST_META_ID = "__hrpt_image_manifest__";

export {
  HRPT_PERMITS_URL,
  HRPT_FETCH_HEADERS,
  HRPT_SOURCE_LABEL,
  FIELD_PERMIT_CACHE_TABLE,
  FIELD_SYNC_META_TABLE,
  HRPT_IMAGE_UPLOAD_BASE,
  HRPT_IMAGE_MAX_INDEX,
  HRPT_IMAGE_URL_RE,
  ANTHROPIC_API_URL,
  ANTHROPIC_VERSION,
  ANTHROPIC_MODEL,
  ANTHROPIC_MAX_TOKENS,
  HRPT_MANIFEST_META_ID,
};
