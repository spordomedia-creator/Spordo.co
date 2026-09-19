/**
 * Unit tests for the Anthropic vision schedule reader. The Anthropic API
 * call is injected via a fake `fetchImpl` — these never hit api.anthropic.com
 * and never spend a token.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  readScheduleImage,
  bytesToBase64,
  extractJson,
  normalizeResult,
  DAY_KEYS,
} from "./visionParser.js";

const IMAGE = { url: "https://example.com/9-13_2026_Field_Schedules.jpg", bytes: new Uint8Array([1, 2, 3, 4]), hash: "abc" };

/** Fake Anthropic Messages API success response wrapping `text` as the model's reply. */
function anthropicOk(text) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { content: [{ type: "text", text }] };
    },
  };
}

test("bytesToBase64 round-trips arbitrary bytes", () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255, 65, 66]);
  const b64 = bytesToBase64(bytes);
  const back = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  assert.deepEqual([...back], [...bytes]);
});

test("extractJson pulls an object out of fenced/prose-wrapped text", () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here you go: {"a":1,"b":[2]} thanks'), { a: 1, b: [2] });
  assert.equal(extractJson("no json here"), null);
  assert.equal(extractJson('{bad json'), null);
});

test("normalizeResult fills all 7 day arrays and trims strings", () => {
  const out = normalizeResult({
    field: "  Pier 25 Turf Field  ",
    weekLabel: " SEP 13-19 ",
    days: { sunday: [" 8:00 AM-1:00 PM ", 42, ""], monday: ["2:00 PM-4:00 PM"] },
  });
  assert.equal(out.field, "Pier 25 Turf Field");
  assert.equal(out.weekLabel, "SEP 13-19");
  assert.deepEqual(Object.keys(out.days), DAY_KEYS);
  assert.deepEqual(out.days.sunday, ["8:00 AM-1:00 PM"]); // number + empty dropped
  assert.deepEqual(out.days.monday, ["2:00 PM-4:00 PM"]);
  assert.deepEqual(out.days.saturday, []);
});

test("normalizeResult rejects a result with no field name", () => {
  assert.equal(normalizeResult({ field: "   ", days: {} }), null);
  assert.equal(normalizeResult(null), null);
});

test("readScheduleImage parses a well-formed vision response", async () => {
  let sentBody = null;
  const fetchImpl = async (url, init) => {
    assert.equal(url, "https://api.anthropic.com/v1/messages");
    assert.equal(init.headers["x-api-key"], "sk-test");
    assert.equal(init.headers["anthropic-version"], "2023-06-01");
    sentBody = JSON.parse(init.body);
    return anthropicOk('{"field":"Pier 25 Turf Field","weekLabel":"SEP 13-19","days":{"sunday":["8:00 AM-1:00 PM"],"monday":[],"tuesday":[],"wednesday":[],"thursday":[],"friday":[],"saturday":["9:00 AM-12:00 PM"]}}');
  };

  const result = await readScheduleImage(IMAGE, { apiKey: "sk-test", fetchImpl });
  assert.equal(result.field, "Pier 25 Turf Field");
  assert.deepEqual(result.days.sunday, ["8:00 AM-1:00 PM"]);
  assert.deepEqual(result.days.saturday, ["9:00 AM-12:00 PM"]);

  // The image was actually attached as a base64 block.
  const imgBlock = sentBody.messages[0].content.find((c) => c.type === "image");
  assert.equal(imgBlock.source.type, "base64");
  assert.equal(imgBlock.source.media_type, "image/jpeg");
  assert.ok(imgBlock.source.data.length > 0);
});

test("readScheduleImage throws without an API key", async () => {
  await assert.rejects(() => readScheduleImage(IMAGE, { apiKey: "", fetchImpl: async () => anthropicOk("{}") }), /ANTHROPIC_API_KEY/);
});

test("readScheduleImage surfaces an API HTTP error", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 429,
    async json() {
      return { error: { message: "rate limited" } };
    },
  });
  await assert.rejects(() => readScheduleImage(IMAGE, { apiKey: "sk-test", fetchImpl }), /HTTP 429/);
});

test("readScheduleImage throws when the response has no parseable JSON", async () => {
  const fetchImpl = async () => anthropicOk("I could not read the image, sorry.");
  await assert.rejects(() => readScheduleImage(IMAGE, { apiKey: "sk-test", fetchImpl }), /could not parse schedule JSON/);
});
