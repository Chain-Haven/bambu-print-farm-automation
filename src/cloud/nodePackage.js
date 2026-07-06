import AdmZip from 'adm-zip';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT_FILES = new Set([
    'package.json',
    'package-lock.json',
    'server.js',
    'Start Cloud Node.bat',
    'fix_network_access.bat',
    'allow_remote_access.bat',
]);
const ROOT_DIRS = new Set(['src', 'public']);
// Junk/build-time directories that must never ship, no matter how deeply nested.
const NESTED_EXCLUDED_DIRS = new Set([
    '.git',
    '.playwright-cli',
    'node_modules',
]);
// Top-level-only directories to skip. These are matched ONLY at the repo root so
// that nested directories which happen to share a name still ship. Critically,
// `src/api/**` (the Express router the local node imports via server.js) must NOT
// be dropped just because a top-level `api/` directory (Vercel functions) exists.
const ROOT_EXCLUDED_DIRS = new Set([
    'api',
    'data',
    'docs',
    'output',
    'supabase',
    'tests',
    'uploads',
]);
const EXCLUDED_FILES = new Set(['.env', '.env.local']);
// public/ files that belong only to the cloud console and are never served by
// the local node — kept out of the portable bundle too.
const PORTABLE_PUBLIC_EXCLUDES = new Set([
    'public/cloud.html',
    'public/css/cloud.css',
    'public/js/cloud-dashboard.js',
    'public/js/fleet-view.js',
]);
const EXCLUDED_PATHS = new Set([
    'public/cloud.html',
    'public/css/cloud.css',
    'public/js/cloud-dashboard.js',
    'public/js/fleet-view.js',
    'src/cloud/adminHandlers.js',
    'src/cloud/nodePackage.js',
    'src/cloud/supabaseRest.js',
]);

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRequiredString(value, name) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`${name} is required`);
    }
    return value.trim();
}

function normalizePath(relativePath) {
    return relativePath.split(path.sep).join('/');
}

function shouldIncludeFile(relativePath) {
    const normalized = normalizePath(relativePath);
    const segments = normalized.split('/');
    if (EXCLUDED_PATHS.has(normalized)) return false;
    if (segments.some((segment) => NESTED_EXCLUDED_DIRS.has(segment))) return false;
    if (ROOT_EXCLUDED_DIRS.has(segments[0])) return false;
    if (EXCLUDED_FILES.has(segments.at(-1))) return false;

    if (segments.length === 1) return ROOT_FILES.has(normalized);
    return ROOT_DIRS.has(segments[0]);
}

function walkFiles(rootDir, currentDir = rootDir, files = []) {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
        const absolutePath = path.join(currentDir, entry.name);
        const relativePath = path.relative(rootDir, absolutePath);

        if (entry.isDirectory()) {
            if (NESTED_EXCLUDED_DIRS.has(entry.name)) continue;
            // At the repo root, only descend into directories that can hold
            // shippable files (src/, public/). Root-level junk (api/, data/,
            // tests/, node_modules/, …) is skipped here; nested dirs of the same
            // name (e.g. src/api) are still walked because this guard only fires
            // at depth 0.
            if (currentDir === rootDir && !ROOT_DIRS.has(entry.name)) continue;
            walkFiles(rootDir, absolutePath, files);
        } else if (entry.isFile() && shouldIncludeFile(relativePath)) {
            files.push(normalizePath(relativePath));
        }
    }

    return files;
}

function jsonString(value) {
    return JSON.stringify(isPlainObject(value) ? value : {});
}

function sanitizeFileName(value) {
    return String(value || 'printkinetix-node')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'printkinetix-node';
}

export function collectNodePackageFiles(rootDir) {
    return walkFiles(rootDir).sort((a, b) => a.localeCompare(b));
}

