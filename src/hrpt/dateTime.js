/**
 * Date/time inference for the HRPT schedule grid: turning day-column
 * headers into calendar dates, row labels into times, and runs of
 * consecutive "booked" cells into {start_time, end_time} ranges.
 *
 * The exact header text formats on the live page are unconfirmed (we have
 * only DevTools screenshots, not raw HTML), so parsing here is deliberately
 * defensive: unparseable columns/rows are logged as anomalies and skipped
 * rather than guessed.
 */

import { decodeEntities } from "./htmlUtils.js";

const MONTHS = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

/**
 * Best-effort extraction of the definitive year from a page-level heading
 * such as "June 28 – July 5, 2026". Returns null if none is found, in which
 * case callers should fall back to a reference date's year (with Dec/Jan
 * rollover handling per column).
 */
function findAnchorYearInPage(html) {
  // Decode entities first (e.g. HRPT's "&ndash;" between the two dates)
  // so the small inter-date separator doesn't get lost inside raw markup.
  const text = decodeEntities(html);
  const re = /[A-Za-z]{3,9}\.?\s+\d{1,2}[^0-9]{0,12}(?:[A-Za-z]{3,9}\.?\s+)?\d{1,2},?\s*(\d{4})/;
  const m = re.exec(text);
  if (!m) return null;
  return parseInt(m[1], 10);
}

/**
 * Parse a day-column header (e.g. "Sun 6/28", "June 28", "Jun 28, 2026")
 * into an ISO "YYYY-MM-DD" string.
 *
 * @param {string} headerText
 * @param {{ anchorYear: number|null, referenceDate: Date }} opts
 * @returns {string|null}
 */
function parseColumnDate(headerText, { anchorYear = null, referenceDate = new Date() } = {}) {
  if (!headerText) return null;
  const text = headerText.trim();

  // "Month D, YYYY" or "Month D YYYY"
  let m = /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})\b/.exec(text);
  if (m) {
    const month = MONTHS[m[1].toLowerCase()];
    if (month !== undefined) return toIso(parseInt(m[3], 10), month, parseInt(m[2], 10));
  }

  // "M/D/YYYY" or "M/D/YY"
  m = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/.exec(text);
  if (m) {
    let year = parseInt(m[3], 10);
    if (year < 100) year += 2000;
    return toIso(year, parseInt(m[1], 10) - 1, parseInt(m[2], 10));
  }

  // "Month D" (no year) — fold in the anchor/reference year.
  m = /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(text);
  if (m) {
    const month = MONTHS[m[1].toLowerCase()];
    if (month !== undefined) {
      const day = parseInt(m[2], 10);
      const year = resolveYear(month, day, anchorYear, referenceDate);
      return toIso(year, month, day);
    }
  }

  // "M/D" (no year)
  m = /\b(\d{1,2})\/(\d{1,2})\b/.exec(text);
  if (m) {
    const month = parseInt(m[1], 10) - 1;
    const day = parseInt(m[2], 10);
    const year = resolveYear(month, day, anchorYear, referenceDate);
    return toIso(year, month, day);
  }

  return null;
}

function resolveYear(month, day, anchorYear, referenceDate) {
  if (anchorYear) return anchorYear;
  const refYear = referenceDate.getFullYear();
  // If naively using the reference year would put this date more than ~60
  // days in the past, assume it actually belongs to next year (handles a
  // schedule window that spans a Dec -> Jan boundary).
  const candidate = new Date(Date.UTC(refYear, month, day));
  const diffDays = (candidate.getTime() - Date.UTC(refYear, referenceDate.getMonth(), referenceDate.getDate())) / 86400000;
  if (diffDays < -60) return refYear + 1;
  return refYear;
}

function toIso(year, monthIndex0, day) {
  const mm = String(monthIndex0 + 1).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

/** Parse "10:00 AM" / "3:30pm" / "12:00 PM" into minutes-since-midnight. */
function parseTimeLabel(text) {
  if (!text) return null;
  const m = /(\d{1,2})(?::(\d{2}))?\s*([AaPp][Mm])/.exec(text.trim());
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const isPM = m[3].toLowerCase() === "pm";
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
  if (hour === 12) hour = 0;
  if (isPM) hour += 12;
  return hour * 60 + minute;
}

/** minutes-since-midnight -> "HH:MM:00" (24h, matches a Postgres `time`). */
function formatTime(minutes) {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
}

/**
 * Try to parse an explicit visible range label like
 * "3:30 PM–6:00 PM" / "3:30–6:00 PM" / "3:30pm - 6pm".
 * Returns {startMinutes, endMinutes, remainder} or null.
 */
function parseExplicitRangeLabel(text) {
  if (!text) return null;
  const re = /(\d{1,2}(?::\d{2})?(?:\s*[AaPp][Mm])?)\s*[–—-]\s*(\d{1,2}(?::\d{2})?\s*[AaPp][Mm])/;
  const m = re.exec(text);
  if (!m) return null;
  let startText = m[1].trim();
  const endText = m[2].trim();
  // If the start half omitted AM/PM (e.g. "3:30–6:00 PM"), inherit the
  // period from the end half.
  if (!/[AaPp][Mm]/.test(startText)) {
    const period = /[AaPp][Mm]/.exec(endText)[0];
    startText = `${startText} ${period}`;
  }
  const startMinutes = parseTimeLabel(startText);
  const endMinutes = parseTimeLabel(endText);
  if (startMinutes == null || endMinutes == null) return null;
  const remainder = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
  return { startMinutes, endMinutes, remainder };
}

/**
 * True when `text` is nothing but a bare time (optionally with AM/PM,
 * optionally followed by a trailing dash) and carries no other content —
 * e.g. "9:00 AM–", "8:30 AM", "7:00–". These show up as a booked cell's own
 * text when the page renders just a start-time label inside the colored
 * block rather than a full "start–end" range parseExplicitRangeLabel can
 * match; the row position already gives us that same start time, so using
 * this verbatim as an event name would just echo it back as a dangling
 * fragment. A genuine label that happens to start with a time (e.g. "9:00
 * AM Practice") has trailing content after the optional dash and does not
 * match.
 */
function isBareTimeFragment(text) {
  const re = /^\s*\d{1,2}(?::\d{2})?\s*(?:[AaPp][Mm])?\s*[–—-]?\s*$/;
  return !!text && re.test(text);
}

/** Compute the modal/minimum positive gap between sorted row start times. */
function inferSlotIntervalMinutes(sortedMinutes) {
  const diffs = [];
  for (let i = 1; i < sortedMinutes.length; i++) {
    const d = sortedMinutes[i] - sortedMinutes[i - 1];
    if (d > 0) diffs.push(d);
  }
  if (diffs.length === 0) return null;
  return Math.min(...diffs);
}

export {
  findAnchorYearInPage,
  parseColumnDate,
  parseTimeLabel,
  formatTime,
  parseExplicitRangeLabel,
  isBareTimeFragment,
  inferSlotIntervalMinutes,
};
