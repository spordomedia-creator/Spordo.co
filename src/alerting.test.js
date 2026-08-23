import { test } from "node:test";
import assert from "node:assert/strict";
import { sendSlackAlert, buildSyncFailureAlert, buildStalenessAlert } from "./alerting.js";

test("sendSlackAlert POSTs the text as JSON to the webhook URL", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200 };
  };

  const result = await sendSlackAlert("https://hooks.slack.com/services/FAKE", "hello", { fetchImpl });

  assert.deepEqual(result, { sent: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://hooks.slack.com/services/FAKE");
  assert.equal(calls[0].opts.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].opts.body), { text: "hello" });
});

test("sendSlackAlert no-ops (does not throw) when the webhook URL is unset", async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, status: 200 }; };

  const result = await sendSlackAlert(undefined, "hello", { fetchImpl });

  assert.equal(result.sent, false);
  assert.match(result.reason, /not configured/);
  assert.equal(called, false, "must not attempt a fetch with no webhook URL");
});

test("sendSlackAlert reports failure (does not throw) on a non-OK Slack response", async () => {
  const fetchImpl = async () => ({ ok: false, status: 404 });
  const result = await sendSlackAlert("https://hooks.slack.com/services/FAKE", "hello", { fetchImpl });
  assert.equal(result.sent, false);
  assert.match(result.reason, /404/);
});

test("sendSlackAlert reports failure (does not throw) when fetch itself throws", async () => {
  const fetchImpl = async () => { throw new Error("network down"); };
  const result = await sendSlackAlert("https://hooks.slack.com/services/FAKE", "hello", { fetchImpl });
  assert.equal(result.sent, false);
  assert.match(result.reason, /network down/);
});

test("buildSyncFailureAlert returns null for a successful run", () => {
  assert.equal(buildSyncFailureAlert("HRPT", { ok: true }), null);
});

test("buildSyncFailureAlert builds a message for a failed run, using HRPT's fieldsWritten shape", () => {
  const msg = buildSyncFailureAlert("HRPT", {
    ok: false,
    reason: "no fields were successfully written",
    fieldsWritten: 0,
    anomalies: ["block 1: no heading/caption found"],
  });
  assert.match(msg, /HRPT sync failed/);
  assert.match(msg, /no fields were successfully written/);
  assert.match(msg, /Written: 0/);
  assert.match(msg, /no heading\/caption found/);
});

test("buildSyncFailureAlert also handles Socrata's sportsSynced shape (no fieldsWritten)", () => {
  const msg = buildSyncFailureAlert("Socrata", {
    ok: false,
    reason: "no sports were successfully synced",
    sportsSynced: [],
    anomalies: [],
  });
  assert.match(msg, /Socrata sync failed/);
  assert.match(msg, /Written: 0/);
});

test("buildStalenessAlert returns null when coverage is empty (nothing tracked yet)", () => {
  assert.equal(buildStalenessAlert("HRPT", [], "2026-08-22"), null);
});

test("buildStalenessAlert returns null when at least one tracked field's data reaches today", () => {
  const coverage = [
    { fieldId: "pier-25", latestDate: "2026-08-16" }, // stale
    { fieldId: "pier-26", latestDate: "2026-08-22" }, // current -- source is fine
  ];
  assert.equal(buildStalenessAlert("HRPT", coverage, "2026-08-22"), null);
});

test("buildStalenessAlert fires when ALL tracked fields are stale (the real incident's signature)", () => {
  const coverage = [
    { fieldId: "pier-25", latestDate: "2026-08-16" },
    { fieldId: "pier-26", latestDate: "2026-08-09" },
    { fieldId: "pier-40", latestDate: null }, // never synced at all
  ];
  const msg = buildStalenessAlert("HRPT", coverage, "2026-08-22");
  assert.match(msg, /HRPT source data looks stale/);
  assert.match(msg, /3\/3 tracked fields/);
  assert.match(msg, /2026-08-16/); // most recent among the stale ones
  assert.match(msg, /not a sync failure/);
});

test("buildStalenessAlert treats a future-dated latestDate as current, not stale", () => {
  const coverage = [{ fieldId: "pier-25", latestDate: "2026-08-25" }];
  assert.equal(buildStalenessAlert("HRPT", coverage, "2026-08-22"), null);
});
