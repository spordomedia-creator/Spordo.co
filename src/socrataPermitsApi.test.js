import { test } from "node:test";
import assert from "node:assert/strict";
import { handleSocrataPermitsRequest } from "./socrataPermitsApi.js";
import { createFakeSupabaseRest } from "./socrata/__testUtils__/fakeSupabaseRest.js";

const env = { SUPABASE_URL: "https://fake.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "svc-key" };

test("returns 500 when Supabase is not configured", async () => {
  const resp = await handleSocrataPermitsRequest({}, { sport: "soccer" });
  assert.equal(resp.status, 500);
  const body = await resp.json();
  assert.match(body.error, /Supabase is not configured/);
});

test("returns 400 for a missing or unknown sport", async () => {
  const { fetchImpl } = createFakeSupabaseRest();
  const resp1 = await handleSocrataPermitsRequest(env, {}, fetchImpl);
  assert.equal(resp1.status, 400);

  const resp2 = await handleSocrataPermitsRequest(env, { sport: "chess" }, fetchImpl);
  assert.equal(resp2.status, 400);
});

test("returns cached permits for a known sport, in the same field-name shape the frontend already expects", async () => {
  const { fetchImpl, tables } = createFakeSupabaseRest();
  tables.field_permit_cache.push(
    { source: "socrata", sport: "soccer", event_location: "Pier 40", event_borough: "MANHATTAN", start_date_time: "2026-08-22T09:00:00.000", end_date_time: "2026-08-22T11:00:00.000", event_name: "Soccer League", event_type: "Adult", permit_holder_name: "Jane", organization: "NYCFC" },
    { source: "socrata", sport: "basketball", event_location: "Rucker Park", start_date_time: "2026-08-22T09:00:00.000" } // different sport, must not appear
  );
  tables.field_sync_meta.push({ source: "socrata", scope: "sport:soccer", last_synced_at: new Date().toISOString(), status: "synced", rows_synced: 1, rows_dropped: 0 });

  const resp = await handleSocrataPermitsRequest(env, { sport: "soccer" }, fetchImpl);
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get("Content-Type"), "application/json");
  const body = await resp.json();
  assert.equal(body.length, 1);
  assert.equal(body[0].event_location, "Pier 40");
  assert.equal(body[0].event_name, "Soccer League");
  assert.equal(resp.headers.get("X-Spordo-Stale"), "false");
});

test("marks the response stale when the sport was last synced beyond the staleness threshold", async () => {
  const { fetchImpl, tables } = createFakeSupabaseRest();
  const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  tables.field_sync_meta.push({ source: "socrata", scope: "sport:soccer", last_synced_at: longAgo, status: "synced", rows_synced: 0, rows_dropped: 0 });

  const resp = await handleSocrataPermitsRequest(env, { sport: "soccer" }, fetchImpl);
  assert.equal(resp.headers.get("X-Spordo-Stale"), "true");
});

test("marks staleness as 'unknown' (not 'false') when the sport has never been synced", async () => {
  const { fetchImpl } = createFakeSupabaseRest();
  const resp = await handleSocrataPermitsRequest(env, { sport: "soccer" }, fetchImpl);
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.deepEqual(body, []);
  assert.equal(resp.headers.get("X-Spordo-Stale"), "unknown");
});

test("returns 502 when the Supabase permits read fails", async () => {
  const { fetchImpl } = createFakeSupabaseRest({ failTables: ["field_permit_cache"] });
  const resp = await handleSocrataPermitsRequest(env, { sport: "soccer" }, fetchImpl);
  assert.equal(resp.status, 502);
});
