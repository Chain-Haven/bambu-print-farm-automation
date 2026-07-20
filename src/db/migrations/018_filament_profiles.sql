-- Custom filament profiles: a named, reusable bundle of filament setting
-- overrides (SLICER_SETTING_FIELDS keys with target=filament) applied on top
-- of the bundled Bambu/Generic material preset at slice time. The engine's
-- preset stays the base — these are user tweaks, same knobs as OrcaSlicer.

CREATE TABLE IF NOT EXISTS filament_profiles (
  profile_id  TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  material    TEXT NOT NULL DEFAULT 'PLA',  -- base material whose preset these settings modify
  settings    TEXT NOT NULL DEFAULT '{}',   -- JSON {orca_filament_key: value}
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
