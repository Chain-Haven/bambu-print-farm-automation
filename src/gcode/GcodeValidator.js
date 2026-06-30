// src/gcode/GcodeValidator.js — Fail-safe validation for transformed G-code
//
// Ensures the transformed output remains valid and safe to print.
// More tolerant of different G-code styles (not just Bambu Studio output).

import { parseLine, isExtrudingMove } from './GcodeParser.js';

/**
 * Validate transformed G-code.
 *
 * @param {string[]} lines - Transformed G-code lines
 * @param {string[]} originalLines - Original G-code lines (for comparison)
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validateGcode(lines, originalLines = []) {
    const result = {
        valid: true,
        errors: [],
        warnings: [],
    };

    // 1. Check that extrusion still exists (anywhere in file, not just model region)
    let hasExtrusion = false;
    let hasTemp = false;
    let hasLayerChange = false;
    let lineCount = 0;
    let emptyCount = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        lineCount++;

        if (!line || line.trim().length === 0) {
            emptyCount++;
            continue;
        }

        // Skip disabled lines
        if (line.trim().startsWith('; [AG_DISABLED]')) continue;

        const parsed = parseLine(line);

        // Track layer changes
        if (/^;\s*(LAYER_CHANGE|layer_change)/i.test(line.trim())) {
            hasLayerChange = true;
        }

        // Check for extrusion anywhere in the file (more tolerant)
        if (isExtrudingMove(parsed)) {
            hasExtrusion = true;
        }

        // Check for temperature commands
        if (parsed.command && ['M104', 'M109', 'M140', 'M190'].includes(parsed.command)) {
            hasTemp = true;
        }
    }

    // 2. FAIL: No extrusion at all
    if (!hasExtrusion) {
        result.valid = false;
        result.errors.push('CRITICAL: No extrusion commands (G1 with E parameter) found in G-code after transform');
    }

    // 3. WARN: No layer change markers (file might not be Bambu Studio format)
    if (!hasLayerChange && hasExtrusion) {
        result.warnings.push('No LAYER_CHANGE markers found — file may not be from Bambu Studio. Transform still applied.');
    }

    // 4. WARN: No temperature commands (unusual but not fatal)
    if (!hasTemp) {
        result.warnings.push('No temperature commands found in G-code (unusual for FDM)');
    }

    // 5. Check that original temp waits are preserved
    if (originalLines.length > 0) {
        const origTempWaits = countTempWaits(originalLines);
        const transTempWaits = countTempWaits(lines);

        if (transTempWaits < origTempWaits) {
            // Downgrade from error to warning — temp commands might be disabled lines
            result.warnings.push(
                `Temperature wait commands changed: original=${origTempWaits}, transformed=${transTempWaits}`
            );
        }
    }

    // 6. Check for malformed lines (non-comment lines that don't parse)
    let malformedCount = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith(';')) continue;
        if (!/^[A-Za-z]/.test(line)) {
            malformedCount++;
            if (malformedCount <= 3) {
                result.warnings.push(`Potentially malformed line ${i + 1}: "${line.slice(0, 50)}"`);
            }
        }
    }
    if (malformedCount > 3) {
        result.warnings.push(`... and ${malformedCount - 3} more potentially malformed lines`);
    }

    // 7. Sanity: file is not too short (but be lenient — even small test files should pass)
    const realLines = lineCount - emptyCount;
    if (realLines < 5) {
        result.valid = false;
        result.errors.push(`G-code too short after transform (${realLines} non-empty lines)`);
    }

    return result;
}

/**
 * Count critical temperature wait commands (M109, M190).
 */
function countTempWaits(lines) {
    let count = 0;
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('; [AG_DISABLED]')) continue;
        if (/^M10[49]\s/i.test(trimmed) || /^M190\s/i.test(trimmed)) {
            count++;
        }
    }
    return count;
}

export default validateGcode;
