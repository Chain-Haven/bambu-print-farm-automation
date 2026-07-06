// src/utils/PrinterErrors.js — Decoder for Bambu print_error codes
// Converts decimal error → hex → XXXX-XXXX display format
// Maps known codes to human-readable messages + remediation

import { createLogger } from './logger.js';
const log = createLogger('PrinterErrors');

/**
 * Known Bambu print_error codes.
 * Key = hex string (uppercase, no prefix), Value = { message, severity, remediation }
 */
const KNOWN_ERRORS = {
    '0500C010': {
        message: 'MicroSD card read/write exception',
        severity: 'blocking',
        remediation: [
            'Power off the printer and remove the MicroSD card',
            'Reinsert the MicroSD card firmly and power on',
            'If it persists: format the card using the printer\'s own format option (Settings → Storage)',
            'If it still persists: replace with a high-endurance MicroSD card (Samsung PRO Endurance or similar)',
            'Power-cycle the printer after any storage action',
        ],
    },
    '0500C011': {
        message: 'MicroSD card not detected',
        severity: 'blocking',
        remediation: [
            'Power off and reinsert the MicroSD card',
            'Try a different MicroSD card',
            'Check the card slot for debris',
        ],
    },
    '05004003': {
        message: 'Printer rejected file as unparsable (parse error)',
        severity: 'blocking',
        remediation: [
            'Most likely causes: wrong artifact type, malformed package, missing project metadata, wrong remote path, or invalid plate mapping',
            'Ensure the uploaded file is a valid .gcode.3mf package, not a raw .gcode file',
            'Check that the 3MF contains Metadata/plate_N.gcode with correct plate number',
            'Verify the MQTT project_file param matches the gcode entry inside the 3MF',
        ],
    },
};

/**
 * Format a decimal print_error as XXXX-XXXX hex.
 * @param {number} errorCode - Decimal error code
 * @returns {string} e.g. "0500-C010"
 */
export function formatErrorCode(errorCode) {
    if (!errorCode || errorCode === 0) return null;
    const hex = errorCode.toString(16).toUpperCase().padStart(8, '0');
    return `${hex.slice(0, 4)}-${hex.slice(4)}`;
}

/**
 * Decode a print_error into structured info.
 * @param {number} errorCode - Decimal error code from MQTT
 * @returns {{ code: number, hex: string, formatted: string, message: string, severity: string, remediation: string[], known: boolean } | null}
 */
export function decodePrintError(errorCode) {
    if (!errorCode || errorCode === 0) return null;

    const hex = errorCode.toString(16).toUpperCase().padStart(8, '0');
    const formatted = `${hex.slice(0, 4)}-${hex.slice(4)}`;
    const known = KNOWN_ERRORS[hex];

    if (known) {
        return {
            code: errorCode,
            hex: `0x${hex}`,
            formatted,
            message: known.message,
            severity: known.severity,
            remediation: known.remediation,
            known: true,
        };
    }

    return {
        code: errorCode,
        hex: `0x${hex}`,
        formatted,
        message: `Unknown printer error (${formatted})`,
        severity: 'warning',
        remediation: [
            'Power-cycle the printer',
            'Check the printer screen for error details',
            `Error code: ${formatted} (decimal: ${errorCode})`,
        ],
        known: false,
    };
}

/**
 * Check if an error code is a blocking error that prevents printing.
 * @param {number} errorCode
 * @returns {boolean}
 */
