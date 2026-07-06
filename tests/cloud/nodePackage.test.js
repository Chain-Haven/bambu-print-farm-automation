import AdmZip from 'adm-zip';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    buildWindowsNodePackage,
    buildPortableNodePackage,
    collectNodePackageFiles,
    collectPortablePublicFiles,
    createFarmNodeLauncherBat,
    createGetNodePs1,
    createGetNodeSh,
    createNodeEnv,
    createNodePackageReadme,
    createStartFarmNodeSh,
    hasPortableBundle,
} from '../../src/cloud/nodePackage.js';

const tempRoots = [];

function makeTempRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkx-node-package-'));
    tempRoots.push(root);
    return root;
}

function writeFile(root, relativePath, content = 'fixture') {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
}

afterEach(() => {
    while (tempRoots.length) {
        fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
    }
});

describe('Windows node package builder', () => {
    it('collects only files needed by the local Windows runtime', () => {
        const root = makeTempRoot();
        [
            'package.json',
            'package-lock.json',
            'server.js',
            'Start Cloud Node.bat',
            'src/cloud/runLocalNode.js',
            'src/services/PrinterRegistry.js',
            'public/index.html',
            'public/cloud.html',
            'public/js/cloud-dashboard.js',
            'public/css/cloud.css',
            'api/cloud/overview.js',
            'supabase/migrations/001.sql',
            'tests/cloud/nodePackage.test.js',
            '.env',
            'data/antigravity.db',
            'node_modules/example/index.js',
        ].forEach((file) => writeFile(root, file));

        const files = collectNodePackageFiles(root);

        expect(new Set(files)).toEqual(new Set([
            'Start Cloud Node.bat',
            'package-lock.json',
            'package.json',
            'public/index.html',
            'server.js',
            'src/cloud/runLocalNode.js',
            'src/services/PrinterRegistry.js',
        ]));
        expect(files).not.toContain('public/cloud.html');
        expect(files).not.toContain('public/js/cloud-dashboard.js');
        expect(files).not.toContain('public/css/cloud.css');
    });

    it('ships the nested src/api Express router the local node imports (regression)', () => {
        // server.js does `import apiRouter from './src/api/router.js'`, so the whole
        // src/api tree MUST be in the package. A previous bug excluded any path with
        // an `api` segment, dropping src/api/** and crashing the node on Windows with
        // "Cannot find module '...\\src\\api\\router.js'".
        const root = makeTempRoot();
        [
            'server.js',
            'package.json',
            'src/api/router.js',
            'src/api/websocket.js',
            'src/api/routes/printers.js',
            'src/api/middleware/errorHandler.js',
            'api/cloud/node-package.js', // top-level Vercel function — must still be excluded
        ].forEach((file) => writeFile(root, file));

        const files = collectNodePackageFiles(root);

        expect(files).toContain('src/api/router.js');
        expect(files).toContain('src/api/websocket.js');
        expect(files).toContain('src/api/routes/printers.js');
        expect(files).toContain('src/api/middleware/errorHandler.js');
        // The top-level Vercel functions directory is still excluded.
        expect(files).not.toContain('api/cloud/node-package.js');
    });

    it('bundles the real repository into a package that includes src/api', () => {
        // Guard against the exclusion regression using the ACTUAL repo tree.
        // Vitest runs from the repo root, so process.cwd() is the project root.
        const files = collectNodePackageFiles(process.cwd());
        expect(files).toContain('src/api/router.js');
        expect(files).toContain('server.js');
        // Cloud-only + secret files stay out.
        expect(files).not.toContain('src/cloud/adminHandlers.js');
        expect(files).not.toContain('public/cloud.html');
    });

    it('creates a prefilled local env without cloud service secrets', () => {
        const env = createNodeEnv({
            cloudApiUrl: 'https://farm.example.com',
            localNodeToken: 'pkx_node_secret',
        });

        expect(env).toContain('CLOUD_API_URL=https://farm.example.com');
        expect(env).toContain('LOCAL_NODE_TOKEN=pkx_node_secret');
        expect(env).toContain('CLOUD_RETRY_MAX_ATTEMPTS=4');
        expect(env).toContain('CLOUD_REQUEST_TIMEOUT_MS=15000');
        expect(env).toContain('CLOUD_RESULT_OUTBOX_PATH=./data/cloud-result-outbox.json');
        expect(env).toContain('MOCK_MODE=false');
        expect(env).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
        expect(env).not.toContain('NODE_TOKEN_PEPPER');
        expect(env).not.toContain('CLOUD_ADMIN_TOKEN');
    });

    it('never ships the old static secrets and binds the dashboard to localhost by default', () => {
        const env = createNodeEnv({
            cloudApiUrl: 'https://farm.example.com',
            localNodeToken: 'pkx_node_secret',
        });

        // The historically-shipped constants must never appear again.
        expect(env).not.toContain('JWT_SECRET=change-me');
        expect(env).not.toContain('ADMIN_PASSWORD=antigravity');
        expect(env).not.toContain('ENCRYPTION_KEY=0123456789abcdef0123456789abcdef');
        // Loopback bind by default — no LAN-exposed admin dashboard.
        expect(env).toContain('HOST=127.0.0.1');
        expect(env).not.toContain('HOST=0.0.0.0');

        // A 32-byte (64 hex char) encryption key so src/utils/crypto.js uses it directly.
        const encMatch = env.match(/^ENCRYPTION_KEY=([0-9a-f]{64})$/m);
        expect(encMatch).not.toBeNull();
        const jwtMatch = env.match(/^JWT_SECRET=(\S+)$/m);
        expect(jwtMatch[1].length).toBeGreaterThanOrEqual(32);
    });

    it('generates a UNIQUE secret set for every package (no reuse across downloads)', () => {
        const a = createNodeEnv({ cloudApiUrl: 'https://a.example.com', localNodeToken: 't1' });
        const b = createNodeEnv({ cloudApiUrl: 'https://a.example.com', localNodeToken: 't1' });
        const keyOf = (env, name) => env.match(new RegExp(`^${name}=(.*)$`, 'm'))[1];

        expect(keyOf(a, 'ENCRYPTION_KEY')).not.toEqual(keyOf(b, 'ENCRYPTION_KEY'));
        expect(keyOf(a, 'JWT_SECRET')).not.toEqual(keyOf(b, 'JWT_SECRET'));
        expect(keyOf(a, 'ADMIN_PASSWORD')).not.toEqual(keyOf(b, 'ADMIN_PASSWORD'));
    });

    it('surfaces the generated dashboard password in the README so the operator can sign in', () => {
        const env = createNodeEnv({ cloudApiUrl: 'https://farm.example.com', localNodeToken: 't', secrets: {
            encryptionKey: 'a'.repeat(64), jwtSecret: 'jwt', adminPassword: 'Sh4reMe',
        } });
        expect(env).toContain('ADMIN_PASSWORD=Sh4reMe');
        const readme = createNodePackageReadme({
            nodeName: 'Print NUC 01',
            cloudApiUrl: 'https://farm.example.com',
            adminPassword: 'Sh4reMe',
        });
        expect(readme).toContain('Password: Sh4reMe');
        expect(readme).toContain('localhost only');
    });

    it('documents the secure Windows node connection model', () => {
        const readme = createNodePackageReadme({
            nodeName: 'Print NUC 01',
            cloudApiUrl: 'https://farm.example.com',
        });

        expect(readme).toContain('Print NUC 01');
        expect(readme).toContain('HTTPS outbound');
        expect(readme).toContain('LOCAL_NODE_TOKEN');
        expect(readme).toContain('SUPABASE_SERVICE_ROLE_KEY');
        expect(readme).toContain('Start Cloud Node.bat');
        expect(readme).toContain('Cloud setup quickstart');
        expect(readme).toContain('Discover LAN Printers');
        expect(readme).toContain('Sync Printer Inventory');
        expect(readme).toContain('C:\\PrintKinetix');
        expect(readme).toContain('cloud.print.ready');
        expect(readme).toContain('cloud.printers.sync');
        expect(readme).toContain('cloud-result-outbox.json');
    });

    it('builds a zip with runtime files, readme, manifest, and prefilled env', () => {
        const root = makeTempRoot();
        writeFile(root, 'package.json', '{"name":"antigravity"}');
        writeFile(root, 'package-lock.json', '{"lockfileVersion":3}');
        writeFile(root, 'server.js', 'import "./src/index.js";');
        writeFile(root, 'Start Cloud Node.bat', '@echo off');
        writeFile(root, 'src/cloud/runLocalNode.js', 'console.log("node");');
        writeFile(root, 'src/cloud/adminHandlers.js', 'do-not-ship');
        writeFile(root, 'src/cloud/supabaseRest.js', 'do-not-ship');
        writeFile(root, 'src/cloud/nodePackage.js', 'do-not-ship');
        writeFile(root, 'public/index.html', '<main></main>');
        writeFile(root, 'public/cloud.html', '<main>cloud</main>');
        writeFile(root, 'api/cloud/overview.js', 'do-not-ship');
        writeFile(root, '.env', 'SUPABASE_SERVICE_ROLE_KEY=do-not-ship');

        const buffer = buildWindowsNodePackage({
            rootDir: root,
            cloudApiUrl: 'https://farm.example.com',
            localNodeToken: 'pkx_node_secret',
            nodeName: 'Print NUC 01',
            now: () => new Date('2026-06-30T23:00:00.000Z'),
        });
        const zip = new AdmZip(buffer);
        const entries = zip.getEntries().map((entry) => entry.entryName).sort();

        expect(entries).toEqual([
            '.env',
            'README-FIRST.txt',
            'Start Cloud Node.bat',
            'node-package-manifest.json',
            'package-lock.json',
            'package.json',
            'public/index.html',
            'server.js',
            'src/cloud/runLocalNode.js',
        ]);
        expect(zip.readAsText('.env')).toContain('LOCAL_NODE_TOKEN=pkx_node_secret');
        expect(zip.readAsText('.env')).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
        expect(zip.readAsText('README-FIRST.txt')).toContain('Print NUC 01');
        expect(zip.readAsText('README-FIRST.txt')).toContain('Start Cloud Node.bat');
        expect(zip.readAsText('README-FIRST.txt')).toContain('HTTPS outbound');
        expect(zip.readAsText('README-FIRST.txt')).toContain('Discover LAN Printers');
        expect(zip.readAsText('README-FIRST.txt')).toContain('Sync Printer Inventory');
        expect(zip.readAsText('README-FIRST.txt')).toContain('cloud.print.ready');
        expect(zip.readAsText('README-FIRST.txt')).toContain('cloud.printers.sync');
        expect(zip.readAsText('README-FIRST.txt')).toContain('cloud-result-outbox.json');
        expect(JSON.parse(zip.readAsText('node-package-manifest.json'))).toMatchObject({
            generated_at: '2026-06-30T23:00:00.000Z',
            node_name: 'Print NUC 01',
            files: expect.arrayContaining(['src/cloud/runLocalNode.js']),
        });
    });
});

