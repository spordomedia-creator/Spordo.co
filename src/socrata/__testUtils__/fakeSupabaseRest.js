/**
 * A minimal in-memory fake of the Supabase PostgREST HTTP surface that
 * src/socrata/supabaseClient.js and src/socrataPermitsApi.js actually call:
 * DELETE/POST to /rest/v1/<table> with `eq.`/`gte.`/`lte.` filters, and GET
 * with `select=`/`order=`/`limit=`.
 *
 * Same caveat as src/hrpt/__testUtils__/fakeD1.js: this is NOT a real
 * Postgres/PostgREST implementation. It recognizes only the exact filter
 * shapes this codebase's clients issue and applies them to a plain
 * in-memory array per table, so client request-construction and
 * response-handling logic can be unit-tested without a real Supabase
 * project. Passing tests here is not proof of real PostgREST behavior
 * (e.g. no real RLS enforcement, no real UNIQUE constraint errors).
 */

function createFakeSupabaseRest({ baseUrl = "https://fake.supabase.co", failTables = [] } = {}) {
  const tables = {
    field_permit_cache: [],
    field_sync_meta: [],
  };
  const calls = [];

  function parseFilters(searchParams) {
    // Returns a list of { column, op, value } for every `eq./gte./lte.`
    // style filter param (ignores select/order/limit/on_conflict).
    const reserved = new Set(["select", "order", "limit", "on_conflict"]);
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
        const [col, dir] = order.split(".");
        rows = [...rows].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (dir === "desc" ? -1 : 1));
      }
      const limit = u.searchParams.get("limit");
      if (limit) rows = rows.slice(0, Number(limit));
      const select = u.searchParams.get("select");
      if (select) {
        const cols = select.split(",");
        rows = rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
      }
      return { ok: true, status: 200, json: async () => rows, text: async () => JSON.stringify(rows) };
    }

    return { ok: false, status: 405, text: async () => `unsupported method ${method}` };
  }

  return { fetchImpl: handle, tables, calls };
}

export { createFakeSupabaseRest };
