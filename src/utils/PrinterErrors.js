// src/utils/PrinterErrors.js — Decoder for Bambu print_error codes
// Converts decimal error → hex → XXXX-XXXX display format
// Maps known codes to human-readable messages + remediation

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from './logger.js';
const log = createLogger('PrinterErrors');

// Official Bambu error-code table, vendored from e.bambulab.com (the same
// endpoint Bambu Studio queries). Gives real descriptions for ~530 print
// errors and ~4000 HMS codes. The curated KNOWN_ERRORS below still win —
// they carry farm-specific remediation the official one-liners lack.
let BAMBU_TABLE = { print_errors: {}, hms: {} };
try {
    const tablePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../assets/bambu_error_codes.json');
    BAMBU_TABLE = JSON.parse(fs.readFileSync(tablePath, 'utf-8'));
    log.info(`Bambu error table loaded: ${Object.keys(BAMBU_TABLE.print_errors || {}).length} print errors, ${Object.keys(BAMBU_TABLE.hms || {}).length} HMS codes`);
} catch (err) {
    log.warn(`Bambu error table not available (${err.message}) — using built-in list only`);
}

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
    // Bound empirically on A1 4 (2026-07-09): appeared 3× in lockstep with
    // HMS 1200-4500-0002-0002 (filament cutter), including in a controlled
    // idle ams_change_filament test with no print involved. The mapping/
    // tray-target was correct every time (tray_tar followed ams_mapping);
    // the CUT of the loaded filament is what fails, so the old spool stays
    // in the extruder and prints continue in the previous color.
    // NOTE (2026-07-13): despite the HMS text blaming the cutter, the verified
    // real-world cause was the LOADED FILAMENT being stuck (taut/tangled/ground
    // path) — the cutter hardware itself was fine. The firmware reports the cut
    // stroke overshooting when the filament won't move or separate.
    '12008001': {
        message: 'Filament change failed — the loaded filament could not be cut/pulled free (usually a stuck, tangled, or ground filament path, not the cutter itself). The previously loaded spool is still in the extruder — this is why prints continue in the OLD color.',
        severity: 'blocking',
        remediation: [
            'Manually remove the loaded filament: open the toolhead filament clip and pull it back out through the tube — with the extruder empty, the next print loads the new spool without a cut',
            'Check the removed filament and its path: tangles on the spool, kinks in the PTFE tube, or a ground/chewed section where the extruder gripped it',
            'If it repeats with fresh filament: inspect the toolhead cutter lever/blade and X travel for obstructions',
            'Dismiss the error on the printer screen after fixing',
        ],
    },
    // Observed on A1 4 (2026-07-08) after a mid-print stop with parts left on
    // the plate; persists through clean_print_error (firmware re-detects it).
    '03004000': {
        message: 'Z-axis homing failed (physical fault — bed obstructed, plate askew, or Z axis jammed)',
        severity: 'blocking',
        remediation: [
            'Remove ALL prints/debris from the build plate — leftover parts are the most common cause',
            'Re-seat the build plate so it sits flat and straight',
            'Check the Z lead screws and bed rails for debris; make sure the bed moves freely',
            'Dismiss the error on the printer screen (or retry) after clearing the bed',
            'If it persists on an empty bed: power-cycle the printer',
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

    // Official Bambu description — what the printer's own screen says
    const official = BAMBU_TABLE.print_errors?.[hex];
    if (official) {
        return {
            code: errorCode,
            hex: `0x${hex}`,
            formatted,
            message: official,
            severity: 'blocking',
            remediation: [`Official Bambu description shown above — check the printer screen for the full dialog (code ${formatted})`],
            known: true,
            source: 'bambu',
        };
    }

    return {
        code: errorCode,
        hex: `0x${hex}`,
        formatted,
        message: `Unknown printer error (${formatted}) — not in Bambu's published table; check the printer screen`,
        severity: 'warning',
        remediation: [
            'Check the printer screen for error details',
            'Power-cycle the printer if it persists',
            `Error code: ${formatted} (decimal: ${errorCode})`,
        ],
        known: false,
    };
}

/**
 * Decode an HMS entry ({attr, code} numbers from MQTT) via the official table.
 * @returns {{ ecode: string, formatted: string, message: string|null }}
 */
export function decodeHms(attr, code) {
    const ecode = ((attr ?? 0) >>> 0).toString(16).toUpperCase().padStart(8, '0')
        + ((code ?? 0) >>> 0).toString(16).toUpperCase().padStart(8, '0');
    const formatted = ecode.match(/.{4}/g).join('-');
    return { ecode, formatted, message: BAMBU_TABLE.hms?.[ecode] || null };
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

export default { formatErrorCode, decodePrintError, decodeHms, isBlockingError };