describe('Portable ("no install") node package', () => {
    function makePortableFixture() {
        const root = makeTempRoot();
        // Prebuilt bundle artifacts.
        writeFile(root, 'dist/windows-node/farm-node.cjs', 'console.log("bundled node");');
        writeFile(root, 'dist/windows-node/sql-wasm.wasm', 'WASM');
        // Repo assets the portable package pulls in.
        writeFile(root, 'public/index.html', '<main></main>');
        writeFile(root, 'public/js/app.js', 'console.log("spa")');
        writeFile(root, 'public/cloud.html', '<main>cloud</main>');
        writeFile(root, 'public/js/cloud-dashboard.js', 'cloud only');
        writeFile(root, 'src/db/migrations/001_initial.sql', 'CREATE TABLE t(id);');
        writeFile(root, 'src/db/migrations/002_more.sql', 'ALTER TABLE t ADD c;');
        return root;
    }

    it('detects a prebuilt bundle', () => {
        const root = makePortableFixture();
        expect(hasPortableBundle(path.join(root, 'dist', 'windows-node'))).toBe(true);
        expect(hasPortableBundle(makeTempRoot())).toBe(false);
    });

    it('collects public assets but omits the cloud console files', () => {
        const root = makePortableFixture();
        const files = collectPortablePublicFiles(root);
        expect(files).toContain('public/index.html');
        expect(files).toContain('public/js/app.js');
        expect(files).not.toContain('public/cloud.html');
        expect(files).not.toContain('public/js/cloud-dashboard.js');
    });

    it('buildWindowsNodePackage ships the portable bundle when it exists', () => {
        const root = makePortableFixture();
        const buffer = buildWindowsNodePackage({
            rootDir: root,
            cloudApiUrl: 'https://farm.example.com',
            localNodeToken: 'pkx_node_secret',
            nodeName: 'Print NUC 01',
        });
        const entries = new AdmZip(buffer).getEntries().map((e) => e.entryName).sort();

        // Bundle + colocated assets + launcher + per-user env.
        expect(entries).toContain('farm-node.cjs');
        expect(entries).toContain('sql-wasm.wasm');
        expect(entries).toContain('migrations/001_initial.sql');
        expect(entries).toContain('migrations/002_more.sql');
        expect(entries).toContain('public/index.html');
        expect(entries).toContain('Start Farm Node.bat');
        expect(entries).toContain('get-node.ps1');
        // Cross-platform: Raspberry Pi 5 / Linux launchers ship in the same package.
        expect(entries).toContain('start-farm-node.sh');
        expect(entries).toContain('get-node.sh');
        expect(entries).toContain('install-service.sh');
        expect(entries).toContain('README-FIRST.txt');
        expect(entries).toContain('.env');
        // No source tree and no cloud console in the portable package.
        expect(entries).not.toContain('server.js');
        expect(entries).not.toContain('src/cloud/runLocalNode.js');
        expect(entries).not.toContain('public/cloud.html');

        const zip = new AdmZip(buffer);
        expect(zip.readAsText('.env')).toContain('LOCAL_NODE_TOKEN=pkx_node_secret');
        expect(zip.readAsText('.env')).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    });

    it('launcher never runs npm install and finds a Node runtime three ways', () => {
        const bat = createFarmNodeLauncherBat();
        expect(bat).not.toMatch(/npm install/i);
        expect(bat).toContain('farm-node.cjs');
        expect(bat).toContain('node\\node.exe'); // bundled runtime
        expect(bat).toContain('where node');     // system Node
        expect(bat).toContain('get-node.ps1');   // auto-download portable Node
    });

    it('Pi/Linux launcher is npm-free, LF-terminated, and finds Node three ways', () => {
        const sh = createStartFarmNodeSh();
        expect(sh).not.toMatch(/npm install/i);
        expect(sh).not.toContain('\r'); // LF only, or bash chokes on CRLF
        expect(sh.startsWith('#!/usr/bin/env bash')).toBe(true);
        expect(sh).toContain('farm-node.cjs');
        expect(sh).toContain('./node/bin/node');       // bundled runtime
        expect(sh).toContain('command -v node');        // system Node
        expect(sh).toContain('get-node.sh');            // auto-download portable Node
    });

    it('portable Node download targets the Raspberry Pi 5 architecture', () => {
        const sh = createGetNodeSh();
        expect(sh).toContain('aarch64|arm64) NODE_ARCH="linux-arm64"'); // Pi 5
        expect(sh).toContain('x86_64|amd64)  NODE_ARCH="linux-x64"');
        expect(sh).not.toContain('\r');
    });

    it('verifies the Node runtime SHA-256 before extracting it (supply-chain guard)', () => {
        const sh = createGetNodeSh();
        // Every supported arch carries a pinned expected hash and the script
        // aborts on mismatch instead of extracting/running an unverified runtime.
        expect(sh).toContain('EXPECTED="6031d04b98f59ff0f7cb98566f65b115ecd893d3b7870821171708cdbaf7ae6e"'); // arm64
        expect(sh).toContain('EXPECTED="83bf07dd343002a26211cf1fcd46a9d9534219aad42ee02847816940bf610a72"'); // x64
        expect(sh).toMatch(/Aborting for safety/);
        expect(sh).toContain('mktemp -d'); // no predictable /tmp path
        expect(sh).not.toContain('-o "/tmp/');

        const ps1 = createGetNodePs1();
        expect(ps1).toContain('$expected = "905373a059aecaf7f48c1ce10ffbd5334457ca00f678747f19db5ea7d256c236"'); // win-x64
        expect(ps1).toContain('Get-FileHash -Algorithm SHA256');
        expect(ps1).toMatch(/Aborting for safety/);
    });

    it('buildPortableNodePackage requires cloud url and token', () => {
        const root = makePortableFixture();
        expect(() => buildPortableNodePackage({
            rootDir: root,
            bundleDir: path.join(root, 'dist', 'windows-node'),
            localNodeToken: 'pkx_node_secret',
        })).toThrow(/cloud_api_url/);
    });
});
