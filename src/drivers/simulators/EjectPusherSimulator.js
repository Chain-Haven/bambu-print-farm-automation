// src/drivers/simulators/EjectPusherSimulator.js — Mock eject_printhead driver
//
// In-memory state machine for testing without hardware.
// Supports: push, tap, home, calibrate, get_state

import { DriverInterface } from '../DriverInterface.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('EjectPusherSim');

export class EjectPusherSimulator extends DriverInterface {
    constructor(accessory) {
        super(accessory);
        this.state = 'ready';      // ready|moving|jam|unknown|error
        this.pushCount = 0;
        this.lastPushResult = null;
        this.simulateJam = false;   // for testing
        this.jamOnPushNumber = -1;  // trigger jam on specific push count

        // Calibration defaults
        this.servoOpenUs = accessory.calibration?.servo_open_us || 1100;
        this.servoPushUs = accessory.calibration?.servo_push_us || 1900;
        this.servoTravelTimeMs = accessory.calibration?.servo_travel_time_ms || 900;
        this.pushForceLimitMs = accessory.calibration?.push_force_limit_ms || 1800;

        this._updateHealth('online');
        log.info(`EjectPusherSimulator created for accessory ${this.accessoryId}`);
    }

    getCapabilities() {
        return {
            type: 'eject_printhead',
            actions: [
                {
                    name: 'eject.push', label: 'Push (Eject)', params: [
                        { name: 'cycles', type: 'number', min: 1, max: 5, default: 2, label: 'Push Cycles' },
                        { name: 'cycle_delay_ms', type: 'number', min: 100, max: 2000, default: 700, label: 'Cycle Delay (ms)' },
                    ]
                },
                {
                    name: 'eject.tap', label: 'Tap (Loosen)', params: [
                        { name: 'cycles', type: 'number', min: 1, max: 3, default: 1, label: 'Tap Cycles' },
                    ]
                },
                { name: 'eject.home', label: 'Home (Retract)', params: [] },
                {
                    name: 'eject.calibrate', label: 'Calibrate', params: [
                        { name: 'servo_open_us', type: 'number', label: 'Open μs' },
                        { name: 'servo_push_us', type: 'number', label: 'Push μs' },
                        { name: 'servo_travel_time_ms', type: 'number', label: 'Travel Time (ms)' },
                    ]
                },
                { name: 'eject.get_state', label: 'Get State', params: [] },
            ],
            state_fields: ['state', 'push_count', 'last_push_result', 'health', 'last_error', 'last_seen'],
            controls: [
                { type: 'button_group', actions: ['eject.push', 'eject.tap', 'eject.home'] },
            ],
        };
    }

    getState() {
        return {
            state: this.state,
            push_count: this.pushCount,
            last_push_result: this.lastPushResult,
            health: this.health,
            last_error: this.lastError,
            last_seen: this.lastSeen,
        };
    }

    async execute(action, params = {}) {
        this._updateHealth('online');

        switch (action) {
            case 'eject.push':
                return this._push(params);
            case 'eject.tap':
                return this._tap(params);
            case 'eject.home':
                return this._home();
            case 'eject.calibrate':
                return this._calibrate(params);
            case 'eject.get_state':
                return { success: true, data: this.getState() };
            default:
                return { success: false, error: `Unknown action: ${action}` };
        }
    }

    async _push(params) {
        const cycles = params.cycles || 2;
        const cycleDelayMs = params.cycle_delay_ms || 700;

        log.info(`Executing push: ${cycles} cycles, ${cycleDelayMs}ms delay`);
        this.state = 'moving';

        for (let i = 0; i < cycles; i++) {
            this.pushCount++;

            // Check for simulated jam
            if (this.simulateJam || this.pushCount === this.jamOnPushNumber) {
                this.state = 'jam';
                this.lastPushResult = 'jam';
                this._updateHealth('degraded', 'Jam detected (simulated)');
                log.warn(`Jam detected on push cycle ${i + 1}/${cycles}`);
                return { success: false, error: 'Jam detected', data: { cycle: i + 1, total: cycles } };
            }

            // Simulate push motion
            await this._sleep(this.servoTravelTimeMs);
            // Simulate retract
            await this._sleep(this.servoTravelTimeMs);

            if (i < cycles - 1) {
                await this._sleep(cycleDelayMs);
            }

            log.debug(`Push cycle ${i + 1}/${cycles} complete`);
        }

        this.state = 'ready';
        this.lastPushResult = 'success';
        log.info(`Push complete: ${cycles} cycles, total pushes: ${this.pushCount}`);
        return { success: true, data: { cycles_completed: cycles, total_pushes: this.pushCount } };
    }

    async _tap(params) {
        const cycles = params.cycles || 1;
        log.info(`Executing tap: ${cycles} cycles`);
        this.state = 'moving';

        for (let i = 0; i < cycles; i++) {
            // Tap is a shorter/gentler push
            await this._sleep(this.servoTravelTimeMs / 2);
            await this._sleep(this.servoTravelTimeMs / 2);
            log.debug(`Tap cycle ${i + 1}/${cycles} complete`);
        }

        this.state = 'ready';
        return { success: true, data: { cycles_completed: cycles } };
    }

    async _home() {
        log.info('Homing (retracting) pusher');
        this.state = 'moving';
        await this._sleep(this.servoTravelTimeMs);
        this.state = 'ready';
        return { success: true, data: { state: 'ready' } };
    }

    _calibrate(params) {
        if (params.servo_open_us !== undefined) this.servoOpenUs = params.servo_open_us;
        if (params.servo_push_us !== undefined) this.servoPushUs = params.servo_push_us;
        if (params.servo_travel_time_ms !== undefined) this.servoTravelTimeMs = params.servo_travel_time_ms;

        this.calibration = {
            servo_open_us: this.servoOpenUs,
            servo_push_us: this.servoPushUs,
            servo_travel_time_ms: this.servoTravelTimeMs,
            push_force_limit_ms: this.pushForceLimitMs,
        };

        log.info('Ejector calibration updated', this.calibration);
        return { success: true, data: { calibration: this.calibration } };
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

export default EjectPusherSimulator;
