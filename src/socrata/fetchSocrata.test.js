import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchSportWindow } from "./fetchSocrata.js";

function silentLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

const noopSleep = async () => {};
const sport = { id: "soccer", eventNameLike: "SOCCER" };
const window = { minDateIso: "2026-08-22", maxDateIso: "2026-11-20" };

function makeRows(n, offset = 0) {
  return Array.from({ length: n }, (_, i) => ({ event_location: `Field ${offset + i}`, start_date_time: "2026-08-22T09:00:00.000" }));
}

test("a single short page (< PAGE_SIZE) is treated as the complete result, not truncated", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => makeRows(5) };
  };
  const result = await fetchSportWindow(sport, { ...window, fetchImpl, appToken: "tok", log: silentLog(), sleepImpl: noopSleep });
  assert.equal(result.rawRows.length, 5);
  assert.equal(result.pages, 1);
  assert.equal(result.truncated, false);
  assert.equal(calls.length, 1);
});

test("pages through offsets until a short page is returned", async () => {
  let call = 0;
  const fetchImpl = async (url) => {
    call += 1;
    const u = new URL(url);
    const offset = Number(u.searchParams.get("$offset"));
    // Two full pages (1000 each), then a short third page.
    const size = offset < 2000 ? 1000 : 200;
    return { ok: true, status: 200, json: async () => makeRows(size, offset) };
  };
  const result = await fetchSportWindow(sport, { ...window, fetchImpl, appToken: "tok", log: silentLog(), sleepImpl: noopSleep });
  assert.equal(result.pages, 3);
  assert.equal(result.rawRows.length, 1000 + 1000 + 200);
  assert.equal(result.truncated, false);
});

test("sends the X-App-Token header when configured, and omits it (with a warning) when not", async () => {
  const seenHeaders = [];
  const fetchImpl = async (url, init) => {
    seenHeaders.push(init.headers);
    return { ok: true, status: 200, json: async () => [] };
  };
  await fetchSportWindow(sport, { ...window, fetchImpl, appToken: "my-token", log: silentLog(), sleepImpl: noopSleep });
  assert.equal(seenHeaders[0]["X-App-Token"], "my-token");

  const warnings = [];
  const log = { info: () => {}, warn: (m) => warnings.push(m), error: () => {} };
  await fetchSportWindow(sport, { ...window, fetchImpl, appToken: undefined, log, sleepImpl: noopSleep });
  assert.equal(seenHeaders[1]["X-App-Token"], undefined);
  assert.ok(warnings.some((w) => w.includes("no SOCRATA_APP_TOKEN")));
});

test("retries on 429 and eventually succeeds", async () => {
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    if (call === 1) return { ok: false, status: 429 };
    return { ok: true, status: 200, json: async () => makeRows(3) };
  };
  const result = await fetchSportWindow(sport, { ...window, fetchImpl, appToken: "tok", log: silentLog(), sleepImpl: noopSleep });
  assert.equal(result.rawRows.length, 3);
  assert.equal(call, 2);
});

test("retries on 5xx and gives up after MAX_FETCH_RETRIES, throwing (caller must not touch cache)", async () => {
  const fetchImpl = async () => ({ ok: false, status: 503 });
  await assert.rejects(
    () => fetchSportWindow(sport, { ...window, fetchImpl, appToken: "tok", log: silentLog(), sleepImpl: noopSleep }),
    /503/
  );
});

test("a non-retryable 4xx (e.g. 400) fails fast without exhausting all retries", async () => {
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    return { ok: false, status: 400 };
  };
  await assert.rejects(() => fetchSportWindow(sport, { ...window, fetchImpl, appToken: "tok", log: silentLog(), sleepImpl: noopSleep }));
  assert.equal(call, 1, "expected a non-retryable 4xx to fail on the first attempt");
});

test("a thrown network error is retried the same as a retryable HTTP failure", async () => {
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    if (call === 1) throw new Error("network blip");
    return { ok: true, status: 200, json: async () => makeRows(1) };
  };
  const result = await fetchSportWindow(sport, { ...window, fetchImpl, appToken: "tok", log: silentLog(), sleepImpl: noopSleep });
  assert.equal(result.rawRows.length, 1);
  assert.equal(call, 2);
});

test("hitting MAX_PAGES_PER_SPORT stops fetching and reports truncated:true rather than looping forever", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => makeRows(1000) }); // always a full page
  const errors = [];
  const log = { info: () => {}, warn: () => {}, error: (m) => errors.push(m) };
  const result = await fetchSportWindow(sport, { ...window, fetchImpl, appToken: "tok", log, sleepImpl: noopSleep });
  assert.equal(result.truncated, true);
  assert.equal(result.pages, 20); // MAX_PAGES_PER_SPORT
  assert.ok(errors.some((e) => e.includes("MAX_PAGES_PER_SPORT")));
});

test("a non-array JSON response throws instead of silently caching garbage", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ error: "not an array" }) });
  await assert.rejects(
    () => fetchSportWindow(sport, { ...window, fetchImpl, appToken: "tok", log: silentLog(), sleepImpl: noopSleep }),
    /unexpected non-array/
  );
});