export function isBlockingError(errorCode) {
    if (!errorCode || errorCode === 0) return false;
    const hex = errorCode.toString(16).toUpperCase().padStart(8, '0');
    const known = KNOWN_ERRORS[hex];
    // All non-zero print_error codes are blocking — printer won't start with any error
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
//  HMS (Health Management System) code decoding
//
//  Bambu printers emit hms: [{ attr, code }] where attr and code are 32-bit
//  ints. The canonical display string (matching the Bambu wiki + the reference
//  Home Assistant integration) splits each into two 16-bit words:
//    ATTR_H _ ATTR_L _ CODE_H _ CODE_L   (each 4 hex digits, uppercase)
//  Severity is carried in the high word of `code`: 1=fatal, 2=serious,
//  3=common, 4=info. This turns an opaque hex blob into an actionable,
//  severity-ranked message with a wiki link for the long tail.
// ─────────────────────────────────────────────────────────────────────────────

const HMS_SEVERITY = { 1: 'fatal', 2: 'serious', 3: 'common', 4: 'info' };
const HMS_SEVERITY_RANK = { fatal: 4, serious: 3, common: 2, info: 1, unknown: 0 };

// Curated messages for the most frequent / actionable HMS codes on a farm.
// Keyed by the formatted "ATTR_H_ATTR_L_CODE_H_CODE_L" string.
const KNOWN_HMS = {
    '0300_0100_0001_0001': { message: 'Nozzle temperature is abnormal; heating may be too slow or failed', category: 'temperature' },
    '0300_0200_0001_0001': { message: 'Heatbed temperature is abnormal', category: 'temperature' },
    '0700_0100_0001_0003': { message: 'The filament may be tangled or stuck; check the spool and AMS path', category: 'filament' },
    '0700_0200_0002_0002': { message: 'AMS filament has run out — load a new spool', category: 'filament' },
    '0700_0100_0002_0002': { message: 'Filament ran out during printing', category: 'filament' },
    '0C00_0100_0001_0001': { message: 'First layer inspection detected a possible defect', category: 'quality' },
    '0500_0100_0001_0001': { message: 'Motor/axis motion anomaly detected', category: 'motion' },
    '1200_0100_0001_0007': { message: 'The build plate may be missing or misplaced', category: 'hardware' },
    '0300_1400_0002_0009': { message: 'Chamber temperature is high; check enclosure and cooling', category: 'temperature' },
};

/** Format two HMS ints into the canonical ATTR_H_ATTR_L_CODE_H_CODE_L string. */
export function formatHmsCode(attr, code) {
    const a = Number(attr) >>> 0;
    const c = Number(code) >>> 0;
    const hx = (n) => (n & 0xffff).toString(16).toUpperCase().padStart(4, '0');
    return `${hx(a >>> 16)}_${hx(a)}_${hx(c >>> 16)}_${hx(c)}`;
}

/**
 * Decode one HMS entry.
 * @param {{attr:number, code:number}} entry
 * @returns {{ attr:number, code:number, formatted:string, severity:string, severity_rank:number, message:string, category:string, wiki_url:string, known:boolean } | null}
 */
export function decodeHms(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const attr = Number(entry.attr) >>> 0;
    const code = Number(entry.code) >>> 0;
    if (!attr && !code) return null;

    const formatted = formatHmsCode(attr, code);
    const severity = HMS_SEVERITY[(code >>> 16) & 0xffff] || 'unknown';
    const known = KNOWN_HMS[formatted];

    return {
        attr,
        code,
        formatted,
        severity,
        severity_rank: HMS_SEVERITY_RANK[severity] ?? 0,
        message: known?.message || `Unrecognized HMS notice (${formatted})`,
        category: known?.category || 'unknown',
        // The Bambu wiki keys HMS pages by the lowercased code with no underscores.
        wiki_url: `https://wiki.bambulab.com/en/x1/troubleshooting/hmscode/${formatted.replace(/_/g, '').toLowerCase()}`,
        known: !!known,
    };
}

/**
 * Decode a full HMS array, sorted most-severe first.
 * @param {Array<{attr:number, code:number}>} hmsList
 */
export function decodeHmsList(hmsList) {
    if (!Array.isArray(hmsList)) return [];
    return hmsList
        .map(decodeHms)
        .filter(Boolean)
        .sort((a, b) => b.severity_rank - a.severity_rank);
}

/** True when any HMS entry is a fatal/serious fault (worth alerting/halting). */
export function hasBlockingHms(hmsList) {
    return decodeHmsList(hmsList).some((h) => h.severity === 'fatal' || h.severity === 'serious');
}

export default {
    formatErrorCode,
    decodePrintError,
    isBlockingError,
    formatHmsCode,
    decodeHms,
    decodeHmsList,
    hasBlockingHms,
};
