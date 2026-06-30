-- Antigravity Initial Schema
-- Compatible with SQLite (primary) and PostgreSQL (future)

-- ============================================================
-- PRINTERS
-- ============================================================
CREATE TABLE IF NOT EXISTS printers (
  printer_id   TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  model        TEXT NOT NULL,
  ip_hostname  TEXT NOT NULL,
  auth         TEXT,                -- encrypted JSON
  capabilities TEXT DEFAULT '{}',   -- JSON, derived & cached
  camera_url   TEXT,
  status_snapshot TEXT,             -- JSON, cached latest status
  last_seen    TEXT,                -- ISO-8601 timestamp
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_printers_model ON printers(model);

-- ============================================================
-- ACCESSORIES
-- ============================================================
CREATE TABLE IF NOT EXISTS accessories (
  accessory_id    TEXT PRIMARY KEY,
  type            TEXT NOT NULL CHECK(type IN (
                    'door_servo','eject_printhead','camera','scale'
                  )),
  printer_id      TEXT REFERENCES printers(printer_id) ON DELETE SET NULL,
  connection_type TEXT NOT NULL CHECK(connection_type IN ('http','mqtt','usb_serial')),
  endpoint        TEXT NOT NULL,    -- JSON: URL, broker+topic, or tty path
  capabilities    TEXT DEFAULT '{}',
  calibration     TEXT DEFAULT '{}',
  last_seen       TEXT,
  health          TEXT DEFAULT 'unknown' CHECK(health IN (
                    'online','offline','degraded','unknown'
                  )),
  last_error      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_accessories_printer ON accessories(printer_id);
CREATE INDEX IF NOT EXISTS idx_accessories_type    ON accessories(type);

-- ============================================================
-- COMMANDS (Command Bus)
-- ============================================================
CREATE TABLE IF NOT EXISTS commands (
  command_id      TEXT PRIMARY KEY,
  target_type     TEXT NOT NULL CHECK(target_type IN ('printer','accessory')),
  target_id       TEXT NOT NULL,
  action          TEXT NOT NULL,
  params          TEXT DEFAULT '{}',
  requested_by    TEXT,
  idempotency_key TEXT,
  status          TEXT NOT NULL DEFAULT 'queued' CHECK(status IN (
                    'queued','sent','ack','done','failed','timeout','canceled'
                  )),
  timeout_seconds INTEGER DEFAULT 30,
  max_retries     INTEGER DEFAULT 0,
  attempt_count   INTEGER DEFAULT 0,
  result          TEXT,
  error           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_commands_target  ON commands(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_commands_status  ON commands(status);
CREATE INDEX IF NOT EXISTS idx_commands_idemp   ON commands(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_commands_created ON commands(created_at);

-- ============================================================
-- EVENTS (Timeline / Audit)
-- ============================================================
CREATE TABLE IF NOT EXISTS events (
  event_id    TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK(entity_type IN (
                'printer','accessory','job','system','command'
              )),
  entity_id   TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  payload     TEXT DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_entity  ON events(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_events_type    ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);

-- ============================================================
-- G-CODE TRANSFORM PROFILES
-- ============================================================
CREATE TABLE IF NOT EXISTS gcode_profiles (
  profile_id              TEXT PRIMARY KEY,
  name                    TEXT NOT NULL UNIQUE,
  description             TEXT DEFAULT '',
  printer_model           TEXT DEFAULT '*',
  remove_front_prime_line INTEGER DEFAULT 1,  -- bool
  insert_automation_tags  INTEGER DEFAULT 1,
  park_before_eject       INTEGER DEFAULT 1,
  release_bed_temp_c      REAL    DEFAULT 27.0,
  release_temp_hysteresis_c REAL  DEFAULT 0.5,
  release_hold_seconds    INTEGER DEFAULT 20,
  max_cool_wait_minutes   INTEGER DEFAULT 45,
  park_x_mm               REAL    DEFAULT 5.0,
  park_y_mm               REAL,                -- NULL = auto by model
  park_z_mm               REAL    DEFAULT 25.0,
  park_feed_mm_min        INTEGER DEFAULT 6000,
  eject_mode              TEXT    DEFAULT 'printhead_push',
  eject_params            TEXT    DEFAULT '{}',
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- JOBS
-- ============================================================
CREATE TABLE IF NOT EXISTS jobs (
  job_id              TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  printer_id          TEXT REFERENCES printers(printer_id) ON DELETE SET NULL,
  status              TEXT NOT NULL DEFAULT 'queued' CHECK(status IN (
                        'queued','assigned','uploading','printing',
                        'paused','completed','failed','canceled'
                      )),
  source_file_name    TEXT,
  transformed_file_name TEXT,
  profile_id          TEXT REFERENCES gcode_profiles(profile_id),
  transform_report    TEXT,          -- JSON
  diff_summary        TEXT,          -- JSON
  ams_roles           TEXT,          -- JSON
  repeat_total        INTEGER DEFAULT 1,
  repeat_remaining    INTEGER DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_printer ON jobs(printer_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status  ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);

-- ============================================================
-- JOB RUNS
-- ============================================================
CREATE TABLE IF NOT EXISTS job_runs (
  run_id     TEXT PRIMARY KEY,
  job_id     TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
  printer_id TEXT REFERENCES printers(printer_id) ON DELETE SET NULL,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
               'pending','printing','completed','failed','canceled'
             )),
  started_at TEXT,
  ended_at   TEXT,
  result     TEXT,   -- JSON
  error      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jobruns_job ON job_runs(job_id);
CREATE INDEX IF NOT EXISTS idx_jobruns_printer ON job_runs(printer_id);

-- ============================================================
-- AUTH USERS (simple single-user initially)
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  user_id       TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'admin',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
