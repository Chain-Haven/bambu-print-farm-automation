import { describe, expect, it } from 'vitest';
import { createMemoryCloudStore } from '../../src/cloud/memoryCloudStore.js';
import { createHeartbeatHandler } from '../../src/cloud/agentHandlers.js';
import { hashNodeToken } from '../../src/cloud/agentProtocol.js';
import { planAutoEjectCommands } from '../../src/cloud/farmAutomation.js';
import { executeCloudCommand } from '../../src/cloud/localCommandExecutor.js';

const PEPPER = 'eject-pepper';
const TOKEN = 'pkx_node_eject_test';

function finishedPrinter(overrides = {}) {
    return {
        local_printer_id: 'printer-1',
        name: 'A1 Bay 1',
        model: 'Bambu A1',
        status: 'online',
        status_snapshot: { print: { gcode_state: 'FINISH' } },
        capabilities: { auto_eject: true },
        ...overrides,
    };
}

function createMockResponse() {
    return {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
        setHeader() {},
    };
}

async function setupCloud({ policy } = {}) {
    const store = createMemoryCloudStore();
    const org = await store.createOrganization({ name: 'Eject Org' });
    await store.createFarmNode({
        org_id: org.org_id,
        name: 'Eject Node',
        token_hash: hashNodeToken(TOKEN, PEPPER),
    });
    if (policy) {
        await store.upsertPlatformSetting('farm_automation_policy', policy);
    }
    return { store };
}

async function sendHeartbeat(store, printers) {
    const handler = createHeartbeatHandler({ store, pepper: PEPPER });
    const res = createMockResponse();
    await handler({
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
        body: { status: 'online', printers },
    }, res);
    return res;
}

describe('planAutoEjectCommands', () => {
    it('plans ejects only for finished, eject-capable printers when the policy is on', () => {
        const settings = { policy: { auto_eject_enabled: true, release_temperature_c: 25, max_eject_attempts: 2 } };

        const plan = planAutoEjectCommands({
            printers: [
                finishedPrinter(),
                finishedPrinter({ local_printer_id: 'printer-busy', status_snapshot: { print: { gcode_state: 'RUNNING' } } }),
                finishedPrinter({ local_printer_id: 'printer-no-cap', capabilities: {} }),
                finishedPrinter({ local_printer_id: 'printer-clear', capabilities: { auto_eject: true, bed_clear: true } }),
            ],
            settings,
        });

        expect(plan).toEqual([{
            local_printer_id: 'printer-1',
            release_temperature_c: 25,
            max_eject_attempts: 2,
            verification: 'camera_or_operator',
        }]);
    });

    it('plans nothing when auto-eject is disabled', () => {
        const plan = planAutoEjectCommands({
            printers: [finishedPrinter()],
            settings: { policy: { auto_eject_enabled: false } },
        });
        expect(plan).toEqual([]);
    });
});

describe('heartbeat auto-eject command queueing', () => {
    it('queues a durable printer.eject command for a finished printer', async () => {
        const { store } = await setupCloud({
            policy: { auto_eject_enabled: true, release_temperature_c: 26, max_eject_attempts: 4 },
        });

        const res = await sendHeartbeat(store, [finishedPrinter()]);
        expect(res.statusCode).toBe(200);
        expect(res.body.auto_eject_commands_queued).toBe(1);

        const commands = store._db.commands.filter((cmd) => cmd.command_type === 'printer.eject');
        expect(commands).toHaveLength(1);
        expect(commands[0].payload).toMatchObject({
            local_printer_id: 'printer-1',
            release_temperature_c: 26,
            max_eject_attempts: 4,
            source: 'auto_eject_policy',
        });
    });

    it('does not queue duplicates while an eject command is pending', async () => {
        const { store } = await setupCloud({ policy: { auto_eject_enabled: true } });

        await sendHeartbeat(store, [finishedPrinter()]);
        await sendHeartbeat(store, [finishedPrinter()]);

        const commands = store._db.commands.filter((cmd) => cmd.command_type === 'printer.eject');
        expect(commands).toHaveLength(1);
    });

    it('does not re-eject inside the cooldown window after a finished eject', async () => {
        const { store } = await setupCloud({ policy: { auto_eject_enabled: true } });

        await sendHeartbeat(store, [finishedPrinter()]);
        const [command] = store._db.commands;
        command.status = 'succeeded';
        command.finished_at = new Date().toISOString();

        await sendHeartbeat(store, [finishedPrinter()]);
        expect(store._db.commands.filter((cmd) => cmd.command_type === 'printer.eject')).toHaveLength(1);
    });

    it('queues nothing without a stored policy (planner stays advisory-only)', async () => {
        const { store } = await setupCloud();
        const res = await sendHeartbeat(store, [finishedPrinter()]);
        expect(res.statusCode).toBe(200);
        expect(res.body.auto_eject_commands_queued).toBeUndefined();
        expect(store._db.commands).toHaveLength(0);
    });
});

describe('printer.eject node command', () => {
    it('runs the injected eject sequence with the policy parameters', async () => {
        const calls = [];
        const result = await executeCloudCommand(
            {
                command_id: 'cmd-eject-1',
                command_type: 'printer.eject',
                payload: {
                    local_printer_id: 'printer-1',
                    release_temperature_c: 26,
                    max_eject_attempts: 4,
                },
            },
            {
                ejectPrinter: async (localPrinterId, options) => {
                    calls.push({ localPrinterId, options });
                    return { success: true, attempt: 1 };
                },
            },
        );

        expect(calls).toHaveLength(1);
        expect(calls[0].localPrinterId).toBe('printer-1');
        expect(calls[0].options).toMatchObject({
            command_id: 'cmd-eject-1',
            release_temperature_c: 26,
            max_eject_attempts: 4,
        });
        expect(result).toMatchObject({ ok: true, local_printer_id: 'printer-1', success: true });
    });
});
