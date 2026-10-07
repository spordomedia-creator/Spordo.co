/**
 * New York calendar dates and hours.
 *
 * Every permit source stores New York wall-clock times (Socrata's floating
 * timestamps, HRPT's schedule images, Asphalt Green's public hours), but
 * `new Date().toISOString()` gives the UTC date -- which is already tomorrow
 * from 8pm ET (7pm in winter). Anything asking "what day is it?" about
 * permits has to ask in New York time, or tonight's bookings fall out of the
 * window and "today" checks run against tomorrow's schedule.
 *
 * Mirrored by hand in public/TrueSpordo.html (search for `nycDate`), which is
 * a non-module inline script node --test can't import -- same arrangement as
 * permitStatus.js. Keep the two in sync.
 */

const NYC_TIME_ZONE = "America/New_York";

// formatToParts, same as asphaltGreen/sync.js's toNewYorkParts: the parts are
// stable across ICU versions, a locale's default date pattern is not.
const NYC_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: NYC_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

function nycParts(date) {
  return Object.fromEntries(NYC_PARTS.formatToParts(date).map((p) => [p.type, p.value]));
}

/** "YYYY-MM-DD": the calendar date in New York at the instant `date`. */
function nycDateIso(date = new Date()) {
  const p = nycParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

/** 0-23: the hour in New York at the instant `date`. */
function nycHour(date = new Date()) {
  return Number(nycParts(date).hour) % 24;
}

/** Shift a "YYYY-MM-DD" calendar date by `days`. Pure calendar math, no time zone involved. */
function addDaysIso(isoDate, days) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().split("T")[0];
}

export { NYC_TIME_ZONE, nycDateIso, nycHour, addDaysIso };
