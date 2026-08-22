/**
 * SoQL query building for the Socrata (`tvpp-9vvx`) sync.
 *
 * Pure/testable — no fetch here, just string building. See
 * .claude/skills/nyc-open-data/SKILL.md for the gotchas encoded below:
 *   - Socrata rejects a trailing `Z` on timestamps (floating/local time).
 *   - Single quotes in any interpolated string must be escaped ('' not \').
 *   - Pagination is $limit/$offset, never assume one page is everything.
 */

import { SOCRATA_BASE_URL, PAGE_SIZE } from "./config.js";

/** Escape a value being interpolated into a SoQL string literal. */
function escapeSoqlString(value) {
  return String(value).replace(/'/g, "''");
}

/**
 * ISO date-only string (YYYY-MM-DD), UTC — matches public/TrueSpordo.html's
 * `today()`/`daysFrom(n)` helpers exactly so the sync window lines up with
 * what the live frontend used to request.
 */
function isoDateOnly(date) {
  return date.toISOString().split("T")[0];
}

function daysFromIsoDate(date, n) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + n);
  return isoDateOnly(d);
}

/**
 * Build the $where clause for one tracked sport's forward date window.
 * Mirrors public/TrueSpordo.html's loadFields() `where` string exactly
 * (including the baseball-also-matches-softball OR), so the data the sync
 * caches is the same data the live client used to fetch directly.
 */
function buildSportWhereClause(sport, { minDateIso, maxDateIso }) {
  const keyword = escapeSoqlString(sport.eventNameLike.toUpperCase());
  let clause = `upper(event_name) like '%${keyword}%'`;
  if (sport.altEventNameLike) {
    clause += ` OR upper(event_name) like '%${escapeSoqlString(sport.altEventNameLike.toUpperCase())}%'`;
  }
  return (
    `start_date_time>='${minDateIso}T00:00:00.000' AND ` +
    `start_date_time<='${maxDateIso}T23:59:59.000' AND (${clause})`
  );
}

/** Build one paginated Socrata request URL for a sport + offset. */
function buildSportPageUrl(sport, { minDateIso, maxDateIso, offset = 0, limit = PAGE_SIZE }) {
  const where = buildSportWhereClause(sport, { minDateIso, maxDateIso });
  const params = new URLSearchParams({
    $limit: String(limit),
    $offset: String(offset),
    $where: where,
    $order: "start_date_time ASC",
  });
  return `${SOCRATA_BASE_URL}?${params.toString()}`;
}

export { escapeSoqlString, isoDateOnly, daysFromIsoDate, buildSportWhereClause, buildSportPageUrl };
