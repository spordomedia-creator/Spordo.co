/**
 * Minimal Supabase PostgREST client for the HRPT sync worker.
 *
 * Deliberately dependency-free (plain `fetch` against PostgREST) rather
 * than pulling in `@supabase/supabase-js` — this keeps the Worker bundle
 * small and every call easily mockable in tests via an injected `fetchImpl`.
 *
 * Requires (server-side only, never in client code):
 *   env.SUPABASE_URL                — e.g. https://xxxx.supabase.co (same
 *                                     project the frontend already reads
 *                                     from; see SUPABASE_URL in
 *                                     public/TrueSpordo.html)
 *   env.SUPABASE_SERVICE_ROLE_KEY   — Wrangler secret. The anon key the
 *                                     frontend uses is read-only by RLS
 *                                     design and must NOT be used here for
 *                                     writes.
 *
 * Schema requirements this client assumes (own conceptually by
 * backend-engineer — flagged, not unilaterally migrated):
 *   field_permit_cache(field_id, permit_date, start_time, end_time, event_name)
 *     - needs a way to delete-then-replace the exact (field_id, permit_date)
 *       window a sync run covered. No unique constraint is strictly
 *       required for the delete+insert strategy used here (see sync.js),
 *       but one on (field_id, permit_date, start_time) would make a
 *       future upsert-based strategy possible and would guard against
 *       accidental duplicate rows from a retried partial insert.
 *   field_sync_meta(field_id, last_permit_sync_at, live_availability_status,
 *     permit_source_url)
 *     - needs a UNIQUE constraint on field_id for the upsert
 *       (`on_conflict=field_id`) used here to work; this table doesn't
 *       exist via migration in-repo yet, so this is a concrete ask for
 *       backend-engineer.
 */

function assertConfigured(env) {
  if (!env.SUPABASE_URL) throw new Error("SUPABASE_URL is not configured");
  if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
}

function authHeaders(env) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
}

/**
 * Delete every field_permit_cache row for `fieldId` whose permit_date falls
 * within [minDate, maxDate] (inclusive), then insert `rows`. Scoped to a
 * single field and to the exact date window the sync actually parsed, so a
 * failure on one field's block never touches another field's cached rows,
 * and dates outside what HRPT's page currently shows are left untouched.
 *
 * Never called with an empty `rows` array by the caller unless the field
 * genuinely had zero booked slots in its parsed window (a legitimate "all
 * available" result) — see sync.js for the empty-vs-failed distinction.
 */
async function replaceFieldPermitWindow(env, { table, fieldId, minDate, maxDate, rows, fetchImpl = fetch }) {
  assertConfigured(env);
  const base = `${env.SUPABASE_URL}/rest/v1/${table}`;
  const headers = authHeaders(env);

  const deleteUrl =
    `${base}?field_id=eq.${encodeURIComponent(fieldId)}` +
    `&permit_date=gte.${encodeURIComponent(minDate)}` +
    `&permit_date=lte.${encodeURIComponent(maxDate)}`;

  const deleteResp = await fetchImpl(deleteUrl, {
    method: "DELETE",
    headers: { ...headers, Prefer: "return=minimal" },
  });
  if (!deleteResp.ok) {
    throw new Error(`Supabase delete failed for field_id=${fieldId} (${deleteResp.status}): ${await safeText(deleteResp)}`);
  }

  if (rows.length === 0) return { deleted: true, inserted: 0 };

  const insertResp = await fetchImpl(base, {
    method: "POST",
    headers: { ...headers, Prefer: "return=minimal" },
    body: JSON.stringify(rows),
  });
  if (!insertResp.ok) {
    throw new Error(`Supabase insert failed for field_id=${fieldId} (${insertResp.status}): ${await safeText(insertResp)}`);
  }

  return { deleted: true, inserted: rows.length };
}

/** Upsert one field_sync_meta row (on_conflict=field_id). */
async function upsertSyncMeta(env, { table, row, fetchImpl = fetch }) {
  assertConfigured(env);
  const url = `${env.SUPABASE_URL}/rest/v1/${table}?on_conflict=field_id`;
  const resp = await fetchImpl(url, {
    method: "POST",
    headers: { ...authHeaders(env), Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([row]),
  });
  if (!resp.ok) {
    throw new Error(`Supabase sync-meta upsert failed for field_id=${row.field_id} (${resp.status}): ${await safeText(resp)}`);
  }
}

async function safeText(resp) {
  try {
    return await resp.text();
  } catch {
    return "<no body>";
  }
}

export { replaceFieldPermitWindow, upsertSyncMeta };
