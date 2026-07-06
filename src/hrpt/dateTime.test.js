import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findAnchorYearInPage,
  parseColumnDate,
  parseTimeLabel,
  formatTime,
  parseExplicitRangeLabel,
  inferSlotIntervalMinutes,
} from "./dateTime.js";

test("findAnchorYearInPage extracts the year from a range heading", () => {
  assert.equal(findAnchorYearInPage("<h1>June 28 &ndash; July 5, 2026</h1>"), 2026);
  assert.equal(findAnchorYearInPage("<h1>no dates here</h1>"), null);
});

test("parseColumnDate handles 'Month D' with an anchor year", () => {
  assert.equal(parseColumnDate("Jun 28", { anchorYear: 2026 }), "2026-06-28");
  assert.equal(parseColumnDate("June 28", { anchorYear: 2026 }), "2026-06-28");
});

test("parseColumnDate handles explicit year in the header itself", () => {
  assert.equal(parseColumnDate("June 28, 2026"), "2026-06-28");
  assert.equal(parseColumnDate("6/28/2026"), "2026-06-28");
});

test("parseColumnDate falls back to referenceDate's year and rolls Dec->Jan", () => {
  const referenceDate = new Date("2026-12-29T00:00:00Z");
  assert.equal(parseColumnDate("Jan 2", { referenceDate }), "2027-01-02");
  assert.equal(parseColumnDate("Dec 30", { referenceDate }), "2026-12-30");
});

test("parseColumnDate returns null for unparseable headers instead of guessing", () => {
  assert.equal(parseColumnDate("Someday"), null);
  assert.equal(parseColumnDate(""), null);
});

test("parseTimeLabel parses 12h clock labels", () => {
  assert.equal(parseTimeLabel("10:00 AM"), 600);
  assert.equal(parseTimeLabel("12:00 PM"), 720);
  assert.equal(parseTimeLabel("12:30 AM"), 30);
  assert.equal(parseTimeLabel("3:30pm"), 15 * 60 + 30);
  assert.equal(parseTimeLabel("not a time"), null);
});

test("formatTime renders 24h HH:MM:00", () => {
  assert.equal(formatTime(600), "10:00:00");
  assert.equal(formatTime(720), "12:00:00");
  assert.equal(formatTime(30), "00:30:00");
});

test("parseExplicitRangeLabel parses a full range and inherits the period when omitted", () => {
  const full = parseExplicitRangeLabel("3:30 PM–6:00 PM");
  assert.equal(full.startMinutes, 15 * 60 + 30);
  assert.equal(full.endMinutes, 18 * 60);

  const shorthand = parseExplicitRangeLabel("3:30–6:00 PM");
  assert.equal(shorthand.startMinutes, 15 * 60 + 30);
  assert.equal(shorthand.endMinutes, 18 * 60);
});

test("parseExplicitRangeLabel returns null for non-range text", () => {
  assert.equal(parseExplicitRangeLabel("Private Event"), null);
  assert.equal(parseExplicitRangeLabel(""), null);
});

test("inferSlotIntervalMinutes finds the minimum positive gap", () => {
  assert.equal(inferSlotIntervalMinutes([540, 570, 600, 630]), 30);
  assert.equal(inferSlotIntervalMinutes([540]), null);
  assert.equal(inferSlotIntervalMinutes([]), null);
});
