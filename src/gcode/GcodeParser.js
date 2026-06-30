// src/gcode/GcodeParser.js — G-code parser with exact P1S/A1 purge + anchor detection
//
// Purge windows (exact boundaries):
//   P1S: `;===== nozzle load line` → first subsequent `M400`
//   A1:  `;===== extrude cali test` → `;========turn off light and wait extrude temperature`
//   If neither found → do NOT attempt purge removal (fail-safe)
//
// Insertion anchors (priority order):
//   P1S: immediately AFTER `M623; end of "timelapse_record_flag"`
//   A1:  immediately AFTER M623 following M991+timelapse line
//   Fallback: immediately BEFORE `; EXECUTABLE_BLOCK_END` (never AFTER)

/**
 * Parse a single G-code line into structured components.
 */
export function parseLine(raw) {
    const trimmed = raw.trimEnd();
    const result = { raw: trimmed, command: null, params: {}, comment: null, isEmpty: false, lineNumber: 0 };

    if (!trimmed || trimmed.length === 0) {
        result.isEmpty = true;
        return result;
    }

    const commentIdx = trimmed.indexOf(';');
    let codePart = trimmed;
    if (commentIdx >= 0) {
        result.comment = trimmed.slice(commentIdx + 1).trim();
        codePart = trimmed.slice(0, commentIdx).trim();
    }

    if (!codePart) {
        result.isEmpty = !result.comment;
        return result;
    }

    const tokens = codePart.split(/\s+/);
    if (tokens.length > 0) {
        result.command = tokens[0].toUpperCase();
        for (let i = 1; i < tokens.length; i++) {
            const t = tokens[i];
            if (t.length > 0) {
                const letter = t[0].toUpperCase();
                const value = parseFloat(t.slice(1));
                result.params[letter] = isNaN(value) ? t.slice(1) : value;
            }
        }
    }

    return result;
}

/**
 * Check if a parsed line is an extruding move (G0/G1 with E parameter).
 */
export function isExtrudingMove(parsed) {
    if (!parsed.command) return false;
    return (parsed.command === 'G0' || parsed.command === 'G1') && 'E' in parsed.params;
}

/**
 * Check if a parsed line is a movement command (G0/G1).
 */
export function isMovement(parsed) {
    return parsed.command === 'G0' || parsed.command === 'G1';
}

/**
 * Track modal G-code state across lines.
 */
export class ModalState {
    constructor() {
        this.absolutePosition = true;
        this.absoluteExtrusion = true;
        this.lastE = 0;
        this.eResetCount = 0;
        this.hasSeenExtrusion = false;
        this.lineNumber = 0;
    }

    update(parsed) {
        this.lineNumber++;
        switch (parsed.command) {
            case 'G90': this.absolutePosition = true; break;
            case 'G91': this.absolutePosition = false; break;
            case 'M82': this.absoluteExtrusion = true; break;
            case 'M83': this.absoluteExtrusion = false; break;
            case 'G92':
                if ('E' in parsed.params) {
                    this.lastE = parsed.params.E;
                    this.eResetCount++;
                }
                break;
        }
        if (isExtrudingMove(parsed)) {
            this.lastE = parsed.params.E;
            this.hasSeenExtrusion = true;
        }
    }
}

/**
 * Collect indices of all E-motion lines (G0/G1 with E parameter).
 * Used for pre/post transform integrity checking.
 *
 * @param {string[]} lines
 * @returns {{ index: number, content: string }[]}
 */
export function collectEMotionLines(lines) {
    const result = [];
    for (let i = 0; i < lines.length; i++) {
        const parsed = parseLine(lines[i]);
        if (isExtrudingMove(parsed)) {
            result.push({ index: i, content: lines[i].trim() });
        }
    }
    return result;
}

/**
 * Detect purge windows, insertion anchors, fan channels, and Z_MAX.
 *
 * @param {string[]} lines
 * @returns {object}
 */
