/**
 * A minimal in-memory fake of the D1 Workers Binding surface area that
 * src/hrpt/d1Client.js actually calls: `env.DB.prepare(sql).bind(...).run()`
 * and `env.DB.batch([...])`.
 *
 * IMPORTANT — what this is and isn't:
 *   - It is NOT a SQL engine. It recognizes only the exact statement shapes
 *     d1Client.js issues today (a windowed DELETE, a plain multi-column
 *     INSERT, and an `INSERT ... ON CONFLICT(field_id) DO UPDATE` upsert)
 *     and applies them to a plain in-memory array per table.
 *   - It exists so d1Client.js's request-construction and
 *     error-propagation logic (which statements get built, in what order,
 *     with what bound args, and how failures surface) can be unit-tested
 *     with plain `node --test`, without requiring the Workers runtime.
 *   - It does NOT exercise real D1/SQLite semantics: no real transactions
 *     (a "batch" here applies statements one at a time and does not roll
 *     back earlier statements in the same batch if a later one fails),
 *     no real constraint enforcement, no real SQL parsing. Passing tests
 *     against this fake is not proof the real D1 database behaves
 *     identically — that requires `wrangler dev` (Miniflare-backed local
 *     D1) or a real D1 instance, which this project's `node --test` setup
 *     deliberately does not spin up. If that gap matters for a given
 *     change, say so rather than treating these tests as full coverage.
 */

function createFakeD1({ failTables = [] } = {}) {
  const tables = {
    field_permit_cache: [],
    field_sync_meta: [],
  };
  const calls = [];

  function tableNameFromSql(sql) {
    const m = sql.match(/(?:FROM|INTO)\s+(\w+)/i);
    return m ? m[1] : null;
  }

  function execute(sql, args) {
    const table = tableNameFromSql(sql);
    calls.push({ sql, args, table });

    if (table && failTables.includes(table)) {
      return { success: false, error: `simulated failure for table ${table}` };
    }
    if (!table || !(table in tables)) {
      return { success: false, error: `fake D1: unknown table in statement: ${sql}` };
    }

    const trimmed = sql.trim();

    if (/^DELETE/i.test(trimmed)) {
      const [fieldId, minDate, maxDate] = args;
      tables[table] = tables[table].filter(
        (row) => !(row.field_id === fieldId && row.permit_date >= minDate && row.permit_date <= maxDate)
      );
      return { success: true };
    }

    if (/^INSERT/i.test(trimmed)) {
      if (table === "field_permit_cache") {
        const [field_id, permit_date, start_time, end_time, event_name] = args;
        tables[table].push({ field_id, permit_date, start_time, end_time, event_name });
        return { success: true };
      }
      if (table === "field_sync_meta") {
        const [field_id, last_permit_sync_at, live_availability_status, permit_source_url] = args;
        const idx = tables[table].findIndex((row) => row.field_id === field_id);
        const row = { field_id, last_permit_sync_at, live_availability_status, permit_source_url };
        if (idx >= 0) tables[table][idx] = row;
        else tables[table].push(row);
        return { success: true };
      }
    }

    return { success: false, error: `fake D1 does not recognize statement: ${sql}` };
  }

  function makeStatement(sql) {
    let boundArgs = [];
    return {
      bind(...args) {
        boundArgs = args;
        return this;
      },
      async run() {
        return execute(sql, boundArgs);
      },
      // Exposed for batch(): batch() needs to run the same bound statement.
      _sql: sql,
      _args: () => boundArgs,
    };
  }

  const db = {
    prepare(sql) {
      return makeStatement(sql);
    },
    async batch(statements) {
      const results = [];
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      return results;
    },
  };

  return { db, tables, calls };
}

export { createFakeD1 };
