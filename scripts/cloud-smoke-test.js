#!/usr/bin/env node
import { loadCloudSmokeEnv } from '../src/cloud/cloudSmokeEnv.js';
import { runCloudSmokeTest } from '../src/cloud/cloudSmokeTest.js';

loadCloudSmokeEnv();

function getArgValue(name) {
    const index = process.argv.indexOf(name);
    if (index === -1) return null;
    return process.argv[index + 1] || null;
}

function hasFlag(name) {
    return process.argv.includes(name);
}

function printText(summary) {
    console.log('PrintKinetix cloud smoke test passed');
    console.log(`Organization: ${summary.organization_id}`);
    console.log(`Node: ${summary.node_id}`);
    console.log(`Command: ${summary.command_id}`);
    console.log(`Agent: claimed=${summary.agent.claimed} succeeded=${summary.agent.succeeded} failed=${summary.agent.failed}`);
}

try {
    const summary = await runCloudSmokeTest({
        cloudApiUrl: getArgValue('--cloud-url') || process.env.CLOUD_API_URL,
        adminToken: getArgValue('--admin-token') || process.env.CLOUD_ADMIN_TOKEN,
        organizationName: getArgValue('--org-name') || undefined,
        nodeName: getArgValue('--node-name') || undefined,
        localPrinterId: getArgValue('--printer-id') || undefined,
    });

    if (hasFlag('--json')) {
        console.log(JSON.stringify(summary, null, 2));
    } else {
        printText(summary);
    }

    process.exit(summary.ok ? 0 : 1);
} catch (error) {
    if (hasFlag('--json')) {
        console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    } else {
        console.error(`PrintKinetix cloud smoke test failed: ${error.message}`);
    }
    process.exit(1);
}
