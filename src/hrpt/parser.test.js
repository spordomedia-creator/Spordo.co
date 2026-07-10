import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseHrptPermitsHtml } from "./parser.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rowspanHtml = readFileSync(path.join(__dirname, "__fixtures__/rowspan-pattern.html"), "utf8");
const repeatedHtml = readFileSync(path.join(__dirname, "__fixtures__/repeated-cell-pattern.html"), "utf8");

const REFERENCE_DATE = new Date("2026-06-25T12:00:00Z");

test("rowspan and repeated-cell fixtures parse to identical normalized rows", () => {
  const rowspanResult = parseHrptPermitsHtml(rowspanHtml, { referenceDate: REFERENCE_DATE });
  const repeatedResult = parseHrptPermitsHtml(repeatedHtml, { referenceDate: REFERENCE_DATE });

  assert.deepEqual(rowspanResult.rows, repeatedResult.rows);
});

test("produces the expected two booked ranges for Pier 25, using the page's anchor year", () => {
  const { rows } = parseHrptPermitsHtml(rowspanHtml, { referenceDate: REFERENCE_DATE });
  const pier25Rows = rows.filter((r) => r.field_name_on_page === "Pier 25 Artificial Turf Field");

  assert.equal(pier25Rows.length, 2);

  const jun28 = pier25Rows.find((r) => r.permit_date === "2026-06-28");
  assert.ok(jun28, "expected a booked row on 2026-06-28");
  assert.equal(jun28.start_time, "10:00:00");
  assert.equal(jun28.end_time, "11:00:00");
  // Explicit visible label agreed with row-derived bounds, so it's used
  // as the event_name remainder (empty string here since the whole label
  // was the time range with nothing left over) -> null.
  assert.equal(jun28.event_name, null);

  const jun29 = pier25Rows.find((r) => r.permit_date === "2026-06-29");
  assert.ok(jun29, "expected a booked row on 2026-06-29");
  assert.equal(jun29.start_time, "10:30:00");
  // No explicit label and the run reaches the bottom of the table -> end
  // time is inferred from the last booked row's time + the inferred
  // 30-minute slot interval.
  assert.equal(jun29.end_time, "12:00:00");
});

test("a field with zero booked slots still gets a resolvable date window (all-available result)", () => {
  const { rows, fieldsFound } = parseHrptPermitsHtml(rowspanHtml, { referenceDate: REFERENCE_DATE });
  const gansevoort = fieldsFound.find((f) => f.fieldNameOnPage === "Gansevoort Peninsula Athletic Field");
  assert.ok(gansevoort);
  assert.equal(gansevoort.bookedSlotCount, 0);
  assert.ok(gansevoort.dateWindow);
  assert.equal(gansevoort.dateWindow.minDate, "2026-06-28");
  assert.equal(gansevoort.dateWindow.maxDate, "2026-06-29");
  assert.equal(rows.some((r) => r.field_name_on_page === "Gansevoort Peninsula Athletic Field"), false);
});

test("a block with no discoverable heading is skipped, not guessed, and logged as an anomaly", () => {
  const { fieldsFound, anomalies } = parseHrptPermitsHtml(rowspanHtml, { referenceDate: REFERENCE_DATE });
  assert.equal(fieldsFound.some((f) => f.fieldNameOnPage === null), false);
  assert.ok(anomalies.some((a) => a.includes("mystery") && a.includes("no heading")));
});
