// src/services/EjectionService.js — Automated print ejection (cool-release @ 27°C)
import { CommandBus } from './CommandBus.js';
import { EventModel } from '../models/Event.js';
import { PrinterModel } from '../models/Printer.js';
import { AccessoryModel } from '../models/Accessory.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('EjectionService');

/**
 * Execute the full ejection sequence for a completed print.
 *
 * @param {object} params - Ejection parameters
 * @param {string} params.job_id
 * @param {string} params.printer_id
 * @param {object} params.profile - G-code profile with ejection settings
 * @returns {Promise<object>} Result of ejection
 */
export async function executeEjectionSequence(params) {
    const {
        job_id, printer_id, profile,
        release_temp_c = profile?.release_bed_temp_c || 27.0,
        hysteresis_c = profile?.release_temp_hysteresis_c || 0.5,
        hold_seconds = profile?.release_hold_seconds || 20,
        max_wait_minutes = profile?.max_cool_wait_minutes || 45,
    } = params;

    const ejectParams = profile?.eject_params || {};
    const startTime = Date.now();

    log.info(`Starting ejection sequence for job ${job_id} on printer ${printer_id}`);
    EventModel.create({
        entity_type: 'job', entity_id: job_id,
        event_type: 'eject.sequence_started',
        payload: { printer_id, release_temp_c },
    });

    try {
        // Step 1: Wait for bed to cool to release temperature
        log.info(`Waiting for bed temp ≤ ${release_temp_c}°C (timeout: ${max_wait_minutes}min)`);
        const coolResult = await waitForCoolDown(printer_id, release_temp_c, hysteresis_c, hold_seconds, max_wait_minutes);

        if (!coolResult.success) {
            EventModel.create({
                entity_type: 'job', entity_id: job_id,
                event_type: 'eject.cool_timeout',
                payload: { final_temp: coolResult.lastTemp, elapsed_minutes: coolResult.elapsedMinutes },
            });
            return { success: false, error: 'Cool-down timeout', ...coolResult };
        }

        log.info(`Bed cooled to ${coolResult.lastTemp}°C in ${coolResult.elapsedMinutes.toFixed(1)} min`);

        // Step 2: Find eject_printhead accessory for this printer
        const ejectorAccessories = AccessoryModel.findByPrinterId(printer_id)
            .filter(a => a.type === 'eject_printhead');

        if (ejectorAccessories.length === 0) {
            log.warn(`No eject_printhead accessory found for printer ${printer_id}`);
            EventModel.create({
                entity_type: 'job', entity_id: job_id,
                event_type: 'eject.no_ejector', payload: { printer_id },
            });
            return { success: false, error: 'No ejector accessory found' };
        }

        const ejector = ejectorAccessories[0];
        const maxAttempts = ejectParams.max_eject_attempts || 3;
        const preTapCycles = ejectParams.pre_push_tap_cycles || 1;
        const pushCycles = ejectParams.push_cycles || 2;
        const cycleDelayMs = ejectParams.push_cycle_delay_ms || 700;

        // Step 3: Pre-push tap (loosen the part)
        if (preTapCycles > 0) {
            log.info(`Pre-push tap: ${preTapCycles} cycles`);
            CommandBus.enqueue({
                target_type: 'accessory', target_id: ejector.accessory_id,
                action: 'eject.tap', params: { cycles: preTapCycles },
                requested_by: 'ejection_service',
                idempotency_key: `eject-tap-${job_id}`,
                timeout_seconds: 10,
            });
            await sleep(preTapCycles * 1500); // Wait for tap to complete
        }

        // Step 4: Push cycles with retry
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            log.info(`Eject attempt ${attempt}/${maxAttempts}: ${pushCycles} push cycles`);

            const pushCmd = CommandBus.enqueue({
                target_type: 'accessory', target_id: ejector.accessory_id,
                action: 'eject.push',
                params: { cycles: pushCycles, cycle_delay_ms: cycleDelayMs },
                requested_by: 'ejection_service',
                idempotency_key: `eject-push-${job_id}-attempt${attempt}`,
                timeout_seconds: 30,
            });

            // Wait for push command to complete
            await sleep((pushCycles * 2 * 1000) + (cycleDelayMs * pushCycles));

            // Check result
            const cmdResult = CommandBus.findById(pushCmd.command_id);
            if (cmdResult.status === 'done') {
                EventModel.create({
                    entity_type: 'job', entity_id: job_id,
                    event_type: 'eject.success',
                    payload: { attempt, elapsed_ms: Date.now() - startTime },
                });
                log.info(`Ejection successful on attempt ${attempt}`);

                // Home the pusher
                CommandBus.enqueue({
                    target_type: 'accessory', target_id: ejector.accessory_id,
                    action: 'eject.home', params: {},
                    requested_by: 'ejection_service',
                });

                return { success: true, attempt, elapsed_ms: Date.now() - startTime };
            }

            if (attempt < maxAttempts) {
                log.warn(`Eject attempt ${attempt} failed, retrying...`);
                await sleep(2000);
            }
        }

        // All attempts failed
        EventModel.create({
            entity_type: 'job', entity_id: job_id,
            event_type: 'eject.failed',
            payload: { attempts: maxAttempts, elapsed_ms: Date.now() - startTime },
        });
        return { success: false, error: `Ejection failed after ${maxAttempts} attempts` };

    } catch (err) {
        log.error(`Ejection error: ${err.message}`);
        EventModel.create({
            entity_type: 'job', entity_id: job_id,
            event_type: 'eject.error', payload: { error: err.message },
        });
        return { success: false, error: err.message };
    }
}

/**
 * Wait for bed temperature to drop to target with hysteresis and hold.
 */
async function waitForCoolDown(printerId, targetTemp, hysteresis, holdSeconds, maxWaitMinutes) {
    const maxWaitMs = maxWaitMinutes * 60 * 1000;
    const startTime = Date.now();
    let holdStart = null;
    let lastTemp = null;

    while (Date.now() - startTime < maxWaitMs) {
        const printer = PrinterModel.findById(printerId);
        const snapshot = printer?.status_snapshot;
        const bedTemp = typeof snapshot === 'object' ? snapshot.bed_temp : null;

        if (bedTemp !== null && bedTemp !== undefined) {
            lastTemp = bedTemp;

            if (bedTemp <= targetTemp) {
                if (!holdStart) {
                    holdStart = Date.now();
                    log.debug(`Bed at ${bedTemp}°C, starting hold (${holdSeconds}s)`);
                }

                // Check hysteresis: temp must stay within hysteresis during hold
                if (bedTemp <= targetTemp + hysteresis) {
                    const heldMs = Date.now() - holdStart;
                    if (heldMs >= holdSeconds * 1000) {
                        return {
                            success: true,
                            lastTemp: bedTemp,
                            elapsedMinutes: (Date.now() - startTime) / 60000,
                        };
                    }
                } else {
                    // Temp rose above hysteresis during hold, reset
                    holdStart = null;
                }
            } else {
                holdStart = null;
            }
        }

        await sleep(5000); // Poll every 5 seconds
    }

    return {
        success: false,
        lastTemp,
        elapsedMinutes: (Date.now() - startTime) / 60000,
    };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export default { executeEjectionSequence };
