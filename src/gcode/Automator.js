// src/gcode/Automator.js — G-code Automator (complete rewrite)
//
// Based on FactorianDesigns' proven tutorial approach.
// Takes plate_*.gcode text and produces automated gcode with:
//   1) Purge/calibration line removal (strictly anchored)
//   2) Cooldown wait using repeated M190 S (tutorial method)
//   3) Sweep-eject at fixed Z height
//   4) N-loop concatenation (copy-paste method)
//
// NO negative Z moves. NO G4 waits for cooldown. NO M190 R.

import { createLogger } from '../utils/logger.js';

const log = createLogger('Automator');

// ============================================================
// A) PRINTER MODEL DEFAULTS
// ============================================================

const MODEL_DEFAULTS = {
    P1S: {
        zMax: 250,
        sweepStartX: 128, sweepStartY: 250,
        sweepEndY: 0,
        sweepLanesX: [128, 78, 178, 28, 228], // center-out, L-R, 50mm increments
        parkX: 65, parkY: 245,
        fTravel: 12000, fSweep: 2000, fZ: 600,
        hasChamberFan: true,   // M106 P3
        hasAuxFan: true,       // M106 P2
        purgeFamily: 'P1X1',
    },
    X1: {
        zMax: 250,
        sweepStartX: 128, sweepStartY: 250,
        sweepEndY: 0,
        sweepLanesX: [128, 78, 178, 28, 228], // center-out, L-R, 50mm increments
        parkX: 65, parkY: 245,
        fTravel: 12000, fSweep: 2000, fZ: 600,
        hasChamberFan: true,
        hasAuxFan: true,
        purgeFamily: 'P1X1',
    },
    A1: {
        zMax: 256,
        sweepStartX: 128, sweepStartY: 250,
        sweepEndY: 0,
        sweepLanesX: [128, 78, 178, 28, 228], // center-out, L-R, 50mm increments
        parkX: -48, parkY: 262,
        fTravel: 12000, fSweep: 2000, fZ: 600,
        hasChamberFan: false,
        hasAuxFan: false,
        purgeFamily: 'A1',
    },
    A1_MINI: {
        zMax: 180,
        sweepStartX: 90, sweepStartY: 175,
        sweepEndY: 0,
        sweepLanesX: [90, 40, 140], // center-out, L-R, 50mm increments
        parkX: -13, parkY: 185,
        fTravel: 12000, fSweep: 2000, fZ: 600,
        hasChamberFan: false,
        hasAuxFan: false,
        purgeFamily: 'A1',
    },
};

// ============================================================
// MAIN ENTRY POINT
// ============================================================

/**
 * Transform a plate_*.gcode string into an automated version.
 *
 * @param {string} gcodeText - Raw plate gcode content
 * @param {object} config - User configuration
 * @param {string} config.printerModel - One of P1S, X1, A1, A1_MINI
 * @param {number} config.loopsN - Number of loops (>= 1)
 * @param {number} config.releaseTempC - Target bed temp where part releases (default 27)
 * @param {number} config.tempEarlyExitOffsetC - Fixed 3 (do not change)
 * @param {number} config.maxWaitMin - Max cooldown wait in minutes (default 60)
 * @param {number} config.sweepZMm - Sweep height in mm (fixed 4)
 * @param {number} config.zClearTravelMm - Safe travel Z after sweep (default 200)
 * @param {object} [config.overrides] - Override any MODEL_DEFAULTS key
 * @returns {{ output: string, report: object }}
 */
