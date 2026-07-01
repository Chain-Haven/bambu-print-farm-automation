-- 012_printer_maintenance.sql — per-printer maintenance tasks with an odometer.
-- The "odometer" (cumulative print hours) is derived from completed job_runs;
-- each task remembers the odometer reading when it was last done, so "due" is
-- (current_odometer_hours - hours_at_last_done) >= interval_hours.

CREATE TABLE IF NOT EXISTS printer_maintenance (
  id                  TEXT PRIMARY KEY,
  printer_id          TEXT NOT NULL REFERENCES printers(printer_id) ON DELETE CASCADE,
  task                TEXT NOT NULL,
  interval_hours      REAL NOT NULL DEFAULT 200,
  hours_at_last_done  REAL NOT NULL DEFAULT 0,
  last_done_at        TEXT,
  notes               TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_printer_maintenance_printer ON printer_maintenance(printer_id);