// Per-package secrets. Each downloaded node bundle gets a UNIQUE, random set —
// never the old shipped constants. Rationale:
//   - ENCRYPTION_KEY encrypts printer access codes at rest (src/utils/crypto.js).
//     A shared constant made that encryption worthless; a per-node 32-byte key
//     means a leaked node .env only exposes THAT node's stored codes.
//   - JWT_SECRET signs the local dashboard's session cookies. A known secret let
//     anyone forge an admin session; a per-node random secret prevents that.
//   - ADMIN_PASSWORD is the local dashboard login. A shipped default ("antigravity")
//     let anyone who could reach the port log in; a per-node random password does not.
// The admin password is surfaced in README-FIRST.txt so the operator can sign in.
export function generateNodeSecrets(randomBytes = crypto.randomBytes) {
    // Ambiguous characters (0/O, 1/l/I) removed so the password is easy to
    // transcribe from the README into the browser.
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    const bytes = randomBytes(20);
    let adminPassword = '';
    for (let i = 0; i < bytes.length; i += 1) {
        adminPassword += alphabet[bytes[i] % alphabet.length];
    }
    return {
        // 32 bytes hex = 64 chars — exactly what src/utils/crypto.js consumes.
        encryptionKey: randomBytes(32).toString('hex'),
        jwtSecret: randomBytes(32).toString('base64url'),
        adminPassword,
    };
}

export function createNodeEnv({
    cloudApiUrl,
    localNodeToken,
    pollIntervalMs = 2000,
    maxPollIntervalMs = 30000,
    heartbeatIntervalMs = 30000,
    requestTimeoutMs = 15000,
    retryMaxAttempts = 4,
    retryBaseDelayMs = 500,
    retryMaxDelayMs = 10000,
    resultOutboxPath = './data/cloud-result-outbox.json',
    resultOutboxFlushLimit = 25,
    resultOutboxMaxEntries = 1000,
    mockMode = false,
    // Bind the local dashboard to loopback by default: printer control does not
    // require the dashboard to be reachable from other machines, and exposing an
    // admin login on the LAN is unnecessary attack surface. Operators who need
    // LAN access can set HOST=0.0.0.0 deliberately after changing the password.
    host = '127.0.0.1',
    secrets = null,
    adminUsername = 'admin',
} = {}) {
    const normalizedCloudApiUrl = normalizeRequiredString(cloudApiUrl, 'cloud_api_url').replace(/\/+$/, '');
    const normalizedToken = normalizeRequiredString(localNodeToken, 'local_node_token');
    const { encryptionKey, jwtSecret, adminPassword } = secrets || generateNodeSecrets();

    return [
        '# PrintKinetix Windows node configuration',
        '# Secrets below are UNIQUE to this download — keep this file private.',
        'PORT=3000',
        `HOST=${host}`,
        `JWT_SECRET=${jwtSecret}`,
        `ADMIN_USERNAME=${adminUsername}`,
        `ADMIN_PASSWORD=${adminPassword}`,
        'DB_PATH=./data/antigravity.db',
        `ENCRYPTION_KEY=${encryptionKey}`,
        'LOG_LEVEL=info',
        '',
        `CLOUD_API_URL=${normalizedCloudApiUrl}`,
        `LOCAL_NODE_TOKEN=${normalizedToken}`,
        `CLOUD_COMMAND_POLL_INTERVAL_MS=${pollIntervalMs}`,
        `CLOUD_COMMAND_MAX_POLL_INTERVAL_MS=${maxPollIntervalMs}`,
        `CLOUD_HEARTBEAT_INTERVAL_MS=${heartbeatIntervalMs}`,
        `CLOUD_REQUEST_TIMEOUT_MS=${requestTimeoutMs}`,
        `CLOUD_RETRY_MAX_ATTEMPTS=${retryMaxAttempts}`,
        `CLOUD_RETRY_BASE_DELAY_MS=${retryBaseDelayMs}`,
        `CLOUD_RETRY_MAX_DELAY_MS=${retryMaxDelayMs}`,
        `CLOUD_RESULT_OUTBOX_PATH=${resultOutboxPath}`,
        `CLOUD_RESULT_OUTBOX_FLUSH_LIMIT=${resultOutboxFlushLimit}`,
        `CLOUD_RESULT_OUTBOX_MAX_ENTRIES=${resultOutboxMaxEntries}`,
        '',
        'MQTT_RECONNECT_INTERVAL_MS=5000',
        'HEALTH_CHECK_INTERVAL_MS=30000',
        'COMMAND_POLL_INTERVAL_MS=1000',
        `MOCK_MODE=${mockMode ? 'true' : 'false'}`,
        '',
    ].join('\n');
}

