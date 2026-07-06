/**
 * Turns a single <table>...</table> HTML fragment into a dense, rectangular
 * grid of cells: one row per time slot, one column per day.
 *
 * HRPT's page renders a visually-merged colored block for a run of booked
 * time slots. We don't know (haven't fetched the real HTML yet) whether the
 * underlying markup expresses that merge via `rowspan` on a single <td>, or
 * via literal repetition of `class="permitted"` on each un-labeled adjacent
 * <td>. This module normalizes BOTH into the same dense grid using the
 * standard rowspan-expansion algorithm:
 *
 *   - Walking rows top-to-bottom, each column tracks a "pending" fill left
 *     over from an earlier row's rowspan. While a column has pending fill
 *     remaining, subsequent rows do NOT consume a literal <td> for that
 *     column (per HTML's own rowspan semantics: the spanned rows simply omit
 *     the cell).
 *   - If a row's cell for a given column has no pending fill, the next
 *     unconsumed <td> in that row is used; if it declares `rowspan="N"`
 *     with N > 1, that status is queued as "pending" for the next N-1 rows.
 *   - If the real markup instead just repeats `class="permitted"` on
 *     literal adjacent <td>s (no rowspan at all), every row simply supplies
 *     its own <td> for that column and the grid ends up with the same
 *     "booked" status repeated down the column — no special-casing needed.
 *
 * Both patterns therefore converge on an identical dense grid, and the
 * downstream range-grouping logic (dateTime.js) only has to deal with one
 * representation.
 */

import { extractElements, getAttr, hasClass, textContent } from "./htmlUtils.js";

/**
 * @typedef {Object} GridCell
 * @property {'available'|'booked'} status
 * @property {string} text raw (stripped) text content of the cell, e.g. a
 *   time-range label like "3:30 PM–6:00 PM", or "" if empty.
 */

/**
 * @typedef {Object} TableGrid
 * @property {string[]} columnHeaders raw header text per day column (index
 *   0 = first day column; the header row's own leading "corner" cell is
 *   excluded).
 * @property {string[]} rowLabels raw first-cell text per body row (e.g.
 *   "10:00 AM").
 * @property {GridCell[][]} grid grid[rowIndex][colIndex]
 * @property {string[]} anomalies human-readable parse anomalies encountered
 *   while building this specific table's grid (row/column count mismatches,
 *   unterminated rows, etc).
 */

/**
 * @param {string} tableHtml the inner or outer HTML of a single <table>.
 * @returns {TableGrid}
 */
function parseTableToGrid(tableHtml) {
  const anomalies = [];
  const rows = extractElements(tableHtml, "tr");

  if (rows.length === 0) {
    return { columnHeaders: [], rowLabels: [], grid: [], anomalies: ["table has no <tr> rows"] };
  }

  const rowCells = rows.map((row) => extractCells(row.innerHTML));

  const [headerRow, ...bodyRows] = rowCells;
  // The header row's first cell is the sticky "corner" (blank or a label
  // like "Time"); the remaining cells are the day-column headers.
  const columnHeaders = headerRow.slice(1).map((c) => c.text);
  const nCols = columnHeaders.length;

  if (nCols === 0) {
    anomalies.push("header row did not yield any day columns (expected corner cell + >=1 date cell)");
  }

  const rowLabels = [];
  const grid = [];
  // pending[col] = { remaining, status, text } | null
  const pending = new Array(nCols).fill(null);

  bodyRows.forEach((cells, rowIdx) => {
    if (cells.length === 0) {
      anomalies.push(`body row ${rowIdx} has no cells; skipped`);
      rowLabels.push(null);
      grid.push(new Array(nCols).fill({ status: "available", text: "" }));
      return;
    }

    const [labelCell, ...dataCells] = cells;
    rowLabels.push(labelCell.text);

    const gridRow = new Array(nCols);
    let dataIdx = 0;
    for (let col = 0; col < nCols; col++) {
      const p = pending[col];
      if (p && p.remaining > 0) {
        gridRow[col] = { status: p.status, text: p.text };
        p.remaining -= 1;
        if (p.remaining === 0) pending[col] = null;
        continue;
      }

      const cell = dataCells[dataIdx];
      dataIdx += 1;
      if (!cell) {
        // Fewer <td>s than expected columns for this row and no pending
        // rowspan explains the gap: log and treat as available rather than
        // guessing.
        anomalies.push(`body row ${rowIdx} ("${labelCell.text}") ran out of cells at column ${col}`);
        gridRow[col] = { status: "available", text: "" };
        continue;
      }

      const status = hasClass(cell.attrs, "permitted") ? "booked" : "available";
      const rowspan = parseInt(getAttr(cell.attrs, "rowspan") || "1", 10) || 1;
      gridRow[col] = { status, text: cell.text };
      if (rowspan > 1) {
        pending[col] = { remaining: rowspan - 1, status, text: cell.text };
      }
    }

    if (dataIdx < dataCells.length) {
      anomalies.push(
        `body row ${rowIdx} ("${labelCell.text}") has ${dataCells.length - dataIdx} extra <td>(s) beyond the ${nCols} known day columns`
      );
    }

    grid.push(gridRow);
  });

  return { columnHeaders, rowLabels, grid, anomalies };
}

/** Extract <td>/<th> cells (in order) from a single <tr>'s innerHTML. */
function extractCells(rowInnerHtml) {
  const tds = extractElements(rowInnerHtml, "td");
  const ths = extractElements(rowInnerHtml, "th");
  // Merge by position so a header row of <th>s (or a mixed row) still works.
  const all = [...tds, ...ths].sort((a, b) => a.start - b.start);
  return all.map((el) => ({ attrs: el.attrs, text: textContent(el.innerHTML) }));
}

export { parseTableToGrid };
