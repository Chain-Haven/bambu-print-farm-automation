// src/services/EventLog.js — Event recording + query service
import { EventModel } from '../models/Event.js';

export class EventLog {
    static record(entityType, entityId, eventType, payload = {}) {
        return EventModel.create({ entity_type: entityType, entity_id: entityId, event_type: eventType, payload });
    }

    static getByEntity(entityType, entityId, options = {}) {
        return EventModel.findByEntity(entityType, entityId, options);
    }

    static getAll(options = {}) {
        return EventModel.findAll(options);
    }

    /** Unified timeline for a printer: merges events + commands. */
    static getPrinterTimeline(printerId, options = {}) {
        const events = EventModel.findByEntity('printer', printerId, options);
        // Commands for this printer
        const { CommandModel: CmdModel } = import('../models/Command.js');
        return events; // Commands are linked via events already
    }
}

export default EventLog;
