import { test } from "node:test";
import assert from "node:assert/strict";
import { replaceFieldPermitWindow, upsertSyncMeta } from "./d1Client.js";
import { createFakeD1 } from "./__testUtils__/fakeD1.js";

// See __testUtils__/fakeD1.js for exactly what this fake does and does not
// prove: it tests d1Client.js's own statement-construction and
// error-propagation logic, not real D1/SQLite semantics.

test("replaceFieldPermitWindow deletes the field's date window then inserts rows, scoped to that field only", async () => {
  const { db, tables } = createFakeD1();
  const env = { DB: db };

  // Seed a row for a different field and a row outside the window — both
  // should survive untouched.
  tables.field_permit_cache.push(
    { field_id: "other-field", permit_date: "2026-06-28", start_time: "10:00", end_time: "11:00", event_name: "not touched" },
    { field_id: "pier-25", permit_date: "2026-05-01", start_time: "09:00", end_time: "10:00", event_name: "outside window" }
  );

  const result = await replaceFieldPermitWindow(env, {
    table: "field_permit_cache",
    fieldId: "pier-25",
    minDate: "2026-06-28",
    maxDate: "2026-06-29",
    rows: [
      { field_id: "pier-25", permit_date: "2026-06-28", start_time: "18:00", end_time: "20:00", event_name: "League A" },
      { field_id: "pier-25", permit_date: "2026-06-29", start_time: "09:00", end_time: "11:00", event_name: "League B" },
    ],
  });

  assert.deepEqual(result, { deleted: true, inserted: 2 });
  assert.equal(tables.field_permit_cache.length, 4); // 2 untouched + 2 newly inserted
  assert.ok(tables.field_permit_cache.some((r) => r.field_id === "other-field"));
  assert.ok(tables.field_permit_cache.some((r) => r.field_id === "pier-25" && r.permit_date === "2026-05-01"));
  assert.equal(tables.field_permit_cache.filter((r) => r.field_id === "pier-25" && r.event_name === "League A").length, 1);
});

test("replaceFieldPermitWindow with zero rows deletes the window and inserts nothing (legitimate all-available result)", async () => {
  const { db, tables } = createFakeD1();
  const env = { DB: db };
  tables.field_permit_cache.push({ field_id: "gansevoort", permit_date: "2026-06-28", start_time: null, end_time: null, event_name: "stale row" });

  const result = await replaceFieldPermitWindow(env, {
    table: "field_permit_cache",
    fieldId: "gansevoort",
    minDate: "2026-06-28",
    maxDate: "2026-06-29",
    rows: [],
  });

  assert.deepEqual(result, { deleted: true, inserted: 0 });
  assert.equal(tables.field_permit_cache.length, 0);
});

test("replaceFieldPermitWindow throws (and does not corrupt other fields) when D1 reports a failure", async () => {
  const { db, tables } = createFakeD1({ failTables: ["field_permit_cache"] });
  const env = { DB: db };
  tables.field_permit_cache.push({ field_id: "other-field", permit_date: "2026-06-28", start_time: "10:00", end_time: "11:00", event_name: "must survive" });

  await assert.rejects(
    () =>
      replaceFieldPermitWindow(env, {
        table: "field_permit_cache",
        fieldId: "pier-25",
        minDate: "2026-06-28",
        maxDate: "2026-06-29",
        rows: [{ field_id: "pier-25", permit_date: "2026-06-28", start_time: "18:00", end_time: "20:00", event_name: "League A" }],
      }),
    /D1 delete\+insert \(batch\) failed for field_id=pier-25/
  );

  // The fake doesn't roll back a mid-batch failure (see its doc comment),
  // but the point we're proving here is that d1Client.js surfaces the
  // failure as a thrown error rather than swallowing it or reporting
  // success — sync.js relies on that to know not to count this field as
  // written.
  assert.ok(tables.field_permit_cache.some((r) => r.field_id === "other-field"));
});

test("upsertSyncMeta inserts a new row", async () => {
  const { db, tables } = createFakeD1();
  const env = { DB: db };

  await upsertSyncMeta(env, {
    table: "field_sync_meta",
    row: { field_id: "pier-25", last_permit_sync_at: "2026-07-08T00:00:00.000Z", live_availability_status: "synced", permit_source_url: "https://example.com" },
  });

  assert.equal(tables.field_sync_meta.length, 1);
  assert.equal(tables.field_sync_meta[0].field_id, "pier-25");
});

test("upsertSyncMeta updates the existing row for the same field_id instead of duplicating it", async () => {
  const { db, tables } = createFakeD1();
  const env = { DB: db };

  const row1 = { field_id: "pier-25", last_permit_sync_at: "2026-07-08T00:00:00.000Z", live_availability_status: "synced", permit_source_url: "https://example.com" };
  const row2 = { field_id: "pier-25", last_permit_sync_at: "2026-07-08T03:00:00.000Z", live_availability_status: "synced", permit_source_url: "https://example.com" };

  await upsertSyncMeta(env, { table: "field_sync_meta", row: row1 });
  await upsertSyncMeta(env, { table: "field_sync_meta", row: row2 });

  assert.equal(tables.field_sync_meta.length, 1, "expected the field_id UNIQUE/PRIMARY KEY upsert to replace, not duplicate");
  assert.equal(tables.field_sync_meta[0].last_permit_sync_at, "2026-07-08T03:00:00.000Z");
});

test("upsertSyncMeta throws when D1 reports a failure", async () => {
  const { db } = createFakeD1({ failTables: ["field_sync_meta"] });
  const env = { DB: db };

  await assert.rejects(
    () =>
      upsertSyncMeta(env, {
        table: "field_sync_meta",
        row: { field_id: "pier-25", last_permit_sync_at: "now", live_availability_status: "synced", permit_source_url: "https://example.com" },
      }),
    /D1 sync-meta upsert failed for field_id=pier-25/
  );
});

test("a thrown/rejected run() (not just success:false) is also wrapped into a thrown Error", async () => {
  const env = {
    DB: {
      prepare() {
        return {
          bind() {
            return this;
          },
          async run() {
            throw new Error("simulated D1 binding exception");
          },
        };
      },
      async batch(stmts) {
        // Mirror real D1: a throw from any statement rejects the whole batch.
        for (const s of stmts) await s.run();
        return [];
      },
    },
  };

  await assert.rejects(
    () =>
      replaceFieldPermitWindow(env, {
        table: "field_permit_cache",
        fieldId: "pier-25",
        minDate: "2026-06-28",
        maxDate: "2026-06-29",
        rows: [{ field_id: "pier-25", permit_date: "2026-06-28", start_time: "18:00", end_time: "20:00", event_name: "League A" }],
      }),
    /D1 delete\+insert \(batch\) failed for field_id=pier-25.*simulated D1 binding exception/s
  );
});
