// scripts/build-windows-node.mjs — build the portable Windows print-server node.
//
// Produces a self-contained bundle under dist/windows-node/ that runs with NO
// `npm install` and NO source tree: every npm dependency is inlined into a single
// farm-node.cjs, and the three runtime assets (public/, migrations/, the sql.js
// wasm) are copied next to it. A banner points PKX_ASSET_ROOT at the bundle's own
// folder so those assets resolve wherever the user unzips it.
//
// Usage:
//   node scripts/build-windows-node.mjs            # build the portable bundle
//   node scripts/build-windows-node.mjs --exe      # also emit a native SEA exe
//
// The optional --exe step uses Node's built-in Single Executable Application
// support. Run it on the target OS (or CI matrix) to get a signed farm-node.exe;
// on Linux it emits a Linux binary that proves the pipeline end to end.
import esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
    createFarmNodeLauncherBat,
    createGetNodePs1,
    createGetNodeSh,
    createInstallServiceSh,
    createPortableReadme,
    createStartFarmNodeSh,
} from '../src/cloud/nodePackage.js';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'dist', 'windows-node');

// public/ files that belong only to the cloud console — never served by the node.
const PUBLIC_EXCLUDES = new Set([
    'cloud.html',
    'css/cloud.css',
    'js/cloud-dashboard.js',
]);

function log(msg) {
    process.stdout.write(`[build-windows-node] ${msg}\n`);
}

function rimraf(target) {
    fs.rmSync(target, { recursive: true, force: true });
}

function copyDir(srcDir, destDir, { exclude = new Set(), baseDir = srcDir } = {}) {
    fs.mkdirSync(destDir, { recursive: true });
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
        const srcPath = path.join(srcDir, entry.name);
        const rel = path.relative(baseDir, srcPath).split(path.sep).join('/');
        if (exclude.has(rel)) continue;
        const destPath = path.join(destDir, entry.name);
        if (entry.isDirectory()) {
            copyDir(srcPath, destPath, { exclude, baseDir });
        } else if (entry.isFile()) {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

async function bundle() {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const result = await esbuild.build({
        entryPoints: [path.join(ROOT, 'src', 'cloud', 'runLocalNode.js')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node18',
        outfile: path.join(OUT_DIR, 'farm-node.cjs'),
        // @ffmpeg-installer ships a platform-specific binary + dynamic require;
        // it is only needed for X1 RTSP streaming and is loaded lazily, so keep
        // it external rather than choking the bundle. A1/P1 JPEG framing needs no
        // ffmpeg and works in the bundle.
        external: ['@ffmpeg-installer/ffmpeg'],
        banner: {
            // Resolve colocated assets relative to the bundle wherever it lands.
            js: "process.env.PKX_ASSET_ROOT = process.env.PKX_ASSET_ROOT || __dirname;",
        },
        logLevel: 'silent',
        metafile: false,
    });
    const sizeKb = Math.round(fs.statSync(path.join(OUT_DIR, 'farm-node.cjs')).size / 1024);
    log(`bundled farm-node.cjs (${sizeKb} KB), ${result.warnings.length} warning(s)`);
}

function copyAssets() {
    // public/ (local SPA + guides), minus the cloud-console-only files.
    copyDir(path.join(ROOT, 'public'), path.join(OUT_DIR, 'public'), { exclude: PUBLIC_EXCLUDES });
    // SQL migrations the node applies to its local SQLite DB on first run.
    copyDir(path.join(ROOT, 'src', 'db', 'migrations'), path.join(OUT_DIR, 'migrations'));
    // sql.js WebAssembly, resolved via PKX_ASSET_ROOT/sql-wasm.wasm at runtime.
    const wasmSrc = path.join(path.dirname(require.resolve('sql.js')), 'sql-wasm.wasm');
    fs.copyFileSync(wasmSrc, path.join(OUT_DIR, 'sql-wasm.wasm'));
    log('copied public/, migrations/, sql-wasm.wasm');
}

function writeLauncher() {
    // Reuse the exact launchers the download handler ships, so local and served
    // bundles stay identical. Windows + Raspberry Pi / Linux.
    fs.writeFileSync(path.join(OUT_DIR, 'Start Farm Node.bat'), createFarmNodeLauncherBat());
    fs.writeFileSync(path.join(OUT_DIR, 'get-node.ps1'), createGetNodePs1());
    const sh = [
        ['start-farm-node.sh', createStartFarmNodeSh()],
        ['get-node.sh', createGetNodeSh()],
        ['install-service.sh', createInstallServiceSh()],
    ];
    for (const [name, content] of sh) {
        const target = path.join(OUT_DIR, name);
        fs.writeFileSync(target, content);
        fs.chmodSync(target, 0o755); // executable for local Pi/Linux testing
    }
    log('wrote Windows (.bat/.ps1) + Pi/Linux (.sh) launchers');
}

function writeReadme() {
    fs.writeFileSync(path.join(OUT_DIR, 'README-FIRST.txt'), createPortableReadme({ nodeName: 'Windows NUC' }));
}

function buildSeaExe() {
    // Node Single Executable Application. Produces a native binary from the bundle.
    const isWin = process.platform === 'win32';
    const exeName = isWin ? 'farm-node.exe' : 'farm-node';
    const exePath = path.join(OUT_DIR, exeName);
    const blobPath = path.join(OUT_DIR, 'farm-node.blob');
    const seaConfig = path.join(OUT_DIR, 'sea-config.json');
    fs.writeFileSync(seaConfig, JSON.stringify({
        main: path.join(OUT_DIR, 'farm-node.cjs'),
        output: blobPath,
        disableExperimentalSEAWarning: true,
    }, null, 2));

    log('generating SEA blob...');
    execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });
    fs.copyFileSync(process.execPath, exePath);

    let postject;
    try {
        postject = require.resolve('postject/dist/cli.js');
    } catch {
        log('postject not installed — skipping blob injection. Install `postject` to finish the exe.');
        return;
    }
    const args = [
        postject, exePath, 'NODE_SEA_BLOB', blobPath,
        '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    ];
    if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
    execFileSync(process.execPath, args, { stdio: 'inherit' });
    log(`built native executable: ${path.relative(ROOT, exePath)}`);
}

async function main() {
    const wantExe = process.argv.includes('--exe');
    log(`output: ${path.relative(ROOT, OUT_DIR)}`);
    rimraf(OUT_DIR);
    await bundle();
    copyAssets();
    writeLauncher();
    writeReadme();
    if (wantExe) buildSeaExe();
    log('done.');
}

main().catch((err) => {
    process.stderr.write(`[build-windows-node] FAILED: ${err.stack || err.message}\n`);
    process.exit(1);
});
