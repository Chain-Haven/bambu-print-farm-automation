import { describe, expect, it } from 'vitest';
import {
    formatHmsCode,
    decodeHms,
    decodeHmsList,
    hasBlockingHms,
} from '../src/utils/PrinterErrors.js';

describe('HMS decoding', () => {
    it('formats attr/code pairs into the canonical ATTR_H_ATTR_L_CODE_H_CODE_L string', () => {
        // 0x0700_0200 attr, 0x0002_0002 code → AMS filament runout in the table.
        expect(formatHmsCode(0x07000200, 0x00020002)).toBe('0700_0200_0002_0002');
    });

    it('decodes a known HMS code into a readable, severity-ranked message', () => {
        const decoded = decodeHms({ attr: 0x07000200, code: 0x00020002 });
        expect(decoded).toMatchObject({
            formatted: '0700_0200_0002_0002',
            message: 'AMS filament has run out — load a new spool',
            category: 'filament',
            known: true,
        });
        expect(decoded.wiki_url).toContain('0700020000020002');
    });

    it('derives severity from the code high word for unknown codes', () => {
        // code high word 0x0001 → fatal, 0x0004 → info.
        expect(decodeHms({ attr: 1, code: 0x00010005 }).severity).toBe('fatal');
        expect(decodeHms({ attr: 1, code: 0x00040005 }).severity).toBe('info');
        expect(decodeHms({ attr: 1, code: 0x00030005 }).known).toBe(false);
    });

    it('sorts a list most-severe first and detects blocking faults', () => {
        const list = decodeHmsList([
            { attr: 1, code: 0x00040001 }, // info
            { attr: 1, code: 0x00010001 }, // fatal
            { attr: 1, code: 0x00030001 }, // common
        ]);
        expect(list.map((h) => h.severity)).toEqual(['fatal', 'common', 'info']);
        expect(hasBlockingHms([{ attr: 1, code: 0x00010001 }])).toBe(true);
        expect(hasBlockingHms([{ attr: 1, code: 0x00040001 }])).toBe(false);
    });

    it('ignores empty / malformed entries', () => {
        expect(decodeHms(null)).toBeNull();
        expect(decodeHms({ attr: 0, code: 0 })).toBeNull();
        expect(decodeHmsList('nope')).toEqual([]);
    });
});
