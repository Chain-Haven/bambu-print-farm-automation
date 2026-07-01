import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getUploadPath, getUploadRoot } from '../../src/utils/uploadPaths.js';

describe('runtime upload paths', () => {
    it('uses /tmp-backed storage on Vercel when no explicit upload directory is set', () => {
        const env = { VERCEL: '1' };

        expect(getUploadRoot(env)).toBe(path.join(os.tmpdir(), 'printkinetix-uploads'));
        expect(getUploadPath('templates', env)).toBe(path.join(os.tmpdir(), 'printkinetix-uploads', 'templates'));
    });

    it('respects explicit UPLOADS_DIR outside and inside serverless', () => {
        const root = path.join(os.tmpdir(), 'pkx-custom-uploads');

        expect(getUploadRoot({ VERCEL: '1', UPLOADS_DIR: root })).toBe(root);
        expect(getUploadPath('templates', { VERCEL: '1', UPLOADS_DIR: root })).toBe(path.join(root, 'templates'));
    });
});