export function detectSections(lines) {
    const result = {
        // Purge window (exact boundaries)
        purgeWindow: null,       // { start, end, method: 'p1s'|'a1' } or null
        // Insertion anchor (line index to insert AFTER)
        insertionAnchor: null,   // { line, method: 'p1s_m623'|'a1_m623'|'exec_block_end' }
        // Printer model detection
        printerModel: null,      // 'P1S' | 'A1' | null
        // Fan channels detected in source
        fanChannels: { hasP2: false, hasP3: false },
        // Z_MAX parsed from header
        zMax: null,
        // First LAYER_CHANGE
        modelPrintStart: -1,
    };

    // --- Pass 1: Scan for all anchors ---
    let p1sPurgeStart = -1;      // ;===== nozzle load line
    let p1sPurgeEnd = -1;        // first M400 after purge start
    let a1PurgeStart = -1;       // ;===== extrude cali test
    let a1PurgeEnd = -1;         // ;========turn off light and wait extrude temperature

    let p1sTimelapseMark = -1;   // M623; end of "timelapse_record_flag"
    let a1M991Line = -1;         // M991 ... timelapse
    let a1M623AfterM991 = -1;    // M623 after M991 timelapse
    let execBlockEnd = -1;       // ; EXECUTABLE_BLOCK_END
    let firstLayerChange = -1;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // --- Fan detection ---
        if (/^M106\s/i.test(trimmed)) {
            const p = parseLine(trimmed);
            if ('P' in p.params) {
                if (p.params.P === 2) result.fanChannels.hasP2 = true;
                if (p.params.P === 3) result.fanChannels.hasP3 = true;
            }
        }

        // --- First LAYER_CHANGE ---
        if (firstLayerChange === -1 && /^;\s*(LAYER_CHANGE|layer_change)/i.test(trimmed)) {
            firstLayerChange = i;
        }

        // --- Z_MAX from header comments ---
        // Look for "; max_z = 256" or similar
        if (result.zMax === null) {
            const zMatch = trimmed.match(/^;\s*(?:max_z|z_max|printer_z)\s*=\s*([\d.]+)/i);
            if (zMatch) result.zMax = parseFloat(zMatch[1]);
        }

        // --- Printer model detection ---
        if (!result.printerModel) {
            if (/P1S/i.test(trimmed) && /^;\s*(printer|machine)/i.test(trimmed)) {
                result.printerModel = 'P1S';
            } else if (/\bA1\b/i.test(trimmed) && /^;\s*(printer|machine)/i.test(trimmed)) {
                result.printerModel = 'A1';
            }
        }

        // === P1S purge: `;===== nozzle load line` ===
        if (p1sPurgeStart === -1 && /^;={3,}\s*nozzle\s*load\s*line/i.test(trimmed)) {
            p1sPurgeStart = i;
        }
        // First M400 after P1S purge start = end boundary
        if (p1sPurgeStart >= 0 && p1sPurgeEnd === -1 && i > p1sPurgeStart) {
            if (/^M400\b/i.test(trimmed)) {
                p1sPurgeEnd = i;
            }
        }

        // === A1 purge: `;===== extrude cali test` ===
        if (a1PurgeStart === -1 && /^;={3,}\s*extrude\s+cali\s+test/i.test(trimmed)) {
            a1PurgeStart = i;
        }
        // A1 purge end: `;========turn off light and wait extrude temperature`
        if (a1PurgeStart >= 0 && a1PurgeEnd === -1 && i > a1PurgeStart) {
            if (/^;={3,}\s*turn\s+off\s+light\s+and\s+wait\s+extrude\s+temp/i.test(trimmed)) {
                a1PurgeEnd = i;
            }
        }

        // === P1S insertion anchor: `M623; end of "timelapse_record_flag"` ===
        if (p1sTimelapseMark === -1 && /^M623\s*;\s*end\s+of\s+"?timelapse_record_flag"?/i.test(trimmed)) {
            p1sTimelapseMark = i;
        }

        // === A1 insertion anchor: M991 ... timelapse, then next M623 ===
        if (/^M991\b/i.test(trimmed) && /timelapse/i.test(trimmed)) {
            a1M991Line = i;
        }
        if (a1M991Line >= 0 && a1M623AfterM991 === -1 && i > a1M991Line && /^M623\b/i.test(trimmed)) {
            a1M623AfterM991 = i;
        }

        // === EXECUTABLE_BLOCK_END ===
        if (/;\s*EXECUTABLE_BLOCK_END/i.test(trimmed)) {
            execBlockEnd = i;
        }
    }

    // --- Resolve purge window ---
    if (p1sPurgeStart >= 0 && p1sPurgeEnd >= 0) {
        result.purgeWindow = { start: p1sPurgeStart, end: p1sPurgeEnd, method: 'p1s' };
        if (!result.printerModel) result.printerModel = 'P1S';
    } else if (a1PurgeStart >= 0 && a1PurgeEnd >= 0) {
        result.purgeWindow = { start: a1PurgeStart, end: a1PurgeEnd, method: 'a1' };
        if (!result.printerModel) result.printerModel = 'A1';
    }
    // If neither found → purgeWindow stays null → fail-safe: no purge removal

    // --- Resolve insertion anchor (priority order) ---
    if (p1sTimelapseMark >= 0) {
        // P1S: insert immediately AFTER M623 timelapse line
        result.insertionAnchor = { line: p1sTimelapseMark + 1, method: 'p1s_m623' };
    } else if (a1M623AfterM991 >= 0) {
        // A1: insert immediately AFTER M623 following M991 timelapse
        result.insertionAnchor = { line: a1M623AfterM991 + 1, method: 'a1_m623' };
    } else if (execBlockEnd >= 0) {
        // Fallback: insert immediately BEFORE EXECUTABLE_BLOCK_END (never AFTER)
        result.insertionAnchor = { line: execBlockEnd, method: 'exec_block_end' };
    } else {
        // Last resort: insert at end of file
        result.insertionAnchor = { line: lines.length, method: 'eof' };
    }

    result.modelPrintStart = firstLayerChange;

    return result;
}

export default { parseLine, isExtrudingMove, isMovement, ModalState, detectSections, collectEMotionLines };
