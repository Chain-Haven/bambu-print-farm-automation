-- 011_filament_spools.sql — filament spool inventory + consumption ledger.
-- Adds spool-level stock tracking (grams remaining, low-stock threshold) and a
-- consumption ledger, on top of the existing AMS tray config / reservations.

CREATE TABLE IF NOT EXISTS filament_spools (
  spool_id             TEXT PRIMARY KEY,
  name                 TEXT,
  material             TEXT NOT NULL DEFAULT 'PLA',
  color_hex            TEXT DEFAULT 'FFFFFFFF',
  color_name           TEXT DEFAULT 'Unknown',
  vendor               TEXT,
  printer_id           TEXT REFERENCES printers(printer_id) ON DELETE SET NULL,
  ams_unit             INTEGER,
  ams_tray             INTEGER,
  total_grams          REAL NOT NULL DEFAULT 1000,
  remaining_grams      REAL NOT NULL DEFAULT 1000,
  low_threshold_grams  REAL NOT NULL DEFAULT 100,
  archived             INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_filament_spools_printer ON filament_spools(printer_id);

CREATE TABLE IF NOT EXISTS filament_consumption (
  id         TEXT PRIMARY KEY,
  spool_id   TEXT NOT NULL REFERENCES filament_spools(spool_id) ON DELETE CASCADE,
  job_id     TEXT,
  grams      REAL NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_filament_consumption_spool ON filament_consumption(spool_id);
