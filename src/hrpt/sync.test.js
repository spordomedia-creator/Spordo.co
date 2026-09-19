/**
 * Integration tests for the HRPT image-based sync (imageSource -> vision ->
 * fieldMap -> D1). Every external boundary is injected:
 *   - `fetchImpl` serves the permits page HTML + the schedule JPEG bytes.
 *   - `readImage` stands in for the (paid) Anthropic vision read, returning
 *     the structured schedule we want for each image URL.
 *   - `env.DB` is the in-memory fake D1.
 * No network, no API tokens spent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runHrptSync } from "./sync.js";
import { EXACT_NAME_TO_FIELD_ID, NO_PERMIT_SCHEDULE_FIELDS } from "./fieldMap.js";
import { createFakeD1 } from "./__testUtils__/fakeD1.js";
import { HRPT_MANIFEST_META_ID } from "./config.js";

const REFERENCE_DATE = new Date("2026-09-18T12:00:00Z"); // a Friday; week Sunday = 2026-09-13
const UPLOADS = "https://hudsonriverpark.org/app/uploads";
const PIER25_URL = `${UPLOADS}/2026/09/9-13_2026_Field_Schedules.jpg`;
const GANSEVOORT_URL = `${UPLOADS}/2026/09/9-13_2026_Field_Schedules2.jpg`;

function silentLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

/** A JPEG-ish body of `n` bytes (only size + content-type are checked by fetchImage). */
function jpegBytes(seed = 0xab, n = 2048) {
  return new Uint8Array(n).fill(seed);
}

/**
 * fetchImpl serving the permits page (linking two schedule images) and the
 * image bytes themselves. `imageSeed` lets a test change the bytes so the
 * manifest hash changes between runs.
 */
function makeFetch({ imageUrls = [PIER25_URL, GANSEVOORT_URL], imageSeed = {} } = {}) {
  const calls = [];
  const html = imageUrls.map((u) => `<img src="${u}">`).join("");
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.includes("/permits/fields")) {
      return { ok: true, status: 200, headers: { get: () => "text/html" }, text: async () => html };
    }
    if (imageUrls.includes(url)) {
      const bytes = jpegBytes(imageSeed[url] ?? 0xab);
      return {
        ok: true,
        status: 200,
        headers: { get: (h) => (h.toLowerCase() === "content-type" ? "image/jpeg" : null) },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    }
    return { ok: false, status: 404, headers: { get: () => null } };
  };
  return { fetchImpl, calls };
}

const EMPTY_DAYS = { sunday: [], monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [] };

/** A readImage fake mapping each image URL to the structured schedule it "reads". */
function makeReadImage(byUrl) {
  const seen = [];
  const readImage = async (image) => {
    seen.push(image.url);
    if (!(image.url in byUrl)) throw new Error(`no fake schedule for ${image.url}`);
    return byUrl[image.url];
  };
  return { readImage, seen };
}

/** Default: Pier 25 (alias) with two Sunday ranges; Gansevoort (alias) fully open. */
function defaultReadImage() {
  return makeReadImage({
    [PIER25_URL]: {
      field: "Pier 25 Turf Field",
      weekLabel: "SEP 13-19",
      days: { ...EMPTY_DAYS, sunday: ["8:00 AM-1:00 PM", "3:00 PM-6:00 PM"] },
    },
    [GANSEVOORT_URL]: {
      field: "Gansevoort Peninsula Athletic Field",
      weekLabel: "SEP 13-19",
      days: { ...EMPTY_DAYS },
    },
  });
}

