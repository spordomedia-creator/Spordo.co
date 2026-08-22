import { test } from "node:test";
import assert from "node:assert/strict";
import { replaceSportPermitWindow, upsertSyncMeta, assertConfigured } from "./supabaseClient.js";
import { createFakeSupabaseRest } from "./__testUtils__/fakeSupabaseRest.js";

const env = { SUPABASE_URL: "https://fake.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret" };

test("assertConfigured throws when SUPABASE_URL or the service-role key are missing", () => {
  assert.throws(() => assertConfigured({ SUPABASE_SERVICE_ROLE_KEY: "x" }), /SUPABASE_URL/);
  assert.throws(() => assertConfigured({ SUPABASE_URL: "https://x" }), /SUPABASE_SERVICE_ROLE_KEY/);
});

test("replaceSportPermitWindow deletes the sport's date window then inserts rows, scoped to that sport + source only", async () => {
  const { fetchImpl, tables } = createFakeSupabaseRest();
  tables.field_permit_cache.push(
    { source: "socrata", sport: "basketball", start_date_time: "2026-08-22T09:00:00.000", event_location: "not touched (diff sport)" },
    { source: "socrata", sport: "soccer", start_date_time: "2026-05-01T09:00:00.000", event_location: "outside window" },
    { source: "hrpt", sport: "soccer", start_date_time: "2026-08-22T09:00:00.000", event_location: "not touched (diff source)" }
  );

  const result = await replaceSportPermitWindow(env, {
    table: "field_permit_cache",
    sport: "soccer",
    minDateIso: "2026-08-22",
    maxDateIso: "2026-11-20",
    rows: [
      { source: "socrata", sport: "soccer", event_location: "Field A", start_date_time: "2026-08-22T09:00:00.000" },
      { source: "socrata", sport: "soccer", event_location: "Field B", start_date_time: "2026-08-23T09:00:00.000" },
    ],
    fetchImpl,
  });

  assert.deepEqual(result, { deleted: true, inserted: 2 });
  assert.equal(tables.field_permit_cache.length, 5); // 3 untouched + 2 newly inserted
  assert.ok(tables.field_permit_cache.some((r) => r.event_location === "not touched (diff sport)"));
  assert.ok(tables.field_permit_cache.some((r) => r.event_location === "outside window"));
  assert.ok(tables.field_permit_cache.some((r) => r.event_location === "not touched (diff source)"));
  assert.equal(tables.field_permit_cache.filter((r) => r.event_location === "Field A").length, 1);
});

test("replaceSportPermitWindow with zero rows deletes the window and inserts nothing (legitimate all-clear result)", async () => {
  const { fetchImpl, tables } = createFakeSupabaseRest();
  tables.field_permit_cache.push({ source: "socrata", sport: "soccer", start_date_time: "2026-08-22T09:00:00.000", event_location: "stale" });

  const result = await replaceSportPermitWindow(env, {
    table: "field_permit_cache",
    sport: "soccer",
    minDateIso: "2026-08-22",
    maxDateIso: "2026-11-20",
    rows: [],
    fetchImpl,
  });

  assert.deepEqual(result, { deleted: true, inserted: 0 });
  assert.equal(tables.field_permit_cache.length, 0);
});

test("replaceSportPermitWindow throws when the delete request fails, without attempting the insert", async () => {
  const { fetchImpl } = createFakeSupabaseRest({ failTables: ["field_permit_cache"] });
  await assert.rejects(
    () =>
      replaceSportPermitWindow(env, {
        table: "field_permit_cache",
        sport: "soccer",
        minDateIso: "2026-08-22",
        maxDateIso: "2026-11-20",
        rows: [{ source: "socrata", sport: "soccer", event_location: "Field A", start_date_time: "2026-08-22T09:00:00.000" }],
        fetchImpl,
      }),
    /Supabase delete failed for sport=soccer/
  );
});

test("upsertSyncMeta inserts a new (source, scope) row", async () => {
  const { fetchImpl, tables } = createFakeSupabaseRest();
  await upsertSyncMeta(env, {
    table: "field_sync_meta",
    row: { source: "socrata", scope: "sport:soccer", last_synced_at: "2026-08-22T00:00:00.000Z", status: "synced", rows_synced: 2, rows_dropped: 0, error_message: null, source_url: "https://example.com" },
    fetchImpl,
  });
  assert.equal(tables.field_sync_meta.length, 1);
  assert.equal(tables.field_sync_meta[0].scope, "sport:soccer");
});

test("upsertSyncMeta updates the existing (source, scope) row instead of duplicating it", async () => {
  const { fetchImpl, tables } = createFakeSupabaseRest();
  const row1 = { source: "socrata", scope: "sport:soccer", last_synced_at: "2026-08-22T00:00:00.000Z", status: "synced", rows_synced: 2, rows_dropped: 0, error_message: null, source_url: "https://example.com" };
  const row2 = { ...row1, last_synced_at: "2026-08-22T03:00:00.000Z", rows_synced: 5 };

  await upsertSyncMeta(env, { table: "field_sync_meta", row: row1, fetchImpl });
  await upsertSyncMeta(env, { table: "field_sync_meta", row: row2, fetchImpl });

  assert.equal(tables.field_sync_meta.length, 1, "expected the (source, scope) upsert to replace, not duplicate");
  assert.equal(tables.field_sync_meta[0].last_synced_at, "2026-08-22T03:00:00.000Z");
  assert.equal(tables.field_sync_meta[0].rows_synced, 5);
});

test("upsertSyncMeta for a different sport's scope does not collide with an existing one", async () => {
  const { fetchImpl, tables } = createFakeSupabaseRest();
  await upsertSyncMeta(env, {
    table: "field_sync_meta",
    row: { source: "socrata", scope: "sport:soccer", last_synced_at: "t1", status: "synced", rows_synced: 1, rows_dropped: 0, error_message: null, source_url: "u" },
    fetchImpl,
  });
  await upsertSyncMeta(env, {
    table: "field_sync_meta",
    row: { source: "socrata", scope: "sport:basketball", last_synced_at: "t2", status: "synced", rows_synced: 1, rows_dropped: 0, error_message: null, source_url: "u" },
    fetchImpl,
  });
  assert.equal(tables.field_sync_meta.length, 2);
});

test("upsertSyncMeta throws when Supabase reports a failure", async () => {
  const { fetchImpl } = createFakeSupabaseRest({ failTables: ["field_sync_meta"] });
  await assert.rejects(
    () =>
      upsertSyncMeta(env, {
        table: "field_sync_meta",
        row: { source: "socrata", scope: "sport:soccer", last_synced_at: "now", status: "synced", rows_synced: 0, rows_dropped: 0, error_message: null, source_url: "u" },
        fetchImpl,
      }),
    /Supabase sync-meta upsert failed for scope=sport:soccer/
  );
});