export function createNodePackageReadme({ nodeName = 'Windows NUC', cloudApiUrl, adminPassword = null } = {}) {
    return [
        'PrintKinetix Cloud Node',
        '=======================',
        '',
        `Node: ${nodeName || 'Windows NUC'}`,
        `Cloud: ${cloudApiUrl || 'configured in .env'}`,
        '',
        'Local dashboard sign-in',
        '-----------------------',
        '  URL:      http://localhost:3000',
        '  Username: admin',
        `  Password: ${adminPassword || '(see ADMIN_PASSWORD in .env)'}`,
        'This password is UNIQUE to this download and also stored in .env. Change it',
        'after first sign-in if you like. The dashboard binds to localhost only by',
        'default — set HOST=0.0.0.0 in .env only if you must reach it from another',
        'machine, and change the password first.',
        '',
        'Security model',
        '--------------',
        '- This node uses HTTPS outbound to reach the Vercel cloud API.',
        '- Do not open inbound firewall ports from the public internet to this computer.',
        '- Keep LOCAL_NODE_TOKEN private; it is the only cloud credential needed here.',
        '- .env also holds this node\'s UNIQUE JWT_SECRET, ENCRYPTION_KEY (encrypts stored',
        '  printer access codes), and ADMIN_PASSWORD. Never share or reuse them across nodes.',
        '- This package must not contain SUPABASE_SERVICE_ROLE_KEY, CLOUD_ADMIN_TOKEN, NODE_TOKEN_PEPPER, or merchant API key pepper values.',
        '- Printer control stays on the local network through Bambu MQTT and FTPS.',
        '- Cloud command results are spooled to ./data/cloud-result-outbox.json if Vercel or Supabase is temporarily unreachable.',
        '',
        'Cloud setup quickstart',
        '----------------------',
        '1. Install Node.js 24 LTS or newer on the Windows computer.',
        '2. Extract this ZIP to a stable folder such as C:\\PrintKinetix.',
        '3. Confirm .env contains CLOUD_API_URL and LOCAL_NODE_TOKEN.',
        '4. Double-click Start Cloud Node.bat.',
        '5. Open http://localhost:3000 on this computer to configure LAN printers.',
        '6. Enable LAN/Developer mode on each Bambu printer and add its IP, serial, and access code.',
        '7. Return to /cloud, open Local Printer Sync, and queue Discover LAN Printers.',
        '8. Queue Sync Printer Inventory after printers are saved locally so the cloud command result includes printer, AMS, and filament snapshots.',
        '9. Verify the node heartbeat is online and check network interfaces if printers live on multiple VLANs or NICs.',
        '',
        'Cloud sync commands',
        '-------------------',
        '- Discover LAN Printers queues cloud.printers.discover. The node returns Bambu SSDP discoveries visible from this Windows machine.',
        '- Sync Printer Inventory queues cloud.printers.sync. The node returns registered local printers, live worker status, AMS tray counts, and saved filament snapshots when available.',
        '',
        'Merchant print flow',
        '-------------------',
        'When Vercel queues cloud.print.ready, this node downloads the signed private print artifact, wraps raw .gcode into .gcode.3mf when needed, uploads to the selected Bambu printer over LAN FTPS, starts the print through MQTT, and reports the result back to Vercel.',
        '',
    ].join('\r\n');
}

