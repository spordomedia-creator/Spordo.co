/**
 * Locates and fetches HRPT's weekly schedule images.
 *
 * Primary path: fetch the permits page and scrape every "…Field_Schedules….jpg"
 * URL out of the markup (authoritative — whatever HRPT actually published this
 * week, in whatever upload folder / numbering they used).
 *
 * Fallback path: if the page can't be read (bot-block, markup change), construct
 * candidate URLs from the current week's Sunday date — HRPT names the files
 * `<M>-<D>_<YYYY>_Field_Schedules[<N>].jpg` under `/uploads/<YYYY>/<MM>/` — and
 * probe them. We keep whatever returns a real JPEG.
 *
 * Each returned image carries a sha-256 of its bytes so the sync can skip the
 * (paid) vision read when nothing changed since last run.
 */

import {
  HRPT_PERMITS_URL,
  HRPT_FETCH_HEADERS,
  HRPT_IMAGE_UPLOAD_BASE,
  HRPT_IMAGE_MAX_INDEX,
  HRPT_IMAGE_URL_RE,
} from "./config.js";

/** The Sunday (00:00) that begins the schedule week containing `date`. */
function weekSunday(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay()); // getUTCDay(): 0 = Sunday
  return d;
}

/** "YYYY-MM-DD" for a Date, in UTC. */
function isoDate(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** permit_date for day N (0=Sun..6=Sat) of the week starting `sundayIso`. */
function dateForDayIndex(sundayIso, dayIndex) {
  const [y, m, d] = sundayIso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + dayIndex);
  return isoDate(dt);
}

/** Upgrade a WordPress "-1080x810" (etc.) sized URL to the full-resolution original. */
function toFullRes(url) {
  return url.replace(/-\d+x\d+(?=\.\w+$)/i, "");
}

/** The week's Sunday ("YYYY-MM-DD") encoded in an image filename ("…/9-13_2026_Field_Schedules…"), or null. */
function weekIsoFromUrl(url) {
  const m = /(\d{1,2})-(\d{1,2})_(\d{4})_Field_Schedules/i.exec(String(url));
  if (!m) return null;
  return `${m[3]}-${String(+m[1]).padStart(2, "0")}-${String(+m[2]).padStart(2, "0")}`;
}

function scrapeImageUrls(html) {
  const found = new Set();
  for (const m of String(html).matchAll(HRPT_IMAGE_URL_RE)) found.add(toFullRes(m[0]));
  return [...found];
}

/** Candidate URLs for a given week's Sunday, used only when scraping finds none. */
function constructImageUrls(sunday) {
  const yyyy = sunday.getUTCFullYear();
  const mm = String(sunday.getUTCMonth() + 1).padStart(2, "0");
  const mUn = sunday.getUTCMonth() + 1; // filename month is NOT zero-padded ("9-13")
  const day = sunday.getUTCDate();
  const stem = `${HRPT_IMAGE_UPLOAD_BASE}/${yyyy}/${mm}/${mUn}-${day}_${yyyy}_Field_Schedules`;
  const urls = [`${stem}.jpg`];
  for (let n = 2; n <= HRPT_IMAGE_MAX_INDEX; n++) urls.push(`${stem}${n}.jpg`);
  return urls;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Fetch one image; return {url, bytes, hash} or null if it isn't a real JPEG. */
async function fetchImage(url, fetchImpl) {
  let resp;
  try {
    resp = await fetchImpl(url, { headers: HRPT_FETCH_HEADERS });
  } catch {
    return null;
  }
  if (!resp.ok) return null;
  const ct = resp.headers.get("content-type") || "";
  if (!/image\/jpe?g/i.test(ct)) return null;
  const buf = new Uint8Array(await resp.arrayBuffer());
  if (buf.byteLength < 1024) return null; // guard against tiny error/placeholder bodies
  return { url, bytes: buf, hash: await sha256Hex(buf) };
}

/**
 * Discover + fetch this week's schedule images.
 * @returns {Promise<{ images: {url,bytes,hash}[], sundayIso: string, source: 'page'|'constructed'|'none', anomalies: string[] }>}
 */
async function fetchWeekImages(opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const now = opts.now ? opts.now() : new Date();
  const anomalies = [];
  const sunday = weekSunday(now);
  const sundayIso = isoDate(sunday);

  // Primary: scrape the live page for the real image URLs.
  let urls = [];
  let source = "page";
  try {
    const resp = await fetchImpl(HRPT_PERMITS_URL, { headers: HRPT_FETCH_HEADERS });
    if (resp.ok) {
      urls = scrapeImageUrls(await resp.text());
    } else {
      anomalies.push(`permits page returned HTTP ${resp.status}; falling back to constructed URLs`);
    }
  } catch (err) {
    anomalies.push(`permits page fetch failed (${err && err.message ? err.message : err}); falling back to constructed URLs`);
  }

  if (urls.length === 0) {
    source = "constructed";
    urls = constructImageUrls(sunday);
  }

  const settled = await Promise.all(urls.map((u) => fetchImage(u, fetchImpl)));
  const images = settled.filter(Boolean);
  if (images.length === 0) {
    source = "none";
    anomalies.push("no schedule images could be fetched (page scrape and constructed URLs both empty)");
  }

  return { images, sundayIso, source, anomalies };
}

export { fetchWeekImages, weekSunday, isoDate, dateForDayIndex, toFullRes, scrapeImageUrls, constructImageUrls, sha256Hex, weekIsoFromUrl };
