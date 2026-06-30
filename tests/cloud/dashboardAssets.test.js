import fs from 'node:fs';
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
});