export function buildNodePackageManifest({ files, generatedAt, nodeName, cloudApiUrl }) {
    return {
        package: 'printkinetix-cloud-node',
        generated_at: generatedAt,
        node_name: nodeName || 'Windows NUC',
        cloud_api_url: cloudApiUrl,
        files,
    };
}

function buildSourceNodePackage({
    rootDir = process.cwd(),
    cloudApiUrl,
    localNodeToken,
    nodeName = 'Windows NUC',
    now = () => new Date(),
} = {}) {
    const normalizedCloudApiUrl = normalizeRequiredString(cloudApiUrl, 'cloud_api_url').replace(/\/+$/, '');
    const normalizedToken = normalizeRequiredString(localNodeToken, 'local_node_token');
    const files = collectNodePackageFiles(rootDir);
    const generatedAt = now().toISOString();
    const zip = new AdmZip();
    // One random secret set per package, shared between .env and the README so
    // the operator can read the generated dashboard password.
    const secrets = generateNodeSecrets();

    for (const relativePath of files) {
        zip.addFile(relativePath, fs.readFileSync(path.join(rootDir, relativePath)));
    }

    zip.addFile('.env', Buffer.from(createNodeEnv({
        cloudApiUrl: normalizedCloudApiUrl,
        localNodeToken: normalizedToken,
        secrets,
    })));
    zip.addFile('README-FIRST.txt', Buffer.from(createNodePackageReadme({
        nodeName,
        cloudApiUrl: normalizedCloudApiUrl,
        adminPassword: secrets.adminPassword,
    })));
    zip.addFile('node-package-manifest.json', Buffer.from(JSON.stringify(buildNodePackageManifest({
        files,
        generatedAt,
        nodeName,
        cloudApiUrl: normalizedCloudApiUrl,
    }), null, 2)));

    return zip.toBuffer();
}

// ------------------------------------------------------------------
// Portable ("no install") bundle
//
// When the prebuilt bundle exists (dist/windows-node/farm-node.cjs), the
// download ships a self-contained package: a single compiled farm-node.cjs (all
// npm deps inlined), the colocated runtime assets, a double-click launcher, and
// the per-user .env. No `npm install`, no source tree.
// ------------------------------------------------------------------

export const PORTABLE_BUNDLE_SUBDIR = path.join('dist', 'windows-node');

export function hasPortableBundle(bundleDir) {
    try {
        return fs.existsSync(path.join(bundleDir, 'farm-node.cjs'))
            && fs.existsSync(path.join(bundleDir, 'sql-wasm.wasm'));
    } catch {
        return false;
    }
}

// Walk public/ for the portable bundle: everything the local dashboard needs,
// minus the cloud-console-only files.
export function collectPortablePublicFiles(rootDir) {
    const publicDir = path.join(rootDir, 'public');
    if (!fs.existsSync(publicDir)) return [];
    const out = [];
    const walk = (currentDir) => {
        for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
            const absolutePath = path.join(currentDir, entry.name);
            const relativePath = normalizePath(path.relative(rootDir, absolutePath));
            if (entry.isDirectory()) {
                if (NESTED_EXCLUDED_DIRS.has(entry.name)) continue;
                walk(absolutePath);
            } else if (entry.isFile()
                && !PORTABLE_PUBLIC_EXCLUDES.has(relativePath)
                && !EXCLUDED_FILES.has(entry.name)) {
                out.push(relativePath);
            }
        }
    };
    walk(publicDir);
    return out.sort((a, b) => a.localeCompare(b));
}

