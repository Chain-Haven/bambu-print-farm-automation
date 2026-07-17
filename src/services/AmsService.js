// src/services/AmsService.js — AMS/Tray Data Service + Filament Sync
import { PrinterModel } from '../models/Printer.js';
import { dbAll, dbGet, dbRun } from '../db/database.js';
import { buildTrayPayload, autoMapFilaments as catalogAutoMap, getSettingId, FILAMENT_TYPES, COLOR_PALETTE } from './FilamentCatalog.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('AmsService');

export class AmsService {
    /**
     * Get AMS slot/tray data from printer status snapshot (live from MQTT).
     */
    static getLiveTrays(printerId) {
        const printer = PrinterModel.findById(printerId);
        if (!printer || !printer.status_snapshot) return null;

        const ams = printer.status_snapshot.ams;
        if (!ams) return { available: false, slots: [] };

        const units = ams.ams || [];
        const slots = [];
        const humidity = [];

        for (const unit of units) {
            // Bambu humidity index: 1 (dry) … 5 (wet); some units omit it
            if (unit.humidity !== undefined && unit.humidity !== null && unit.humidity !== '') {
                humidity.push({ ams_id: Number(unit.id) || 0, humidity: Number(unit.humidity) });
            }
            const trays = unit.tray || [];
            for (let i = 0; i < trays.length; i++) {
                const tray = trays[i];
                slots.push({
                    slot: slots.length,
                    unit_id: unit.id,
                    tray_id: tray.id,
                    type: tray.tray_type || 'unknown',
                    color: tray.tray_color ? `#${tray.tray_color}` : null,
                    material: tray.tray_sub_brands || tray.tray_type,
                    material_name: tray.tray_sub_brands || null, // e.g. "PLA Basic"
                    temp_nozzle: tray.nozzle_temp_max,
                    temp_bed: tray.bed_temp,
                    remaining: tray.remain, // percent, -1 = unknown
                });
            }
        }

        // tray_now = GLOBAL index of the tray physically loaded in the
        // extruder right now (Bambu: 254 = external spool, 255 = none)
        const trayNowRaw = parseInt(ams.tray_now ?? '', 10);
        const tray_now = Number.isFinite(trayNowRaw) && trayNowRaw < 254 ? trayNowRaw : null;
        const external_spool_loaded = trayNowRaw === 254;

        return { available: true, slots, tray_now, external_spool_loaded, humidity };
    }

    // ─────────────────────────────────────────────
    //  DB-based AMS Configuration (user-managed)
    // ─────────────────────────────────────────────

    /**
     * Get all configured trays for a printer from the DB.
     */
    static getConfig(printerId) {
        return dbAll(
            `SELECT ams_id, tray_id, material, color_hex, color_name, setting_id
             FROM printer_ams_config
             WHERE printer_id = ?
             ORDER BY ams_id, tray_id`,
            [printerId]
        );
    }

