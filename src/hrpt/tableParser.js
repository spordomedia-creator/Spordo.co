/**
 * Parser for HRPT's weekly HTML schedule tables (the format HRPT went back to
 * in late Sep 2026, after a few months of JPG graphics — see imageSource.js).
 *
 * One <table> per field:
 *   - <thead> row 1: <th colspan="9"><img alt="Pier 40 Courtyard East">  (the field name)
 *   - <thead> row 2: Time | Sun<br>10/4 | Mon<br>10/5 | … | Sun<br>10/11  (8 day columns)
 *   - <tbody>: one row per hour (6:00 AM … 11:00 PM). Booked cells carry class
 *     "permitted" (whole hour), "permitted-first-half" (:00–:30) or
 *     "permitted-second-half" (:30–:00).
 *   - Each booking also has explicit text labels: a start ("7:00 AM–") and an
 *     end ("8:30 AM"), usually in two consecutive cells placed MID-block, not
 *     on the block's first row — so a label's row says nothing about its time.
 *
 * Strategy per day column: pair the labels top-to-bottom into exact ranges
 * (start "X–" + next end "Y"). The cell shading is the backstop: any booked
 * half-hour no label range covers becomes its own block (logged as an
 * anomaly), so an unlabeled booking is never silently dropped. Labels win
 * where both exist because shading alone merges back-to-back bookings.
 *
 * Captured fixture: __fixtures__/weekly-tables-2026-10.html.
 */

import { extractElements, getAttr, hasClass, textContent } from "./htmlUtils.js";
import { parseTimeLabel, formatTime } from "./dateTime.js";

const SLOT = 30; // minutes — the finest granularity the shading encodes
const RANGE_RE = /(\d{1,2}(?::\d{2})?\s*[AaPp][Mm])\s*[–—-]\s*(\d{1,2}(?::\d{2})?\s*[AaPp][Mm])/;
const START_RE = /(\d{1,2}(?::\d{2})?\s*[AaPp][Mm])\s*[–—-]\s*$/;
const TIME_ONLY_RE = /^\s*(\d{1,2}(?::\d{2})?\s*[AaPp][Mm])\s*$/;

