import { executeCloudCommand } from './localCommandExecutor.js';

export function createLocalNodeAgent({
    client,
    executeCommand = executeCloudCommand,
    claimLimit = 10,
    pollIntervalMs = 2000,
    logger = console,
}) {
    if (!client) throw new Error('client is required');
    let timer = null;
    let running = false;

    async function runOnce() {
        const response = await client.claimCommands({ limit: claimLimit });
        const commands = Array.isArray(response?.commands) ? response.commands : [];
        const summary = { claimed: commands.length, succeeded: 0, failed: 0 };

        for (const command of commands) {
            const commandId = command.command_id;
            try {
                await client.reportCommandResult(commandId, { status: 'running' });
                const result = await executeCommand(command);
                await client.reportCommandResult(commandId, { status: 'succeeded', result });
                summary.succeeded += 1;
            } catch (error) {
                await client.reportCommandResult(commandId, {
                    status: 'failed',
                    error: error.message,
                });
                summary.failed += 1;
            }
        }

        return summary;
    }

    function start() {
        if (running) return;
        running = true;
        timer = setInterval(() => {
            runOnce().catch((error) => logger.warn?.(`Cloud command poll failed: ${error.message}`));
        }, pollIntervalMs);
    }

    function stop() {
        running = false;
        if (timer) clearInterval(timer);
        timer = null;
    }

    return { runOnce, start, stop };
}
