import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runAsphaltGreenSync,
  parseAuraContext,
  parseAuraResponse,
  toPermitRows,
  toNewYorkParts,
  encodeFieldId,
  LITWIN_FIELD_ID,
} from "./sync.js";
import { createFakeD1 } from "../hrpt/__testUtils__/fakeD1.js";

// Shape captured from the live endpoint on 2026-09-30.
const BOOKINGS = [
  { endTime: "2026-09-30T12:00:00.000Z", eventName: "Public Field Hours", facilityName: "Litwin Field - Full Field", functionName: "Public Hours", id: "a", startTime: "2026-09-30T10:00:00.000Z" },
  { endTime: "2026-10-03T13:00:00.000Z", eventName: "Public Field Hours", facilityName: "Litwin Field - Full Field", functionName: "Public Hours", id: "b", startTime: "2026-10-03T10:00:00.000Z" },
];

function auraOk(rows) {
  return JSON.stringify({ actions: [{ id: "1;a", state: "SUCCESS", returnValue: { returnValue: rows, cacheable: true }, error: [] }] });
}

function fakeFetch({ page = "", aura = auraOk(BOOKINGS), auraStatus = 200 } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (String(url).includes("sfsites/aura")) {
      return new Response(aura, { status: auraStatus });
    }
    return new Response(page, { status: 200 });
  };
  return { impl, calls };
}

test("LITWIN_FIELD_ID matches the frontend encodeId for the EXTERNAL_ORGS entry", () => {
  assert.equal(LITWIN_FIELD_ID, encodeFieldId("Asphalt Green Litwin Field|MANHATTAN"));
  assert.equal(LITWIN_FIELD_ID, "QXNwaGFsdCBHcmVlbiBMaXR3aW4gRmllbGR8TUFOSEFUVEFO");
});

test("toNewYorkParts converts UTC to New York local date and 24h time", () => {
  assert.deepEqual(toNewYorkParts("2026-09-30T10:00:00.000Z"), { date: "2026-09-30", time: "06:00" });
  // After DST ends (Nov 1, 2026) the offset is -5.
  assert.deepEqual(toNewYorkParts("2026-11-02T11:00:00.000Z"), { date: "2026-11-02", time: "06:00" });
  // Late-evening UTC-date rollover stays on the local date.
  assert.deepEqual(toNewYorkParts("2026-10-01T02:30:00.000Z"), { date: "2026-09-30", time: "22:30" });
});

test("toPermitRows maps public-hours windows to sorted cache rows and drops other functions", () => {
  const rows = toPermitRows(
    [BOOKINGS[1], { ...BOOKINGS[0], functionName: "Rental" }, BOOKINGS[0]],
    "fid"
  );
  assert.deepEqual(rows, [
    { field_id: "fid", permit_date: "2026-09-30", start_time: "06:00", end_time: "08:00", event_name: "Open to public" },
    { field_id: "fid", permit_date: "2026-10-03", start_time: "06:00", end_time: "09:00", event_name: "Open to public" },
  ]);
});

test("parseAuraContext reads fwuid and app version from URL-encoded bootstrap markup", () => {
  const html = `<script src="/s/sfsites/l/${encodeURIComponent('{"mode":"PROD","fwuid":"FW123","loaded":{"APPLICATION@markup://siteforce:communityApp":"APP9"}}')}/app.js"></script>`;
  assert.deepEqual(parseAuraContext(html), { fwuid: "FW123", appVersion: "APP9" });
  assert.deepEqual(parseAuraContext("<html>nothing</html>"), { fwuid: null, appVersion: null });
});

test("parseAuraResponse strips the */ guard and throws on a non-SUCCESS action", () => {
  assert.equal(parseAuraResponse("*/" + auraOk(BOOKINGS)).length, 2);
  assert.throws(
    () => parseAuraResponse(JSON.stringify({ actions: [{ state: "ERROR", error: [{ message: "boom" }] }] })),
    /boom/
  );
});

test("runAsphaltGreenSync writes future windows and marks the field as public_hours", async () => {
  const { db, tables } = createFakeD1();
  const { impl, calls } = fakeFetch({ page: '"fwuid":"LIVEFW"' });
  const summary = await runAsphaltGreenSync({ DB: db }, { fetchImpl: impl, now: new Date("2026-09-30T14:00:00Z") });

  assert.deepEqual(summary, { ok: true, fieldId: LITWIN_FIELD_ID, windows: 2, through: "2026-10-03" });
  assert.equal(tables.field_permit_cache.length, 2);
  assert.ok(tables.field_permit_cache.every((r) => r.field_id === LITWIN_FIELD_ID && r.event_name === "Open to public"));
  assert.equal(tables.field_sync_meta[0].live_availability_status, "public_hours");
  // The scraped fwuid is what gets sent, not the fallback.
  const auraBody = new URLSearchParams(String(calls[1].init.body));
  assert.equal(JSON.parse(auraBody.get("aura.context")).fwuid, "LIVEFW");
  assert.match(auraBody.get("message"), /Litwin Field - Full Field/);
});

test("runAsphaltGreenSync keeps existing rows and reports failure when AG returns no windows", async () => {
  const { db, tables } = createFakeD1();
  tables.field_permit_cache.push({ field_id: LITWIN_FIELD_ID, permit_date: "2026-10-01", start_time: "06:00", end_time: "07:00", event_name: "Open to public" });
  const { impl } = fakeFetch({ aura: auraOk([]) });
  const summary = await runAsphaltGreenSync({ DB: db }, { fetchImpl: impl, now: new Date("2026-09-30T14:00:00Z") });

  assert.equal(summary.ok, false);
  assert.equal(summary.reason, "no_public_hours_returned");
  assert.equal(tables.field_permit_cache.length, 1);
});

test("runAsphaltGreenSync never throws on an HTTP error — returns ok:false with a reason", async () => {
  const { db } = createFakeD1();
  const { impl } = fakeFetch({ auraStatus: 503 });
  const summary = await runAsphaltGreenSync({ DB: db }, { fetchImpl: impl });
  assert.equal(summary.ok, false);
  assert.match(summary.reason, /503/);
});
