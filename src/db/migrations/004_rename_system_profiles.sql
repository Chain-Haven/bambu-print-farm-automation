-- Migration: Rename defaults and add is_system flag
ALTER TABLE gcode_profiles ADD COLUMN is_system INTEGER DEFAULT 0;

UPDATE gcode_profiles SET name='P1S', is_system=1 WHERE name='p1s_default';
UPDATE gcode_profiles SET name='A1 Mini', is_system=1 WHERE name='a1_default';
UPDATE gcode_profiles SET name='X1 Carbon', is_system=1 WHERE name='x1c_default';
UPDATE gcode_profiles SET name='Universal', is_system=1 WHERE name='universal';