/** "Sun 10/4" -> "2026-10-04", picking the year that puts the date closest to `referenceDate`. */
function headerDateToIso(text, referenceDate) {
  const m = /(\d{1,2})\s*\/\s*(\d{1,2})/.exec(text || "");
  if (!m) return null;
  const month = parseInt(m[1], 10);
  const day = parseInt(m[2], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const refYear = referenceDate.getUTCFullYear();
  let best = null;
  for (const year of [refYear - 1, refYear, refYear + 1]) {
    const t = Date.UTC(year, month - 1, day);
    const dist = Math.abs(t - referenceDate.getTime());
    if (!best || dist < best.dist) best = { year, dist };
  }
  return `${best.year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** End-of-range minutes: a range ending at/before its start ran past midnight ("…–12:00 AM"). */
function normalizeEnd(startMinutes, endMinutes) {
  return endMinutes <= startMinutes ? endMinutes + 1440 : endMinutes;
}

/** minutes -> "HH:MM:00"; 1440 (midnight end) -> "24:00:00" so it sorts/reads as end-of-day, not 00:00. */
function formatEnd(minutes) {
  return minutes >= 1440 ? "24:00:00" : formatTime(minutes);
}

/** Booked half-hour slot starts for one cell, from its permitted* class. */
function cellSlots(attrs, hourMinutes) {
  if (hasClass(attrs, "permitted")) return [hourMinutes, hourMinutes + SLOT];
  if (hasClass(attrs, "permitted-first-half")) return [hourMinutes];
  if (hasClass(attrs, "permitted-second-half")) return [hourMinutes + SLOT];
  return [];
}

/** Collapse sorted slot starts into contiguous [start, end) runs. */
function slotsToRuns(slots) {
  const runs = [];
  for (const s of [...slots].sort((a, b) => a - b)) {
    const last = runs[runs.length - 1];
    if (last && last.end === s) last.end = s + SLOT;
    else runs.push({ start: s, end: s + SLOT });
  }
  return runs;
}

/**
 * Parse one day column (cells top-to-bottom) into booked ranges.
 * @returns {{ ranges: Array<{start:number,end:number}>, anomalies: string[] }}
 */
function parseDayColumn(cells, context) {
  const anomalies = [];
  const ranges = [];
  const booked = new Set();
  let pendingStart = null;

  for (const { attrs, text, hourMinutes } of cells) {
    for (const s of cellSlots(attrs, hourMinutes)) booked.add(s);
    if (!text) continue;

    const full = RANGE_RE.exec(text);
    if (full) {
      const start = parseTimeLabel(full[1]);
      const end = parseTimeLabel(full[2]);
      if (start != null && end != null) ranges.push({ start, end: normalizeEnd(start, end) });
      pendingStart = null;
      continue;
    }
    const startOnly = START_RE.exec(text);
    if (startOnly) {
      if (pendingStart != null) anomalies.push(`${context}: start label with no end before the next start ("${text}")`);
      pendingStart = parseTimeLabel(startOnly[1]);
      continue;
    }
    const endOnly = TIME_ONLY_RE.exec(text);
    if (endOnly) {
      const end = parseTimeLabel(endOnly[1]);
      if (pendingStart == null) {
        anomalies.push(`${context}: end label "${text}" with no start label; ignored`);
      } else if (end != null) {
        ranges.push({ start: pendingStart, end: normalizeEnd(pendingStart, end) });
      }
      pendingStart = null;
      continue;
    }
    anomalies.push(`${context}: unrecognized cell text "${text}"; ignored`);
  }
  if (pendingStart != null) anomalies.push(`${context}: start label ${formatTime(pendingStart)} never got an end label`);

  // Shading backstop: booked slots no label range covers become their own blocks.
  const uncovered = [...booked].filter((s) => !ranges.some((r) => s >= r.start && s < r.end));
  for (const run of slotsToRuns(uncovered)) {
    anomalies.push(`${context}: shaded ${formatTime(run.start)}–${formatEnd(run.end)} had no label; added from cell shading`);
    ranges.push(run);
  }

  ranges.sort((a, b) => a.start - b.start);
  return { ranges, anomalies };
}

/**
 * @param {string} html the full permits page
 * @param {{ referenceDate?: Date }} [opts]
 * @returns {{ fields: Array<{ fieldNameOnPage: string, minDate: string, maxDate: string,
 *             rows: Array<{permit_date:string,start_time:string,end_time:string}> }>, anomalies: string[] }}
 */
function parseHrptScheduleTables(html, { referenceDate = new Date() } = {}) {
  const anomalies = [];
  const fields = [];
  const clean = String(html || "").replace(/<!--[\s\S]*?-->/g, "");

  for (const table of extractElements(clean, "table")) {
    const img = /<img\b([^>]*)>/i.exec(table.innerHTML);
    const fieldNameOnPage = img ? (getAttr(img[1], "alt") || "").trim() : "";
    if (!fieldNameOnPage) continue; // not a field schedule (e.g. the "Permit Season" table)

    const headerCells = extractElements(table.innerHTML, "th").map((th) => textContent(th.innerHTML));
    const dates = headerCells.map((t) => headerDateToIso(t, referenceDate)).filter(Boolean);
    if (dates.length < 7) {
      anomalies.push(`${fieldNameOnPage}: found ${dates.length} dated day columns (expected 8); table skipped`);
      continue;
    }

    const body = extractElements(table.innerHTML, "tbody")[0];
    const columns = dates.map(() => []);
    for (const tr of extractElements(body ? body.innerHTML : "", "tr")) {
      const tds = extractElements(tr.innerHTML, "td");
      if (!tds.length) continue;
      const hourMinutes = parseTimeLabel(textContent(tds[0].innerHTML));
      if (hourMinutes == null) {
        anomalies.push(`${fieldNameOnPage}: row without a time label ("${textContent(tds[0].innerHTML)}"); skipped`);
        continue;
      }
      tds.slice(1, 1 + dates.length).forEach((td, i) => {
        columns[i].push({ attrs: td.attrs, text: textContent(td.innerHTML).replace(/ /g, " ").trim(), hourMinutes });
      });
    }

    const rows = [];
    columns.forEach((cells, i) => {
      const { ranges, anomalies: colAnoms } = parseDayColumn(cells, `${fieldNameOnPage} ${dates[i]}`);
      anomalies.push(...colAnoms);
      for (const r of ranges) {
        rows.push({ permit_date: dates[i], start_time: formatTime(r.start), end_time: formatEnd(r.end) });
      }
    });

    fields.push({ fieldNameOnPage, minDate: dates[0], maxDate: dates[dates.length - 1], rows });
  }

  return { fields, anomalies };
}

export { parseHrptScheduleTables, headerDateToIso };
