import { EventEmitter } from 'node:events';

class SystemEvents extends EventEmitter { }

// Singleton instance
const systemEvents = new SystemEvents();

const originalEmit = systemEvents.emit.bind(systemEvents);
systemEvents.emit = (event, ...args) => {
    // console.log(`[SystemEvents] Emitting ${event}`); // Debug log
    return originalEmit(event, ...args);
};

export default systemEvents;
