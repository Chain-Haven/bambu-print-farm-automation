// src/utils/runtimePaths.js — asset location for both source and bundled runtimes.
//
// The portable Windows node is a single esbuild bundle (farm-node.cjs). When it
// runs, its launcher/banner sets PKX_ASSET_ROOT to the folder that holds the
// colocated runtime assets (public/, migrations/, sql-wasm.wasm). In normal
// source/dev mode PKX_ASSET_ROOT is unset and callers fall back to their own
// source-relative directory, so behaviour is unchanged outside the bundle.
import path from 'node:path';

export function assetRoot() {
    const root = process.env.PKX_ASSET_ROOT;
    return typeof root === 'string' && root.trim() ? root.trim() : null;
}

// Resolve a runtime asset: use the bundle asset root when set, else the provided
// source-relative default.
export function resolveAsset(subpath, sourceDefault) {
    const root = assetRoot();
    return root ? path.join(root, subpath) : sourceDefault;
}
