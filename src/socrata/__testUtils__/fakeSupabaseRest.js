/**
 * A minimal in-memory fake of the Supabase PostgREST HTTP surface that
 * src/socrata/supabaseClient.js and src/socrataPermitsApi.js actually call:
 * DELETE/POST to /rest/v1/<table> with `eq.`/`gte.`/`lte.` filters, and GET
 * with `select=`/`order=`/`limit=`/`offset=` (+ `Prefer: count=exact`).
 *
 * GET models Supabase's "Max rows" cap (`maxRows`, 1,000 by default like a
 * real project): no response carries more rows than that, whatever `limit`
 * asks for, and Content-Range reports what was returned. The old fake applied
 * `limit` as-is, which is how a single `limit=20000` read passed every test
 * here while production silently got the first 1,000 rows.
 *
 * Same caveat as src/hrpt/__testUtils__/fakeD1.js: this is NOT a real
 * Postgres/PostgREST implementation. It recognizes only the exact filter
 * shapes this codebase's clients issue and applies them to a plain
 * in-memory array per table, so client request-construction and
 * response-handling logic can be unit-tested without a real Supabase
 * project. Passing tests here is not proof of real PostgREST behavior
 * (e.g. no real RLS enforcement, no real UNIQUE constraint errors).
 */

function createFakeSupabaseRest({ baseUrl = "https://fake.supabase.co", failTables = [], maxRows = 1000 } = {}) {
  const tables = {
    field_permit_cache: [],
    field_sync_meta: [],
  };
  const calls = [];

  function parseFilters(searchParams) {
    // Returns a list of { column, op, value } for every `eq./gte./lte.`
    // style filter param (ignores select/order/limit/offset/on_conflict).
    const reserved = new Set(["select", "order", "limit", "offset", "on_conflict"]);
    const filters = [];
    for (const [key, raw] of searchParams.entries()) {
      if (reserved.has(key)) continue;
      const m = raw.match(/^(eq|gte|lte)\.(.*)$/);
      if (m) filters.push({ column: key, op: m[1], value: m[2] });
    }
    return filters;
  }

  function rowMatches(row, filters) {
    return filters.every(({ column, op, value }) => {
      const v = row[column];
      if (op === "eq") return String(v) === decodeURIComponent(value);
      if (op === "gte") return v !== null && v !== undefined && v >= decodeURIComponent(value);
      if (op === "lte") return v !== null && v !== undefined && v <= decodeURIComponent(value);
      return false;
    });
  }

  async function handle(url, init = {}) {
    const u = new URL(url, baseUrl);
    const table = u.pathname.replace(/^\/rest\/v1\//, "");
    const method = (init.method || "GET").toUpperCase();
    calls.push({ table, method, url });

    if (failTables.includes(table)) {
      return {
        ok: false,
        status: 500,
        json: async () => ({ message: `simulated failure for table ${table}` }),
        text: async () => `simulated failure for table ${table}`,
      };
    }
    if (!(table in tables)) {
      return { ok: false, status: 404, text: async () => `unknown table ${table}` };
    }

    const filters = parseFilters(u.searchParams);

    if (method === "DELETE") {
      tables[table] = tables[table].filter((row) => !rowMatches(row, filters));
      return { ok: true, status: 204, text: async () => "" };
    }

    if (method === "POST") {
      const body = init.body ? JSON.parse(init.body) : [];
      const onConflict = u.searchParams.get("on_conflict");
      for (const row of body) {
        if (onConflict) {
          const keyCols = onConflict.split(",");
          const idx = tables[table].findIndex((r) => keyCols.every((c) => r[c] === row[c]));
          if (idx >= 0) tables[table][idx] = { ...tables[table][idx], ...row };
          else tables[table].push({ ...row });
        } else {
          tables[table].push({ ...row });
        }
      }
      return { ok: true, status: 201, text: async () => "" };
    }

    if (method === "GET") {
      let rows = tables[table].filter((row) => rowMatches(row, filters));
      const order = u.searchParams.get("order");
      if (order) {
        // "col.dir[,col.dir...]". Array sort is stable, so full ties keep insertion order.
        const keys = order.split(",").map((part) => part.split("."));
        rows = [...rows].sort((a, b) => {
          for (const [col, dir] of keys) {
            const cmp = a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0;
            if (cmp) return dir === "desc" ? -cmp : cmp;
          }
          return 0;
        });
      }
      const total = rows.length;
      const offset = Number(u.searchParams.get("offset") || 0);
      const limit = u.searchParams.get("limit") ? Number(u.searchParams.get("limit")) : Infinity;
      rows = rows.slice(offset, offset + Math.min(limit, maxRows));
      const select = u.searchParams.get("select");
      if (select) {
        const cols = select.split(",");
        rows = rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
      }
      const counted = /count=exact/.test((init.headers && init.headers.Prefer) || "");
      const range = `${rows.length ? `${offset}-${offset + rows.length - 1}` : "*"}/${counted ? total : "*"}`;
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { "Content-Type": "application/json", "Content-Range": range },
      });
    }

    return { ok: false, status: 405, text: async () => `unsupported method ${method}` };
  }

  return { fetchImpl: handle, tables, calls };
}

export { createFakeSupabaseRest };
