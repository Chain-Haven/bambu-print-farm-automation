-- Migration: Fix A1 name and add A1 Mini
UPDATE gcode_profiles SET name='A1' WHERE name='A1 Mini';

-- Insert A1 Mini profile if not exists
INSERT INTO gcode_profiles (profile_id, name, description, printer_model, park_y_mm, eject_params, is_system)
SELECT
  'profile_a1_mini_sys',
  'A1 Mini',
  'Default profile for Bambu A1 Mini',
  'Bambu A1 Mini',
  175,
  '{"servo_open_us":1100,"servo_push_us":1900,"servo_travel_time_ms":900,"push_force_limit_ms":1800,"pre_push_tap_cycles":1,"push_cycles":2,"push_cycle_delay_ms":700,"max_eject_attempts":3}',
  1
WHERE NOT EXISTS (SELECT 1 FROM gcode_profiles WHERE name = 'A1 Mini');
