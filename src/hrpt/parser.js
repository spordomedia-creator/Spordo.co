/**
 * Top-level HRPT permits-page parser: HTML in, normalized permit rows out.
 *
 * Output rows are keyed by `field_name_on_page` (the raw name as found on
 * hudsonriverpark.org) — mapping that to SPORDO's internal `field_id` is a
 * separate concern (see fieldMap.js), kept deliberately decoupled so it's
 * trivial to update as HRPT field names in FIELD_DATABASE get corrected on
 * another branch.
 *
 * IMPORTANT: this parser has been validated only against synthetic fixture
 * HTML modeling the two plausible merged-cell patterns described from
 * DevTools inspection (rowspan vs. repeated `class="permitted"`). It has
 * NOT yet been run against a real fetch of hudsonriverpark.org (this
 * sandbox cannot reach that host). Treat its real-world accuracy as
 * unverified until confirmed against a live fetch.
 */

import { findFieldTableBlocks } from "./fieldBlocks.js";
import { parseTableToGrid } from "./tableGrid.js";
import {
  findAnchorYearInPage,
  parseColumnDate,
  parseTimeLabel,
  formatTime,
  parseExplicitRangeLabel,
  isBareTimeFragment,
  inferSlotIntervalMinutes,
} from "./dateTime.js";

/**
 * @typedef {Object} ParsedPermitRow
 * @property {string} field_name_on_page
 * @property {string} permit_date  "YYYY-MM-DD"
 * @property {string} start_time   "HH:MM:00"
 * @property {string} end_time     "HH:MM:00"
 * @property {string|null} event_name
 */

/**
 * @typedef {Object} ParsedField
 * @property {string|null} fieldNameOnPage
 * @property {number} bookedSlotCount
 */

/**
 * @param {string} html full HRPT permits page HTML.
 * @param {{ referenceDate?: Date }} [opts]
 * @returns {{
 *   rows: ParsedPermitRow[],
 *   fieldsFound: ParsedField[],
 *   anomalies: string[],
 * }}
 */
function parseHrptPermitsHtml(html, opts = {}) {
  const referenceDate = opts.referenceDate || new Date();
  const anomalies = [];

  const { blocks, anomalies: blockAnomalies } = findFieldTableBlocks(html);
  anomalies.push(...blockAnomalies);

  const anchorYear = findAnchorYearInPage(html);

  const rows = [];
  const fieldsFound = [];

  for (const block of blocks) {
    if (!block.fieldNameOnPage || !block.tableHtml) {
      // Already logged in findFieldTableBlocks; nothing more to do for a
      // block we can't attribute to a field.
      continue;
    }

    const { columnHeaders, rowLabels, grid, anomalies: gridAnomalies } = parseTableToGrid(block.tableHtml);
    for (const a of gridAnomalies) {
      anomalies.push(`[${block.fieldNameOnPage}] ${a}`);
    }

    if (grid.length === 0 || columnHeaders.length === 0) {
      anomalies.push(`[${block.fieldNameOnPage}] table produced an empty grid; skipping`);
      continue;
    }

    const columnDates = columnHeaders.map((h) => {
      const iso = parseColumnDate(h, { anchorYear, referenceDate });
      if (!iso) anomalies.push(`[${block.fieldNameOnPage}] could not parse date from column header "${h}"; column skipped`);
      return iso;
    });

    const parsedRowTimes = rowLabels.map((l) => (l ? parseTimeLabel(l) : null));
    rowLabels.forEach((l, idx) => {
      if (l && parsedRowTimes[idx] == null) {
        anomalies.push(`[${block.fieldNameOnPage}] could not parse time from row label "${l}"`);
      }
    });
    const sortedValidTimes = parsedRowTimes.filter((t) => t != null).sort((a, b) => a - b);
    const interval = inferSlotIntervalMinutes(sortedValidTimes) || 30;

    let bookedSlotCount = 0;

    for (let col = 0; col < columnDates.length; col++) {
      const date = columnDates[col];
      if (!date) continue;

      let runStart = null;
      for (let row = 0; row <= grid.length; row++) {
        const cell = row < grid.length ? grid[row][col] : null;
        const isBooked = !!cell && cell.status === "booked";

        if (isBooked && runStart === null) {
          runStart = row;
        } else if (!isBooked && runStart !== null) {
          const emitted = emitRun({
            fieldNameOnPage: block.fieldNameOnPage,
            date,
            grid,
            col,
            startRow: runStart,
            endRowExclusive: row,
            parsedRowTimes,
            rowLabels,
            interval,
            anomalies,
          });
          if (emitted) {
            rows.push(emitted);
            bookedSlotCount += 1;
          }
          runStart = null;
        }
      }
    }

    const validDates = columnDates.filter(Boolean).sort();
    const dateWindow = validDates.length > 0 ? { minDate: validDates[0], maxDate: validDates[validDates.length - 1] } : null;
    if (!dateWindow) {
      anomalies.push(`[${block.fieldNameOnPage}] no day column parsed to a valid date; this field's cache will NOT be touched this run`);
    }

    fieldsFound.push({ fieldNameOnPage: block.fieldNameOnPage, bookedSlotCount, dateWindow });
  }

  return { rows, fieldsFound, anomalies };
}

