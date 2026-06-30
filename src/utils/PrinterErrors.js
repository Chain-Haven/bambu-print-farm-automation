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

export default { formatErrorCode, decodePrintError, isBlockingError };
