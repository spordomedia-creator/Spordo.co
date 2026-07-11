import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveFieldId, EXACT_NAME_TO_FIELD_ID, NO_PERMIT_SCHEDULE_FIELDS } from "./fieldMap.js";

test("resolves an exact-match current FIELD_DATABASE name", () => {
  const result = resolveFieldId("Pier 25 Artificial Turf Field");
  assert.equal(result.matchType, "exact");
  assert.equal(result.fieldId, EXACT_NAME_TO_FIELD_ID["Pier 25 Artificial Turf Field"]);
});

test("exact match is case/whitespace insensitive", () => {
  const result = resolveFieldId("  pier 25   artificial turf field ");
  assert.equal(result.matchType, "exact");
});

test("resolves a known live-page alias to the current field_id", () => {
  const result = resolveFieldId("Gansevoort Peninsula Athletic Field");
  assert.equal(result.matchType, "alias");
  assert.equal(result.fieldId, EXACT_NAME_TO_FIELD_ID["Gansevoort Peninsula Playing Field"]);
});

test("strips the live page's trailing 'Schedule' suffix before matching an exact name", () => {
  const result = resolveFieldId("Chelsea Waterside Athletic Field Schedule");
  assert.equal(result.matchType, "exact");
  assert.equal(result.fieldId, EXACT_NAME_TO_FIELD_ID["Chelsea Waterside Athletic Field"]);
});

test("strips the live page's trailing 'Schedule' suffix before matching an alias", () => {
  const result = resolveFieldId("Gansevoort Peninsula Athletic Field Schedule");
  assert.equal(result.matchType, "alias");
  assert.equal(result.fieldId, EXACT_NAME_TO_FIELD_ID["Gansevoort Peninsula Playing Field"]);
});

test("resolves the live page's 'Field'-less Courtyard East/West names via alias", () => {
  const east = resolveFieldId("Pier 40 Courtyard East Schedule");
  const west = resolveFieldId("Pier 40 Courtyard West Schedule");
  assert.equal(east.fieldId, EXACT_NAME_TO_FIELD_ID["Pier 40 Courtyard East Field"]);
  assert.equal(west.fieldId, EXACT_NAME_TO_FIELD_ID["Pier 40 Courtyard West Field"]);
});

test("returns null (does not guess) for an unrecognized name", () => {
  assert.equal(resolveFieldId("Some Brand New Field Nobody Has Heard Of"), null);
});

test("returns null for empty/nullish input", () => {
  assert.equal(resolveFieldId(""), null);
  assert.equal(resolveFieldId(null), null);
});

test("returns null for a field confirmed to have no HRPT schedule table (Chelsea Waterside Basketball Court)", () => {
  assert.equal(resolveFieldId("Chelsea Waterside Basketball Court"), null);
  assert.equal(resolveFieldId("Chelsea Waterside Basketball Court Schedule"), null);
  assert.ok(NO_PERMIT_SCHEDULE_FIELDS.some((f) => f.name === "Chelsea Waterside Basketball Court"));
});
