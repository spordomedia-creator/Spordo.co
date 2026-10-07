import { test } from "node:test";
import assert from "node:assert/strict";
import { nycDateIso, nycHour, addDaysIso } from "./nycTime.js";

test("nycDateIso is still today in New York after 8pm ET, when the UTC date has already rolled over", () => {
  const evening = new Date("2026-10-08T00:30:00Z"); // 8:30pm EDT on Oct 7
  assert.equal(evening.toISOString().split("T")[0], "2026-10-08"); // the old, wrong answer
  assert.equal(nycDateIso(evening), "2026-10-07");
  assert.equal(nycHour(evening), 20);
});

test("nycDateIso / nycHour follow EST in winter (UTC-5)", () => {
  const winterEvening = new Date("2026-12-15T00:30:00Z"); // 7:30pm EST on Dec 14
  assert.equal(nycDateIso(winterEvening), "2026-12-14");
  assert.equal(nycHour(winterEvening), 19);
});

test("nycHour reports midnight as 0, not 24", () => {
  assert.equal(nycHour(new Date("2026-10-07T04:00:00Z")), 0); // 00:00 EDT
  assert.equal(nycDateIso(new Date("2026-10-07T04:00:00Z")), "2026-10-07");
});

test("nycDateIso does not depend on the machine's own time zone", () => {
  // Fixed instants, so this holds whatever TZ the test process runs in.
  assert.equal(nycDateIso(new Date("2026-10-07T03:59:59Z")), "2026-10-06");
  assert.equal(nycDateIso(new Date("2026-10-07T04:00:00Z")), "2026-10-07");
});

test("addDaysIso does plain calendar math across month, year and DST boundaries", () => {
  assert.equal(addDaysIso("2026-10-07", 90), "2027-01-05");
  assert.equal(addDaysIso("2026-10-31", 1), "2026-11-01");
  assert.equal(addDaysIso("2026-11-01", 1), "2026-11-02"); // DST ends Nov 1
  assert.equal(addDaysIso("2027-01-01", -1), "2026-12-31");
  assert.equal(addDaysIso("2026-10-07", 0), "2026-10-07");
});