test("happy path: reads each image, maps its field, writes cache + sync_meta", async () => {
  const { fetchImpl } = makeFetch();
  const { readImage } = defaultReadImage();
  const { db, tables, calls: d1Calls } = createFakeD1();

  const summary = await runHrptSync({ DB: db }, { fetchImpl, readImage, apiKey: "sk-test", now: () => REFERENCE_DATE, log: silentLog() });

  assert.equal(summary.ok, true);
  assert.equal(summary.imagesFound, 2);
  assert.equal(summary.imagesRead, 2);
  assert.equal(summary.fieldsWritten, 2);
  assert.equal(summary.rowsInserted, 2); // Pier 25's two ranges; Gansevoort none

  const pier25Id = EXACT_NAME_TO_FIELD_ID["Pier 25 Artificial Turf Field"];
  const pier25Deletes = d1Calls.filter((c) => c.table === "field_permit_cache" && /^DELETE/i.test(c.sql) && c.args[0] === pier25Id);
  assert.equal(pier25Deletes.length, 1, "expected exactly one scoped delete for Pier 25's window");
  assert.equal(pier25Deletes[0].args[1], "2026-09-13"); // week Sunday from the filename
  assert.equal(pier25Deletes[0].args[2], "2026-09-19"); // week Saturday

  const pier25Rows = tables.field_permit_cache.filter((r) => r.field_id === pier25Id);
  assert.equal(pier25Rows.length, 2);
  assert.ok(pier25Rows.every((r) => r.permit_date === "2026-09-13" && r.event_name === "Permitted"));
  assert.deepEqual(pier25Rows.map((r) => `${r.start_time}-${r.end_time}`).sort(), ["08:00:00-13:00:00", "15:00:00-18:00:00"]);

  const pier25Meta = tables.field_sync_meta.find((r) => r.field_id === pier25Id);
  assert.equal(pier25Meta.live_availability_status, "synced");
  assert.equal(pier25Meta.permit_source_url, "https://hudsonriverpark.org/visit/events/permits/fields/");

  // Gansevoort resolved but had no green blocks -> a delete, no inserted rows (legitimate "fully available").
  const gansevoortId = EXACT_NAME_TO_FIELD_ID["Gansevoort Peninsula Playing Field"];
  assert.equal(tables.field_permit_cache.filter((r) => r.field_id === gansevoortId).length, 0);
  assert.ok(tables.field_sync_meta.some((r) => r.field_id === gansevoortId));

  // The image-set manifest hash was persisted after a successful write.
  assert.ok(tables.field_sync_meta.some((r) => r.field_id === HRPT_MANIFEST_META_ID));
});

test("writes a no_permit_schedule sync_meta row every run for fields with no HRPT schedule at all", async () => {
  const { fetchImpl } = makeFetch();
  const { readImage } = defaultReadImage();
  const { db, tables } = createFakeD1();

  const summary = await runHrptSync({ DB: db }, { fetchImpl, readImage, apiKey: "sk-test", now: () => REFERENCE_DATE, log: silentLog() });

  assert.deepEqual(summary.fieldsNoPermitSchedule, NO_PERMIT_SCHEDULE_FIELDS.map((f) => f.name));
  for (const { fieldId } of NO_PERMIT_SCHEDULE_FIELDS) {
    const meta = tables.field_sync_meta.find((r) => r.field_id === fieldId);
    assert.ok(meta, `expected a field_sync_meta row for ${fieldId}`);
    assert.equal(meta.live_availability_status, "no_permit_schedule");
  }
});

test("unchanged images since last run: skips the (paid) vision reads entirely", async () => {
  const { fetchImpl } = makeFetch();
  const { db, tables } = createFakeD1();

  // First run writes data + stores the manifest hash.
  const first = defaultReadImage();
  const s1 = await runHrptSync({ DB: db }, { fetchImpl, readImage: first.readImage, apiKey: "sk-test", now: () => REFERENCE_DATE, log: silentLog() });
  assert.equal(s1.fieldsWritten, 2);
  assert.equal(first.seen.length, 2);

  const rowsAfterFirst = tables.field_permit_cache.length;

  // Second run, identical image bytes -> manifest matches -> vision skipped.
  const second = defaultReadImage();
  const s2 = await runHrptSync({ DB: db }, { fetchImpl, readImage: second.readImage, apiKey: "sk-test", now: () => REFERENCE_DATE, log: silentLog() });

  assert.equal(s2.ok, true);
  assert.equal(s2.skippedUnchanged, true);
  assert.equal(s2.imagesRead, 0);
  assert.equal(second.seen.length, 0, "readImage must not be called when nothing changed");
  assert.equal(tables.field_permit_cache.length, rowsAfterFirst, "cache untouched on an unchanged run");
});

test("changed image bytes: manifest differs -> vision runs and cache is rewritten", async () => {
  const { db, tables } = createFakeD1();

  const first = defaultReadImage();
  await runHrptSync({ DB: db }, { fetchImpl: makeFetch().fetchImpl, readImage: first.readImage, apiKey: "sk-test", now: () => REFERENCE_DATE, log: silentLog() });

  // New week's graphic: different bytes for Pier 25.
  const changedFetch = makeFetch({ imageSeed: { [PIER25_URL]: 0x11 } }).fetchImpl;
  const second = defaultReadImage();
  const s2 = await runHrptSync({ DB: db }, { fetchImpl: changedFetch, readImage: second.readImage, apiKey: "sk-test", now: () => REFERENCE_DATE, log: silentLog() });

  assert.equal(s2.skippedUnchanged, false);
  assert.equal(s2.imagesRead, 2);
  assert.equal(second.seen.length, 2);
  assert.equal(s2.fieldsWritten, 2);
});

