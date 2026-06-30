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

        for (const unit of units) {
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
                    temp_nozzle: tray.nozzle_temp_max,
                    temp_bed: tray.bed_temp,
                    remaining: tray.remain,
                });
            }
        }

        return { available: true, slots };
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
                live_type: liveSlot?.type || null,
                live_color: liveSlot?.color || null,
                live_remaining: liveSlot?.remaining ?? null,
                in_sync: cfg ? (liveSlot?.type === cfg.material) : true,
            });
        }

        return {
            printer_id: printerId,
            ams_available: live?.available ?? false,
            slots,
            filament_types: FILAMENT_TYPES.map(f => f.material),
            color_palette: COLOR_PALETTE,
        };
    }
}

export default AmsService;
