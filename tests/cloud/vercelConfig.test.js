import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Vercel cloud node package config', () => {
    it('includes local runtime files in the node-package function bundle', () => {
        const config = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));

        expect(config.functions['api/cloud/node-package.js']).toMatchObject({
            maxDuration: 30,
        });
        expect(config.functions['api/cloud/node-package.js'].includeFiles).toContain('package.json');
        expect(config.functions['api/cloud/node-package.js'].includeFiles).toContain('package-lock.json');
        expect(config.functions['api/cloud/node-package.js'].includeFiles).toContain('server.js');
        expect(config.functions['api/cloud/node-package.js'].includeFiles).toContain('Start Cloud Node.bat');
        expect(config.functions['api/cloud/node-package.js'].includeFiles).toContain('src/**');
        expect(config.functions['api/cloud/node-package.js'].includeFiles).toContain('public/**');
    });
});
