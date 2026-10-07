import { test } from "node:test";
import assert from "node:assert/strict";
import { handleSocrataPermitsRequest, PAGE_LIMIT, MAX_PAGES, joinJsonArrays, parseContentRange } from "./socrataPermitsApi.js";
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
  const soon = new Date(Date.now() + 2 * 864e5).toISOString();      // upcoming — must appear
  const past = new Date(Date.now() - 10 * 864e5).toISOString();     // before today — must be filtered out
  tables.field_permit_cache.push(
    { source: "socrata", sport: "soccer", event_location: "Pier 40", event_borough: "MANHATTAN", start_date_time: soon, end_date_time: soon, event_name: "Soccer League", event_type: "Adult", permit_holder_name: "Jane", organization: "NYCFC" },
    { source: "socrata", sport: "soccer", event_location: "Old Field", event_borough: "MANHATTAN", start_date_time: past, event_name: "Past Soccer" }, // past — read returns only current/upcoming
    { source: "socrata", sport: "basketball", event_location: "Rucker Park", start_date_time: soon } // different sport, must not appear
  );
  tables.field_sync_meta.push({ source: "socrata", scope: "sport:soccer", last_synced_at: new Date().toISOString(), status: "synced", rows_synced: 1, rows_dropped: 0 });

  const resp = await handleSocrataPermitsRequest(env, { sport: "soccer" }, fetchImpl);
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get("Content-Type"), "application/json");
  const body = await resp.json();
  assert.equal(body.length, 1);   // only the upcoming soccer permit; past + other-sport excluded
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

// Upcoming soccer rows with distinct, ascending start times (all on future dates).
function upcomingSoccerRows(n, { startDay = 2 } = {}) {
  const base = Date.now() + startDay * 864e5;
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    source: "socrata",
    sport: "soccer",
    event_location: `Field ${i}`,
    start_date_time: new Date(base + i * 60e3).toISOString().replace("Z", ""),
  }));
}

function permitPageCalls(calls) {
  return calls.filter((c) => c.table === "field_permit_cache" && c.method === "GET");
}

test("returns every cached row past Supabase's 1,000-row cap, in order (was: first 1,000 only)", async () => {
  const { fetchImpl, tables, calls } = createFakeSupabaseRest(); // maxRows 1000, like a real project
  tables.field_permit_cache.push(...upcomingSoccerRows(2500));

  const resp = await handleSocrataPermitsRequest(env, { sport: "soccer" }, fetchImpl);
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.length, 2500);
  assert.deepEqual(body.map((r) => r.event_location), Array.from({ length: 2500 }, (_, i) => `Field ${i}`));
  assert.equal(resp.headers.get("X-Spordo-Total-Rows"), "2500");
  assert.equal(resp.headers.get("X-Spordo-Truncated"), "false");

  // First page asks for PAGE_LIMIT; the server returns its 1,000 cap, and the
  // remaining pages ask for exactly that.
  const limits = permitPageCalls(calls).map((c) => Number(new URL(c.url).searchParams.get("limit")));
  assert.deepEqual(limits, [PAGE_LIMIT, 1000, 1000]);
});

test("pages by the size the server actually returns when Max rows is set below 1,000", async () => {
  const { fetchImpl, tables, calls } = createFakeSupabaseRest({ maxRows: 300 });
  tables.field_permit_cache.push(...upcomingSoccerRows(1000));

  const resp = await handleSocrataPermitsRequest(env, { sport: "soccer" }, fetchImpl);
  const body = await resp.json();
  assert.equal(body.length, 1000);
  assert.equal(new Set(body.map((r) => r.event_location)).size, 1000);
  assert.equal(permitPageCalls(calls).length, 4);
});

test("orders rows that share a start time by id, so pages never overlap or skip", async () => {
  const { fetchImpl, tables } = createFakeSupabaseRest({ maxRows: 2 });
  const start = new Date(Date.now() + 2 * 864e5).toISOString().replace("Z", "");
  // Inserted out of id order; all share one start time.
  for (const id of [5, 3, 1, 4, 2]) {
    tables.field_permit_cache.push({ id, source: "socrata", sport: "soccer", event_location: `Field ${id}`, start_date_time: start });
  }
  const body = await (await handleSocrataPermitsRequest(env, { sport: "soccer" }, fetchImpl)).json();
  assert.deepEqual(body.map((r) => r.event_location), ["Field 1", "Field 2", "Field 3", "Field 4", "Field 5"]);
});

