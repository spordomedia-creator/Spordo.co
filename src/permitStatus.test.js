import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyExternalFieldStatus } from "./permitStatus.js";

test("meta === null (never synced) classifies as not_synced, not ok", () => {
  // The bug this guards against: a stale EXTERNAL_ORGS entry (e.g. the old
  // "Pier 40 — Field C") whose name never matched a real HRPT table gets
  // meta: null back from the API. Treating that as "ok" renders the normal
  // grid with an empty permits array -- every day fabricated as "Free".
  assert.equal(classifyExternalFieldStatus(null), "not_synced");
  assert.equal(classifyExternalFieldStatus(undefined), "not_synced");
});

test("no_permit_schedule status classifies as no_schedule", () => {
  assert.equal(
    classifyExternalFieldStatus({ live_availability_status: "no_permit_schedule", source_data_stale: false }),
    "no_schedule"
  );
});

test("source_data_stale classifies as stale even when synced", () => {
  assert.equal(
    classifyExternalFieldStatus({ live_availability_status: "synced", source_data_stale: true }),
    "stale"
  );
});

test("a fresh, current sync classifies as ok", () => {
  assert.equal(
    classifyExternalFieldStatus({ live_availability_status: "synced", source_data_stale: false }),
    "ok"
  );
});

test("no_permit_schedule takes priority over source_data_stale if both were somehow set", () => {
  assert.equal(
    classifyExternalFieldStatus({ live_availability_status: "no_permit_schedule", source_data_stale: true }),
    "no_schedule"
  );
});
