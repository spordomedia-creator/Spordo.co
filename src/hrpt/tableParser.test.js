import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHrptScheduleTables, headerDateToIso } from "./tableParser.js";

// Real markup captured from hudsonriverpark.org on 2026-10-07 (see the fixture's header comment).
const HTML = readFileSync(new URL("./__fixtures__/weekly-tables-2026-10.html", import.meta.url), "utf8");
const REF = new Date("2026-10-07T13:00:00Z");

const blocks = (field, date) =>
  field.rows.filter((r) => r.permit_date === date).map((r) => `${r.start_time.slice(0, 5)}-${r.end_time.slice(0, 5)}`);

test("finds each field table by its heading image alt and skips non-field tables", () => {
  const { fields, anomalies } = parseHrptScheduleTables(HTML, { referenceDate: REF });
  assert.deepEqual(fields.map((f) => f.fieldNameOnPage), ["Pier 26 Sports Court", "Gansevoort Peninsula Athletic Field"]);
  assert.deepEqual(anomalies, []);
  assert.equal(fields[0].minDate, "2026-10-04");
  assert.equal(fields[0].maxDate, "2026-10-11");
});

test("pairs start/end labels into exact ranges, including half-hours and several blocks a day", () => {
  const [pier26] = parseHrptScheduleTables(HTML, { referenceDate: REF }).fields;
  assert.deepEqual(blocks(pier26, "2026-10-06"), ["09:30-11:30", "18:00-21:00"]);
  assert.deepEqual(blocks(pier26, "2026-10-07"), ["09:00-12:00", "16:00-17:30", "18:00-19:30"]);
  assert.deepEqual(blocks(pier26, "2026-10-09"), ["16:00-17:30"]);
});

test("a block ending at 12:00 AM is stored as 24:00, not 00:00", () => {
  const gansevoort = parseHrptScheduleTables(HTML, { referenceDate: REF }).fields[1];
  assert.deepEqual(blocks(gansevoort, "2026-10-05"), ["15:00-24:00"]);
  assert.deepEqual(blocks(gansevoort, "2026-10-09"), ["07:00-09:00", "11:00-14:00", "14:30-24:00"]);
});

test("shaded cells with no label still become a block (and are reported)", () => {
  const html = `<table><thead><tr><th colspan="9"><img alt="Pier 25 Turf Field"></th></tr>
    <tr><th>Time</th>${["10/4", "10/5", "10/6", "10/7", "10/8", "10/9", "10/10", "10/11"].map((d) => `<th>Day<br>${d}</th>`).join("")}</tr></thead>
    <tbody>
      <tr><td>6:00 PM</td><td class="permitted-second-half">&nbsp;</td>${"<td></td>".repeat(7)}</tr>
      <tr><td>7:00 PM</td><td class="permitted">&nbsp;</td>${"<td></td>".repeat(7)}</tr>
    </tbody></table>`;
  const { fields, anomalies } = parseHrptScheduleTables(html, { referenceDate: REF });
  assert.deepEqual(blocks(fields[0], "2026-10-04"), ["18:30-20:00"]);
  assert.match(anomalies[0], /had no label; added from cell shading/);
});

test("header dates resolve to the year nearest the run date (Dec run, Jan columns)", () => {
  assert.equal(headerDateToIso("Sun 1/3", new Date("2026-12-30T12:00:00Z")), "2027-01-03");
  assert.equal(headerDateToIso("Wed 12/30", new Date("2027-01-02T12:00:00Z")), "2026-12-30");
});