export function createFarmNodeLauncherBat() {
    return [
        '@echo off',
        'setlocal',
        'cd /d "%~dp0"',
        '',
        'title PrintKinetix Farm Node',
        'echo Starting PrintKinetix farm node...',
        'echo.',
        '',
        'if not exist ".env" (',
        '  echo Missing .env file next to this launcher.',
        '  echo It should contain CLOUD_API_URL and LOCAL_NODE_TOKEN ^(shipped in this package^).',
        '  pause',
        '  exit /b 1',
        ')',
        '',
        'rem 1) Prefer a Node runtime bundled next to this launcher.',
        'set "NODE_EXE=%~dp0node\\node.exe"',
        'if exist "%NODE_EXE%" goto run',
        '',
        'rem 2) Fall back to a Node already installed on this PC.',
        'where node >nul 2>nul',
        'if %errorlevel%==0 (',
        '  set "NODE_EXE=node"',
        '  goto run',
        ')',
        '',
        'rem 3) No Node found: fetch a portable Node runtime automatically (no admin install, no npm).',
        'echo Node.js was not found. Downloading a portable copy ^(one time^)...',
        'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0get-node.ps1"',
        'if exist "%NODE_EXE%" goto run',
        'echo.',
        'echo Could not obtain Node.js automatically. Install Node 20+ from https://nodejs.org and re-run.',
        'pause',
        'exit /b 1',
        '',
        ':run',
        'echo Using Node: %NODE_EXE%',
        '"%NODE_EXE%" "%~dp0farm-node.cjs"',
        'echo.',
        'echo Farm node stopped.',
        'pause',
    ].join('\r\n');
}

// Pinned Node runtime + its official SHA-256 (from nodejs.org/dist/<ver>/
// SHASUMS256.txt). The launchers download this exact version and MUST verify
// the archive hash before extracting/executing it — a TLS-MITM, a poisoned
// mirror, or a tampered cache would otherwise yield arbitrary code execution as
// the farm-node process. Bump both the version and the hashes together.
export const PORTABLE_NODE_VERSION = 'v22.11.0';
export const PORTABLE_NODE_SHA256 = Object.freeze({
    'win-x64': '905373a059aecaf7f48c1ce10ffbd5334457ca00f678747f19db5ea7d256c236',
    'linux-arm64': '6031d04b98f59ff0f7cb98566f65b115ecd893d3b7870821171708cdbaf7ae6e',
    'linux-x64': '83bf07dd343002a26211cf1fcd46a9d9534219aad42ee02847816940bf610a72',
    'linux-armv7l': '9de0fdcfb1cccbe03f72f939e4e6f03867aef3da8223f90606cd93757704dae0',
});

export function createGetNodePs1() {
    return [
        '$ErrorActionPreference = "Stop"',
        '$dir = Split-Path -Parent $MyInvocation.MyCommand.Path',
        `$ver = "${PORTABLE_NODE_VERSION}"`,
        '$zip = "node-$ver-win-x64.zip"',
        '$url = "https://nodejs.org/dist/$ver/$zip"',
        // Pinned integrity hash for node-<ver>-win-x64.zip.
        `$expected = "${PORTABLE_NODE_SHA256['win-x64']}"`,
        '$tmp = Join-Path $env:TEMP $zip',
        'Write-Host "Downloading $url"',
        'Invoke-WebRequest -Uri $url -OutFile $tmp',
        'Write-Host "Verifying SHA-256..."',
        '$actual = (Get-FileHash -Algorithm SHA256 -Path $tmp).Hash.ToLower()',
        'if ($actual -ne $expected) {',
        '  Remove-Item -Force $tmp',
        '  throw "Node.js download failed integrity check. Expected $expected but got $actual. Aborting for safety."',
        '}',
        'Write-Host "Integrity OK"',
        '$extract = Join-Path $env:TEMP "pkx-node-$ver"',
        'if (Test-Path $extract) { Remove-Item -Recurse -Force $extract }',
        'Expand-Archive -Path $tmp -DestinationPath $extract -Force',
        '$nodeDir = Join-Path $dir "node"',
        'if (Test-Path $nodeDir) { Remove-Item -Recurse -Force $nodeDir }',
        'Move-Item -Path (Join-Path $extract "node-$ver-win-x64") -Destination $nodeDir',
        'Remove-Item -Force $tmp',
        'Write-Host "Portable Node installed to $nodeDir"',
    ].join('\r\n');
}

