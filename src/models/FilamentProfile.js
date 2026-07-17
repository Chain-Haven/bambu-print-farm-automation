// src/models/FilamentProfile.js — custom filament profile data access (sql.js API)
// A profile = named bundle of OrcaSlicer filament-setting overrides applied on
// top of the bundled material preset at slice time.
import { dbAll, dbGet, dbRun } from '../db/database.js';
import { generateId } from '../utils/uuid.js';

const parse = (row) => row && { ...row, settings: JSON.parse(row.settings || '{}') };

export class FilamentProfileModel {
    static create({ name, material = 'PLA', settings = {} }) {
        const id = generateId();
        dbRun(
            `INSERT INTO filament_profiles (profile_id, name, material, settings) VALUES (?,?,?,?)`,
            [id, String(name).trim(), String(material).toUpperCase(), JSON.stringify(settings)]
        );
        return this.findById(id);
    }

    static update(id, { name, material, settings }) {
        const existing = this.findById(id);
        if (!existing) return null;
        dbRun(
            `UPDATE filament_profiles SET name = ?, material = ?, settings = ?, updated_at = datetime('now') WHERE profile_id = ?`,
            [
                name !== undefined ? String(name).trim() : existing.name,
                material !== undefined ? String(material).toUpperCase() : existing.material,
                settings !== undefined ? JSON.stringify(settings) : JSON.stringify(existing.settings),
                id,
            ]
        );
        return this.findById(id);
    }

    static findById(id) { return parse(dbGet(`SELECT * FROM filament_profiles WHERE profile_id = ?`, [id])); }
    static findByName(name) { return parse(dbGet(`SELECT * FROM filament_profiles WHERE name = ? COLLATE NOCASE`, [name])); }
    static findAll() { return dbAll(`SELECT * FROM filament_profiles ORDER BY name`).map(parse); }
    static delete(id) { dbRun(`DELETE FROM filament_profiles WHERE profile_id = ?`, [id]); }
}

export default FilamentProfileModel;
