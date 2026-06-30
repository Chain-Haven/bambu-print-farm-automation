// src/drivers/simulators/DoorServoSimulator.js — Mock door_servo driver
//
// In-memory state machine for testing without hardware.
// Supports: open, close, set_position, calibrate, get_state, emergency_stop

import { DriverInterface } from '../DriverInterface.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('DoorServoSim');

export class DoorServoSimulator extends DriverInterface {
    constructor(accessory) {
        super(accessory);
        this.state = 'closed';     // open|closed|moving|unknown|error
        this.position = 0;         // 0-100
        this.targetPosition = 0;
        this.moveTimer = null;
        this.travelTimeMs = accessory.calibration?.travel_time_ms || 1000;
        this.openPosition = accessory.calibration?.open_position || 100;
        this.closePosition = accessory.calibration?.close_position || 0;
        this.directionInvert = accessory.calibration?.direction_invert || false;
        this.maxMoveTimeMs = accessory.calibration?.max_move_time_ms || 5000;
        this.simulateJam = false;  // for testing
        this._updateHealth('online');
        log.info(`DoorServoSimulator created for accessory ${this.accessoryId}`);
    }

    getCapabilities() {
        return {
            type: 'door_servo',
            actions: [
                { name: 'door.open', label: 'Open Door', params: [] },
                { name: 'door.close', label: 'Close Door', params: [] },
                {
                    name: 'door.set_position', label: 'Set Position', params: [
                        { name: 'position', type: 'number', min: 0, max: 100, label: 'Position (%)' }
                    ]
                },
                {
                    name: 'door.calibrate', label: 'Calibrate', params: [
                        { name: 'open_position', type: 'number', min: 0, max: 100, label: 'Open Position' },
                        { name: 'close_position', type: 'number', min: 0, max: 100, label: 'Close Position' },
                    ]
                },
                { name: 'door.get_state', label: 'Get State', params: [] },
                { name: 'door.emergency_stop', label: 'Emergency Stop', params: [] },
            ],
            state_fields: ['state', 'position', 'health', 'last_error', 'last_seen'],
            controls: [
                { type: 'button_group', actions: ['door.open', 'door.close'] },
                { type: 'slider', action: 'door.set_position', field: 'position', min: 0, max: 100 },
            ],
        };
    }

    getState() {
        return {
            state: this.state,
            position: this.position,
            health: this.health,
            last_error: this.lastError,
            last_seen: this.lastSeen,
        };
    }

    async execute(action, params = {}) {
        this._updateHealth('online');

        switch (action) {
            case 'door.open':
                return this._moveTo(this.openPosition, 'open');
            case 'door.close':
                return this._moveTo(this.closePosition, 'closed');
            case 'door.set_position':
                return this._moveTo(params.position ?? 50, params.position >= 50 ? 'open' : 'closed');
            case 'door.calibrate':
                return this._calibrate(params);
            case 'door.get_state':
                return { success: true, data: this.getState() };
            case 'door.emergency_stop':
                return this._emergencyStop();
            default:
                return { success: false, error: `Unknown action: ${action}` };
        }
    }

    async _moveTo(target, endState) {
        if (this.simulateJam) {
            this.state = 'error';
            this._updateHealth('degraded', 'Simulated jam');
            return { success: false, error: 'Jam detected (simulated)' };
        }

        this.state = 'moving';
        this.targetPosition = Math.max(0, Math.min(100, target));
        const moveDistance = Math.abs(this.targetPosition - this.position);
        const moveTimeMs = (moveDistance / 100) * this.travelTimeMs;

        log.debug(`Moving from ${this.position} to ${this.targetPosition} (${moveTimeMs}ms)`);

        // Simulate movement
        return new Promise(resolve => {
            if (this.moveTimer) clearTimeout(this.moveTimer);
            this.moveTimer = setTimeout(() => {
                this.position = this.targetPosition;
                this.state = endState;
                this.moveTimer = null;
                log.info(`Door move complete: ${endState} at position ${this.position}`);
                resolve({ success: true, data: this.getState() });
            }, Math.min(moveTimeMs, this.maxMoveTimeMs));
        });
    }

    _calibrate(params) {
        if (params.open_position !== undefined) this.openPosition = params.open_position;
        if (params.close_position !== undefined) this.closePosition = params.close_position;
        if (params.direction_invert !== undefined) this.directionInvert = params.direction_invert;
        if (params.travel_time_ms !== undefined) this.travelTimeMs = params.travel_time_ms;

        this.calibration = {
            open_position: this.openPosition,
            close_position: this.closePosition,
            direction_invert: this.directionInvert,
            travel_time_ms: this.travelTimeMs,
        };

        log.info('Door calibration updated', this.calibration);
        return { success: true, data: { calibration: this.calibration } };
    }

    _emergencyStop() {
        if (this.moveTimer) {
            clearTimeout(this.moveTimer);
            this.moveTimer = null;
        }
        this.state = 'unknown';
        log.warn('Emergency stop triggered');
        return { success: true, data: { state: 'unknown', position: this.position } };
    }

    async shutdown() {
        if (this.moveTimer) clearTimeout(this.moveTimer);
    }
}

export default DoorServoSimulator;
