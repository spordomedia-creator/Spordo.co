/**
 * Reads one HRPT weekly-schedule image into structured data with Anthropic's
 * vision API. HRPT publishes these as hand-made graphics (a 7-day grid; green
 * blocks are permit-holder time, each labeled with its exact range), so a
 * vision model is far more robust than pixel/OCR heuristics against their
 * layout/color/font drift.
 *
 * Returns { field, weekLabel, days: { sunday: string[], … saturday: string[] } }
 * where each string is a permitted range exactly as printed ("8:00 AM–1:00 PM").
 * fetch + now are injected so the whole thing is unit-testable with no network.
 */

import { ANTHROPIC_API_URL, ANTHROPIC_VERSION, ANTHROPIC_MODEL, ANTHROPIC_MAX_TOKENS } from "./config.js";

const DAY_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const PROMPT =
  "This image is a Hudson River Park weekly field-permit schedule: a grid with a TIME column and one column per day (Sunday–Saturday). " +
  "GREEN blocks are times reserved for permit holders and are each labeled with an exact range (e.g. \"Permitted 8:00 AM-1:00 PM\"). " +
  "Light-blue is open/available; orange (if any) is closed. " +
  "Read the field name from the title (ignore the words \"WEEKLY SCHEDULE\"), and read every green block per day. " +
  'Respond with ONLY minified JSON, no prose, in exactly this shape: ' +
  '{"field":"<field name>","weekLabel":"<e.g. SEP 13-19>","days":{"sunday":["8:00 AM-1:00 PM"],"monday":[],"tuesday":[],"wednesday":[],"thursday":[],"friday":[],"saturday":[]}}. ' +
  "Each day value is an array of the green ranges for that day (empty array if none). Copy the printed times verbatim.";

/** base64-encode raw bytes without Node Buffer (Workers-safe, chunked for large images). */
function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Pull the JSON object out of the model's text response, tolerating code fences / stray prose. */
function extractJson(text) {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Coerce the model output into a clean {field, weekLabel, days:{7 arrays}} shape. */
function normalizeResult(obj) {
  if (!obj || typeof obj !== "object") return null;
  const field = typeof obj.field === "string" ? obj.field.trim() : "";
  if (!field) return null;
  const days = {};
  for (const k of DAY_KEYS) {
    const v = obj.days && obj.days[k];
    days[k] = Array.isArray(v) ? v.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim()) : [];
  }
  return { field, weekLabel: typeof obj.weekLabel === "string" ? obj.weekLabel.trim() : "", days };
}

/**
 * @param {{url:string,bytes:Uint8Array,hash:string}} image
 * @param {{ apiKey:string, fetchImpl?:typeof fetch, model?:string }} cfg
 * @returns {Promise<{ field, weekLabel, days } >} throws on API/parse failure
 */
async function readScheduleImage(image, cfg) {
  const fetchImpl = cfg.fetchImpl || fetch;
  if (!cfg.apiKey) throw new Error("ANTHROPIC_API_KEY is not configured");

  const body = {
    model: cfg.model || ANTHROPIC_MODEL,
    max_tokens: ANTHROPIC_MAX_TOKENS,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: bytesToBase64(image.bytes) } },
          { type: "text", text: PROMPT },
        ],
      },
    ],
  };

  const resp = await fetchImpl(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`Anthropic API HTTP ${resp.status}: ${data && data.error ? data.error.message : "unknown error"}`);
  }
  const text = Array.isArray(data.content) ? data.content.map((c) => (c && c.type === "text" ? c.text : "")).join("") : "";
  const parsed = normalizeResult(extractJson(text));
  if (!parsed) throw new Error(`could not parse schedule JSON from vision response for ${image.url}`);
  return parsed;
}

export { readScheduleImage, bytesToBase64, extractJson, normalizeResult, DAY_KEYS, PROMPT };
