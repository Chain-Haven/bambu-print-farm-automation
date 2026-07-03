// src/cloud/farmNodeEntry.js — entry point for the bundled farm node
// (farm-node.cjs in the portable zip, and farm-node.exe via Node SEA).
//
// Double-click UX guarantees:
//   1. farm-node.exe is fully self-contained: on first run it extracts its
//      embedded runtime assets (public/, migrations/, sql-wasm.wasm) next to
//      the exe, prompts for the cloud URL + node token, and writes .env.
//   2. Fatal startup errors never flash-and-vanish: when run from a console
//      (double-click), the window stays open until the user presses Enter.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const DEFAULT_CLOUD_URL = 'https://bambu-print-farm-automation.vercel.app';

async function loadSea() {
    try {
        const sea = await import('node:sea');
        return sea?.isSea?.() ? sea : null;
    } catch {
        return null;
    }
}

function holdConsoleOpen(message = '\nPress Enter to close this window...') {
    if (!process.stdin.isTTY) return Promise.resolve();
    process.stdout.write(message);
    return new Promise((resolve) => {
        process.stdin.resume();
        process.stdin.once('data', resolve);
    });
}

async function fatal(error) {
    process.stderr.write('\n[farm-node] Failed to start:\n');
    process.stderr.write(`${error?.stack || error?.message || error}\n`);
    await holdConsoleOpen();
    process.exit(1);
}

function extractEmbeddedAssets(sea, baseDir, AdmZip) {
    const marker = path.join(baseDir, 'sql-wasm.wasm');
    const publicDir = path.join(baseDir, 'public');
    if (fs.existsSync(marker) && fs.existsSync(publicDir)) return false;

    let assetBuffer;
    try {
        assetBuffer = sea.getAsset('assets.zip');
    } catch {
        throw new Error(
            'This farm-node.exe was built without embedded assets. '
            + 'Re-download it from the admin console, or use the Portable .zip instead.',
        );
    }
    new AdmZip(Buffer.from(assetBuffer)).extractAllTo(baseDir, true);
    process.stdout.write(`[farm-node] First run: extracted dashboard assets to ${baseDir}\n`);
    return true;
}

async function promptForCloudConfig(envPath) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (question) => new Promise((resolve) => rl.question(question, resolve));

    process.stdout.write('\n=== PrintKinetix Farm Node — first-time setup ===\n');
    process.stdout.write('Connect this computer to your PrintKinetix cloud.\n');
    process.stdout.write('You can find both values in the cloud console (/cloud) after provisioning a node.\n\n');

    const url = (await ask(`Cloud API URL [${DEFAULT_CLOUD_URL}]: `)).trim() || DEFAULT_CLOUD_URL;
    let token = '';
    while (!token) {
        token = (await ask('Node token (pkx_node_...): ')).trim();
        if (!token) process.stdout.write('The node token is required — copy it from the Provision step in /cloud.\n');
    }
    rl.close();

    const { createNodeEnv } = await import('./nodePackage.js');
    fs.writeFileSync(envPath, createNodeEnv({ cloudApiUrl: url, localNodeToken: token }));
    process.stdout.write(`\nSaved configuration to ${envPath}\n`);
    process.stdout.write('Delete that file (or edit it) to re-run this setup.\n\n');
}

async function bootstrap() {
    const sea = await loadSea();

    // Where the runtime lives: next to the exe (SEA) or the bundle dir (the
    // esbuild banner sets PKX_ASSET_ROOT before this module runs).
    const baseDir = sea
        ? path.dirname(process.execPath)
        : (process.env.PKX_ASSET_ROOT || process.cwd());

    if (sea) {
        process.env.PKX_ASSET_ROOT = baseDir;
        // Relative paths in .env (DB_PATH=./data/...) must resolve next to the
        // exe, not wherever Explorer set the cwd.
        try { process.chdir(baseDir); } catch { /* keep current cwd */ }

        const AdmZip = (await import('adm-zip')).default;
        extractEmbeddedAssets(sea, baseDir, AdmZip);
    }

    // Load .env from the runtime dir (works for exe, portable zip, and dev).
    const envPath = path.join(baseDir, '.env');
    const dotenv = await import('dotenv');
    dotenv.config({ path: envPath });

    // First run without cloud credentials: ask for them interactively when a
    // human is at the console. Never prompt in CI/tests (no TTY) — those set
    // the env vars directly and must fail fast like before.
    const missingCloudConfig = !process.env.CLOUD_API_URL || !process.env.LOCAL_NODE_TOKEN;
    if (missingCloudConfig && process.stdin.isTTY) {
        await promptForCloudConfig(envPath);
        dotenv.config({ path: envPath, override: true });
    }

    // Tell runLocalNode's failure path to hold the window open too.
    if (process.stdin.isTTY) process.env.PKX_HOLD_CONSOLE = '1';

    await import('./runLocalNode.js');
}

process.on('uncaughtException', (error) => { fatal(error); });
process.on('unhandledRejection', (error) => { fatal(error); });

bootstrap().catch(fatal);
