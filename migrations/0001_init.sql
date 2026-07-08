-- Migration number: 0001    2026-07-08T00:00:00.000Z
--
-- Initial D1 schema for the permit-sync pipeline. Written for the HRPT
-- sync (src/hrpt/) but shaped to also serve the not-yet-built NYC Open
-- Data / Socrata (tvpp-9vvx) sync, per data-pipeline-engineer's mandate
-- that both sources write the same field_permit_cache / field_sync_meta
-- shape. This file is the canonical DDL for that shape — keep
-- src/hrpt/d1Client.js in sync if columns ever change.
--
-- Apply with:
--   wrangler d1 migrations apply spordo-hrpt --remote   (production)
--   wrangler d1 migrations apply spordo-hrpt --local    (local/dev)
-- See wrangler.jsonc for the full provisioning steps (this migration
-- can't be applied until the D1 database itself has been created there).

CREATE TABLE IF NOT EXISTS field_permit_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  field_id TEXT NOT NULL,
  permit_date TEXT NOT NULL,      -- ISO date, e.g. "2026-06-28"
  start_time TEXT,                -- e.g. "18:00"; nullable for rows without a parsed time
  end_time TEXT,
  event_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The sync's delete-then-insert window strategy (see
-- src/hrpt/d1Client.js replaceFieldPermitWindow) filters on exactly this
-- pair on every run, so index it to keep syncs cheap as the table grows.
CREATE INDEX IF NOT EXISTS idx_field_permit_cache_field_date
  ON field_permit_cache (field_id, permit_date);

CREATE TABLE IF NOT EXISTS field_sync_meta (
  -- field_id as PRIMARY KEY gives us the UNIQUE constraint the upsert
  -- (`ON CONFLICT(field_id) DO UPDATE`, see src/hrpt/d1Client.js
  -- upsertSyncMeta) requires — this was a known open item carried over
  -- from the Supabase plan (that table never got a UNIQUE constraint
  -- migrated in-repo either) and is fixed here.
  field_id TEXT PRIMARY KEY,
  last_permit_sync_at TEXT NOT NULL,
  live_availability_status TEXT,
  permit_source_url TEXT
);
