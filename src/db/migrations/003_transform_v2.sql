-- G-code Transform v2: sweep geometry, looping, fan policy
-- Adds columns to gcode_profiles for the full cool→sweep→loop pipeline
-- Defaults match validated sweep path for P1S/A1

ALTER TABLE gcode_profiles ADD COLUMN n_loops INTEGER DEFAULT 1;
ALTER TABLE gcode_profiles ADD COLUMN inter_loop_dwell_sec INTEGER DEFAULT 2;
ALTER TABLE gcode_profiles ADD COLUMN cool_target_c REAL DEFAULT 27.0;
ALTER TABLE gcode_profiles ADD COLUMN cool_use_m190_r INTEGER DEFAULT 1;
ALTER TABLE gcode_profiles ADD COLUMN z_clear_travel_mm REAL DEFAULT 200.0;
ALTER TABLE gcode_profiles ADD COLUMN z_sweep_mm REAL DEFAULT 2.0;
ALTER TABLE gcode_profiles ADD COLUMN sweep_start_x_mm REAL DEFAULT 125;
ALTER TABLE gcode_profiles ADD COLUMN sweep_start_y_mm REAL DEFAULT 250;
ALTER TABLE gcode_profiles ADD COLUMN sweep_y_top_mm REAL DEFAULT 250;
ALTER TABLE gcode_profiles ADD COLUMN sweep_y_bottom_mm REAL DEFAULT 0;
ALTER TABLE gcode_profiles ADD COLUMN sweep_x_lanes TEXT DEFAULT '[220,190,160,130,100,70,40,30]';
ALTER TABLE gcode_profiles ADD COLUMN sweep_f_xy INTEGER DEFAULT 12000;
ALTER TABLE gcode_profiles ADD COLUMN sweep_f_z INTEGER DEFAULT 10000;
ALTER TABLE gcode_profiles ADD COLUMN fan_main_during_cool INTEGER;
ALTER TABLE gcode_profiles ADD COLUMN fan_detect_from_source INTEGER DEFAULT 1;