    /**
     * Set the filament for a specific AMS tray in the DB.
     */
    static setTray(printerId, amsId, trayId, { material, colorHex = 'FFFFFFFF', colorName = 'White' }) {
        const printer = PrinterModel.findById(printerId);
        const printerModel = printer?.model || 'Bambu A1';
        const settingId = getSettingId(material, printerModel);

        // Delete existing row first, then insert (sql.js UPSERT workaround)
        dbRun(
            `DELETE FROM printer_ams_config WHERE printer_id = ? AND ams_id = ? AND tray_id = ?`,
            [printerId, amsId, trayId]
        );
        dbRun(
            `INSERT INTO printer_ams_config (printer_id, ams_id, tray_id, material, color_hex, color_name, setting_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [printerId, amsId, trayId, material, colorHex.toUpperCase(), colorName, settingId]
        );

        return { ams_id: amsId, tray_id: trayId, material, color_hex: colorHex, color_name: colorName, setting_id: settingId };
    }

    /**
     * Remove configuration for a specific tray (reset to empty).
     */
    static clearTray(printerId, amsId, trayId) {
        dbRun(
            `DELETE FROM printer_ams_config WHERE printer_id = ? AND ams_id = ? AND tray_id = ?`,
            [printerId, amsId, trayId]
        );
    }

    // ─────────────────────────────────────────────
    //  MQTT Sync — Push config to printer
    // ─────────────────────────────────────────────

    /**
     * Push all configured trays to the printer via MQTT ams_filament_setting.
     * This overrides what the printer thinks is in each AMS slot.
     */
    static async syncToDevice(printerId, mqttClient) {
        const config = this.getConfig(printerId);
        if (!config.length) {
            log.info(`No AMS config found for ${printerId}, skipping sync`);
            return [];
        }

        const printer = PrinterModel.findById(printerId);
        const printerModel = printer?.model || 'Bambu A1';
        const results = [];

        for (const tray of config) {
            try {
                const payload = buildTrayPayload({
                    amsId: tray.ams_id,
                    trayId: tray.tray_id,
                    material: tray.material,
                    colorHex: tray.color_hex,
                    printerModel,
                });
                mqttClient.setAmsTrayFilament(payload);
                results.push({ tray_id: tray.tray_id, status: 'sent', material: tray.material });

                // Small delay between commands to avoid overwhelming the printer
                await new Promise(r => setTimeout(r, 200));
            } catch (e) {
                log.warn(`Failed to sync tray ${tray.tray_id}: ${e.message}`);
                results.push({ tray_id: tray.tray_id, status: 'error', error: e.message });
            }
        }

        log.info(`Synced ${results.filter(r => r.status === 'sent').length}/${config.length} AMS trays for ${printer?.name || printerId}`);
        return results;
    }

    // ─────────────────────────────────────────────
    //  AMS Mapping for Print Jobs
    // ─────────────────────────────────────────────

    /**
     * Auto-generate ams_mapping for a print job.
     */
    static generateMapping(printerId, slicerFilaments = ['PLA']) {
        const config = this.getConfig(printerId);

        if (!config.length) {
            return slicerFilaments.map((_, i) => i);
        }

        const amsTrays = config.map(c => ({
            tray_id: c.ams_id * 4 + c.tray_id,
            material: c.material,
            color: c.color_hex,
        }));

        return catalogAutoMap(slicerFilaments, amsTrays);
    }

    /**
     * Get full AMS status: config from DB + live data from MQTT merged.
     */
    static getFullStatus(printerId) {
        const config = this.getConfig(printerId);
        const live = this.getLiveTrays(printerId);

        const configMap = {};
        for (const c of config) {
            configMap[`${c.ams_id}_${c.tray_id}`] = c;
        }

        const slots = [];
        const numSlots = live?.slots?.length || 4;
        for (let i = 0; i < numSlots; i++) {
            const amsId = Math.floor(i / 4);
            const trayId = i % 4;
            const key = `${amsId}_${trayId}`;
            const cfg = configMap[key];
            const liveSlot = live?.slots?.[i];

            slots.push({
                ams_id: amsId,
                tray_id: trayId,
                configured_material: cfg?.material || null,
                configured_color: cfg?.color_hex || null,
                configured_color_name: cfg?.color_name || null,
                configured_setting_id: cfg?.setting_id || null,
                live_type: liveSlot?.type && liveSlot.type !== 'unknown' ? liveSlot.type : null,
                live_color: liveSlot?.color || null,
                live_material_name: liveSlot?.material_name || null, // printer's own label, e.g. "PLA Basic"
                live_remaining: liveSlot?.remaining ?? null,
                loaded_now: live?.tray_now === i, // this tray is in the extruder
                // Compare the configured material's BASE tray type (e.g. "PLA Silk"
                // -> "PLA") to the live tray type, not the raw material string —
                // otherwise every subtype is falsely flagged out-of-sync.
                in_sync: AmsService._configMatchesLive(cfg, liveSlot),
            });
        }

        return {
            printer_id: printerId,
            ams_available: live?.available ?? false,
            tray_now: live?.tray_now ?? null,
            external_spool_loaded: live?.external_spool_loaded ?? false,
            humidity: live?.humidity || [],
            slots,
            filament_types: FILAMENT_TYPES.map(f => f.material),
            color_palette: COLOR_PALETTE,
        };
    }

    /** True when the loaded (live) tray type matches the configured material's base type. */
    static _configMatchesLive(cfg, liveSlot) {
        if (!cfg) return true;                 // nothing configured — nothing to mismatch
        const live = liveSlot?.type;
        if (!live) return true;                // no live reading to compare against
        const entry = FILAMENT_TYPES.find(f => f.material === cfg.material);
        const expected = entry?.trayType || cfg.material;
        return String(expected).toUpperCase() === String(live).toUpperCase();
    }

    /**
     * Auto-map requested print colors to physical AMS trays by color distance.
     * Pure function (unit-testable): colors = ['#RRGGBB', ...] in filament-slot
     * order; slots = getFullStatus().slots. Greedy nearest-color assignment,
     * one tray per color, with a distance threshold so black never silently
     * prints as white. Returns { ok, mapping: [globalTrayIdx per color] } or
     * { ok:false, error }.
     */
    static matchColorsToTrays(colors, slots, maxDistance = 120, material = null) {
        const hexToRgb = (h) => {
            if (!h) return null;
            const s = String(h).replace('#', '').slice(0, 6);
            if (s.length < 6 || /[^0-9a-fA-F]/.test(s)) return null;
            return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
        };
        const dist = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);

        // MATERIAL FIRST, then color: a white PETG spool must never satisfy a
        // white PLA print (learned the hard way). When the job specifies a
        // material, only trays reporting that material are candidates.
        const wantMat = material ? String(material).trim().toUpperCase() : null;
        const allTrays = (slots || []).map((s, i) => ({
            index: i,
            rgb: hexToRgb(s.configured_color || s.live_color),
            mat: String(s.configured_material || s.live_type || '').trim().toUpperCase(),
            label: `AMS ${s.ams_id + 1} tray ${s.tray_id + 1}`,
            desc: `${s.configured_material || s.live_type || '?'} ${s.configured_color_name || s.configured_color || s.live_color || ''}`.trim(),
        })).filter(t => t.rgb);

        const trays = wantMat ? allTrays.filter(t => t.mat === wantMat) : allTrays;

        if (!trays.length) {
            const have = allTrays.map(t => `${t.label}: ${t.desc}`).join(', ') || 'none';
            return {
                ok: false,
                error: wantMat
                    ? `No ${wantMat} spool is loaded/configured on this printer (loaded: ${have}). Load ${wantMat}, fix the tray material, or choose slots manually.`
                    : 'No AMS tray colors are configured for this printer — set tray colors on the printer page, or choose slots manually.',
            };
        }

        const wanted = colors.map((c, slot) => ({ slot, hex: c, rgb: hexToRgb(c) }));
        for (const w of wanted) {
            if (!w.rgb) return { ok: false, error: `Invalid color "${w.hex}" on filament ${w.slot + 1}` };
        }
        // Greedy global best-match-first so each color gets its closest free tray.
        const taken = new Set();
        const mapping = new Array(colors.length).fill(-1);
        const pairs = [];
        for (const w of wanted) for (const t of trays) pairs.push({ w, t, d: dist(w.rgb, t.rgb) });
        pairs.sort((a, b) => a.d - b.d);
        for (const { w, t, d } of pairs) {
            if (mapping[w.slot] !== -1 || taken.has(t.index)) continue;
            if (d > maxDistance) continue;
            mapping[w.slot] = t.index;
            taken.add(t.index);
        }
        const missing = wanted.filter(w => mapping[w.slot] === -1);
        if (missing.length) {
            const have = trays.map(t => `${t.label}: ${t.desc}`).join(', ');
            return {
                ok: false,
                error: `No AMS spool matches color ${missing.map(m => m.hex).join(', ')} closely enough. Loaded: ${have}. ` +
                    `Load a matching spool, update tray colors, or choose slots manually.`,
            };
        }
        return { ok: true, mapping, details: mapping.map((t, i) => `${colors[i]} -> ${trays.find(x => x.index === t).label}`) };
    }
}

export default AmsService;
