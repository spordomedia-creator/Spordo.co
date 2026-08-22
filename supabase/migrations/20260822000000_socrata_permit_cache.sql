-- Migration: 20260822000000_socrata_permit_cache
--
-- First Supabase migration in this repo (no supabase/migrations/ existed
-- before this — confirmed via grep for field_permit_cache/field_sync_meta
-- across the codebase; the only prior schema knowledge was the D1 DDL in
-- migrations/0001_init.sql, which is a SEPARATE backend for the HRPT sync
-- only — see CLAUDE.md's "Storage is split" section. This file does not
-- touch D1 and is not applied by `wrangler d1 migrations apply`.
--
-- Defines field_permit_cache / field_sync_meta for the NYC Open Data /
-- Socrata (tvpp-9vvx) sync (src/socrata/). Same table names as the D1
-- schema, deliberately different columns — Socrata's sync unit here is
-- "sport" (row-level permits, filterable by sport keyword), not "field_id"
-- the way HRPT's D1 cache is; see src/socrata/normalize.js for why a
-- canonical field_id mapping isn't in scope yet.
--
-- Apply with the Supabase CLI from a machine with real project access:
--   supabase link --project-ref <project-ref>   (the project this repo's
--     SUPABASE_URL in public/TrueSpordo.html already points at:
--     https://avwvtjsabmhqqeosqubw.supabase.co)
--   supabase db push
-- or paste this file's contents into the Supabase Studio SQL editor.
--
-- RLS: enabled with a public SELECT policy (mirrors the existing
-- convention that the Supabase anon key is public-by-design/read-only —
-- see CLAUDE.md). No INSERT/UPDATE/DELETE policy is defined here on
-- purpose: only the service-role key (used exclusively server-side by
-- src/socrata/supabaseClient.js, via a Wrangler secret) can write, and the
-- service role bypasses RLS entirely. Flagging for backend-engineer to
-- confirm/adjust per their access-rules ownership (per
-- .claude/skills/spordo-architecture: "you own the contents, they own the
-- access rules").

CREATE TABLE IF NOT EXISTS field_permit_cache (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'socrata',
  sport TEXT NOT NULL,
  event_location TEXT NOT NULL,
  event_borough TEXT,
  -- Stored as TEXT, not TIMESTAMPTZ: Socrata's tvpp-9vvx timestamps are
  -- floating/local (no timezone, no trailing "Z" — see
  -- .claude/skills/nyc-open-data), and the frontend already parses these
  -- as plain strings (e.g. `p.start_date_time.split('T')[1]`). Coercing to
  -- TIMESTAMPTZ would force a UTC interpretation Postgres/PostgREST would
  -- then re-serialize with an offset, silently shifting displayed times.
  start_date_time TEXT NOT NULL,
  end_date_time TEXT,
  event_name TEXT,
  event_type TEXT,
  permit_holder_name TEXT,
  organization TEXT,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The sync's delete-then-insert window strategy (see
-- src/socrata/supabaseClient.js replaceSportPermitWindow) filters on
-- exactly this shape every run, so index it to keep syncs and reads cheap
-- as the table grows.
CREATE INDEX IF NOT EXISTS idx_field_permit_cache_source_sport_start
  ON field_permit_cache (source, sport, start_date_time);

ALTER TABLE field_permit_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS field_permit_cache_public_read ON field_permit_cache;
CREATE POLICY field_permit_cache_public_read
  ON field_permit_cache
  FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE TABLE IF NOT EXISTS field_sync_meta (
  source TEXT NOT NULL,
  -- Sync unit key, e.g. "sport:soccer" for this pipeline. HRPT's D1
  -- field_sync_meta is keyed by field_id instead (different backend,
  -- different sync granularity by design — see CLAUDE.md).
  scope TEXT NOT NULL,
  last_synced_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL, -- 'synced' | future: 'error' if a partial-failure meta write is ever added
  rows_synced INTEGER NOT NULL DEFAULT 0,
  rows_dropped INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  source_url TEXT,
  PRIMARY KEY (source, scope)
);

ALTER TABLE field_sync_meta ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS field_sync_meta_public_read ON field_sync_meta;
CREATE POLICY field_sync_meta_public_read
  ON field_sync_meta
  FOR SELECT
  TO anon, authenticated
  USING (true);
