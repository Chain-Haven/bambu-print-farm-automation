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
const EXCLUDED_SEGMENTS = new Set([
    '.git',
    '.playwright-cli',
    'api',
    'data',
    'docs',
    'node_modules',
    'output',
    'supabase',
    'tests',
    'uploads',
]);
const EXCLUDED_FILES = new Set(['.env', '.env.local']);
const EXCLUDED_PATHS = new Set([
    'public/cloud.html',
    'public/css/cloud.css',
    'public/js/cloud-dashboard.js',
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
    if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) return false;
    if (EXCLUDED_FILES.has(segments.at(-1))) return false;

    if (segments.length === 1) return ROOT_FILES.has(normalized);
    return ROOT_DIRS.has(segments[0]);
}

function walkFiles(rootDir, currentDir = rootDir, files = []) {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
        const absolutePath = path.join(currentDir, entry.name);
        const relativePath = path.relative(rootDir, absolutePath);

        if (entry.isDirectory()) {
            const normalized = normalizePath(relativePath);
            if (normalized.split('/').some((segment) => EXCLUDED_SEGMENTS.has(segment))) continue;
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
        'Setup',
        '-----',
        '1. Install Node.js 24 LTS or newer on the Windows computer.',
        '2. Extract this ZIP to a stable folder such as C:\\PrintKinetix.',
        '3. Confirm .env contains CLOUD_API_URL and LOCAL_NODE_TOKEN.',
        '4. Double-click Start Cloud Node.bat.',
        '5. Open http://localhost:3000 on this computer to configure LAN printers.',
        '6. Enable LAN/Developer mode on each Bambu printer and add its IP, serial, and access code.',
        '7. Return to /cloud and verify the node heartbeat is online.',
        '8. Check the cloud heartbeat network interface list if printers live on multiple VLANs or NICs.',
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

export function buildWindowsNodePackage({
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

export function getNodePackageFileName(nodeName) {
    return `${sanitizeFileName(nodeName || 'printkinetix-node')}-cloud-node.zip`;
}
