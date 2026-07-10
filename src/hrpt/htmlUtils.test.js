import { test } from "node:test";
import assert from "node:assert/strict";
import { extractElements, getAttr, hasClass, decodeEntities, textContent } from "./htmlUtils.js";

test("extractElements finds nested divs, including the inner one", () => {
  const html = `<div id="outer"><p>x</p><div id="inner" class="a b">hello</div></div>`;
  const divs = extractElements(html, "div");
  assert.equal(divs.length, 2);
  assert.equal(getAttr(divs[0].attrs, "id"), "outer");
  assert.equal(getAttr(divs[1].attrs, "id"), "inner");
  assert.equal(divs[1].innerHTML, "hello");
});

test("extractElements handles multiple sibling elements", () => {
  const html = `<td>a</td><td class="permitted">b</td><td></td>`;
  const tds = extractElements(html, "td");
  assert.equal(tds.length, 3);
  assert.equal(tds[0].innerHTML, "a");
  assert.equal(tds[1].innerHTML, "b");
  assert.equal(tds[2].innerHTML, "");
});

test("extractElements skips unterminated elements rather than throwing", () => {
  const html = `<div id="a">ok</div><div id="b">unterminated`;
  const divs = extractElements(html, "div");
  assert.equal(divs.length, 1);
  assert.equal(getAttr(divs[0].attrs, "id"), "a");
});

test("getAttr supports double, single, and unquoted values", () => {
  assert.equal(getAttr(` id="foo"`, "id"), "foo");
  assert.equal(getAttr(` id='bar'`, "id"), "bar");
  assert.equal(getAttr(` rowspan=3`, "rowspan"), "3");
  assert.equal(getAttr(` class="a"`, "id"), null);
});

test("hasClass matches a single class token, not substrings", () => {
  assert.equal(hasClass(` class="permitted extra"`, "permitted"), true);
  assert.equal(hasClass(` class="not-permitted"`, "permitted"), false);
  assert.equal(hasClass(``, "permitted"), false);
});

test("decodeEntities handles named and numeric entities", () => {
  assert.equal(decodeEntities("3:30&nbsp;PM &ndash; 6:00 PM"), "3:30 PM – 6:00 PM");
  assert.equal(decodeEntities("Tom &amp; Jerry &#39;s"), "Tom & Jerry 's");
});

test("textContent strips nested tags and collapses whitespace", () => {
  assert.equal(textContent(`  <span>10:00</span>\n  AM  `), "10:00 AM");
});
