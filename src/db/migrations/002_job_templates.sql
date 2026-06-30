-- Job Templates table
CREATE TABLE IF NOT EXISTS job_templates (
  template_id   TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT DEFAULT '',
  profile_id    TEXT REFERENCES gcode_profiles(profile_id),
  printer_id    TEXT REFERENCES printers(printer_id),
  source_file_name TEXT,
  source_file_path TEXT,
  ams_roles     TEXT,
  repeat_total  INTEGER DEFAULT 1,
  tags          TEXT DEFAULT '[]',
  last_used_at  TEXT,
  use_count     INTEGER DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
