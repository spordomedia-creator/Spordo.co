import { test } from "node:test";
import assert from "node:assert/strict";
import { handlePermitsRequest } from "./permitsApi.js";

/**
 * A minimal read-only D1 fake (SELECT-only) — deliberately separate from
 * src/hrpt/__testUtils__/fakeD1.js, which only recognizes the write-side
 * statement shapes d1Client.js issues and doesn't model SELECT at all.
 *
 * Branches on the SQL text itself (not just call order) since
 * handlePermitsRequest now issues two different `.first()` queries
 * (field_sync_meta lookup, and a separate MAX(permit_date) coverage
 * check) that must not be confused with each other.
 */
function createFakeReadD1({ syncMeta = {}, permitCache = [] } = {}) {
  const calls = [];
  const db = {
    prepare(sql) {
      let boundArgs = [];
      return {
        bind(...args) {
          boundArgs = args;
          return this;
        },
        async first() {
          calls.push({ sql, args: boundArgs, method: "first" });
          const [fieldId] = boundArgs;
          if (sql.includes("MAX(permit_date)")) {
            const rows = permitCache[fieldId] || [];
            const latest = rows.map((r) => r.permit_date).sort().at(-1) || null;
            return { latest_date: latest };
          }
          return syncMeta[fieldId] || null;
        },
        async all() {
          calls.push({ sql, args: boundArgs, method: "all" });
          const [fieldId, minDate, maxDate] = boundArgs;
          const results = (permitCache[fieldId] || []).filter(
            (r) => r.permit_date >= minDate && r.permit_date <= maxDate
          );
          return { results };
        },
      };
    },
  };
  return { db, calls };
}

/** ISO yyyy-mm-dd string N days from today (negative = past). */
function daysFromToday(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().split("T")[0];
}

test("returns 500 when D1 binding is missing", async () => {
  const resp = await handlePermitsRequest({}, "some-field");
  assert.equal(resp.status, 500);
  const body = await resp.json();
  assert.match(body.error, /DB.*not configured/);
});

test("returns 400 when fieldId is missing/empty", async () => {
  const { db } = createFakeReadD1();
  const resp = await handlePermitsRequest({ DB: db }, "");
  assert.equal(resp.status, 400);
});

test("returns meta + permits for a field with real synced data", async () => {
  const { db } = createFakeReadD1({
    syncMeta: {
      "field-1": {
        field_id: "field-1",
        last_permit_sync_at: new Date().toISOString(),
        live_availability_status: "synced",
        permit_source_url: "https://hudsonriverpark.org/visit/events/permits/fields/",
      },
    },
    permitCache: {
      "field-1": [
        { permit_date: daysFromToday(1), start_time: "18:00", end_time: "20:00", event_name: "League A" },
        { permit_date: daysFromToday(20), start_time: "09:00", end_time: "10:00", event_name: "Too far out" },
      ],
    },
  });

  const resp = await handlePermitsRequest({ DB: db }, "field-1");
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get("Content-Type"), "application/json");
  const body = await resp.json();
  assert.equal(body.meta.live_availability_status, "synced");
  // The +20-day row is outside the 14-day horizon and must be excluded.
  assert.equal(body.permits.length, 1);
  assert.equal(body.permits[0].event_name, "League A");
  // Cache reaches 20 days out, well past today -- not stale.
  assert.equal(body.meta.source_data_stale, false);
});

test("flags source_data_stale when the cache's latest permit_date is before today (e.g. HRPT's own page frozen on an old week)", async () => {
  const { db } = createFakeReadD1({
    syncMeta: {
      "field-1": {
        field_id: "field-1",
        last_permit_sync_at: new Date().toISOString(), // sync ran fine and recently...
        live_availability_status: "synced",
      },
    },
    permitCache: {
      // ...but every cached row is in the past -- the source page itself
      // hasn't advanced, not a sync failure. last_permit_sync_at freshness
      // alone can't catch this; only checking actual data coverage can.
      "field-1": [{ permit_date: daysFromToday(-10), start_time: "18:00", end_time: "20:00", event_name: "Old League" }],
    },
  });

  const resp = await handlePermitsRequest({ DB: db }, "field-1");
  const body = await resp.json();
  assert.equal(body.meta.source_data_stale, true);
  assert.equal(body.meta.latest_permit_date, daysFromToday(-10));
  // The windowed query also correctly returns nothing for "today onward".
  assert.deepEqual(body.permits, []);
});

test("a field with zero permits ever cached is stale, not confused with 'fully available'", async () => {
  const { db } = createFakeReadD1({
    syncMeta: {
      "field-1": { field_id: "field-1", last_permit_sync_at: new Date().toISOString(), live_availability_status: "synced" },
    },
    permitCache: { "field-1": [] },
  });

  const resp = await handlePermitsRequest({ DB: db }, "field-1");
  const body = await resp.json();
  assert.equal(body.meta.source_data_stale, true);
  assert.equal(body.meta.latest_permit_date, null);
});

test("a confirmed no_permit_schedule field is never flagged stale, regardless of cache state", async () => {
  const { db } = createFakeReadD1({
    syncMeta: {
      "field-1": {
        field_id: "field-1",
        last_permit_sync_at: new Date().toISOString(),
        live_availability_status: "no_permit_schedule",
      },
    },
    permitCache: { "field-1": [] },
  });

  const resp = await handlePermitsRequest({ DB: db }, "field-1");
  const body = await resp.json();
  assert.equal(body.meta.source_data_stale, false);
});

test("returns meta: null and permits: [] for an unknown/not-yet-synced field, not an error", async () => {
  const { db } = createFakeReadD1();
  const resp = await handlePermitsRequest({ DB: db }, "never-synced-field");
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.meta, null);
  assert.deepEqual(body.permits, []);
});

test("URL-encoded field ids (containing base64 special chars) are queried as-is once decoded by the caller", async () => {
  const { db, calls } = createFakeReadD1({
    syncMeta: { "SFJQfFBpZXI=": { field_id: "SFJQfFBpZXI=", last_permit_sync_at: "now", live_availability_status: "synced" } },
  });
  const resp = await handlePermitsRequest({ DB: db }, "SFJQfFBpZXI=");
  assert.equal(resp.status, 200);
  const metaCall = calls.find((c) => c.method === "first");
  assert.equal(metaCall.args[0], "SFJQfFBpZXI=");
});
