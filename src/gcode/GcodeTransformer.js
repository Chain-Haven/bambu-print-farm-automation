// src/gcode/GcodeTransformer.js — G-code transform orchestrator v2
//
// Pipeline: detect → collect E-motions → remove purge → insert auto-eject
//           → verify E-motion integrity → validate → wrap loops → report
//
// CRITICAL SAFETY: Before and after purge+eject transforms, we snapshot all
// E-motion lines. ANY change to E-motions outside the purge window and the
// inserted eject block is a hard error — output is NOT produced.

import crypto from 'node:crypto';
import { detectSections, collectEMotionLines } from './GcodeParser.js';
import { removePrimeLine } from './transforms/RemovePrimeLine.js';
import { insertAutoEject } from './transforms/InsertAutoEject.js';
import { wrapLoops } from './transforms/WrapLoops.js';
import { validateGcode } from './GcodeValidator.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('GcodeTransformer');

/**
 * Transform G-code according to a profile.
 *
 * @param {string} content - Raw G-code file content
 * @param {object} profile - Transform profile (from DB or defaults)
 * @param {object} meta - Job metadata { job_id, filename }
 * @returns {TransformResult}
 * @throws {Error} if validation or E-motion safety fails
 */
export function transformGcode(content, profile, meta = {}) {
    const startTime = Date.now();
    const originalLines = content.split('\n');
    const lines = [...originalLines]; // work on a copy

    log.info(`Starting transform: ${originalLines.length} lines, profile="${profile.name || 'unnamed'}"`);

    const report = {
        profile_id: profile.profile_id || null,
        profile_name: profile.name || 'unnamed',
        original_line_count: originalLines.length,
        transformed_line_count: 0,
        // Detection results
        printer_model: null,
        purge_recognizer: 'none',
        eject_anchor: 'none',
        // Purge
        prime_line: null,
        // Auto-eject
        auto_eject: null,
        // E-motion safety
        e_motion_safety: null,
        // Loops
        loops: null,
        // Validation
        validation: null,
        // Finalization
        z_clear_travel: null,
        hash: null,
        warnings: [],
        failures: [],
        transform_time_ms: 0,
    };

    // === Step 1: Detect sections (model-aware) ===
    const detection = detectSections(lines);
    report.printer_model = detection.printerModel || 'unknown';
    report.purge_recognizer = detection.purgeWindow?.method || 'none';

    log.info(`Detection: model=${report.printer_model}, ` +
        `purge=${detection.purgeWindow?.method || 'none'} ` +
        `(${detection.purgeWindow ? `L${detection.purgeWindow.start}-L${detection.purgeWindow.end}` : 'n/a'}), ` +
        `anchor=${detection.insertionAnchor?.method}@L${detection.insertionAnchor?.line}, ` +
        `zMax=${detection.zMax}, fans:P2=${detection.fanChannels.hasP2},P3=${detection.fanChannels.hasP3}`);

    // === Step 2: Snapshot E-motion lines BEFORE transforms ===
    const eMotionBefore = collectEMotionLines(lines);

    // Track which line ranges are "allowed" to change E-motions
    // (these will be updated as we modify the file)
    let purgeStart = -1, purgeEnd = -1;
    let ejectInsertStart = -1, ejectInsertEnd = -1;

    // === Step 3: Remove purge (if enabled and window found) ===
    if (profile.remove_front_prime_line !== false) {
        if (!detection.purgeWindow) {
            report.warnings.push('Purge removal requested but no recognized purge window found — skipped (fail-safe)');
            log.warn('No recognized purge window — skipping purge removal');
        }
        const primeReport = removePrimeLine(lines, detection.purgeWindow);
        report.prime_line = primeReport;
        report.warnings.push(...primeReport.warnings);
        if (primeReport.window_start >= 0) {
            purgeStart = primeReport.window_start;
            purgeEnd = primeReport.window_end;
        }
        log.info(`Purge removal: method=${primeReport.method_used}, disabled=${primeReport.lines_disabled_count}`);
    }

    // === Step 4: Insert auto-eject block ===
    const ejectResult = insertAutoEject(lines, profile, detection);
    report.auto_eject = ejectResult;
    report.eject_anchor = ejectResult.anchor_method;
    report.z_clear_travel = ejectResult.z_clear_travel;
    ejectInsertStart = ejectResult.insertedAt;
    ejectInsertEnd = ejectResult.insertedAt + ejectResult.linesInserted - 1;

    log.info(`Auto-eject: anchor=${ejectResult.anchor_method}, ` +
        `at=L${ejectResult.insertedAt}, Z_CLEAR=${ejectResult.z_clear_travel}, ` +
        `cool=${ejectResult.cool_command}, lanes=${ejectResult.sweep_lanes.length}`);

    // === Step 5: E-motion integrity check ===
    // Collect E-motions AFTER transforms
    const eMotionAfter = collectEMotionLines(lines);

    // Verify: all original E-motion lines must be unchanged UNLESS they fall
    // within the purge window OR are new lines from the eject block
    const eMotionViolations = verifyEMotionIntegrity(
        eMotionBefore, eMotionAfter, originalLines, lines,
        { purgeStart, purgeEnd, ejectInsertStart, ejectInsertEnd }
    );

    report.e_motion_safety = {
        before_count: eMotionBefore.length,
        after_count: eMotionAfter.length,
        violations: eMotionViolations.length,
        violation_details: eMotionViolations.slice(0, 10), // cap for report size
    };

    if (eMotionViolations.length > 0) {
        const errMsg = `E-MOTION SAFETY VIOLATION: ${eMotionViolations.length} E-motion line(s) changed outside allowed regions. ` +
            `First: ${eMotionViolations[0]}`;
        log.error(errMsg);
        throw new Error(errMsg);
    }
    log.info(`E-motion safety: ${eMotionBefore.length} original E-motions, 0 violations ✓`);

    // === Step 6: Confirm M190 S and no M190 R in inserted block ===
    // Bambu firmware: M190 S waits for the bed to COOL to target (M190 R does not
    // behave as a cool-wait here) — see InsertAutoEject.js / FactorianDesigns tutorial.
    const insertedLines = lines.slice(ejectInsertStart, ejectInsertEnd + 1);
    const hasM190R = insertedLines.some(l => /^M190\s+R/i.test(l.trim()));
    const hasM190S = insertedLines.some(l => /^M190\s+S/i.test(l.trim()));

    if (!hasM190S) {
        throw new Error('VALIDATION FAILED: No M190 S command found in inserted eject block');
    }
    if (hasM190R) {
        throw new Error('VALIDATION FAILED: M190 R found in inserted eject block (must use M190 S for cool-wait on Bambu)');
    }

    // === Step 7: Basic validation ===
    const validation = validateGcode(lines, originalLines);
    report.validation = validation;
    report.warnings.push(...validation.warnings);

    if (!validation.valid) {
        report.failures.push(...validation.errors);
        throw new Error(`G-code validation failed: ${validation.errors.join('; ')}`);
    }

    // === Step 8: Wrap in loops ===
    const singleOutput = lines.join('\n');
    const nLoops = profile.n_loops || 1;
    const { output: finalOutput, loopCount } = wrapLoops(singleOutput, {
        n_loops: nLoops,
        inter_loop_dwell_sec: profile.inter_loop_dwell_sec || 2,
    });

    report.loops = { requested: nLoops, applied: loopCount, dwell_sec: profile.inter_loop_dwell_sec || 2 };
    if (loopCount > 1) {
        log.info(`Loops: ${loopCount} copies with ${profile.inter_loop_dwell_sec || 2}s dwell`);
    }

    // === Finalize ===
    const hash = crypto.createHash('sha256').update(finalOutput).digest('hex');
    report.hash = `sha256:${hash}`;
    report.transformed_line_count = finalOutput.split('\n').length;
    report.transform_time_ms = Date.now() - startTime;

    const baseName = meta.filename || 'output.gcode';
    const ext = baseName.lastIndexOf('.') >= 0 ? baseName.slice(baseName.lastIndexOf('.')) : '.gcode';
    const stem = baseName.slice(0, baseName.length - ext.length);
    const loopSuffix = loopCount > 1 ? `.x${loopCount}` : '';
    const outputFilename = `${stem}.AG${loopSuffix}${ext}`;

    // === Mandatory validation report (logged) ===
    log.info('=== TRANSFORM VALIDATION REPORT ===');
    log.info(`  Printer model:       ${report.printer_model}`);
    log.info(`  Purge recognizer:    ${report.purge_recognizer}`);
    log.info(`  Eject anchor:        ${report.eject_anchor}`);
    log.info(`  M190 S present:      ${hasM190S} ✓`);
    log.info(`  M190 R in block:     ${hasM190R} (must be false) ✓`);
    log.info(`  E-motion violations: ${eMotionViolations.length} (must be 0) ✓`);
    log.info(`  Z_CLEAR_TRAVEL:      ${report.z_clear_travel} mm`);
    log.info(`  Loops:               ${loopCount} (dwell ${profile.inter_loop_dwell_sec || 2}s)`);
    log.info(`  Output:              ${outputFilename}`);
    log.info(`  Transform time:      ${report.transform_time_ms}ms`);
    log.info('=== END REPORT ===');

    return {
        output: finalOutput,
        outputFilename,
        report,
        diffSummary: {
            prime_line_removed: report.prime_line?.lines_disabled_count > 0,
            auto_eject_inserted: ejectResult.inserted,
            loops_applied: loopCount > 1,
        },
    };
}