test("stops at MAX_PAGES and flags the response as partial instead of passing it off as complete", async () => {
  const { fetchImpl, tables, calls } = createFakeSupabaseRest({ maxRows: 10 });
  tables.field_permit_cache.push(...upcomingSoccerRows(10 * MAX_PAGES + 5));

  const resp = await handleSocrataPermitsRequest(env, { sport: "soccer" }, fetchImpl);
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.length, 10 * MAX_PAGES);
  assert.equal(resp.headers.get("X-Spordo-Truncated"), "true");
  assert.equal(resp.headers.get("X-Spordo-Total-Rows"), String(10 * MAX_PAGES + 5));
  assert.equal(permitPageCalls(calls).length, MAX_PAGES);
});

test("keeps tonight's permits after 8pm ET: the 'from today' floor is New York's date, not UTC's", async () => {
  const { fetchImpl, tables } = createFakeSupabaseRest();
  tables.field_permit_cache.push(
    { id: 1, source: "socrata", sport: "soccer", event_location: "Yesterday", start_date_time: "2026-10-06T21:00:00.000" },
    { id: 2, source: "socrata", sport: "soccer", event_location: "Tonight", start_date_time: "2026-10-07T21:00:00.000" },
    { id: 3, source: "socrata", sport: "soccer", event_location: "Tomorrow", start_date_time: "2026-10-08T09:00:00.000" }
  );
  const now = new Date("2026-10-08T00:30:00Z"); // 8:30pm EDT on Oct 7; the UTC date is already Oct 8
  const body = await (await handleSocrataPermitsRequest(env, { sport: "soccer", now }, fetchImpl)).json();
  assert.deepEqual(body.map((r) => r.event_location), ["Tonight", "Tomorrow"]);
});

test("returns 502 (not a silently short list) when a later page fails", async () => {
  const fake = createFakeSupabaseRest();
  fake.tables.field_permit_cache.push(...upcomingSoccerRows(2500));
  const fetchImpl = async (url, init) =>
    new URL(url).searchParams.get("offset") === "1000"
      ? { ok: false, status: 500, text: async () => "simulated page failure" }
      : fake.fetchImpl(url, init);

  const resp = await handleSocrataPermitsRequest(env, { sport: "soccer" }, fetchImpl);
  assert.equal(resp.status, 502);
  assert.equal(resp.headers.get("Cache-Control"), "no-store");
});

test("joinJsonArrays splices JSON-array bodies without parsing them, skipping empty pages", () => {
  const enc = (s) => new TextEncoder().encode(s);
  const joined = joinJsonArrays([enc('[{"a":1}, \n {"a":2}]'), enc("[]"), enc(" [ ] "), enc('[{"a":3}]\n')]);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(joined)), [{ a: 1 }, { a: 2 }, { a: 3 }]);
  assert.equal(new TextDecoder().decode(joinJsonArrays([enc("[]")])), "[]");
  assert.throws(() => joinJsonArrays([enc('{"error":"x"}')]), /not a JSON array/);
});

test("parseContentRange reads PostgREST's counted, uncounted and empty ranges", () => {
  assert.deepEqual(parseContentRange("0-999/28848"), { rows: 1000, total: 28848 });
  assert.deepEqual(parseContentRange("0-999/*"), { rows: 1000, total: null });
  assert.deepEqual(parseContentRange("*/0"), { rows: 0, total: 0 });
  assert.equal(parseContentRange(null), null);
  assert.equal(parseContentRange("garbage"), null);
});

test("a partial response is never cacheable; a complete one keeps the short public cache", async () => {
  // No Content-Range at all: can't tell what's missing.
  const fake = createFakeSupabaseRest();
  fake.tables.field_permit_cache.push(...upcomingSoccerRows(2500));
  const stripRange = async (url, init) => {
    const r = await fake.fetchImpl(url, init);
    return new URL(url).pathname.endsWith("field_permit_cache") ? new Response(await r.text(), { status: r.status }) : r;
  };
  const unknown = await handleSocrataPermitsRequest(env, { sport: "soccer" }, stripRange);
  assert.equal(unknown.status, 200);
  assert.equal(unknown.headers.get("X-Spordo-Truncated"), "unknown");
  assert.equal(unknown.headers.get("Cache-Control"), "no-store");
  assert.equal((await unknown.json()).length, 1000);

  // Cut off at MAX_PAGES.
  const big = createFakeSupabaseRest({ maxRows: 10 });
  big.tables.field_permit_cache.push(...upcomingSoccerRows(10 * MAX_PAGES + 1));
  const partial = await handleSocrataPermitsRequest(env, { sport: "soccer" }, big.fetchImpl);
  assert.equal(partial.headers.get("X-Spordo-Truncated"), "true");
  assert.equal(partial.headers.get("Cache-Control"), "no-store");

  // Complete.
  const ok = await handleSocrataPermitsRequest(env, { sport: "soccer" }, fake.fetchImpl);
  assert.equal(ok.headers.get("X-Spordo-Truncated"), "false");
  assert.equal(ok.headers.get("Cache-Control"), "public, max-age=300");
});
