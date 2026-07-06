import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveFieldId, EXACT_NAME_TO_FIELD_ID } from "./fieldMap.js";

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

test("returns null (does not guess) for an unrecognized name", () => {
  assert.equal(resolveFieldId("Some Brand New Field Nobody Has Heard Of"), null);
});

test("returns null for empty/nullish input", () => {
  assert.equal(resolveFieldId(""), null);
  assert.equal(resolveFieldId(null), null);
});
