-- One example table. Adults create/edit/delete; everyone in the household reads
-- (see the `items` row policy in manifest.json). Every table name must be
-- prefixed with app_{appId}__ — here app_app_template__.
--
-- Migrations are additive only: add 002_*.sql, 003_*.sql for later changes.
-- Never DROP/RENAME; the runner applies each version exactly once, in order.
CREATE TABLE IF NOT EXISTS app_app_template__items (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,          -- member id of the author (plaintext: ends in _by)
  created_at TEXT NOT NULL           -- ISO timestamp (plaintext: ends in _at)
);

-- Newest-first listing.
CREATE INDEX IF NOT EXISTS app_app_template__items_created_idx
  ON app_app_template__items (created_at);
