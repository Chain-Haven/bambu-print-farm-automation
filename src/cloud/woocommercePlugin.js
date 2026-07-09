// src/cloud/woocommercePlugin.js — package + serve the WooCommerce plugin.
//
// Merchants download one ZIP, upload it to WordPress, paste their merchant
// API key, and their store sells farm-printed products. The ZIP is built on
// demand from integrations/woocommerce/… with the interactive 3D viewer
// (public/js/model-viewer.js) injected as a bundled asset so the plugin is
// fully self-contained on the merchant's site (no calls back to us for JS).
import AdmZip from 'adm-zip';
import fs from 'node:fs';
import path from 'node:path';

export const WOO_PLUGIN_SLUG = 'printkinetix-print-on-demand';
const PLUGIN_SOURCE_SUBDIR = path.join('integrations', 'woocommerce', WOO_PLUGIN_SLUG);

function walkFiles(dir, baseDir = dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) walkFiles(absolute, baseDir, out);
        else if (entry.isFile()) out.push(path.relative(baseDir, absolute).split(path.sep).join('/'));
    }
    return out;
}

export function buildWooCommercePluginZip({ rootDir = process.cwd() } = {}) {
    const sourceDir = path.join(rootDir, PLUGIN_SOURCE_SUBDIR);
    if (!fs.existsSync(path.join(sourceDir, `${WOO_PLUGIN_SLUG}.php`))) {
        throw new Error('woocommerce_plugin_source_missing');
    }
    const zip = new AdmZip();
    for (const relative of walkFiles(sourceDir).sort()) {
        zip.addFile(`${WOO_PLUGIN_SLUG}/${relative}`, fs.readFileSync(path.join(sourceDir, relative)));
    }
    // Bundle the same dependency-free 3D viewer the storefront uses.
    const viewerPath = path.join(rootDir, 'public', 'js', 'model-viewer.js');
    if (fs.existsSync(viewerPath)) {
        zip.addFile(`${WOO_PLUGIN_SLUG}/assets/pkx-model-viewer.js`, fs.readFileSync(viewerPath));
    }
    return zip.toBuffer();
}

// Public, unauthenticated download — the plugin contains no secrets (the
// merchant pastes their own API key after installing).
export function createWooPluginDownloadHandler({ rootDir = process.cwd() } = {}) {
    return async function wooPluginDownloadHandler(req, res) {
        if (req.method && req.method !== 'GET') {
            res.statusCode = 405;
            return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
        }
        try {
            const buffer = buildWooCommercePluginZip({ rootDir });
            res.statusCode = 200;
            if (typeof res.setHeader === 'function') {
                res.setHeader('Content-Type', 'application/zip');
                res.setHeader('Content-Disposition', `attachment; filename="${WOO_PLUGIN_SLUG}.zip"`);
                res.setHeader('Cache-Control', 'no-store');
            }
            return res.end(buffer);
        } catch (error) {
            res.statusCode = 500;
            if (typeof res.setHeader === 'function') res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ ok: false, error: 'plugin_build_failed', message: error.message }));
        }
    };
}
