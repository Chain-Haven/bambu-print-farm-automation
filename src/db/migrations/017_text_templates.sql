-- Text templates (SLICER_FEATURES_DIRECTIVE §7): a saved base model + a text
-- placeholder with fixed font/size/thickness/placement — everything except the
-- string. A website order fills the string; the server regenerates the text
-- geometry, merges, slices with the real engine, and queues the job.

CREATE TABLE IF NOT EXISTS text_templates (
  template_id    TEXT PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  printer_model  TEXT NOT NULL DEFAULT 'P1S',
  profile_id     TEXT,                    -- gcode_profiles for loop/eject at submit
  base_files     TEXT NOT NULL,           -- JSON [{file, name}] baked STLs (printer coords) on disk
  text_def       TEXT NOT NULL,           -- JSON {fontId,sizeMm,thicknessMm,mode,filament,matrixWorld,targetIndex,maxChars}
  settings       TEXT DEFAULT '{}',       -- JSON slicer setting overrides
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
