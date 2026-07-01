import { executeCloudCommand } from './localCommandExecutor.js';

export function createLocalNodeAgent({
    client,
    executeCommand = executeCloudCommand,
    claimLimit = 10,
    pollIntervalMs = 2000,
    maxPollIntervalMs = 30000,
    resultOutbox = null,
    outboxFlushLimit = 25,
    logger = console,
}) {
    if (!client) throw new Error('client is required');
    let timer = null;
    let running = false;
    let inFlight = false;
    let consecutiveFailures = 0;

    async function flushPendingResults() {
        if (!resultOutbox) return { flushed: 0, deferred: 0 };
        const pending = resultOutbox.list(outboxFlushLimit);
        let flushed = 0;

        for (const entry of pending) {
            try {
                await client.reportCommandResult(entry.command_id, entry.payload);
                resultOutbox.remove(entry.id);
                flushed += 1;
            } catch (error) {
                resultOutbox.markAttempt(entry.id, error);
                logger.warn?.(`Deferred command result still pending: ${entry.command_id}: ${error.message}`);
                break;
            }
        }

        return { flushed, deferred: resultOutbox.size() };
    }

    async function deliverFinalResult(commandId, payload) {
        try {
            await client.reportCommandResult(commandId, payload);
            return { delivered: true, deferred: false };
        } catch (error) {
            if (!resultOutbox) throw error;
            resultOutbox.enqueueCommandResult(commandId, payload);
            logger.warn?.(`Deferred command result for ${commandId}: ${error.message}`);
            return { delivered: false, deferred: true };
        }
    }

    async function runOnce() {
        const flush = await flushPendingResults();
        const response = await client.claimCommands({ limit: claimLimit });
        const commands = Array.isArray(response?.commands) ? response.commands : [];
        const summary = {
            claimed: commands.length,
            succeeded: 0,
            failed: 0,
            deferred: flush.deferred,
            flushed: flush.flushed,
        };

        for (const command of commands) {
            const commandId = command.command_id;
            try {
                try {
                    await client.reportCommandResult(commandId, { status: 'running' });
                } catch (error) {
                    logger.warn?.(`Unable to mark command running (${commandId}): ${error.message}`);
                }
                const result = await executeCommand(command);
                const delivery = await deliverFinalResult(commandId, { status: 'succeeded', result });
                summary.succeeded += 1;
                if (delivery.deferred) summary.deferred += 1;
            } catch (error) {
                const delivery = await deliverFinalResult(commandId, {
                    status: 'failed',
                    error: error.message,
                });
                summary.failed += 1;
                if (delivery.deferred) summary.deferred += 1;
            }
        }

        return summary;
    }

    function nextDelay() {
        if (consecutiveFailures <= 0) return pollIntervalMs;
        return Math.min(maxPollIntervalMs, pollIntervalMs * (2 ** Math.min(consecutiveFailures, 6)));
    }

    function schedule(delay = nextDelay()) {
        if (!running) return;
        timer = setTimeout(async () => {
            if (!running) return;
            if (inFlight) {
                logger.warn?.('Cloud command poll skipped because previous poll is still running');
                schedule(nextDelay());
                return;
            }
            inFlight = true;
            try {
                await runOnce();
                consecutiveFailures = 0;
            } catch (error) {
                consecutiveFailures += 1;
                logger.warn?.(`Cloud command poll failed: ${error.message}`);
            } finally {
                inFlight = false;
                schedule(nextDelay());
            }
        }, delay);
    }

    function start() {
        if (running) return;
        running = true;
        schedule(pollIntervalMs);
    }

    function stop() {
        running = false;
        if (timer) clearTimeout(timer);
        timer = null;
    }

    return { flushPendingResults, runOnce, start, stop };
}