// Linux / Raspberry Pi launcher. Same portable farm-node.cjs, run under Node on
// ARM64/x64. Uses LF line endings so bash accepts it.
export function createStartFarmNodeSh() {
    return [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'cd "$(dirname "$0")"',
        '',
        'echo "Starting PrintKinetix farm node..."',
        '',
        'if [ ! -f ".env" ]; then',
        '  echo "Missing .env file next to this launcher (needs CLOUD_API_URL and LOCAL_NODE_TOKEN)."',
        '  exit 1',
        'fi',
        '',
        '# 1) Prefer a Node runtime bundled next to this launcher.',
        'if [ -x "./node/bin/node" ]; then',
        '  NODE_BIN="./node/bin/node"',
        '# 2) Fall back to a Node already installed on this machine.',
        'elif command -v node >/dev/null 2>&1; then',
        '  NODE_BIN="node"',
        'else',
        '  # 3) No Node found: fetch a portable Node runtime automatically (no apt, no npm).',
        '  echo "Node.js was not found. Downloading a portable copy (one time)..."',
        '  bash ./get-node.sh',
        '  NODE_BIN="./node/bin/node"',
        'fi',
        '',
        'echo "Using Node: $NODE_BIN"',
        'exec "$NODE_BIN" ./farm-node.cjs',
        '',
    ].join('\n');
}

// Downloads a portable Node build matching the machine architecture (Raspberry
// Pi 5 = arm64). No system package manager required.
export function createGetNodeSh() {
    return [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'cd "$(dirname "$0")"',
        '',
        `VER="${PORTABLE_NODE_VERSION}"`,
        'ARCH="$(uname -m)"',
        'case "$ARCH" in',
        `  aarch64|arm64) NODE_ARCH="linux-arm64"; EXPECTED="${PORTABLE_NODE_SHA256['linux-arm64']}" ;;`,
        `  x86_64|amd64)  NODE_ARCH="linux-x64"; EXPECTED="${PORTABLE_NODE_SHA256['linux-x64']}" ;;`,
        `  armv7l|armv6l) NODE_ARCH="linux-armv7l"; EXPECTED="${PORTABLE_NODE_SHA256['linux-armv7l']}" ;;`,
        '  *) echo "Unsupported architecture: $ARCH. Install Node 20+ manually."; exit 1 ;;',
        'esac',
        '',
        'TARBALL="node-$VER-$NODE_ARCH.tar.xz"',
        'URL="https://nodejs.org/dist/$VER/$TARBALL"',
        // Private temp dir (mktemp) avoids a predictable /tmp path a local
        // attacker could pre-create or symlink-swap.
        'WORKDIR="$(mktemp -d)"',
        'trap \'rm -rf "$WORKDIR"\' EXIT',
        'echo "Downloading $URL"',
        'curl -fsSL "$URL" -o "$WORKDIR/$TARBALL"',
        'echo "Verifying SHA-256..."',
        // Prefer sha256sum; fall back to shasum -a 256 (macOS/BSD).
        'if command -v sha256sum >/dev/null 2>&1; then',
        '  ACTUAL="$(sha256sum "$WORKDIR/$TARBALL" | awk \'{print $1}\')"',
        'else',
        '  ACTUAL="$(shasum -a 256 "$WORKDIR/$TARBALL" | awk \'{print $1}\')"',
        'fi',
        'if [ "$ACTUAL" != "$EXPECTED" ]; then',
        '  echo "Node.js download failed integrity check. Expected $EXPECTED but got $ACTUAL. Aborting for safety." >&2',
        '  exit 1',
        'fi',
        'echo "Integrity OK"',
        'rm -rf ./node && mkdir -p ./node',
        'tar -xJf "$WORKDIR/$TARBALL" -C ./node --strip-components=1',
        'echo "Portable Node installed to ./node"',
        '',
    ].join('\n');
}