export function automate(gcodeText, config = {}) {
    const startTime = Date.now();

    // Resolve config
    const printerModel = config.printerModel || 'P1S';
    const modelDef = { ...(MODEL_DEFAULTS[printerModel] || MODEL_DEFAULTS.P1S) };

    // Apply user overrides
    if (config.overrides) {
        for (const [k, v] of Object.entries(config.overrides)) {
            if (k in modelDef && v != null) modelDef[k] = v;
        }
    }

    const loopsN = Math.max(1, config.loopsN || 1);

    // Cooldown mode: 'temperature' (wait until the plate cools to a target temp
    // via repeated M190 S) OR 'time' (wait a fixed duration via G4). These are
    // mutually exclusive — exactly one runs, never both.
    const cooldownMode = config.cooldownMode === 'time' ? 'time' : 'temperature';

    const releaseTempC = config.releaseTempC ?? 27;
    const tempEarlyExitOffsetC = config.tempEarlyExitOffsetC ?? 3;
    // On Bambu firmware M190 S reports "reached" ~3°C early, so the value baked
    // into the gcode is the user's release temp minus the offset (e.g. release
    // 27°C -> M190 S24). This is per the FactorianDesigns tutorial and is NOT a bug.
    const waitTempC = releaseTempC - tempEarlyExitOffsetC;
    const maxWaitMin = config.maxWaitMin ?? 60;
    // M190 S on Bambu times out after ~90s per line, so we repeat it to cover the
    // requested max wait window.
    const m190RepeatCount = Math.ceil((maxWaitMin * 60) / 90);

    // Time mode: fixed dwell. Falls back to maxWaitMin if no explicit value given.
    const coolTimeMin = Math.max(0, config.coolTimeMin ?? maxWaitMin);
    const coolTimeSec = Math.round(coolTimeMin * 60);

    const sweepZMm = config.sweepZMm ?? 4;
    const zClearTravelMm = config.zClearTravelMm ?? 200;
    const zClearClamped = Math.min(zClearTravelMm, modelDef.zMax - 5);

    const report = {
        printerModel,
        loopsN,
        cooldownMode,
        releaseTempC,
        waitTempC,
        m190RepeatCount,
        coolTimeMin,
        sweepZMm,
        zClearClamped,
        purgeRemoval: null,
        insertionPoint: null,
        warnings: [],
        transformTimeMs: 0,
    };

    if (cooldownMode === 'time') {
        log.info(`Automator: model=${printerModel}, loops=${loopsN}, cooldown=TIME ${coolTimeMin}min (G4), sweepZ=${sweepZMm}mm`);
    } else {
        log.info(`Automator: model=${printerModel}, loops=${loopsN}, cooldown=TEMP release=${releaseTempC}°C wait=${waitTempC}°C m190x${m190RepeatCount}, sweepZ=${sweepZMm}mm`);
    }

    const lines = gcodeText.split('\n');

    // ========================================================
    // STEP 1: PURGE / CALIBRATION LINE REMOVAL
    // ========================================================
    const purgeResult = removePurgeBlock(lines, modelDef.purgeFamily);
    report.purgeRemoval = purgeResult;
    if (purgeResult.found) {
        log.info(`Purge removed: ${purgeResult.method}, lines ${purgeResult.startLine}-${purgeResult.endLine} (${purgeResult.linesCommented} lines commented)`);
    } else {
        log.info(`Purge removal: no anchors found (fail-safe, nothing removed)`);
        report.warnings.push('No purge anchors found — nothing removed (fail-safe)');
    }

    // ========================================================
    // STEP 2: FIND INSERTION POINT FOR AUTOMATION BLOCK
    // ========================================================
    const insertionIdx = findInsertionPoint(lines, modelDef.purgeFamily);
    report.insertionPoint = insertionIdx;
    log.info(`Insertion point: line ${insertionIdx.line} (method: ${insertionIdx.method})`);

    // ========================================================
    // STEP 3: BUILD AUTOMATION BLOCK (cooldown + sweep)
    // ========================================================
    const automationBlock = buildAutomationBlock({
        cooldownMode,
        waitTempC,
        m190RepeatCount,
        coolTimeMin,
        coolTimeSec,
        sweepZMm,
        zClearClamped,
        modelDef,
        fZ: modelDef.fZ,
    });

    // ========================================================
    // STEP 4: REMOVE OLD END MOTIONS + INSERT AUTOMATION BLOCK
    // ========================================================
    // We insert our block at the insertion point and remove everything
    // between insertion point and the end-of-file cleanup commands.
    // Strategy: find the end section to replace, splice in our block.
    const singleLoopLines = buildSingleLoop(lines, insertionIdx, automationBlock);

    // ========================================================
    // STEP 5: LOOP
    // ========================================================
    const singleLoopText = singleLoopLines.join('\n');
    let finalOutput;

    if (loopsN <= 1) {
        finalOutput = singleLoopText;
    } else {
        const parts = [];
        for (let i = 1; i <= loopsN; i++) {
            parts.push(`; === LOOP ${i} OF ${loopsN} ===`);
            parts.push('M400');
            parts.push(singleLoopText);
            if (i < loopsN) {
                parts.push(`; === END LOOP ${i} ===`);
                parts.push('G4 S2');
            }
        }
        finalOutput = parts.join('\n');
    }

    // ========================================================
    // STEP 6: VALIDATION
    // ========================================================
    // Check for negative Z moves
    const negZCount = countNegativeZMoves(finalOutput);
    if (negZCount > 0) {
        report.warnings.push(`WARNING: Found ${negZCount} negative Z move(s) in output — review manually`);
        log.warn(`Negative Z moves found: ${negZCount}`);
    }

    report.transformTimeMs = Date.now() - startTime;
    log.info(`Automator complete: ${report.transformTimeMs}ms, ${finalOutput.split('\n').length} lines`);

    return { output: finalOutput, report };
}

// ============================================================
// PURGE REMOVAL — Strictly anchored
// ============================================================

/**
 * @param {string[]} lines - Mutated in place
 * @param {'P1X1'|'A1'} family
 */
