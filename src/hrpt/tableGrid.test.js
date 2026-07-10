import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTableToGrid } from "./tableGrid.js";

const ROWSPAN_TABLE = `
  <table>
    <tbody>
      <tr><td></td><td>Jun 28</td><td>Jun 29</td></tr>
      <tr><td>9:00 AM</td><td></td><td></td></tr>
      <tr><td>9:30 AM</td><td></td><td></td></tr>
      <tr><td>10:00 AM</td><td rowspan="2" class="permitted">10:00 AM&ndash;11:00 AM</td><td></td></tr>
      <tr><td>10:30 AM</td><td rowspan="3" class="permitted"></td></tr>
      <tr><td>11:00 AM</td><td></td></tr>
      <tr><td>11:30 AM</td><td></td></tr>
    </tbody>
  </table>
`;

const REPEATED_TABLE = `
  <table>
    <tbody>
      <tr><td></td><td>Jun 28</td><td>Jun 29</td></tr>
      <tr><td>9:00 AM</td><td></td><td></td></tr>
      <tr><td>9:30 AM</td><td></td><td></td></tr>
      <tr><td>10:00 AM</td><td class="permitted">10:00 AM&ndash;11:00 AM</td><td></td></tr>
      <tr><td>10:30 AM</td><td class="permitted"></td><td class="permitted"></td></tr>
      <tr><td>11:00 AM</td><td></td><td class="permitted"></td></tr>
      <tr><td>11:30 AM</td><td></td><td class="permitted"></td></tr>
    </tbody>
  </table>
`;

function statusGrid(grid) {
  return grid.map((row) => row.map((c) => c.status));
}

test("rowspan pattern expands to the expected dense grid", () => {
  const { columnHeaders, rowLabels, grid, anomalies } = parseTableToGrid(ROWSPAN_TABLE);
  assert.deepEqual(columnHeaders, ["Jun 28", "Jun 29"]);
  assert.deepEqual(rowLabels, ["9:00 AM", "9:30 AM", "10:00 AM", "10:30 AM", "11:00 AM", "11:30 AM"]);
  assert.deepEqual(anomalies, []);
  assert.deepEqual(statusGrid(grid), [
    ["available", "available"],
    ["available", "available"],
    ["booked", "available"],
    ["booked", "booked"],
    ["available", "booked"],
    ["available", "booked"],
  ]);
  // The visible label only lives on the rowspan-owning cell.
  assert.equal(grid[2][0].text, "10:00 AM–11:00 AM");
  assert.equal(grid[3][0].text, "10:00 AM–11:00 AM"); // carried down by expansion
});

test("repeated-class pattern expands to the SAME dense grid as rowspan", () => {
  const rowspanResult = parseTableToGrid(ROWSPAN_TABLE);
  const repeatedResult = parseTableToGrid(REPEATED_TABLE);
  assert.deepEqual(statusGrid(repeatedResult.grid), statusGrid(rowspanResult.grid));
  assert.deepEqual(repeatedResult.rowLabels, rowspanResult.rowLabels);
  assert.deepEqual(repeatedResult.columnHeaders, rowspanResult.columnHeaders);
});

const BANNER_PLUS_HEADER_TABLE = `
  <table>
    <thead>
      <tr><th colspan="3"><img src="heading.png" alt="Pier 25 Turf Field" /></th></tr>
      <tr><th>Time</th><th>Sun<br /> 7/5</th><th>Mon<br /> 7/6</th></tr>
    </thead>
    <tbody>
      <tr><td>6:00 AM</td><td></td><td></td></tr>
      <tr><td>7:00 AM</td><td class="permitted">League A</td><td></td></tr>
    </tbody>
  </table>
`;

test("a full-width <th colspan> banner row ahead of the real <th> header row is skipped, not mistaken for the header", () => {
  const { columnHeaders, rowLabels, grid, anomalies } = parseTableToGrid(BANNER_PLUS_HEADER_TABLE);
  assert.deepEqual(columnHeaders, ["Sun 7/5", "Mon 7/6"]);
  assert.deepEqual(rowLabels, ["6:00 AM", "7:00 AM"]);
  assert.deepEqual(anomalies, []);
  assert.deepEqual(statusGrid(grid), [
    ["available", "available"],
    ["booked", "available"],
  ]);
});

test("logs an anomaly (not a throw) when a row has fewer cells than expected", () => {
  const html = `
    <table>
      <tbody>
        <tr><td></td><td>Jun 28</td><td>Jun 29</td></tr>
        <tr><td>9:00 AM</td><td></td></tr>
      </tbody>
    </table>
  `;
  const { grid, anomalies } = parseTableToGrid(html);
  assert.equal(grid[0][1].status, "available");
  assert.ok(anomalies.some((a) => a.includes("ran out of cells")));
});
