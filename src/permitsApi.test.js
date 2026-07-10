import { test } from "node:test";
import assert from "node:assert/strict";
import { handlePermitsRequest } from "./permitsApi.js";

/**
 * A minimal read-only D1 fake (SELECT-only) — deliberately separate from
 * src/hrpt/__testUtils__/fakeD1.js, which only recognizes the write-side
 * statement shapes d1Client.js issues and doesn't model SELECT at all.
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
        last_permit_sync_at: "2026-07-09T15:00:37.709Z",
        live_availability_status: "synced",
        permit_source_url: "https://hudsonriverpark.org/visit/events/permits/fields/",
      },
    },
    permitCache: {
      "field-1": [
        { permit_date: "2026-07-10", start_time: "18:00", end_time: "20:00", event_name: "League A" },
        { permit_date: "2026-07-25", start_time: "09:00", end_time: "10:00", event_name: "Too far out" },
      ],
    },
  });

  const resp = await handlePermitsRequest({ DB: db }, "field-1");
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get("Content-Type"), "application/json");
  const body = await resp.json();
  assert.equal(body.meta.live_availability_status, "synced");
  // The 2026-07-25 row is outside the 14-day horizon and must be excluded.
  assert.equal(body.permits.length, 1);
  assert.equal(body.permits[0].event_name, "League A");
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
