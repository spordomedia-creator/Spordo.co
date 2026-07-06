import { test } from "node:test";
import assert from "node:assert/strict";
import { findFieldTableBlocks } from "./fieldBlocks.js";

test("finds the field name from a heading before the table, keyed to the innermost div", () => {
  const html = `
    <div id="wrapper-layout">
      <div id="pier25">
        <h3>Pier 25 Artificial Turf Field</h3>
        <table><tbody><tr><td></td><td>Jun 28</td></tr></tbody></table>
      </div>
    </div>
  `;
  const { blocks, anomalies } = findFieldTableBlocks(html);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].fieldNameOnPage, "Pier 25 Artificial Turf Field");
  assert.equal(blocks[0].divId, "pier25");
  assert.deepEqual(anomalies, []);
});

test("falls back to a <caption> inside the table when there is no heading", () => {
  const html = `
    <div id="pier26">
      <table><caption>Pier 26 Sports Court</caption><tbody><tr><td></td></tr></tbody></table>
    </div>
  `;
  const { blocks } = findFieldTableBlocks(html);
  assert.equal(blocks[0].fieldNameOnPage, "Pier 26 Sports Court");
});

test("logs an anomaly and does not guess when no heading or caption is found", () => {
  const html = `
    <div id="mystery">
      <p>Just some text, no heading tag.</p>
      <table><tbody><tr><td></td></tr></tbody></table>
    </div>
  `;
  const { blocks, anomalies } = findFieldTableBlocks(html);
  assert.equal(blocks[0].fieldNameOnPage, null);
  assert.ok(anomalies.some((a) => a.includes("mystery") && a.includes("no heading")));
});

test("handles multiple field blocks on one page independently", () => {
  const html = `
    <div id="pier25"><h3>Pier 25 Artificial Turf Field</h3><table><tbody><tr><td></td></tr></tbody></table></div>
    <div id="gansevoort"><h3>Gansevoort Peninsula Athletic Field</h3><table><tbody><tr><td></td></tr></tbody></table></div>
  `;
  const { blocks } = findFieldTableBlocks(html);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((b) => b.fieldNameOnPage), ["Pier 25 Artificial Turf Field", "Gansevoort Peninsula Athletic Field"]);
});

test("reports an anomaly when there are no table blocks at all", () => {
  const { blocks, anomalies } = findFieldTableBlocks("<html><body>nothing here</body></html>");
  assert.equal(blocks.length, 0);
  assert.ok(anomalies.some((a) => a.includes("no <div>")));
});
