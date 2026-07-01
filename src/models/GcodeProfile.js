// src/models/GcodeProfile.js — G-code transform profile data access (sql.js API)
import { dbAll, dbGet, dbRun } from '../db/database.js';
import { generateId } from '../utils/uuid.js';

export class GcodeProfileModel {
    static create(data) {
        const id = generateId();
        dbRun(
            `INSERT INTO gcode_profiles (
                profile_id, name, description, printer_model,
                remove_front_prime_line, insert_automation_tags, park_before_eject,
                release_bed_temp_c, release_temp_hysteresis_c, release_hold_seconds,
                max_cool_wait_minutes, park_x_mm, park_y_mm, park_z_mm, park_feed_mm_min,
                eject_mode, eject_params,
                n_loops, inter_loop_dwell_sec, cool_target_c, cool_use_m190_r,
                z_clear_travel_mm, z_sweep_mm,
                sweep_start_x_mm, sweep_start_y_mm,
                sweep_y_top_mm, sweep_y_bottom_mm, sweep_x_lanes,
                sweep_f_xy, sweep_f_z,
                fan_main_during_cool, fan_detect_from_source
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [id, data.name, data.description || '',
                data.printer_model || '*',
                data.remove_front_prime_line !== false ? 1 : 0,
                data.insert_automation_tags !== false ? 1 : 0,
                data.park_before_eject !== false ? 1 : 0,
                data.release_bed_temp_c ?? 27.0,
                data.release_temp_hysteresis_c ?? 0.5,
                data.release_hold_seconds ?? 20,
                data.max_cool_wait_minutes ?? 45,
                data.park_x_mm ?? 5,
                data.park_y_mm ?? null,
                data.park_z_mm ?? 25,
                data.park_feed_mm_min ?? 6000,
                data.eject_mode || 'printhead_push',
                JSON.stringify(data.eject_params || {}),
                // New v2 columns
                data.n_loops ?? 1,
                data.inter_loop_dwell_sec ?? 2,
                data.cool_target_c ?? 27.0,
                data.cool_use_m190_r !== false ? 1 : 0,
                data.z_clear_travel_mm ?? 200.0,
                data.z_sweep_mm ?? 2.0,
                data.sweep_start_x_mm ?? 125,
                data.sweep_start_y_mm ?? 250,
                data.sweep_y_top_mm ?? 250,
                data.sweep_y_bottom_mm ?? 0,
                JSON.stringify(data.sweep_x_lanes || [220, 190, 160, 130, 100, 70, 40, 30]),
                data.sweep_f_xy ?? 12000,
                data.sweep_f_z ?? 10000,
                data.fan_main_during_cool ?? null,
                data.fan_detect_from_source !== false ? 1 : 0,
            ]
        );
        return this.findById(id);
    }

    static findAll() {
        return dbAll('SELECT * FROM gcode_profiles ORDER BY name ASC').map(r => this._parse(r));
    }

    static findById(id) {
        const row = dbGet('SELECT * FROM gcode_profiles WHERE profile_id = ?', [id]);
        return row ? this._parse(row) : null;
    }

    static findByName(name) {
        // NOCASE: system profiles were renamed to title case by migration 004
        // ("universal" → "Universal"); lookups predate the rename.
        const row = dbGet('SELECT * FROM gcode_profiles WHERE name = ? COLLATE NOCASE', [name]);
        return row ? this._parse(row) : null;
    }

    static findByModel(model) {
        return dbAll("SELECT * FROM gcode_profiles WHERE printer_model = ? OR printer_model = '*'", [model]).map(r => this._parse(r));
    }

    static update(id, fields) {
        const allowed = ['name', 'description', 'printer_model', 'remove_front_prime_line',
            'insert_automation_tags', 'park_before_eject', 'release_bed_temp_c',
            'release_temp_hysteresis_c', 'release_hold_seconds', 'max_cool_wait_minutes',
            'park_x_mm', 'park_y_mm', 'park_z_mm', 'park_feed_mm_min', 'eject_mode', 'eject_params',
            'n_loops', 'inter_loop_dwell_sec', 'cool_target_c', 'cool_use_m190_r',
            'cooldown_mode', 'cool_time_minutes',
            'z_clear_travel_mm', 'z_sweep_mm',
            'sweep_start_x_mm', 'sweep_start_y_mm',
            'sweep_y_top_mm', 'sweep_y_bottom_mm', 'sweep_x_lanes',
            'sweep_f_xy', 'sweep_f_z',
            'fan_main_during_cool', 'fan_detect_from_source'];
        const sets = []; const vals = [];
        for (const [k, v] of Object.entries(fields)) {
            if (!allowed.includes(k)) continue;
            sets.push(`${k} = ?`);
            vals.push(k === 'eject_params' || k === 'sweep_x_lanes' ? JSON.stringify(v) : v);
        }
        if (sets.length === 0) return this.findById(id);
        sets.push("updated_at = datetime('now')");
        vals.push(id);
        dbRun(`UPDATE gcode_profiles SET ${sets.join(', ')} WHERE profile_id = ?`, vals);
        return this.findById(id);
    }

    static delete(id) { dbRun('DELETE FROM gcode_profiles WHERE profile_id = ?', [id]); }

    static _parse(row) {
        return {
            ...row,
            remove_front_prime_line: !!row.remove_front_prime_line,
            insert_automation_tags: !!row.insert_automation_tags,
            park_before_eject: !!row.park_before_eject,
            cool_use_m190_r: row.cool_use_m190_r == null ? true : !!row.cool_use_m190_r,
            fan_detect_from_source: row.fan_detect_from_source == null ? true : !!row.fan_detect_from_source,
            eject_params: _pj(row.eject_params, {}),
            sweep_x_lanes: _pj(row.sweep_x_lanes, [220, 190, 160, 130, 100, 70, 40, 30]),
        };
    }
}

function _pj(v, fb) { if (!v) return fb; try { return JSON.parse(v); } catch { return fb; } }

export default GcodeProfileModel;
