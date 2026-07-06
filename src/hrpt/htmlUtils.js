/**
 * Dependency-free HTML helpers used by the HRPT parser.
 *
 * We deliberately do NOT pull in a full HTML parsing library (jsdom,
 * linkedom, node-html-parser, ...). The HRPT permits page is a narrow,
 * known shape (nested <div>/<table>/<tr>/<td> elements) and Cloudflare
 * Workers have no DOM available at runtime, so a small, auditable,
 * dependency-free scanner is the more reliable choice here.
 *
 * These helpers are intentionally generic (not HRPT-specific) so they can
 * be unit tested in isolation from the page-specific parsing logic in
 * `parser.js`.
 */

/**
 * Find every element with the given tag name in `html`, including nested
 * occurrences (e.g. nested <div>s), correctly matching each opening tag to
 * its balanced closing tag by depth-counting. This is more robust than a
 * naive regex for elements that can nest (div) and is applied uniformly to
 * elements that don't nest in practice (table/tr/td) too, since it costs
 * little extra and removes any surprise if the real markup nests those
 * unexpectedly.
 *
 * @param {string} html
 * @param {string} tagName lowercase tag name, e.g. "div"
 * @returns {Array<{attrs: string, innerHTML: string, outerHTML: string, start: number, end: number}>}
 */
function extractElements(html, tagName) {
  const openRe = new RegExp(`<${tagName}(\\s[^>]*)?>`, "gi");
  const tagScanSrc = `<${tagName}(?:\\s[^>]*)?>|</${tagName}\\s*>`;
  const results = [];
  let match;
  while ((match = openRe.exec(html))) {
    const start = match.index;
    const attrs = match[1] || "";
    const innerStart = match.index + match[0].length;

    const tagScan = new RegExp(tagScanSrc, "gi");
    tagScan.lastIndex = innerStart;
    let depth = 1;
    let innerEnd = -1;
    let end = -1;
    let m2;
    while ((m2 = tagScan.exec(html))) {
      const isClose = m2[0].charAt(1) === "/";
      if (isClose) {
        depth--;
        if (depth === 0) {
          innerEnd = m2.index;
          end = tagScan.lastIndex;
          break;
        }
      } else {
        depth++;
      }
    }

    if (innerEnd === -1) {
      // Unterminated element (malformed HTML). Skip it; caller-level code
      // is responsible for logging this as an anomaly if it matters.
      continue;
    }

    results.push({
      attrs,
      innerHTML: html.slice(innerStart, innerEnd),
      outerHTML: html.slice(start, end),
      start,
      end,
      innerStart,
      innerEnd,
    });
  }
  return results;
}

/** Read a single attribute value (handles ' or " or unquoted values). */
function getAttr(attrsStr, name) {
  if (!attrsStr) return null;
  const re = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const m = re.exec(attrsStr);
  if (!m) return null;
  return m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
}

/** True if the `class` attribute contains the given token. */
function hasClass(attrsStr, token) {
  const cls = getAttr(attrsStr, "class");
  if (!cls) return false;
  return cls.split(/\s+/).includes(token);
}

const ENTITY_MAP = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  hellip: "…",
};

/** Decode the small set of HTML entities we expect to see on this page. */
function decodeEntities(str) {
  return str.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, code) => {
    if (code[0] === "#") {
      const isHex = code[1] === "x" || code[1] === "X";
      const num = parseInt(isHex ? code.slice(2) : code.slice(1), isHex ? 16 : 10);
      return Number.isFinite(num) ? String.fromCodePoint(num) : whole;
    }
    return Object.prototype.hasOwnProperty.call(ENTITY_MAP, code) ? ENTITY_MAP[code] : whole;
  });
}

/** Strip nested tags and decode entities, collapsing whitespace. */
function textContent(html) {
  const stripped = html.replace(/<[^>]*>/g, " ");
  return decodeEntities(stripped).replace(/\s+/g, " ").trim();
}

export { extractElements, getAttr, hasClass, decodeEntities, textContent };