// Optional: install the node as a systemd service so it auto-starts on boot and
// restarts on failure — turning a Raspberry Pi into a self-healing farm controller.
export function createInstallServiceSh() {
    return [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'DIR="$(cd "$(dirname "$0")" && pwd)"',
        'SERVICE="/etc/systemd/system/printkinetix-node.service"',
        '',
        'echo "Installing systemd service at $SERVICE"',
        'sudo tee "$SERVICE" >/dev/null <<EOF',
        '[Unit]',
        'Description=PrintKinetix Farm Node',
        'After=network-online.target',
        'Wants=network-online.target',
        '',
        '[Service]',
        'Type=simple',
        'WorkingDirectory=$DIR',
        'ExecStart=/usr/bin/env bash "$DIR/start-farm-node.sh"',
        'Restart=always',
        'RestartSec=5',
        'User=$(whoami)',
        '',
        '[Install]',
        'WantedBy=multi-user.target',
        'EOF',
        '',
        'sudo systemctl daemon-reload',
        'sudo systemctl enable --now printkinetix-node',
        'echo "Service installed. Status: sudo systemctl status printkinetix-node"',
        '',
    ].join('\n');
}

export function createPortableReadme({ nodeName = 'Windows NUC', cloudApiUrl } = {}) {
    return [
        'PrintKinetix Farm Node (portable)',
        '=================================',
        '',
        `Node: ${nodeName || 'Windows NUC'}`,
        `Cloud: ${cloudApiUrl || 'configured in .env'}`,
        '',
        'This is a self-contained build. It does NOT need `npm install` and has no',
        'source tree — every dependency is compiled into farm-node.cjs. The same',
        'package runs on Windows, on a Raspberry Pi 5 (arm64), and on Linux x64.',
        '',
        'To run on Windows',
        '-----------------',
        '1. Keep every file in this folder together.',
        '2. Confirm .env is present (it carries CLOUD_API_URL and LOCAL_NODE_TOKEN).',
        '3. Double-click "Start Farm Node.bat".',
        '   - It uses a bundled Node runtime (\\node), Node already on the PC, or',
        '     downloads a portable Node the first time. No manual install, no keys to type.',
        '',
        'To run on a Raspberry Pi 5 / Linux',
        '----------------------------------',
        '1. Copy this folder to the Pi (keep every file together).',
        '2. Confirm .env is present.',
        '3. Run:  bash start-farm-node.sh',
        '   - It uses a bundled Node, Node already installed, or downloads a portable',
        '     Node matching the Pi (arm64) automatically. No apt, no npm, no keys to type.',
        '4. Optional — start on boot + auto-restart (self-healing):  bash install-service.sh',
        '',
        'Then, on either platform',
        '------------------------',
        '- Open http://localhost:3000 on that machine to add LAN printers.',
        '- Enable LAN/Developer mode on each Bambu printer and add its IP, serial, and access code.',
        '- Return to /cloud, open Local Printer Sync, and queue Discover LAN Printers, then Sync Printer Inventory.',
        '',
        'Security model',
        '--------------',
        '- HTTPS outbound only to the cloud API; keep LOCAL_NODE_TOKEN private.',
        '- No inbound public ports. Printer control stays on the LAN via MQTT + FTPS.',
        '- Contains no SUPABASE_SERVICE_ROLE_KEY, CLOUD_ADMIN_TOKEN, or NODE_TOKEN_PEPPER.',
        '- Cloud command results spool to ./data/cloud-result-outbox.json when the cloud is unreachable.',
        '',
        'Files',
        '-----',
        '  farm-node.cjs        the entire node, bundled (no npm install)',
        '  public/              local dashboard served at http://localhost:3000',
        '  migrations/          applied to the local SQLite database on first run',
        '  sql-wasm.wasm        SQLite engine (WebAssembly)',
        '  Start Farm Node.bat  Windows double-click launcher',
        '  start-farm-node.sh   Raspberry Pi / Linux launcher',
        '  install-service.sh   optional systemd auto-start on Pi / Linux',
        '  .env                 your cloud credentials (do not share)',
        '',
    ].join('\r\n');
}