function removePurgeBlock(lines, family) {
    if (family === 'P1X1') {
        return removePurgeP1X1(lines);
    } else if (family === 'A1') {
        return removePurgeA1(lines);
    }
    return { found: false, method: 'unknown_family' };
}

/**
 * P1/X1: start=";===== nozzle load line" -> end=first following "M400"
 */
function removePurgeP1X1(lines) {
    let startIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().startsWith(';===== nozzle load line')) {
            startIdx = i;
            break;
        }
    }
    if (startIdx < 0) return { found: false, method: 'p1x1_no_start_anchor' };

    let endIdx = -1;
    for (let i = startIdx + 1; i < lines.length; i++) {
        if (lines[i].trim() === 'M400') {
            endIdx = i;
            break;
        }
    }
    if (endIdx < 0) return { found: false, method: 'p1x1_no_end_anchor' };

    let commented = 0;
    for (let i = startIdx; i <= endIdx; i++) {
        const trimmed = lines[i].trim();
        if (trimmed && !trimmed.startsWith(';')) {
            lines[i] = `; [AG_PURGE_REMOVED] ${lines[i]}`;
            commented++;
        }
    }

    return { found: true, method: 'p1x1', startLine: startIdx, endLine: endIdx, linesCommented: commented };
}

/**
 * A1: start=";===== extrude cali test" -> end=";========turn off light and wait extrude temperature"
 */
function removePurgeA1(lines) {
    let startIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().startsWith(';===== extrude cali test')) {
            startIdx = i;
            break;
        }
    }
    if (startIdx < 0) return { found: false, method: 'a1_no_start_anchor' };

    let endIdx = -1;
    for (let i = startIdx + 1; i < lines.length; i++) {
        if (lines[i].trim().startsWith(';========turn off light')) {
            endIdx = i;
            break;
        }
    }
    if (endIdx < 0) return { found: false, method: 'a1_no_end_anchor' };

    let commented = 0;
    for (let i = startIdx; i <= endIdx; i++) {
        const trimmed = lines[i].trim();
        if (trimmed && !trimmed.startsWith(';')) {
            lines[i] = `; [AG_PURGE_REMOVED] ${lines[i]}`;
            commented++;
        }
    }

    return { found: true, method: 'a1', startLine: startIdx, endLine: endIdx, linesCommented: commented };
}

// ============================================================
// INSERTION POINT DETECTION
// ============================================================

/**
 * Find where the print body ends and end-gcode begins.
 * We insert our automation block RIGHT HERE, and comment out
 * ALL original end-gcode (which includes Z moves, wipe,
 * AMS return, timelapse stop, parking, EXECUTABLE_BLOCK_END, etc.)
 *
 * Priority:
 * 1. `; MACHINE_END_GCODE_START` — Bambu Studio emits this marker
 * 2. `; filament end gcode` — sometimes appears before MACHINE_END marker
 * 3. `; EXECUTABLE_BLOCK_END` -> insert BEFORE (last resort with framing)
 * 4. Last resort: end of file
 */
function findInsertionPoint(lines, family) {
    // Primary: find MACHINE_END_GCODE_START
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().includes('MACHINE_END_GCODE_START')) {
            return { line: i, method: 'machine_end_gcode_start' };
        }
    }

    // Secondary: "filament end gcode" comment (sometimes before MACHINE_END)
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 200); i--) {
        if (lines[i].trim().startsWith('; filament end gcode')) {
            return { line: i, method: 'filament_end_gcode' };
        }
    }

    // Fallback: EXECUTABLE_BLOCK_END
    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].trim().includes('EXECUTABLE_BLOCK_END')) {
            return { line: i, method: 'executable_block_end' };
        }
    }

    // Last resort: end of file
    return { line: lines.length, method: 'eof' };
}

// ============================================================
// BUILD AUTOMATION BLOCK
// ============================================================

