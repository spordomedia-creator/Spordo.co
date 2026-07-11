import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runHrptSync } from "./sync.js";
import { EXACT_NAME_TO_FIELD_ID, NO_PERMIT_SCHEDULE_FIELDS } from "./fieldMap.js";
import { createFakeD1 } from "./__testUtils__/fakeD1.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rowspanHtml = readFileSync(path.join(__dirname, "__fixtures__/rowspan-pattern.html"), "utf8");

const REFERENCE_DATE = new Date("2026-06-25T12:00:00Z");

function silentLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

/** A fetchImpl that serves only the HRPT page HTML (D1 writes go through env.DB, not fetch, now). */
function makePageFetch({ pageHtml = rowspanHtml, pageStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: pageStatus >= 200 && pageStatus < 300,
      status: pageStatus,
      text: async () => pageHtml,
    };
  };
  return { fetchImpl, calls };
}

test("happy path: fetches, parses, and writes cache + sync_meta for mapped fields only", async () => {
  const { fetchImpl } = makePageFetch();
  const { db, tables, calls: d1Calls } = createFakeD1();
  const env = { DB: db };

  const summary = await runHrptSync(env, { fetchImpl, now: () => REFERENCE_DATE, log: silentLog() });

  assert.equal(summary.ok, true);
  // Pier 25 (exact match) and Gansevoort (alias match) both resolve; the
  // "mystery" block has no discoverable name and is never attempted.
  assert.equal(summary.fieldsWritten, 2);
  assert.equal(summary.rowsInserted, 2); // Pier 25's two booked ranges; Gansevoort has none.

  const pier25Id = EXACT_NAME_TO_FIELD_ID["Pier 25 Artificial Turf Field"];
  const pier25Deletes = d1Calls.filter((c) => c.table === "field_permit_cache" && /^DELETE/i.test(c.sql) && c.args[0] === pier25Id);
  assert.equal(pier25Deletes.length, 1, "expected exactly one scoped delete for Pier 25's window");
  assert.equal(pier25Deletes[0].args[1], "2026-06-28");
  assert.equal(pier25Deletes[0].args[2], "2026-06-29");

  const pier25CacheRows = tables.field_permit_cache.filter((r) => r.field_id === pier25Id);
  assert.equal(pier25CacheRows.length, 2);

  assert.equal(tables.field_sync_meta.length, 2 + NO_PERMIT_SCHEDULE_FIELDS.length);
  const pier25Meta = tables.field_sync_meta.find((r) => r.field_id === pier25Id);
  assert.equal(pier25Meta.live_availability_status, "synced");
  assert.equal(pier25Meta.permit_source_url, "https://hudsonriverpark.org/visit/events/permits/fields/");
});

test("writes a no_permit_schedule sync_meta row every run for fields confirmed to have no HRPT table at all", async () => {
  const { fetchImpl } = makePageFetch();
  const { db, tables } = createFakeD1();

  const summary = await runHrptSync({ DB: db }, { fetchImpl, now: () => REFERENCE_DATE, log: silentLog() });

  assert.deepEqual(
    summary.fieldsNoPermitSchedule,
    NO_PERMIT_SCHEDULE_FIELDS.map((f) => f.name)
  );
  for (const { fieldId } of NO_PERMIT_SCHEDULE_FIELDS) {
    const meta = tables.field_sync_meta.find((r) => r.field_id === fieldId);
    assert.ok(meta, `expected a field_sync_meta row for ${fieldId}`);
    assert.equal(meta.live_availability_status, "no_permit_schedule");
  }
});

test("a suspiciously short response body aborts before any D1 write", async () => {
  const { fetchImpl } = makePageFetch({ pageHtml: "<html></html>" });
  const { db, calls: d1Calls } = createFakeD1();
  const summary = await runHrptSync({ DB: db }, { fetchImpl, now: () => REFERENCE_DATE, log: silentLog() });

  assert.equal(summary.ok, false);
  assert.match(summary.reason, /suspiciously short body/);
  assert.equal(d1Calls.length, 0);
});

test("a page-fetch failure aborts before any D1 write, leaving cache untouched", async () => {
  const { fetchImpl } = makePageFetch({ pageStatus: 503 });
  const { db, calls: d1Calls } = createFakeD1();
  const summary = await runHrptSync({ DB: db }, { fetchImpl, now: () => REFERENCE_DATE, log: silentLog() });

  assert.equal(summary.ok, false);
  assert.match(summary.reason, /HTTP 503/);
  assert.equal(d1Calls.length, 0);
});

test("zero parsed field blocks aborts without writing anything (do not overwrite good cache with an empty result)", async () => {
  // Padded well past the short-body guard (200 bytes) so this specifically
  // exercises the "page fetched fine but no field blocks found" path,
  // distinct from the short-body guard covered implicitly elsewhere.
  const notTheSchedulePage = `<html><body><!-- ${"x".repeat(250)} --><p>This is not the HRPT schedule page (e.g. a maintenance/challenge page).</p></body></html>`;
  const { fetchImpl } = makePageFetch({ pageHtml: notTheSchedulePage });
  const { db, calls: d1Calls } = createFakeD1();
  const summary = await runHrptSync({ DB: db }, { fetchImpl, now: () => REFERENCE_DATE, log: silentLog() });

  assert.equal(summary.ok, false);
  assert.match(summary.reason, /zero field table blocks/);
  assert.equal(d1Calls.length, 0);
});

test("an unmapped field name is skipped and logged, without blocking other fields in the same run", async () => {
  const htmlWithUnmapped = rowspanHtml.replace(
    "Gansevoort Peninsula Athletic Field",
    "Some Brand New Field Nobody Has Heard Of"
  );
  const { fetchImpl } = makePageFetch({ pageHtml: htmlWithUnmapped });
  const { db, tables } = createFakeD1();
  const summary = await runHrptSync({ DB: db }, { fetchImpl, now: () => REFERENCE_DATE, log: silentLog() });

  assert.equal(summary.ok, true); // Pier 25 still wrote successfully.
  assert.equal(summary.fieldsWritten, 1);
  assert.deepEqual(summary.fieldsUnmapped, ["Some Brand New Field Nobody Has Heard Of"]);
  assert.ok(summary.anomalies.some((a) => a.includes("unmapped HRPT field name")));

  const pier25Id = EXACT_NAME_TO_FIELD_ID["Pier 25 Artificial Turf Field"];
  assert.ok(tables.field_sync_meta.some((r) => r.field_id === pier25Id));
});

test("a D1 write failure for one field does not stop other fields from being written", async () => {
  const { fetchImpl } = makePageFetch();
  const { db, calls: d1Calls } = createFakeD1({ failTables: ["field_permit_cache"] });
  const summary = await runHrptSync({ DB: db }, { fetchImpl, now: () => REFERENCE_DATE, log: silentLog() });

  assert.equal(summary.ok, false); // nothing successfully written this run
  assert.equal(summary.fieldsWritten, 0);
  assert.ok(summary.anomalies.some((a) => a.includes("write failed")));
  // Both mapped fields were still attempted (not aborted after the first failure).
  const deleteCalls = d1Calls.filter((c) => /^DELETE/i.test(c.sql));
  assert.ok(deleteCalls.length >= 2);
});