export function buildPortableNodePackage({
    rootDir = process.cwd(),
    bundleDir = path.join(process.cwd(), PORTABLE_BUNDLE_SUBDIR),
    cloudApiUrl,
    localNodeToken,
    nodeName = 'Windows NUC',
    now = () => new Date(),
} = {}) {
    const normalizedCloudApiUrl = normalizeRequiredString(cloudApiUrl, 'cloud_api_url').replace(/\/+$/, '');
    const normalizedToken = normalizeRequiredString(localNodeToken, 'local_node_token');
    const generatedAt = now().toISOString();
    const zip = new AdmZip();
    const files = [];
    const portableSecrets = generateNodeSecrets();

    const addFile = (entryName, buffer) => {
        zip.addFile(entryName, buffer);
        files.push(entryName);
    };

    // 1. Compiled bundle + its WebAssembly engine (the committed build artifacts).
    addFile('farm-node.cjs', fs.readFileSync(path.join(bundleDir, 'farm-node.cjs')));
    addFile('sql-wasm.wasm', fs.readFileSync(path.join(bundleDir, 'sql-wasm.wasm')));

    // 2. Local dashboard assets (public/, minus the cloud-console files).
    for (const relativePath of collectPortablePublicFiles(rootDir)) {
        addFile(relativePath, fs.readFileSync(path.join(rootDir, relativePath)));
    }

    // 3. SQL migrations, colocated at migrations/ so PKX_ASSET_ROOT resolves them.
    const migrationsDir = path.join(rootDir, 'src', 'db', 'migrations');
    if (fs.existsSync(migrationsDir)) {
        for (const file of fs.readdirSync(migrationsDir).sort()) {
            if (file.endsWith('.sql')) {
                addFile(`migrations/${file}`, fs.readFileSync(path.join(migrationsDir, file)));
            }
        }
    }

    // 4. Launchers (Windows + Raspberry Pi / Linux), portable-Node helpers,
    //    README, per-user env, manifest.
    addFile('Start Farm Node.bat', Buffer.from(createFarmNodeLauncherBat(), 'utf-8'));
    addFile('get-node.ps1', Buffer.from(createGetNodePs1(), 'utf-8'));
    addFile('start-farm-node.sh', Buffer.from(createStartFarmNodeSh(), 'utf-8'));
    addFile('get-node.sh', Buffer.from(createGetNodeSh(), 'utf-8'));
    addFile('install-service.sh', Buffer.from(createInstallServiceSh(), 'utf-8'));
    addFile('README-FIRST.txt', Buffer.from(createPortableReadme({
        nodeName,
        cloudApiUrl: normalizedCloudApiUrl,
        adminPassword: portableSecrets.adminPassword,
    })));
    zip.addFile('.env', Buffer.from(createNodeEnv({
        cloudApiUrl: normalizedCloudApiUrl,
        localNodeToken: normalizedToken,
        secrets: portableSecrets,
    })));
    zip.addFile('node-package-manifest.json', Buffer.from(JSON.stringify(buildNodePackageManifest({
        files,
        generatedAt,
        nodeName,
        cloudApiUrl: normalizedCloudApiUrl,
    }), null, 2)));

    return zip.toBuffer();
}

// Ship the portable ("no install") bundle when it has been built; otherwise fall
// back to the source package so the download always works.
export function buildWindowsNodePackage(options = {}) {
    const rootDir = options.rootDir || process.cwd();
    const bundleDir = options.bundleDir || path.join(rootDir, PORTABLE_BUNDLE_SUBDIR);
    if (hasPortableBundle(bundleDir)) {
        return buildPortableNodePackage({ ...options, rootDir, bundleDir });
    }
    return buildSourceNodePackage({ ...options, rootDir });
}

export function getNodePackageFileName(nodeName) {
    return `${sanitizeFileName(nodeName || 'printkinetix-node')}-cloud-node.zip`;
}
