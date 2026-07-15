import AdmZip from 'adm-zip';
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
} = {}) {
    const normalizedCloudApiUrl = normalizeRequiredString(cloudApiUrl, 'cloud_api_url').replace(/\/+$/, '');
    const normalizedToken = normalizeRequiredString(localNodeToken, 'local_node_token');

    return [
        '# PrintKinetix Windows node configuration',
        'PORT=3000',
        'HOST=0.0.0.0',
        'JWT_SECRET=change-me',
        'ADMIN_USERNAME=admin',
        'ADMIN_PASSWORD=antigravity',
        'DB_PATH=./data/antigravity.db',
        'ENCRYPTION_KEY=0123456789abcdef0123456789abcdef',
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

export function createNodePackageReadme({ nodeName = 'Windows NUC', cloudApiUrl } = {}) {
    return [
        'PrintKinetix Cloud Node',
        '=======================',
        '',
        `Node: ${nodeName || 'Windows NUC'}`,
        `Cloud: ${cloudApiUrl || 'configured in .env'}`,
        '',
        'Security model',
        '--------------',
        '- This node uses HTTPS outbound to reach the Vercel cloud API.',
        '- Do not open inbound firewall ports from the public internet to this computer.',
        '- Keep LOCAL_NODE_TOKEN private; it is the only cloud credential needed here.',
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
        '7. Syncing to the cloud is automatic: every heartbeat mirrors registered printers (state + AMS filament) and reports LAN-discovered printers, which appear under "Found on the network" on the /cloud fleet board for one-click adoption.',
        '8. Verify the node heartbeat is online and check network interfaces if printers live on multiple VLANs or NICs.',
        '',
        'Cloud sync commands (optional, for on-demand snapshots)',
        '--------------------------------------------------------',
        '- Discover LAN Printers queues cloud.printers.discover. The node returns Bambu SSDP discoveries visible from this machine immediately, without waiting for the next heartbeat.',
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

    for (const relativePath of files) {
        zip.addFile(relativePath, fs.readFileSync(path.join(rootDir, relativePath)));
    }

    zip.addFile('.env', Buffer.from(createNodeEnv({
        cloudApiUrl: normalizedCloudApiUrl,
        localNodeToken: normalizedToken,
    })));
    zip.addFile('README-FIRST.txt', Buffer.from(createNodePackageReadme({
        nodeName,
        cloudApiUrl: normalizedCloudApiUrl,
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

export function createGetNodePs1() {
    return [
        '$ErrorActionPreference = "Stop"',
        '$dir = Split-Path -Parent $MyInvocation.MyCommand.Path',
        '$ver = "v22.11.0"',
        '$zip = "node-$ver-win-x64.zip"',
        '$url = "https://nodejs.org/dist/$ver/$zip"',
        '$tmp = Join-Path $env:TEMP $zip',
        'Write-Host "Downloading $url"',
        'Invoke-WebRequest -Uri $url -OutFile $tmp',
        '$extract = Join-Path $env:TEMP "pkx-node-$ver"',
        'if (Test-Path $extract) { Remove-Item -Recurse -Force $extract }',
        'Expand-Archive -Path $tmp -DestinationPath $extract -Force',
        '$nodeDir = Join-Path $dir "node"',
        'if (Test-Path $nodeDir) { Remove-Item -Recurse -Force $nodeDir }',
        'Move-Item -Path (Join-Path $extract "node-$ver-win-x64") -Destination $nodeDir',
        'Write-Host "Portable Node installed to $nodeDir"',
    ].join('\r\n');
}

// macOS one-click installer/launcher. Finder runs .command files in Terminal.
// Double-clicking it deploys the node as a launchd LaunchAgent: it starts
// immediately, starts again at every login, and restarts automatically if it
// crashes (KeepAlive). Re-running it is safe — it reinstalls and restarts.
// Works on every macOS launchctl generation: `bootstrap` (10.14+) with a
// `load -w` fallback for older systems.
export const MAC_LAUNCH_AGENT_LABEL = 'com.printkinetix.farm-node';

export function createStartFarmNodeCommand() {
    return [
        '#!/usr/bin/env bash',
        'cd "$(dirname "$0")"',
        'DIR="$(pwd)"',
        `LABEL="${MAC_LAUNCH_AGENT_LABEL}"`,
        'PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"',
        '',
        'echo "PrintKinetix Farm Node — Mac setup"',
        'echo "=================================="',
        '',
        '# Extraction tools sometimes drop the executable bit; restore it.',
        'chmod +x ./start-farm-node.sh ./get-node.sh 2>/dev/null || true',
        '# Best-effort: clear the macOS quarantine flag so helper scripts run without prompts.',
        'xattr -dr com.apple.quarantine . 2>/dev/null || true',
        '',
        'if [ ! -f ".env" ]; then',
        '  echo "Missing .env next to this launcher (it carries your cloud credentials)."',
        '  echo "Re-download the app from the cloud console — the .env is generated into the zip."',
        '  read -r -p "Press Enter to close this window..." || true',
        '  exit 1',
        'fi',
        '',
        '# Always keep a portable Node inside this folder: the login service runs',
        '# with a minimal PATH, so Homebrew/nvm installs are invisible to it.',
        '# Fetching now (with visible progress) keeps the background service',
        '# deterministic on every Mac.',
        'if [ ! -x "./node/bin/node" ]; then',
        '  echo "Fetching a portable Node runtime for this Mac (one time)..."',
        '  bash ./get-node.sh',
        'fi',
        '',
        'mkdir -p "$HOME/Library/LaunchAgents" ./data',
        '',
        '# Install the LaunchAgent: run now, run at every login, restart on crash.',
        'cat > "$PLIST" <<PLIST_EOF',
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        '  <key>Label</key><string>$LABEL</string>',
        '  <key>ProgramArguments</key>',
        '  <array>',
        '    <string>/bin/bash</string>',
        '    <string>$DIR/start-farm-node.sh</string>',
        '  </array>',
        '  <key>WorkingDirectory</key><string>$DIR</string>',
        '  <key>RunAtLoad</key><true/>',
        '  <key>KeepAlive</key><true/>',
        '  <key>StandardOutPath</key><string>$DIR/data/farm-node.log</string>',
        '  <key>StandardErrorPath</key><string>$DIR/data/farm-node.log</string>',
        '</dict>',
        '</plist>',
        'PLIST_EOF',
        '',
        '# (Re)load it: modern launchctl first, legacy fallback for older macOS.',
        'launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true',
        'if ! launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then',
        '  launchctl load -w "$PLIST"',
        'fi',
        '',
        'echo ""',
        'echo "Farm node installed and running."',
        'echo "  - Starts automatically every time you log in to this Mac."',
        'echo "  - Restarts by itself if it ever crashes."',
        'echo "  - Logs: $DIR/data/farm-node.log"',
        'echo "  - To remove it later: double-click \\"Uninstall Farm Node.command\\"."',
        'echo ""',
        'echo "Waiting for the local dashboard to come up..."',
        'for i in $(seq 1 30); do',
        '  if curl -s -o /dev/null "http://localhost:3000"; then',
        '    echo "Dashboard is up — opening http://localhost:3000"',
        '    open "http://localhost:3000"',
        '    break',
        '  fi',
        '  sleep 1',
        'done',
        '',
        'echo ""',
        'read -r -p "All done — press Enter to close this window..." || true',
        '',
    ].join('\n');
}

// macOS uninstaller: stops the LaunchAgent and removes the login item. The
// folder itself is left alone so nothing is deleted without the user doing it.
export function createUninstallFarmNodeCommand() {
    return [
        '#!/usr/bin/env bash',
        `LABEL="${MAC_LAUNCH_AGENT_LABEL}"`,
        'PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"',
        '',
        'launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true',
        'rm -f "$PLIST"',
        'echo "Farm node service removed — it will no longer start at login."',
        'echo "You can delete this folder to remove the app completely."',
        'read -r -p "Press Enter to close this window..." || true',
        '',
    ].join('\n');
}

// macOS / Linux / Raspberry Pi launcher. Same portable farm-node.cjs, run under
// Node on ARM64/x64. Uses LF line endings so bash accepts it.
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

// Downloads a portable Node build matching the machine OS + architecture
// (macOS Apple Silicon/Intel, Raspberry Pi 5 = arm64, Linux x64). No system
// package manager required. macOS gets .tar.gz (bsdtar-safe); Linux gets .tar.xz.
export function createGetNodeSh() {
    return [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'cd "$(dirname "$0")"',
        '',
        'VER="v22.11.0"',
        'OS="$(uname -s)"',
        'ARCH="$(uname -m)"',
        'case "$OS" in',
        '  Darwin)',
        '    case "$ARCH" in',
        '      arm64)  NODE_ARCH="darwin-arm64" ;;',
        '      x86_64) NODE_ARCH="darwin-x64" ;;',
        '      *) echo "Unsupported Mac architecture: $ARCH. Install Node 20+ from nodejs.org manually."; exit 1 ;;',
        '    esac',
        '    EXT="tar.gz"; TARFLAGS="-xzf" ;;',
        '  Linux)',
        '    case "$ARCH" in',
        '      aarch64|arm64) NODE_ARCH="linux-arm64" ;;',
        '      x86_64|amd64)  NODE_ARCH="linux-x64" ;;',
        '      armv7l|armv6l) NODE_ARCH="linux-armv7l" ;;',
        '      *) echo "Unsupported architecture: $ARCH. Install Node 20+ manually."; exit 1 ;;',
        '    esac',
        '    EXT="tar.xz"; TARFLAGS="-xJf" ;;',
        '  *) echo "Unsupported OS: $OS. Install Node 20+ manually."; exit 1 ;;',
        'esac',
        '',
        'TARBALL="node-$VER-$NODE_ARCH.$EXT"',
        'URL="https://nodejs.org/dist/$VER/$TARBALL"',
        'echo "Downloading $URL"',
        'curl -fsSL "$URL" -o "/tmp/$TARBALL"',
        'rm -rf ./node && mkdir -p ./node',
        'tar $TARFLAGS "/tmp/$TARBALL" -C ./node --strip-components=1',
        'rm -f "/tmp/$TARBALL"',
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
        'START HERE — one double-click per platform',
        '------------------------------------------',
        '  Mac:      double-click  "Start Farm Node (Mac).command"',
        '  Windows:  double-click  "Start Farm Node (Windows).bat"',
        '  Linux/Pi: run           bash start-farm-node.sh',
        '',
        'This is a self-contained build. It does NOT need `npm install` and has no',
        'source tree — every dependency is compiled into farm-node.cjs. The same',
        'package runs on Windows, macOS (Apple Silicon or Intel), a Raspberry Pi 5',
        '(arm64), and Linux x64. Your cloud credentials are already inside (.env) —',
        'there is nothing to type.',
        '',
        'To run on a Mac',
        '---------------',
        '1. Unzip and keep every file in this folder together.',
        '2. Double-click "Start Farm Node (Mac).command".',
        '   - First time only: if macOS says it cannot verify the developer,',
        '     right-click the file and choose Open, then Open again.',
        '   - It installs itself as a login service: starts now, starts every time',
        '     you log in, and restarts by itself if it crashes. It fetches a',
        '     portable Node runtime automatically (no Homebrew, no npm) and opens',
        '     the dashboard at http://localhost:3000 when ready.',
        '3. To remove it later, double-click "Uninstall Farm Node.command".',
        '',
        'To run on Windows',
        '-----------------',
        '1. Keep every file in this folder together.',
        '2. Double-click "Start Farm Node (Windows).bat".',
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
        'Then, on any platform',
        '---------------------',
        '- Syncing is automatic: the node heartbeats to the cloud every ~30s, mirrors',
        '  every registered printer (state + AMS filament), and reports printers it',
        '  hears on the LAN — they appear under "Found on the network" on the /cloud',
        '  fleet board, where one click adopts them (you supply the access code).',
        '- Enable LAN/Developer mode on each Bambu printer so it can be discovered',
        '  and controlled.',
        '- Prefer local control? Open http://localhost:3000 on this machine to add',
        '  printers by IP directly.',
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
        '  Start Farm Node (Mac).command      macOS one-click install (runs now + at every login)',
        '  Uninstall Farm Node.command        macOS: remove the login service',
        '  Start Farm Node (Windows).bat      Windows double-click launcher',
        '  start-farm-node.sh                 Raspberry Pi / Linux launcher (terminal)',
        '  install-service.sh                 optional systemd auto-start on Pi / Linux',
        '  .env                               your cloud credentials (do not share)',
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

    // 4. Launchers (Windows + macOS + Raspberry Pi / Linux), portable-Node
    //    helpers, README, per-user env, manifest. Unix scripts carry 0755 in
    //    the zip so macOS Archive Utility / unzip extract them executable.
    const addUnixScript = (entryName, content) => {
        zip.addFile(entryName, Buffer.from(content, 'utf-8'), '', 0o755);
        files.push(entryName);
    };
    addFile('Start Farm Node (Windows).bat', Buffer.from(createFarmNodeLauncherBat(), 'utf-8'));
    addFile('get-node.ps1', Buffer.from(createGetNodePs1(), 'utf-8'));
    addUnixScript('Start Farm Node (Mac).command', createStartFarmNodeCommand());
    addUnixScript('Uninstall Farm Node.command', createUninstallFarmNodeCommand());
    addUnixScript('start-farm-node.sh', createStartFarmNodeSh());
    addUnixScript('get-node.sh', createGetNodeSh());
    addUnixScript('install-service.sh', createInstallServiceSh());
    addFile('README-FIRST.txt', Buffer.from(createPortableReadme({
        nodeName,
        cloudApiUrl: normalizedCloudApiUrl,
    })));
    zip.addFile('.env', Buffer.from(createNodeEnv({
        cloudApiUrl: normalizedCloudApiUrl,
        localNodeToken: normalizedToken,
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