/**
 * Verify that no E-motion lines were changed outside allowed regions.
 *
 * We compare each original E-motion line to the corresponding position in the
 * transformed output, accounting for offset from splice operations.
 */
function verifyEMotionIntegrity(before, after, originalLines, transformedLines, allowed) {
    const violations = [];

    // Build a set of original E-motion line contents (outside purge window)
    const originalEOutsidePurge = [];
    for (const em of before) {
        // Skip E-motions inside the purge window — those ARE allowed to change
        if (allowed.purgeStart >= 0 && em.index >= allowed.purgeStart && em.index <= allowed.purgeEnd) {
            continue;
        }
        originalEOutsidePurge.push(em.content);
    }

    // Collect E-motions from transformed output that are NOT in the eject block
    const transformedEOutsideEject = [];
    for (const em of after) {
        // Skip E-motions inside the inserted eject block
        if (allowed.ejectInsertStart >= 0 && em.index >= allowed.ejectInsertStart && em.index <= allowed.ejectInsertEnd) {
            continue;
        }
        // Skip disabled lines
        if (em.content.startsWith('; [AG_PURGE_DISABLED]')) {
            continue;
        }
        transformedEOutsideEject.push(em.content);
    }

    // The set of E-motions outside allowed regions should be identical
    if (originalEOutsidePurge.length !== transformedEOutsideEject.length) {
        violations.push(
            `E-motion count mismatch outside allowed regions: ` +
            `original=${originalEOutsidePurge.length}, transformed=${transformedEOutsideEject.length}`
        );
    } else {
        for (let i = 0; i < originalEOutsidePurge.length; i++) {
            if (originalEOutsidePurge[i] !== transformedEOutsideEject[i]) {
                violations.push(
                    `E-motion line ${i} changed: "${originalEOutsidePurge[i]}" → "${transformedEOutsideEject[i]}"`
                );
            }
        }
    }

    return violations;
}

/**
 * Default profile values.
 */
export const DEFAULT_PROFILE = {
    name: 'default',
    profile_id: 'default',
    remove_front_prime_line: true,
    park_x_mm: 65,
    park_y_mm: 245,
    eject_mode: 'printhead_push',
    eject_params: {},
    n_loops: 1,
    inter_loop_dwell_sec: 2,
    cool_target_c: 27,
    cool_use_m190_r: false, // Bambu uses repeated M190 S as the cool-wait, not M190 R
    cooldown_mode: 'temperature',
    cool_time_minutes: 30,
    z_clear_travel_mm: 200,
    z_sweep_mm: 2.0,
    sweep_start_x_mm: 125,
    sw