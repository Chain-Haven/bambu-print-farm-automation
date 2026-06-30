// src/db/seeds/default_profiles.js — Seed default G-code transform profiles (sql.js API)
import { dbGet, dbRun } from '../database.js';
import { generateId } from '../../utils/uuid.js';

const DEFAULT_EJECT_PARAMS = {
    servo_open_us: 1100,
    servo_push_us: 1900,
    servo_travel_time_ms: 900,
    push_force_limit_ms: 1800,
    pre_push_tap_cycles: 1,
    push_cycles: 2,
    push_cycle_delay_ms: 700,
    max_eject_attempts: 3,
};

const PROFILES = [
    {
        name: 'A1',
        description: 'Default profile for Bambu A1 (Full Size)',
        printer_model: 'Bambu A1',
        park_y_mm: 251,
        eject_params: DEFAULT_EJECT_PARAMS,
        is_system: 1
    },
    {
        name: 'A1 Mini',
        description: 'Default profile for Bambu A1 Mini',
        printer_model: 'Bambu A1 Mini',
        park_y_mm: 175,
        eject_params: DEFAULT_EJECT_PARAMS,
        is_system: 1
    },
    {
        name: 'P1S',
        description: 'Default profile for Bambu P1S',
        printer_model: 'Bambu P1S',
        park_y_mm: 251,
        eject_params: DEFAULT_EJECT_PARAMS,
        is_system: 1
    },
    {
        name: 'X1 Carbon',
        description: 'Default profile for Bambu X1 Carbon',
        printer_model: 'Bambu X1C',
        park_y_mm: 251,
        eject_params: DEFAULT_EJECT_PARAMS,
        is_system: 1
    },
    {
        name: 'Universal',
        description: 'Universal fallback profile (any printer model)',
        printer_model: '*',
        park_y_mm: 200,
        eject_params: DEFAULT_EJECT_PARAMS,
        is_system: 1
    },
];

export function seedDefaultProfiles() {
    const existing = dbGet('SELECT COUNT(*) as cnt FROM gcode_profiles');
    if (existing && existing.cnt > 0) return;

    for (const p of PROFILES) {
        dbRun(
            `INSERT INTO gcode_profiles (profile_id, name, description, printer_model, park_y_mm, eject_params, is_system)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [generateId(), p.name, p.description, p.printer_model, p.park_y_mm, JSON.stringify(p.eject_params), p.is_system || 0]
        );
    }
}
