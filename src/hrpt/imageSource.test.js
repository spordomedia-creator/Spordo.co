/**
 * Unit tests for the HRPT image discovery/fetch layer. All network is
 * injected via a fake `fetchImpl` — these never touch hudsonriverpark.org.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  fetchWeekImages,
  weekSunday,
  isoDate,
  dateForDayIndex,
  toFullRes,
  scrapeImageUrls,
  constructImageUrls,
  sha256Hex,
  weekIsoFromUrl,
} from "./imageSource.js";

const UPLOADS = "https://hudsonriverpark.org/app/uploads";

/** Build a minimal fake Response. `body` is a string (text) or Uint8Array (bytes). */
function fakeResponse({ ok = true, status = 200, contentType = "", body = "" } = {}) {
  const isBytes = body instanceof Uint8Array;
  return {
    ok,
    status,
    headers: { get: (h) => (h.toLowerCase() === "content-type" ? contentType : null) },
    async text() {
      return isBytes ? new TextDecoder().decode(body) : String(body);
    },
    async arrayBuffer() {
      const bytes = isBytes ? body : new TextEncoder().encode(String(body));
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

/** A JPEG-ish body of `n` bytes (content check only cares about size + content-type). */
function jpegBytes(n = 2048, fill = 0xab) {
  return new Uint8Array(n).fill(fill);
}

test("weekSunday returns the Sunday of the week (UTC)", () => {
  // 2026-09-18 is a Friday; its week's Sunday is 2026-09-13.
  assert.equal(isoDate(weekSunday(new Date("2026-09-18T12:00:00Z"))), "2026-09-13");
  // A Sunday maps to itself.
  assert.equal(isoDate(weekSunday(new Date("2026-09-13T00:00:00Z"))), "2026-09-13");
  // A Saturday maps back to the prior Sunday.
  assert.equal(isoDate(weekSunday(new Date("2026-09-19T23:59:59Z"))), "2026-09-13");
});

test("dateForDayIndex walks Sunday..Saturday", () => {
  assert.equal(dateForDayIndex("2026-09-13", 0), "2026-09-13");
  assert.equal(dateForDayIndex("2026-09-13", 6), "2026-09-19");
  // Crosses a month boundary correctly.
  assert.equal(dateForDayIndex("2026-09-27", 6), "2026-10-03");
});

test("toFullRes strips a WordPress -WxH size suffix", () => {
  assert.equal(
    toFullRes(`${UPLOADS}/2026/09/9-13_2026_Field_Schedules-1080x810.jpg`),
    `${UPLOADS}/2026/09/9-13_2026_Field_Schedules.jpg`
  );
  // No suffix -> unchanged.
  assert.equal(
    toFullRes(`${UPLOADS}/2026/09/9-13_2026_Field_Schedules2.jpg`),
    `${UPLOADS}/2026/09/9-13_2026_Field_Schedules2.jpg`
  );
});

test("weekIsoFromUrl parses the week Sunday out of a filename", () => {
  assert.equal(weekIsoFromUrl(`${UPLOADS}/2026/09/9-13_2026_Field_Schedules.jpg`), "2026-09-13");
  assert.equal(weekIsoFromUrl(`${UPLOADS}/2026/10/10-4_2026_Field_Schedules5.jpg`), "2026-10-04");
  assert.equal(weekIsoFromUrl("https://example.com/not-a-schedule.jpg"), null);
});

test("scrapeImageUrls finds and de-dupes full-res Field_Schedules URLs", () => {
  const html = `
    <img src="${UPLOADS}/2026/09/9-13_2026_Field_Schedules.jpg" />
    <img src="${UPLOADS}/2026/09/9-13_2026_Field_Schedules2-1080x810.jpg" />
    <img src="${UPLOADS}/2026/09/9-13_2026_Field_Schedules.jpg" />
    <img src="${UPLOADS}/2026/09/unrelated-photo.jpg" />
  `;
  const urls = scrapeImageUrls(html).sort();
  assert.deepEqual(urls, [
    `${UPLOADS}/2026/09/9-13_2026_Field_Schedules.jpg`,
    `${UPLOADS}/2026/09/9-13_2026_Field_Schedules2.jpg`,
  ]);
});

test("constructImageUrls builds base + 2..N candidates with a non-padded filename month", () => {
  const urls = constructImageUrls(new Date("2026-09-13T00:00:00Z"));
  assert.equal(urls[0], `${UPLOADS}/2026/09/9-13_2026_Field_Schedules.jpg`);
  assert.equal(urls[1], `${UPLOADS}/2026/09/9-13_2026_Field_Schedules2.jpg`);
  assert.equal(urls.at(-1), `${UPLOADS}/2026/09/9-13_2026_Field_Schedules12.jpg`);
  assert.equal(urls.length, 12);
});

test("sha256Hex is stable and content-sensitive", async () => {
  const a = await sha256Hex(new Uint8Array([1, 2, 3]));
  const b = await sha256Hex(new Uint8Array([1, 2, 3]));
  const c = await sha256Hex(new Uint8Array([1, 2, 4]));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("fetchWeekImages (page path): scrapes URLs and fetches only real JPEGs", async () => {
  const good = `${UPLOADS}/2026/09/9-13_2026_Field_Schedules.jpg`;
  const good2 = `${UPLOADS}/2026/09/9-13_2026_Field_Schedules2.jpg`;
  const tiny = `${UPLOADS}/2026/09/9-13_2026_Field_Schedules3.jpg`; // real JPEG type but <1024 bytes
  const html = `<img src="${good}"><img src="${good2}"><img src="${tiny}">`;

  const fetchImpl = async (url) => {
    if (url.includes("/permits/fields")) return fakeResponse({ contentType: "text/html", body: html });
    if (url === tiny) return fakeResponse({ contentType: "image/jpeg", body: jpegBytes(100) });
    return fakeResponse({ contentType: "image/jpeg", body: jpegBytes(2048) });
  };

  const { images, source, sundayIso, anomalies } = await fetchWeekImages({
    fetchImpl,
    now: () => new Date("2026-09-18T12:00:00Z"),
  });

  assert.equal(source, "page");
  assert.equal(sundayIso, "2026-09-13");
  const urls = images.map((i) => i.url).sort();
  assert.deepEqual(urls, [good, good2]); // tiny one dropped
  assert.ok(images.every((i) => /^[0-9a-f]{64}$/.test(i.hash)));
  assert.deepEqual(anomalies, []);
});

test("fetchWeekImages (fallback path): page fails -> constructed URLs are probed", async () => {
  const constructed = `${UPLOADS}/2026/09/9-13_2026_Field_Schedules.jpg`;
  const fetchImpl = async (url) => {
    if (url.includes("/permits/fields")) return fakeResponse({ ok: false, status: 503 });
    if (url === constructed) return fakeResponse({ contentType: "image/jpeg", body: jpegBytes(2048) });
    return fakeResponse({ ok: false, status: 404 }); // every other constructed candidate 404s
  };

  const { images, source, anomalies } = await fetchWeekImages({
    fetchImpl,
    now: () => new Date("2026-09-18T12:00:00Z"),
  });

  assert.equal(source, "constructed");
  assert.equal(images.length, 1);
  assert.equal(images[0].url, constructed);
  assert.ok(anomalies.some((a) => /HTTP 503/.test(a)));
});

test("fetchWeekImages: nothing fetchable -> source 'none', empty images, anomaly", async () => {
  const fetchImpl = async () => fakeResponse({ ok: false, status: 404 });
  const { images, source, anomalies } = await fetchWeekImages({
    fetchImpl,
    now: () => new Date("2026-09-18T12:00:00Z"),
  });
  assert.equal(source, "none");
  assert.equal(images.length, 0);
  assert.ok(anomalies.length >= 1);
});
