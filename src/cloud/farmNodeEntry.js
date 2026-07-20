// src/cloud/farmNodeEntry.js — entry point for the bundled farm node
// (farm-node.cjs in the portable zip, and farm-node.exe via Node SEA).
//
// Double-click UX guarantees:
//   1. farm-node.exe is fully self-contained: on first run it extracts its
//      embedded runtime assets (public/, migrations/, sql-wasm.wasm) next to
//      the exe, prompts for the cloud URL + node token, and writes .env.
//   2. Fatal startup errors never flash-and-vanish: when run from a console
//      (double-click), the window stays open until the user presses Enter.
//   3. Once the local server answers, the dashboard opens in the default
//      browser (double-click runs only; PKX_OPEN_DASHBOARD=false disables).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
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

function openInBrowser(url) {
    const platform = process.platform;
    let child;
    if (platform === 'darwin') {
        child = spawn('open', [url], { stdio: 'ignore', detached: true });
    } else if (platform === 'win32') {
        // `start` is a cmd builtin; the empty string is the window title slot.
        child = spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true });
    } else {
        child = spawn('xdg-open', [url], { stdio: 'ignore', detached: true });
    }
    child.on('error', () => { /* headless box without a browser — fine */ });
    child.unref();
}

// Out-of-the-box UX for the double-click flows: poll the local server until it
// answers, then pop the dashboard so the user lands in the UI without typing a
// URL. Only runs at an interactive console (never in CI/services), and only
// unref'd timers so a failed server start still exits cleanly.
function openDashboardWhenReady() {
    if (process.env.PKX_OPEN_DASHBOARD === 'false' || !process.stdin.isTTY) return;
    const port = Number.parseInt(process.env.PORT || '', 10) || 3000;
    const url = `http://localhost:${port}`;
    const deadline = Date.now() + 90_000;

    const attempt = () => {
        let settled = false; // destroy() re-fires 'error' — schedule one retry per attempt
        const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, (res) => {
            settled = true;
            res.resume(); // any HTTP answer (200/302/401/…) means the server is up
            process.stdout.write(`\n[farm-node] Local dashboard ready: ${url} (opening browser)\n`);
            openInBrowser(url);
        });
        const retry = () => {
            if (settled) return;
            settled = true;
            req.destroy();
            if (Date.now() < deadline) setTimeout(attempt, 1000).unref();
        };
        req.on('error', retry);
        req.on('timeout', retry);
    };
    setTimeout(attempt, 1500).unref();
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

    openDashboardWhenReady();

    await import('./runLocalNode.js');
}

process.on('uncaughtException', (error) => { fatal(error); });
process.on('unhandledRejection', (error) => { fatal(error); });

bootstrap().catch(fatal);