test("no ANTHROPIC_API_KEY: aborts before any paid read or cache write", async () => {
  const { fetchImpl } = makeFetch();
  const { readImage, seen } = defaultReadImage();
  const { db, tables } = createFakeD1();

  const summary = await runHrptSync({ DB: db }, { fetchImpl, readImage, apiKey: "", now: () => REFERENCE_DATE, log: silentLog() });

  assert.equal(summary.ok, false);
  assert.match(summary.reason, /ANTHROPIC_API_KEY not configured/);
  assert.equal(seen.length, 0);
  assert.equal(tables.field_permit_cache.length, 0);
});

test("no images fetchable: aborts, cache left untouched", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("/permits/fields")) return { ok: false, status: 503, headers: { get: () => null } };
    return { ok: false, status: 404, headers: { get: () => null } };
  };
  const { readImage, seen } = defaultReadImage();
  const { db, calls: d1Calls } = createFakeD1();

  const summary = await runHrptSync({ DB: db }, { fetchImpl, readImage, apiKey: "sk-test", now: () => REFERENCE_DATE, log: silentLog() });

  assert.equal(summary.ok, false);
  assert.match(summary.reason, /no schedule images/);
  assert.equal(seen.length, 0);
  assert.equal(d1Calls.length, 0);
});

test("an unmapped field name is skipped and logged without blocking other fields", async () => {
  const { fetchImpl } = makeFetch();
  const { readImage } = makeReadImage({
    [PIER25_URL]: { field: "Pier 25 Turf Field", weekLabel: "SEP 13-19", days: { ...EMPTY_DAYS, sunday: ["8:00 AM-1:00 PM"] } },
    [GANSEVOORT_URL]: { field: "Some Brand New Field Nobody Has Heard Of", weekLabel: "SEP 13-19", days: { ...EMPTY_DAYS } },
  });
  const { db, tables } = createFakeD1();

  const summary = await runHrptSync({ DB: db }, { fetchImpl, readImage, apiKey: "sk-test", now: () => REFERENCE_DATE, log: silentLog() });

  assert.equal(summary.ok, true); // Pier 25 still wrote
  assert.equal(summary.fieldsWritten, 1);
  assert.deepEqual(summary.fieldsUnmapped, ["Some Brand New Field Nobody Has Heard Of"]);
  assert.ok(summary.anomalies.some((a) => a.includes("unmapped HRPT field name")));

  const pier25Id = EXACT_NAME_TO_FIELD_ID["Pier 25 Artificial Turf Field"];
  assert.ok(tables.field_sync_meta.some((r) => r.field_id === pier25Id));
});

test("a vision read failure for one image does not stop other images", async () => {
  const { fetchImpl } = makeFetch();
  const readImage = async (image) => {
    if (image.url === GANSEVOORT_URL) throw new Error("simulated vision timeout");
    return { field: "Pier 25 Turf Field", weekLabel: "SEP 13-19", days: { ...EMPTY_DAYS, sunday: ["8:00 AM-1:00 PM"] } };
  };
  const { db } = createFakeD1();

  const summary = await runHrptSync({ DB: db }, { fetchImpl, readImage, apiKey: "sk-test", now: () => REFERENCE_DATE, log: silentLog() });

  assert.equal(summary.fieldsWritten, 1);
  assert.equal(summary.imagesRead, 1);
  assert.ok(summary.anomalies.some((a) => /vision read failed/.test(a)));
});

test("a D1 write failure does not persist the manifest hash (so the next run retries)", async () => {
  const { fetchImpl } = makeFetch();
  const { readImage } = defaultReadImage();
  const { db, tables } = createFakeD1({ failTables: ["field_permit_cache"] });

  const summary = await runHrptSync({ DB: db }, { fetchImpl, readImage, apiKey: "sk-test", now: () => REFERENCE_DATE, log: silentLog() });

  assert.equal(summary.ok, false);
  assert.equal(summary.fieldsWritten, 0);
  assert.ok(summary.anomalies.some((a) => a.includes("write failed")));
  assert.ok(!tables.field_sync_meta.some((r) => r.field_id === HRPT_MANIFEST_META_ID), "manifest must not be stored after a failed run");
});
