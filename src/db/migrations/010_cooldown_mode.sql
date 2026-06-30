-- Cooldown mode: let a profile choose how it waits before ejecting.
--   'temperature' = wait until the plate cools to release_bed_temp_c (repeated M190 S)
--   'time'        = wait a fixed duration (G4 dwell), ignoring temperature
-- These are mutually exclusive — exactly one applies.

ALTER TABLE gcode_profiles ADD COLUMN cooldown_mode TEXT DEFAULT 'temperature';
ALTER TABLE gcode_profiles ADD COLUMN cool_time_minutes INTEGER DEFAULT 30;
