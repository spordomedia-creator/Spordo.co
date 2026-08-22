/**
 * Minimal Supabase PostgREST client for the Socrata sync worker.
 *
 * Deliberately dependency-free (plain `fetch` against PostgREST) rather
 * than pulling in `@supabase/supabase-js` — same rationale as the old
 * src/hrpt/supabaseClient.js (removed in commit 4897b5a when HRPT moved to
 * D1; this is a new, sport-scoped sibling, not a revival of that file).
 * Small bundle, every call trivially mockable via an injected `fetchImpl`.
 *
 * Requires (server-side only, Wrangler secrets, never in client code):
 *   env.SUPABASE_URL                — same project the frontend already
 *                                     reads from (SUPABASE_URL in
 *                                     public/TrueSpordo.html); not secret,
 *                                     but still read from env for parity
 *                                     with the service-role key and to
 *                                     avoid hardcoding a project URL twice.
 *   env.SUPABASE_SERVICE_ROLE_KEY   — Wrangler secret. The anon key the
 *                                     frontend uses is public-by-design and
 *                                     RLS-read-only; writes must use the
 *                                     service-role key, which bypasses RLS
 *                                     and must never reach client code.
 *
 * Sync unit here is (source, sport) rather than HRPT's (field_id) — see
 * normalize.js's doc comment for why Socrata rows aren't grouped into a
 * canonical field_id at sync time. field_permit_cache rows are scoped by
 * `sport`; field_sync_meta rows are scoped by `scope` (e.g. "sport:soccer")
 * so per-sport freshness/failure is independently trackable, mirroring the
 * per-field granularity HRPT's sync/d1Client.js already established.
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

async function safeText(resp) {
  try {
    return await resp.text();
  } catch {
    return "<no body>";
  }
}

/**
 * Delete every field_permit_cache row for `sport` whose start_date_time
 * falls within [minDateIso, maxDateIso] (inclusive of the whole end date),
 * then insert `rows`. Scoped to a single sport's exact fetched window, so a
 * failure/partial run for one sport never touches another sport's cached
 * rows, and — critically — never deletes rows for OTHER sports that happen
 * to reference the same physical field (a field can host soccer AND
 * football permits; those are separate cache rows tagged by sport, not a
 * single per-field record).
 *
 * Never called with an empty `rows` array unless the sport genuinely had
 * zero matching permits in its fetched window (a legitimate "nothing
 * currently booked" result, distinct from a failed fetch — see sync.js).
 */
async function replaceSportPermitWindow(env, { table, sport, minDateIso, maxDateIso, rows, fetchImpl = fetch }) {
  assertConfigured(env);
  const base = `${env.SUPABASE_URL}/rest/v1/${table}`;
  const headers = authHeaders(env);

  const deleteUrl =
    `${base}?source=eq.socrata&sport=eq.${encodeURIComponent(sport)}` +
    `&start_date_time=gte.${encodeURIComponent(minDateIso + "T00:00:00.000")}` +
    `&start_date_time=lte.${encodeURIComponent(maxDateIso + "T23:59:59.999")}`;

  const deleteResp = await fetchImpl(deleteUrl, {
    method: "DELETE",
    headers: { ...headers, Prefer: "return=minimal" },
  });
  if (!deleteResp.ok) {
    throw new Error(`Supabase delete failed for sport=${sport} (${deleteResp.status}): ${await safeText(deleteResp)}`);
  }

  if (rows.length === 0) return { deleted: true, inserted: 0 };

  const insertResp = await fetchImpl(base, {
    method: "POST",
    headers: { ...headers, Prefer: "return=minimal" },
    body: JSON.stringify(rows),
  });
  if (!insertResp.ok) {
    throw new Error(`Supabase insert failed for sport=${sport} (${insertResp.status}): ${await safeText(insertResp)}`);
  }

  return { deleted: true, inserted: rows.length };
}

/** Upsert one field_sync_meta row, keyed on (source, scope). */
async function upsertSyncMeta(env, { table, row, fetchImpl = fetch }) {
  assertConfigured(env);
  const url = `${env.SUPABASE_URL}/rest/v1/${table}?on_conflict=source,scope`;
  const resp = await fetchImpl(url, {
    method: "POST",
    headers: { ...authHeaders(env), Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([row]),
  });
  if (!resp.ok) {
    throw new Error(`Supabase sync-meta upsert failed for scope=${row.scope} (${resp.status}): ${await safeText(resp)}`);
  }
}

export { replaceSportPermitWindow, upsertSyncMeta, assertConfigured };