function buildAutomationBlock({ cooldownMode, waitTempC, m190RepeatCount, coolTimeMin, coolTimeSec, sweepZMm, zClearClamped, modelDef, fZ }) {
    const block = [];

    block.push('');
    block.push(';===== ANTIGRAVITY AUTOMATION START =====');
    block.push('M400 ; wait for all print moves to complete');
    block.push('G90 ; absolute positioning');
    block.push('');

    // --- Retreat to rear center (clear the part before cooldown) ---
    block.push('; --- Retreat to rear center ---');
    block.push(`G1 X${modelDef.sweepStartX} Y${modelDef.sweepStartY} F${modelDef.fTravel} ; move nozzle to rear center (NO Z change)`);
    block.push('');

    // --- Cooldown ---
    block.push('; --- Cooldown ---');
    block.push('M140 S0 ; turn off bed heater');
    block.push('M104 S0 ; turn off hotend');
    block.push('M106 S0 ; turn off part fan');

    // Aux + chamber fans for faster cooling (P1S/X1 only)
    if (modelDef.hasAuxFan) {
        block.push('M106 P2 S255 ; aux fan ON for faster cooldown');
    }
    if (modelDef.hasChamberFan) {
        block.push('M106 P3 S200 ; chamber fan ON for faster cooldown');
    }

    block.push('');

    // Cooldown wait — exactly ONE mode runs.
    if (cooldownMode === 'time') {
        // TIME MODE: dwell a fixed duration regardless of temperature.
        // Chunked into 60s G4 lines (same defensive pattern as the repeated M190 S):
        // if firmware ever caps a single G4 dwell, the full wait still holds.
        const chunkSec = 60;
        const fullChunks = Math.floor(coolTimeSec / chunkSec);
        const remainderSec = coolTimeSec - fullChunks * chunkSec;
        block.push(`; Cooldown wait: FIXED TIME ${coolTimeMin} min (G4 dwell, ${chunkSec}s chunks)`);
        for (let i = 0; i < fullChunks; i++) block.push(`G4 S${chunkSec} ; fixed-time cooldown dwell`);
        if (remainderSec > 0) block.push(`G4 S${remainderSec} ; fixed-time cooldown dwell (remainder)`);
    } else {
        // TEMPERATURE MODE: wait until the plate cools to the release temp.
        // M190 S on Bambu waits for the bed to fall to the target (timing out
        // ~90s per line), and reports "reached" ~3°C early — hence waitTempC is
        // releaseTemp-3 and the command is repeated to cover the max wait window.
        block.push(`; Cooldown wait: M190 S${waitTempC} x${m190RepeatCount} (max ${Math.round(m190RepeatCount * 90 / 60)} min)`);
        block.push(`; Target release temp: ${waitTempC + 3}°C (M190 exits ~3°C early)`);
        for (let i = 0; i < m190RepeatCount; i++) {
            block.push(`M190 S${waitTempC} ; wait for bed temp`);
        }
    }

    block.push('');

    // Turn off cooldown fans
    if (modelDef.hasAuxFan) {
        block.push('M106 P2 S0 ; aux fan OFF');
    }
    if (modelDef.hasChamberFan) {
        block.push('M106 P3 S0 ; chamber fan OFF');
    }
    block.push('M140 S0 ; ensure bed heater stays off');
    block.push('');

    // --- Sweep ---
    block.push('; --- Sweep Eject (NO Z change until at sweep start XY) ---');
    block.push(`G1 X${modelDef.sweepStartX} Y${modelDef.sweepStartY} F${modelDef.fTravel} ; travel to sweep start (NO Z change)`);
    block.push(`G1 Z${sweepZMm} F${fZ} ; lower to sweep height`);
    block.push('');

    // Lanes
    for (const x of modelDef.sweepLanesX) {
        block.push(`G1 X${x} F${modelDef.fTravel} ; move to lane X=${x}`);
        block.push(`G1 Y${modelDef.sweepEndY} F${modelDef.fSweep} ; sweep forward`);
        block.push(`G1 Y${modelDef.sweepStartY} F${modelDef.fTravel} ; return to back`);
    }

    block.push('');
    block.push(`; --- Sweep complete, park ---`);
    block.push(`G1 Z${zClearClamped} F${fZ} ; raise to safe travel height`);
    block.push(`G1 X${modelDef.parkX} Y${modelDef.parkY} F${modelDef.fTravel} ; park`);
    block.push('');

    // Reset commands (from tutorial end codes)
    block.push('M220 S100 ; reset feedrate');
    block.push('M201.2 K1.0 ; reset acc magnitude');
    block.push('M73.2 R1.0 ; reset left time magnitude');
    block.push('M1002 set_gcode_claim_speed_level : 0');
    block.push('');
    block.push(';===== ANTIGRAVITY AUTOMATION END =====');
    block.push('');

    return block;
}

// ============================================================
// BUILD SINGLE LOOP
// ============================================================

/**
 * Build one complete loop of: [print body] + [automation block] + [EXECUTABLE_BLOCK_END]
 *
 * - Everything before insertionIdx.line is kept (print body)
 * - Everything from insertionIdx.line to EOF is the original end-gcode:
 *   we comment ALL of it out with ; [AG_END_REPLACED] prefix
 * - Then we append our automation block
 * - Finally we re-add ; EXECUTABLE_BLOCK_END to preserve Studio framing
 */
function buildSingleLoop(lines, insertionIdx, automationBlock) {
    const result = [];

    // 1) Keep the print body (lines before insertion point)
    for (let i = 0; i < insertionIdx.line; i++) {
        const trimmed = lines[i].trim();
        // Comment out M73 P100 (progress=100%) to allow looping
        if (/^M73\s+P100\b/i.test(trimmed)) {
            result.push(`; [AG_REMOVED] ${lines[