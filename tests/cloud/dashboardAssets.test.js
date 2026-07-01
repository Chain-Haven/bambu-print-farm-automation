import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('cloud dashboard assets', () => {
    it('surfaces backend setup status before provisioning workflows', () => {
        const html = fs.readFileSync('public/cloud.html', 'utf8');
        const js = fs.readFileSync('public/js/cloud-dashboard.js', 'utf8');
        const css = fs.readFileSync('public/css/cloud.css', 'utf8');

        expect(html).toContain('id="setup-status"');
        expect(html).toContain('Backend Setup');
        expect(js).toContain('/api/cloud/setup');
        expect(js).toContain('renderSetupStatus');
        expect(css).toContain('.setup-status');
    });

    it('keeps browser controller scripts parseable', () => {
        for (const file of ['public/js/api.js', 'public/js/ws.js', 'public/js/app.js']) {
            execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
        }
    });
});
