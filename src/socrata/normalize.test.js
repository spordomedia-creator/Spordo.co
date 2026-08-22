import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePermitRow, normalizeRows } from "./normalize.js";

test("normalizePermitRow keeps a well-formed row, tagging it with the sport it was fetched under", () => {
  const raw = {
    event_location: "Pier 40 Soccer Complex",
    event_borough: "MANHATTAN",
    start_date_time: "2026-08-22T09:00:00.000",
    end_date_time: "2026-08-22T11:00:00.000",
    event_name: "Adult Soccer League",
    event_type: "Adult",
    permit_holder_name: "Jane Doe",
    organization: "NYC Soccer League",
  };
  const result = normalizePermitRow(raw, "soccer");
  assert.equal(result.dropped, undefined);
  assert.deepEqual(result.row, {
    source: "socrata",
    sport: "soccer",
    event_location: "Pier 40 Soccer Complex",
    event_borough: "MANHATTAN",
    start_date_time: "2026-08-22T09:00:00.000",
    end_date_time: "2026-08-22T11:00:00.000",
    event_name: "Adult Soccer League",
    event_type: "Adult",
    permit_holder_name: "Jane Doe",
    organization: "NYC Soccer League",
  });
});

test("normalizePermitRow drops a row missing start_date_time, with a stated reason", () => {
  const result = normalizePermitRow({ event_location: "Some Field" }, "soccer");
  assert.equal(result.dropped, true);
  assert.match(result.reason, /start_date_time/);
});

test("normalizePermitRow drops a row whose start_date_time is only whitespace", () => {
  const result = normalizePermitRow({ event_location: "Some Field", start_date_time: "   " }, "soccer");
  assert.equal(result.dropped, true);
});

test("normalizePermitRow falls back event_location to a default (matches the frontend's own fallback), not a drop", () => {
  const result = normalizePermitRow({ start_date_time: "2026-08-22T09:00:00.000" }, "soccer");
  assert.equal(result.dropped, undefined);
  assert.equal(result.row.event_location, "NYC Parks Field");
});

test("normalizePermitRow trims strings and nulls out empty-after-trim fields", () => {
  const result = normalizePermitRow({ start_date_time: "2026-08-22T09:00:00.000", event_name: "   ", organization: "  NYC Parks  " }, "soccer");
  assert.equal(result.row.event_name, null);
  assert.equal(result.row.organization, "NYC Parks");
});

test("normalizeRows separates kept rows from drops and preserves order/count", () => {
  const raw = [
    { event_location: "A", start_date_time: "2026-08-22T09:00:00.000" },
    { event_location: "B" }, // dropped: no start_date_time
    { event_location: "C", start_date_time: "2026-08-23T09:00:00.000" },
  ];
  const { rows, drops } = normalizeRows(raw, "soccer");
  assert.equal(rows.length, 2);
  assert.equal(drops.length, 1);
  assert.equal(rows[0].event_location, "A");
  assert.equal(rows[1].event_location, "C");
  assert.match(drops[0], /start_date_time/);
});
