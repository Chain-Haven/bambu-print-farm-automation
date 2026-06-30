import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Vercel cloud node package config', () => {
    it('includes local runtime files in the node-package function bundle', () => {
        const config = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));

        expect(config.functions['api/cloud/node-package.js']).toMatchObject({
            maxDuration: 30,
            includeFiles: expect.arrayContaining([
                'package.json',
                'package-lock.json',
                'server.js',
                'Start Cloud Node.bat',
                'src/**',
                'public/**',
            ]),
        });
    });
});
