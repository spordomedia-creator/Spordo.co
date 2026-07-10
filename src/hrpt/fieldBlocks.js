/**
 * Locates each per-field schedule block on the HRPT permits page: the
 * (confirmed via DevTools) pattern is one <table> per field, each wrapped
 * in a <div id="pier25"> (or similar per-field id — the exact id scheme
 * for every field is unconfirmed). We don't rely on the div id's text for
 * the field name (it's an internal slug, not guaranteed to map cleanly to
 * the display name); instead we look for a nearby heading/caption inside
 * the block and treat that as the authoritative "name as shown on the
 * page". If no such heading is found we do NOT guess — we flag it as an
 * anomaly with whatever positional context we have (div id / block index)
 * so it can be diagnosed against the real page.
 */

import { extractElements, getAttr, textContent } from "./htmlUtils.js";

const HEADING_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6", "caption"];

/**
 * @typedef {Object} FieldBlock
 * @property {string|null} fieldNameOnPage
 * @property {string|null} divId
 * @property {string} tableHtml outer HTML of the block's <table>.
 * @property {number} blockIndex position among all blocks found, for
 *   anomaly messages when there's no other identifying info.
 */

/**
 * @param {string} html full page HTML.
 * @returns {{ blocks: FieldBlock[], anomalies: string[] }}
 */
function findFieldTableBlocks(html) {
  const anomalies = [];

  const divs = extractElements(html, "div").filter((d) => d.innerHTML.includes("<table"));

  // A table can be wrapped by several nested divs (layout wrappers). Pick
  // the innermost qualifying div per distinct table by preferring the
  // shortest innerHTML among divs that share the same first <table> start
  // offset (relative to the div's own innerHTML start).
  const byTableStart = new Map();
  for (const div of divs) {
    // Absolute offset of the table's opening "<table" within the full
    // page HTML — must be anchored to innerStart (where this div's
    // content begins), not div.start (the div's own opening tag start),
    // since divs with different attributes have different opening-tag
    // lengths and would otherwise produce non-comparable offsets.
    const tableOffset = div.innerStart + div.innerHTML.indexOf("<table");
    const existing = byTableStart.get(tableOffset);
    if (!existing || div.innerHTML.length < existing.innerHTML.length) {
      byTableStart.set(tableOffset, div);
    }
  }

  const candidateDivs = [...byTableStart.values()].sort((a, b) => a.start - b.start);

  if (candidateDivs.length === 0) {
    anomalies.push("no <div>...<table>...</table></div> blocks found on the page at all");
    return { blocks: [], anomalies };
  }

  const blocks = candidateDivs.map((div, blockIndex) => {
    const divId = getAttr(div.attrs, "id");
    const tables = extractElements(div.innerHTML, "table");
    if (tables.length === 0) {
      // Shouldn't happen given the .includes("<table") filter above, but
      // guard anyway (e.g. a table opened but never closed).
      anomalies.push(`block ${blockIndex} (div id="${divId || "?"}"): <table> tag found but could not be parsed`);
      return { fieldNameOnPage: null, divId: divId || null, tableHtml: "", blockIndex };
    }
    if (tables.length > 1) {
      anomalies.push(
        `block ${blockIndex} (div id="${divId || "?"}"): expected one <table> per field, found ${tables.length}; using the first`
      );
    }

    const fieldNameOnPage = findHeadingText(div.innerHTML, tables[0].start);
    if (!fieldNameOnPage) {
      anomalies.push(
        `block ${blockIndex} (div id="${divId || "?"}"): no heading/caption found to identify the field name; skipping rather than guessing`
      );
    }

    return { fieldNameOnPage, divId: divId || null, tableHtml: tables[0].outerHTML, blockIndex };
  });

  return { blocks, anomalies };
}

/**
 * Look for the nearest heading-like element before the table within the
 * div's own innerHTML, falling back to a <caption> inside the table itself.
 */
function findHeadingText(divInnerHtml, tableStartWithinDiv) {
  const before = divInnerHtml.slice(0, tableStartWithinDiv);
  let best = null;
  for (const tag of HEADING_TAGS) {
    const els = extractElements(before, tag);
    if (els.length > 0) {
      const last = els[els.length - 1];
      const text = textContent(last.innerHTML);
      if (text) {
        best = text;
        break;
      }
    }
  }
  if (best) return best;

  // Fall back to a <caption> inside the table itself.
  const tableHtml = divInnerHtml.slice(tableStartWithinDiv);
  const captions = extractElements(tableHtml, "caption");
  if (captions.length > 0) {
    const text = textContent(captions[0].innerHTML);
    if (text) return text;
  }

  return null;
}

export { findFieldTableBlocks };