function emitRun({ fieldNameOnPage, date, grid, col, startRow, endRowExclusive, parsedRowTimes, rowLabels, interval, anomalies }) {
  const startMinutes = parsedRowTimes[startRow];
  if (startMinutes == null) {
    anomalies.push(
      `[${fieldNameOnPage}] dropped a booked run on ${date} starting at row ${startRow} — row label "${rowLabels[startRow]}" did not parse to a time`
    );
    return null;
  }

  let endMinutes = null;
  if (endRowExclusive < parsedRowTimes.length && parsedRowTimes[endRowExclusive] != null) {
    endMinutes = parsedRowTimes[endRowExclusive];
  } else {
    const lastRowMinutes = parsedRowTimes[endRowExclusive - 1];
    if (lastRowMinutes != null) endMinutes = lastRowMinutes + interval;
  }

  if (endMinutes == null) {
    anomalies.push(
      `[${fieldNameOnPage}] dropped a booked run on ${date} (rows ${startRow}-${endRowExclusive - 1}) — could not determine an end time`
    );
    return null;
  }

  // Prefer an explicit visible label (e.g. "3:30 PM–6:00 PM") when present
  // and consistent with the row-derived bounds (within one slot interval),
  // since it may be more precise than the grid's own granularity. Row
  // positions remain the source of truth otherwise.
  let eventName = null;
  for (let row = startRow; row < endRowExclusive; row++) {
    const text = grid[row][col]?.text;
    if (!text) continue;
    const explicit = parseExplicitRangeLabel(text);
    if (explicit) {
      const startOk = Math.abs(explicit.startMinutes - startMinutes) <= interval;
      const endOk = Math.abs(explicit.endMinutes - endMinutes) <= interval;
      if (startOk && endOk) {
        eventName = explicit.remainder || null;
        return {
          field_name_on_page: fieldNameOnPage,
          permit_date: date,
          start_time: formatTime(explicit.startMinutes),
          end_time: formatTime(explicit.endMinutes),
          event_name: eventName,
        };
      }
      anomalies.push(
        `[${fieldNameOnPage}] label "${text}" on ${date} disagreed with row-derived bounds (row-derived ${formatTime(startMinutes)}-${formatTime(
          endMinutes
        )}); used row-derived bounds instead`
      );
    } else if (!eventName && !isBareTimeFragment(text)) {
      // A cell whose only text is a bare time (e.g. "9:00 AM–") isn't a
      // real event label — it's just the block's own start time echoed
      // back, conveying nothing the row position doesn't already give us.
      // Leaving eventName null here (not logged as an anomaly: this is a
      // routine, expected shape, not a fault) lets it fall through to the
      // `event_name: eventName || null` default below.
      eventName = text;
    }
    break;
  }

  return {
    field_name_on_page: fieldNameOnPage,
    permit_date: date,
    start_time: formatTime(startMinutes),
    end_time: formatTime(endMinutes),
    event_name: eventName || null,
  };
}

export { parseHrptPermitsHtml };
