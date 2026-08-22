import { test } from "node:test";
import assert from "node:assert/strict";
import { runSocrataSync } from "./sync.js";
import { createFakeSupabaseRest } from "./__testUtils__/fakeSupabaseRest.js";
import { TRACKED_SPORTS } from "./config.js";

const REFERENCE_DATE = new Date("2026-08-22T12:00:00.000Z");
const noopSleep = async () => {};

function silentLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

/** A Socrata fetchImpl that returns `rowsBySport[sportKeyword]` rows on the first page, empty otherwise. */
function makeSocrataFetch(rowsBySportId = {}) {
  return async (url) => {
    const u = new URL(url);
    const where = u.searchParams.get("$where") || "";
    const offset = Number(u.searchParams.get("$offset"));
    if (offset > 0) return { ok: true, status: 200, json: async () => [] };
    const matchedSport = Object.keys(rowsBySportId).find((id) => {
      const sport = TRACKED_SPORTS.find((s) => s.id === id);
      return sport && where.includes(sport.eventNameLike);
    });
    const rows = matchedSport ? rowsBySportId[matchedSport] : [];
    return { ok: true, status: 200, json: async () => rows };
  };
}

const env = { SUPABASE_URL: "https://fake.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "svc-key" };

test("happy path: fetches every tracked sport, normalizes, and writes cache + sync_meta per sport", async () => {
  const fetchImpl = makeSocrataFetch({
    soccer: [{ event_location: "Pier 40", start_date_time: "2026-08-22T09:00:00.000", event_name: "Soccer League" }],
    basketball: [{ event_location: "Rucker Park", start_date_time: "2026-08-23T09:00:00.000", event_name: "Basketball Run" }],
  });
  const { fetchImpl: supabaseFetchImpl, tables } = createFakeSupabaseRest();

  const summary = await runSocrataSync(env, { fetchImpl, supabaseFetchImpl, now: () => REFERENCE_DATE, log: silentLog(), sleepImpl: noopSleep });

  assert.equal(summary.ok, true);
  assert.equal(summary.sportsSynced.length, TRACKED_SPORTS.length); // every sport synced (even with 0 rows -- legitimate "nothing booked")
  assert.equal(summary.sportsFailed.length, 0);
  assert.equal(summary.rowsInserted, 2);

  const soccerRows = tables.field_permit_cache.filter((r) => r.sport === "soccer");
  assert.equal(soccerRows.length, 1);
  assert.equal(soccerRows[0].event_location, "Pier 40");
  assert.equal(soccerRows[0].source, "socrata");

  assert.equal(tables.field_sync_meta.length, TRACKED_SPORTS.length);
  const soccerMeta = tables.field_sync_meta.find((r) => r.scope === "sport:soccer");
  assert.equal(soccerMeta.status, "synced");
  assert.equal(soccerMeta.rows_synced, 1);

  const rugbyMeta = tables.field_sync_meta.find((r) => r.scope === "sport:rugby");
  assert.equal(rugbyMeta.rows_synced, 0, "rugby had zero matching permits this run -- a legitimate result, not a failure");
});

test("a fetch failure for one sport does not block other sports, and leaves that sport's cache untouched", async () => {
  let call = 0;
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if ((u.searchParams.get("$where") || "").includes("SOCCER")) {
      return { ok: false, status: 503 };
    }
    return { ok: true, status: 200, json: async () => [] };
  };
  const { fetchImpl: supabaseFetchImpl, tables } = createFakeSupabaseRest();
  tables.field_permit_cache.push({ source: "socrata", sport: "soccer", event_location: "must survive", start_date_time: "2026-08-22T09:00:00.000" });

  const summary = await runSocrataSync(env, { fetchImpl, supabaseFetchImpl, now: () => REFERENCE_DATE, log: silentLog(), sleepImpl: noopSleep });

  assert.equal(summary.ok, true); // other sports still succeeded
  assert.ok(summary.sportsFailed.includes("soccer"));
  assert.ok(!summary.sportsSynced.includes("soccer"));
  assert.ok(summary.anomalies.some((a) => a.includes("fetch failed for sport=soccer")));

  // Soccer's pre-existing cache row must be untouched (fetch failed -> no delete/insert issued for soccer).
  assert.ok(tables.field_permit_cache.some((r) => r.sport === "soccer" && r.event_location === "must survive"));
  assert.equal(tables.field_sync_meta.some((r) => r.scope === "sport:soccer"), false, "no sync_meta write for a sport whose fetch failed");
});

test("a Supabase write failure for one sport does not block other sports", async () => {
  const fetchImpl = makeSocrataFetch({
    soccer: [{ event_location: "Pier 40", start_date_time: "2026-08-22T09:00:00.000" }],
  });
  const { fetchImpl: supabaseFetchImpl, tables } = createFakeSupabaseRest({ failTables: ["field_permit_cache"] });

  const summary = await runSocrataSync(env, { fetchImpl, supabaseFetchImpl, now: () => REFERENCE_DATE, log: silentLog(), sleepImpl: noopSleep });

  assert.equal(summary.ok, false); // every sport's cache write fails (same fake table failure applies to all)
  assert.equal(summary.sportsSynced.length, 0);
  assert.equal(summary.sportsFailed.length, TRACKED_SPORTS.length);
  assert.ok(summary.anomalies.some((a) => a.includes("write failed for sport=")));
});

test("rows missing start_date_time are dropped and counted, not silently discarded", async () => {
  const fetchImpl = makeSocrataFetch({
    soccer: [
      { event_location: "Pier 40", start_date_time: "2026-08-22T09:00:00.000" },
      { event_location: "Missing date field" }, // no start_date_time -> dropped
    ],
  });
  const { fetchImpl: supabaseFetchImpl, tables } = createFakeSupabaseRest();

  const summary = await runSocrataSync(env, { fetchImpl, supabaseFetchImpl, now: () => REFERENCE_DATE, log: silentLog(), sleepImpl: noopSleep });

  assert.equal(summary.rowsDropped, 1);
  assert.ok(summary.anomalies.some((a) => a.includes("dropped 1 of 2")));
  const soccerMeta = tables.field_sync_meta.find((r) => r.scope === "sport:soccer");
  assert.equal(soccerMeta.rows_dropped, 1);
  assert.equal(soccerMeta.rows_synced, 1);
});

test("summary.ok is false and summary.reason is set when every sport fails", async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });
  const { fetchImpl: supabaseFetchImpl } = createFakeSupabaseRest();

  const summary = await runSocrataSync(env, { fetchImpl, supabaseFetchImpl, now: () => REFERENCE_DATE, log: silentLog(), sleepImpl: noopSleep });

  assert.equal(summary.ok, false);
  assert.match(summary.reason, /no sports were successfully synced/);
});
