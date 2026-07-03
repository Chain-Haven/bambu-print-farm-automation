// src/services/PrinterRegistry.js — Printer Registry Service
// CRUD printers, derive capabilities, track status

import { PrinterModel } from '../models/Printer.js';
import { AccessoryModel } from '../models/Accessory.js';
import { EventModel } from '../models/Event.js';
import { createLogger } from '../utils/logger.js';
import { capabilitiesFor } from '../models/PrinterModels.js';

import systemEvents from '../utils/SystemEvents.js';

const log = createLogger('PrinterRegistry');

export class PrinterRegistry {
    /**
     * Register a new printer.
     */
    static create(data) {
        const capabilities = this.deriveCapabilities(data.model, []);
        const printer = PrinterModel.create({ ...data, capabilities });
        EventModel.create({
            entity_type: 'printer', entity_id: printer.printer_id,
            event_type: 'printer.registered', payload: { name: data.name, model: data.model }
        });

        // Notify system
        systemEvents.emit('printer.created', printer);

        log.info(`Printer registered: ${printer.name} (${printer.model})`);
        return printer;
    }

    static findAll() { return PrinterModel.findAll(); }
    static findById(id) { return PrinterModel.findById(id); }

    // Decrypted printer auth ({ access_code, serial }). Several routes reference
    // PrinterRegistry.getAuth(); without it they silently fell back to an empty
    // access code (broken FTPS reachability / camera / diagnostics on real printers).
    static getAuth(id) { return PrinterModel.getAuth(id); }

    static update(id, fields) {
        const printer = PrinterModel.update(id, fields);
        if (printer && fields.model) {
            // Re-derive capabilities if model changed
            const accessories = AccessoryModel.findByPrinterId(id);
            const caps = this.deriveCapabilities(fields.model, accessories);
            PrinterModel.update(id, { capabilities: caps });
        }
        return PrinterModel.findById(id);
    }

    static delete(id) {
        const printer = PrinterModel.findById(id);
        if (printer) {
            PrinterModel.delete(id);
            EventModel.create({
                entity_type: 'printer', entity_id: id,
                event_type: 'printer.removed', payload: { name: printer.name }
            });

            // Notify system
            systemEvents.emit('printer.deleted', id);

            log.info(`Printer removed: ${printer.name}`);
        }
        return printer;
    }

    /**
     * Derive capabilities from model + attached accessories.
     */
    static deriveCapabilities(model, accessories = []) {
        // Resolved through the canonical model registry; unknown models get a
        // conservative baseline.
        const base = capabilitiesFor(model) || { mqtt_control: true, ams: false, camera: false };
        const caps = { ...base };

        // Merge accessory capabilities
        for (const acc of accessories) {
            if (acc.type === 'camera') caps.camera = true;
            if (acc.type === 'door_servo') caps.door_servo = true;
            if (acc.type === 'eject_printhead') caps.eject_printhead = true;
            if (acc.type === 'scale') caps.scale = true;
        }

        return caps;
    }

    /**
     * Refresh capabilities for a printer (call after accessory changes).
     */
    static refreshCapabilities(printerId) {
        const printer = PrinterModel.findById(printerId);
        if (!printer) return null;
        const accessories = AccessoryModel.findByPrinterId(printerId);
        const model = printer.model;
        const caps = this.deriveCapabilities(model, accessories);
        PrinterModel.update(printerId, { capabilities: caps });
        return caps;
    }

    /**
     * Update printer status snapshot.
     */
    static updateStatus(printerId, statusSnapshot) {
        PrinterModel.updateStatus(printerId, statusSnapshot);
    }

    /**
     * Get printer with full details (accessories, capabilities).
     */
    static getFullDetail(printerId) {
        const printer = PrinterModel.findById(printerId);
        if (!printer) return null;
        const accessories = AccessoryModel.findByPrinterId(printerId);
        return { ...printer, accessories };
    }
}

export default PrinterRegistry;
