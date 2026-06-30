// src/services/CommandBus.js — Command Bus Service (Reliable Control Plane)
// Enqueue commands, dispatch to workers, handle retry/timeout/idempotency

import { CommandModel } from '../models/Command.js';
import { EventModel } from '../models/Event.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('CommandBus');

export class CommandBus {
    /**
     * Enqueue a new command.
     */
    static enqueue({ target_type, target_id, action, params, requested_by, idempotency_key, timeout_seconds, max_retries }) {
        const cmd = CommandModel.create({
            target_type, target_id, action, params,
            requested_by: requested_by || 'system',
            idempotency_key, timeout_seconds, max_retries,
        });

        EventModel.create({
            entity_type: 'command', entity_id: cmd.command_id,
            event_type: 'command.queued',
            payload: { action, target_type, target_id },
        });

        log.info(`Command queued: ${action} → ${target_type}/${target_id} [${cmd.command_id}]`);
        return cmd;
    }

    /**
     * Pull queued commands for a target (called by workers).
     */
    static pullQueued(targetType, targetId, limit = 10) {
        return CommandModel.findQueued(targetType, targetId, limit);
    }

    /**
     * Mark command as sent (in-progress).
     */
    static markSent(commandId) {
        const cmd = CommandModel.updateStatus(commandId, 'sent');
        EventModel.create({
            entity_type: 'command', entity_id: commandId,
            event_type: 'command.sent', payload: { attempt: cmd.attempt_count },
        });
        return cmd;
    }

    /**
     * Mark command as acknowledged.
     */
    static markAck(commandId) {
        return CommandModel.updateStatus(commandId, 'ack');
    }

    /**
     * Mark command as done with result.
     */
    static markDone(commandId, result = {}) {
        const cmd = CommandModel.updateStatus(commandId, 'done', { result });
        EventModel.create({
            entity_type: 'command', entity_id: commandId,
            event_type: 'command.done', payload: { result },
        });
        log.info(`Command done: ${cmd.action} [${commandId}]`);
        return cmd;
    }

    /**
     * Mark command as failed with error.
     */
    static markFailed(commandId, error) {
        const cmd = CommandModel.findById(commandId);
        if (!cmd) return null;

        // Check if retries available
        if (cmd.attempt_count < cmd.max_retries) {
            // Re-queue for retry
            CommandModel.updateStatus(commandId, 'queued', { error });
            EventModel.create({
                entity_type: 'command', entity_id: commandId,
                event_type: 'command.retry',
                payload: { attempt: cmd.attempt_count, error, max_retries: cmd.max_retries },
            });
            log.warn(`Command retry ${cmd.attempt_count}/${cmd.max_retries}: ${cmd.action} [${commandId}]`);
            return CommandModel.findById(commandId);
        }

        // Final failure
        const failed = CommandModel.updateStatus(commandId, 'failed', { error });
        EventModel.create({
            entity_type: 'command', entity_id: commandId,
            event_type: 'command.failed', payload: { error, attempts: cmd.attempt_count },
        });
        log.error(`Command failed: ${cmd.action} [${commandId}]: ${error}`);
        return failed;
    }

    /**
     * Mark command as timed out.
     */
    static markTimeout(commandId) {
        return this.markFailed(commandId, 'Command timed out');
    }

    /**
     * Cancel a command.
     */
    static cancel(commandId) {
        const cmd = CommandModel.cancel(commandId);
        EventModel.create({
            entity_type: 'command', entity_id: commandId,
            event_type: 'command.canceled', payload: {},
        });
        return cmd;
    }

    /**
     * Get commands for a target entity (timeline).
     */
    static getTimeline(targetType, targetId, options = {}) {
        return CommandModel.findByTarget(targetType, targetId, options);
    }

    /**
     * Get all commands with filters.
     */
    static findAll(options = {}) {
        return CommandModel.findAll(options);
    }

    static findById(id) {
        return CommandModel.findById(id);
    }

    /**
     * Check for timed-out commands and fail them.
     * Call this periodically.
     */
    static processTimeouts() {
        const sent = CommandModel.findAll({ status: 'sent', limit: 100 });
        const now = Date.now();
        let timeoutCount = 0;

        for (const cmd of sent) {
            const createdAt = new Date(cmd.created_at).getTime();
            const timeoutMs = (cmd.timeout_seconds || 30) * 1000;
            if (now - createdAt > timeoutMs) {
                this.markTimeout(cmd.command_id);
                timeoutCount++;
            }
        }

        if (timeoutCount > 0) {
            log.warn(`Timed out ${timeoutCount} commands`);
        }
        return timeoutCount;
    }
}

export default CommandBus;
