/**
 * D1 client for the HRPT sync worker.
 *
 * Replaces supabaseClient.js (a hand-written PostgREST-over-`fetch` client)
 * now that the storage backend is Cloudflare D1. D1 is reached through a
 * Workers Binding (`env.DB`, configured in wrangler.jsonc), not an HTTP
 * REST URL — there is no bearer-token secret to configure here; access is
 * gated by the Worker's own deployment/binding, not by a credential read
 * from `env`. That's why this client is simpler than supabaseClient.js: no
 * URL building, no auth headers, no `fetchImpl` injection for tests (D1
 * statements are mocked directly instead — see d1Client.test.js).
 *
 * Schema: see migrations/0001_init.sql for the authoritative DDL. In brief:
 *   field_permit_cache(field_id, permit_date, start_time, end_time, event_name)
 *   field_sync_meta(field_id UNIQUE/PRIMARY KEY, last_permit_sync_at,
 *     live_availability_status, permit_source_url)
 *
 * Error-handling note: the Workers D1 binding's exact failure signaling
 * (a rejected promise vs. a resolved `{ success: false, error }` result)
 * has varied across D1's API evolution, so both call sites below check for
 * both: a thrown/rejected error is caught and re-wrapped, and a resolved
 * result with `success === false` is treated as a failure too. Either way
 * failures are surfaced as a thrown Error with the field/table in the
 * message, and — same integrity rule as the Supabase version — a failure
 * on one field's statements never touches another field's rows, since
 * each field's delete+insert runs in its own `env.DB.batch()` call.
 */

function assertConfigured(env) {
  if (!env.DB) throw new Error("DB (D1 binding) is not configured — see wrangler.jsonc d1_databases");
}

/** Run one prepared statement and normalize both throw- and success:false-style failures into a thrown Error. */
async function runStatement(stmt, { fieldId, table, action }) {
  let result;
  try {
    result = await stmt.run();
  } catch (err) {
    throw new Error(`D1 ${action} failed for field_id=${fieldId} on ${table}: ${err && err.message ? err.message : err}`);
  }
  if (result && result.success === false) {
    throw new Error(`D1 ${action} failed for field_id=${fieldId} on ${table}: ${result.error || "unknown error"}`);
  }
  return result;
}

/** Run a batch of prepared statements and normalize failures the same way runStatement() does. */
async function runBatch(env, stmts, { fieldId, table, action }) {
  let results;
  try {
    results = await env.DB.batch(stmts);
  } catch (err) {
    throw new Error(`D1 ${action} (batch) failed for field_id=${fieldId} on ${table}: ${err && err.message ? err.message : err}`);
  }
  const failed = Array.isArray(results) ? results.find((r) => r && r.success === false) : null;
  if (failed) {
    throw new Error(`D1 ${action} (batch) failed for field_id=${fieldId} on ${table}: ${failed.error || "unknown error"}`);
  }
  return results;
}

/**
 * Delete every field_permit_cache row for `fieldId` whose permit_date falls
 * within [minDate, maxDate] (inclusive), then insert `rows` — as a single
 * `env.DB.batch()` call, which D1 runs as one implicit transaction. That
 * gives us (at least) the same guarantee the old two-HTTP-call Supabase
 * version had to work to preserve: if the insert half fails, the delete
 * half is not left applied on its own — and it's scoped to a single
 * field's exact parsed window, so a failure here never touches another
 * field's cached rows (see sync.js for the per-field try/catch).
 *
 * Never called with an empty `rows` array by the caller unless the field
 * genuinely had zero booked slots in its parsed window (a legitimate "all
 * available" result) — see sync.js for the empty-vs-failed distinction.
 */
async function replaceFieldPermitWindow(env, { table, fieldId, minDate, maxDate, rows }) {
  assertConfigured(env);

  const deleteStmt = env.DB.prepare(
    `DELETE FROM ${table} WHERE field_id = ? AND permit_date >= ? AND permit_date <= ?`
  ).bind(fieldId, minDate, maxDate);

  if (rows.length === 0) {
    await runStatement(deleteStmt, { fieldId, table, action: "delete" });
    return { deleted: true, inserted: 0 };
  }

  const insertStmts = rows.map((r) =>
    env.DB.prepare(
      `INSERT INTO ${table} (field_id, permit_date, start_time, end_time, event_name) VALUES (?, ?, ?, ?, ?)`
    ).bind(r.field_id, r.permit_date, r.start_time, r.end_time, r.event_name)
  );

  await runBatch(env, [deleteStmt, ...insertStmts], { fieldId, table, action: "delete+insert" });

  return { deleted: true, inserted: rows.length };
}

/** Upsert one field_sync_meta row, keyed on the UNIQUE/PRIMARY KEY field_id constraint (see migrations/0001_init.sql). */
async function upsertSyncMeta(env, { table, row }) {
  assertConfigured(env);

  const stmt = env.DB.prepare(
    `INSERT INTO ${table} (field_id, last_permit_sync_at, live_availability_status, permit_source_url)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(field_id) DO UPDATE SET
       last_permit_sync_at = excluded.last_permit_sync_at,
       live_availability_status = excluded.live_availability_status,
       permit_source_url = excluded.permit_source_url`
  ).bind(row.field_id, row.last_permit_sync_at, row.live_availability_status, row.permit_source_url);

  await runStatement(stmt, { fieldId: row.field_id, table, action: "sync-meta upsert" });
}

export { replaceFieldPermitWindow, upsertSyncMeta };
