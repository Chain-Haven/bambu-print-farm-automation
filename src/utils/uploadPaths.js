import os from 'node:os';
import path from 'node:path';

export function isVercelRuntime(env = process.env) {
    return env.VERCEL === '1' || env.VERCEL === 'true';
}

export function getUploadRoot(env = process.env) {
    if (typeof env.UPLOADS_DIR === 'string' && env.UPLOADS_DIR.trim()) {
        return path.resolve(env.UPLOADS_DIR.trim());
    }

    if (isVercelRuntime(env)) {
        return path.join(os.tmpdir(), 'printkinetix-uploads');
    }

    return path.resolve('./uploads');
}

export function getUploadPath(...segments) {
    let env = process.env;
    if (
        segments.length > 0
        && segments[segments.length - 1]
        && typeof segments[segments.length - 1] === 'object'
        && !Array.isArray(segments[segments.length - 1])
    ) {
        env = segments.pop();
    }

    return path.join(getUploadRoot(env), ...segments.filter(Boolean).map(String));
}
