import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeSoqlString, isoDateOnly, daysFromIsoDate, buildSportWhereClause, buildSportPageUrl } from "./soql.js";
import { PAGE_SIZE } from "./config.js";

test("escapeSoqlString doubles single quotes", () => {
  assert.equal(escapeSoqlString("O'Brien"), "O''Brien");
  assert.equal(escapeSoqlString("no quotes"), "no quotes");
});

test("isoDateOnly / daysFromIsoDate produce YYYY-MM-DD strings for the New York calendar day", () => {
  const d = new Date("2026-08-22T23:59:59.000Z"); // 7:59pm EDT, same date in both zones
  assert.equal(isoDateOnly(d), "2026-08-22");
  assert.equal(daysFromIsoDate(d, 90), "2026-11-20");
  assert.equal(daysFromIsoDate(d, 0), "2026-08-22");
});

test("isoDateOnly stays on the New York date after 8pm ET, when UTC has already rolled over", () => {
  const evening = new Date("2026-08-23T00:30:00.000Z"); // 8:30pm EDT on Aug 22
  assert.equal(isoDateOnly(evening), "2026-08-22");
  assert.equal(daysFromIsoDate(evening, 90), "2026-11-20");
});

test("buildSportWhereClause never includes a trailing Z on timestamps (Socrata rejects it)", () => {
  const clause = buildSportWhereClause({ id: "soccer", eventNameLike: "SOCCER" }, { minDateIso: "2026-08-22", maxDateIso: "2026-11-20" });
  assert.doesNotMatch(clause, /Z/);
  assert.match(clause, /start_date_time>='2026-08-22T00:00:00\.000'/);
  assert.match(clause, /start_date_time<='2026-11-20T23:59:59\.000'/);
  assert.match(clause, /upper\(event_name\) like '%SOCCER%'/);
});

test("buildSportWhereClause ORs in the alt keyword (baseball also matches softball)", () => {
  const clause = buildSportWhereClause(
    { id: "baseball", eventNameLike: "BASEBALL", altEventNameLike: "SOFTBALL" },
    { minDateIso: "2026-08-22", maxDateIso: "2026-11-20" }
  );
  assert.match(clause, /upper\(event_name\) like '%BASEBALL%' OR upper\(event_name\) like '%SOFTBALL%'/);
});

test("buildSportWhereClause escapes single quotes in the keyword", () => {
  const clause = buildSportWhereClause({ id: "x", eventNameLike: "O'BRIEN" }, { minDateIso: "2026-08-22", maxDateIso: "2026-11-20" });
  assert.match(clause, /O''BRIEN/);
});

test("buildSportPageUrl includes $limit/$offset/$where/$order and points at the tvpp-9vvx dataset", () => {
  const url = buildSportPageUrl({ id: "soccer", eventNameLike: "SOCCER" }, { minDateIso: "2026-08-22", maxDateIso: "2026-11-20", offset: 1000, limit: 1000 });
  assert.match(url, /^https:\/\/data\.cityofnewyork\.us\/resource\/tvpp-9vvx\.json\?/);
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("$limit"), "1000");
  assert.equal(parsed.searchParams.get("$offset"), "1000");
  // :id tiebreak keeps paging stable when many rows share a start time.
  assert.equal(parsed.searchParams.get("$order"), "start_date_time ASC, :id ASC");
  assert.match(parsed.searchParams.get("$where"), /SOCCER/);
});

test("buildSportPageUrl defaults offset to 0 and limit to PAGE_SIZE", () => {
  const url = buildSportPageUrl({ id: "soccer", eventNameLike: "SOCCER" }, { minDateIso: "2026-08-22", maxDateIso: "2026-11-20" });
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("$offset"), "0");
  assert.equal(parsed.searchParams.get("$limit"), String(PAGE_SIZE));
});
