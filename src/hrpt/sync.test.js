import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runHrptSync } from "./sync.js";
import { EXACT_NAME_TO_FIELD_ID } from "./fieldMap.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rowspanHtml = readFileSync(path.join(__dirname, "__fixtures__/rowspan-pattern.html"), "utf8");

const REFERENCE_DATE = new Date("2026-06-25T12:00:00Z");
const FAKE_ENV = { SUPABASE_URL: "https://fake.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "fake-key" };

function silentLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

/** A fetchImpl that serves the HRPT page HTML and records/mocks Supabase REST calls. */
function makeMockFetch({ pageHtml = rowspanHtml, pageStatus = 200, supabaseStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (typeof url === "string" && url.includes("hudsonriverpark.org")) {
      calls.push({ kind: "page-fetch", url, init });
      return {
        ok: pageStatus >= 200 && pageStatus < 300,
        status: pageStatus,
        text: async () => pageHtml,
      };
    }
    // Supabase REST call.
    calls.push({ kind: "supabase", url, init, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    return {
      ok: supabaseStatus >= 200 && supabaseStatus < 300,
      status: supabaseStatus,
      text: async () => (supabaseStatus >= 200 && supabaseStatus < 300 ? "" : "mock supabase error"),
    };
  };
  return { fetchImpl, calls };
}

test("happy path: fetches, parses, and writes cache + sync_meta for mapped fields only", async () => {
  const { fetchImpl, calls } = makeMockFetch();
  const summary = await runHrptSync(FAKE_ENV, { fetchImpl, now: () => REFERENCE_DATE, log: silentLog() });

  assert.equal(summary.ok, true);
  // Pier 25 (exact match) and Gansevoort (alias match) both resolve; the
  // "mystery" block has no discoverable name and is never attempted.
  assert.equal(summary.fieldsWritten, 2);
  assert.equal(summary.rowsInserted, 2); // Pier 25's two booked ranges; Gansevoort has none.

  const supabaseCalls = calls.filter((c) => c.kind === "supabase");
  const pier25Id = EXACT_NAME_TO_FIELD_ID["Pier 25 Artificial Turf Field"];
  const pier25Deletes = supabaseCalls.filter((c) => c.method === "DELETE" && c.url.includes(`field_id=eq.${pier25Id}`));
  assert.equal(pier25Deletes.length, 1, "expected exactly one scoped delete for Pier 25's window");
  assert.ok(pier25Deletes[0].url.includes("permit_date=gte.2026-06-28"));
  assert.ok(pier25Deletes[0].url.includes("permit_date=lte.2026-06-29"));

  const pier25Inserts = supabaseCalls.filter((c) => c.method === "POST" && c.url.includes("/field_permit_cache"));
  // Only Pier 25 has an insert call: Gansevoort resolved and had its stale
  // window deleted (see pier25Deletes-equivalent assertion below), but with
  // zero booked rows there's nothing to insert, so no POST is made for it.
  assert.equal(pier25Inserts.length, 1);
  const pier25RowsSent = pier25Inserts.find((c) => c.body.some((r) => r.field_id === pier25Id));
  assert.equal(pier25RowsSent.body.length, 2);
  assert.equal(pier25RowsSent.body[0].field_id, pier25Id);

  const syncMetaCalls = supabaseCalls.filter((c) => c.url.includes("/field_sync_meta"));
  assert.equal(syncMetaCalls.length, 2);
  assert.equal(syncMetaCalls[0].body[0].live_availability_status, "synced");
  assert.equal(syncMetaCalls[0].body[0].permit_source_url, "https://hudsonriverpark.org/visit/events/permits/fields/");
});

test("a suspiciously short response body aborts before any Supabase write", async () => {
  const { fetchImpl, calls } = makeMockFetch({ pageHtml: "<html></html>" });
  const summary = await runHrptSync(FAKE_ENV, { fetchImpl, now: () => REFERENCE_DATE, log: silentLog() });

  assert.equal(summary.ok, false);
  assert.match(summary.reason, /suspiciously short body/);
  assert.equal(calls.filter((c) => c.kind === "supabase").length, 0);
});

test("a page-fetch failure aborts before any Supabase write, leaving cache untouched", async () => {
  const { fetchImpl, calls } = makeMockFetch({ pageStatus: 503 });
  const summary = await runHrptSync(FAKE_ENV, { fetchImpl, now: () => REFERENCE_DATE, log: silentLog() });

  assert.equal(summary.ok, false);
  assert.match(summary.reason, /HTTP 503/);
  assert.equal(calls.filter((c) => c.kind === "supabase").length, 0);
});

test("zero parsed field blocks aborts without writing anything (do not overwrite good cache with an empty result)", async () => {
  // Padded well past the short-body guard (200 bytes) so this specifically
  // exercises the "page fetched fine but no field blocks found" path,
  // distinct from the short-body guard covered implicitly elsewhere.
  const notTheSchedulePage = `<html><body><!-- ${"x".repeat(250)} --><p>This is not the HRPT schedule page (e.g. a maintenance/challenge page).</p></body></html>`;
  const { fetchImpl, calls } = makeMockFetch({ pageHtml: notTheSchedulePage });
  const summary = await runHrptSync(FAKE_ENV, { fetchImpl, now: () => REFERENCE_DATE, log: silentLog() });

  assert.equal(summary.ok, false);
  assert.match(summary.reason, /zero field table blocks/);
  assert.equal(calls.filter((c) => c.kind === "supabase").length, 0);
});

test("an unmapped field name is skipped and logged, without blocking other fields in the same run", async () => {
  const htmlWithUnmapped = rowspanHtml.replace(
    "Gansevoort Peninsula Athletic Field",
    "Some Brand New Field Nobody Has Heard Of"
  );
  const { fetchImpl, calls } = makeMockFetch({ pageHtml: htmlWithUnmapped });
  const summary = await runHrptSync(FAKE_ENV, { fetchImpl, now: () => REFERENCE_DATE, log: silentLog() });

  assert.equal(summary.ok, true); // Pier 25 still wrote successfully.
  assert.equal(summary.fieldsWritten, 1);
  assert.deepEqual(summary.fieldsUnmapped, ["Some Brand New Field Nobody Has Heard Of"]);
  assert.ok(summary.anomalies.some((a) => a.includes("unmapped HRPT field name")));

  const pier25Id = EXACT_NAME_TO_FIELD_ID["Pier 25 Artificial Turf Field"];
  const supabaseCalls = calls.filter((c) => c.kind === "supabase");
  assert.ok(supabaseCalls.some((c) => c.url.includes(pier25Id)));
});

test("a Supabase write failure for one field does not stop other fields from being written", async () => {
  const { fetchImpl, calls } = makeMockFetch({ supabaseStatus: 500 });
  const summary = await runHrptSync(FAKE_ENV, { fetchImpl, now: () => REFERENCE_DATE, log: silentLog() });

  assert.equal(summary.ok, false); // nothing successfully written this run
  assert.equal(summary.fieldsWritten, 0);
  assert.ok(summary.anomalies.some((a) => a.includes("write failed")));
  // Both mapped fields were still attempted (not aborted after the first failure).
  const supabaseCalls = calls.filter((c) => c.kind === "supabase");
  assert.ok(supabaseCalls.length >= 2);
});
