// src/gcode/transforms/InsertAutoEject.js — Validated cool-then-sweep ejection block
//
// HARDCODED VALIDATED SWEEP PATH — do not improvise coordinates.
//
// Defaults:
//   Z_CLEAR_TRAVEL = min(200, Z_MAX - 5)
//   SWEEP_START = X125 Y250
//   Z_SWEEP = 2.00
//   LANES = [220, 190, 160, 130, 100, 70, 40, 30]
//   Y_TOP = 250, Y_BOTTOM = 0
//   PARK = X65 Y245
//   F_Z = 10000, F_XY = 12000
//
// Cooldown: repeated M190 S{target-3} (Bambu firmware: M190 S waits for the bed
//   to COOL to target, times out ~90s/line, and reports reached ~3°C early — per
//   the FactorianDesigns tutorial proven over thousands of prints). NOT M190 R.
// Debug markers: M117 WAIT_BED_{target} and M117 SWEEP_START

// Default Z_MAX per printer model
const Z_MAX_DEFAULTS = { P1S: 256, A1: 256 };

/**
 * Compute Z_CLEAR_TRAVEL clamped to printer limits.
 */
function clampZClear(requested, printerModel) {
    const zMax = Z_MAX_DEFAULTS[printerModel] || 256;
    return Math.min(requested, zMax - 5);
}

/**
 * Insert the auto-eject block into G-code at the detected insertion anchor.
 *
 * @param {string[]} lines - G-code lines (mutated in place via splice)
 * @param {object} profile - Transform profile
 * @param {object} detection - Detection results from detectSections()
 * @returns {object} Report with insertion details
 */
export function insertAutoEject(lines, profile, detection) {
    const coolTarget = profile.cool_target_c ?? 27;
    const zClearRequested = profile.z_clear_travel_mm ?? 200;
    const printerModel = detection.printerModel || profile.printer_model || 'P1S';
    const zClear = clampZClear(zClearRequested, printerModel);
    const zSweep = profile.z_sweep_mm ?? 2.0;

    // Sweep geometry (hardcoded validated defaults)
    const sweepStartX = profile.sweep_start_x_mm ?? 125;
    const sweepStartY = profile.sweep_start_y_mm ?? 250;
    const lanes = Array.isArray(profile.sweep_x_lanes) && profile.sweep_x_lanes.length > 0
        ? profile.sweep_x_lanes
        : [220, 190, 160, 130, 100, 70, 40, 30];
    const yTop = profile.sweep_y_top_mm ?? 250;
    const yBottom = profile.sweep_y_bottom_mm ?? 0;
    const parkX = profile.park_x_mm ?? 65;
    const parkY = profile.park_y_mm ?? 245;
    const fZ = profile.sweep_f_z ?? 10000;
    const fXY = profile.sweep_f_xy ?? 12000;

    // Bambu M190 S reports "reached" ~3°C early, so bake target-3 into the gcode.
    // M190 S times out ~90s per line, so repeat to cover the max wait window.
    const earlyExitOffsetC = profile.cool_early_exit_offset_c ?? 3;
    const m190Temp = coolTarget - earlyExitOffsetC;
    const maxWaitMin = profile.max_cool_wait_minutes ?? 60;
    const m190RepeatCount = Math.max(1, Math.ceil((maxWaitMin * 60) / 90));
    const coolWaitLines = [];
    for (let i = 0; i < m190RepeatCount; i++) {
        coolWaitLines.push(`M190 S${m190Temp}`);
    }

    // Build lane sweep lines (verbatim format)
    const laneLines = [];
    for (const x of lanes) {
        laneLines.push('');
        laneLines.push(`G1 Y${yTop} F${fXY}`);
        laneLines.push(`G1 X${x} F${fXY}`);
        laneLines.push(`G1 Y${yBottom} F${fXY}`);
    }

    // Fan lines during cooldown
    const fanLines = [];
    if (profile.fan_main_during_cool != null) {
        fanLines.push(`M106 S${profile.fan_main_during_cool}`);
        if (profile.fan_detect_from_source !== false && detection.fanChannels) {
            if (detection.fanChannels.hasP2) fanLines.push(`M106 P2 S${profile.fan_main_during_cool}`);
            if (detection.fanChannels.hasP3) fanLines.push(`M106 P3 S${profile.fan_main_during_cool}`);
        }
    }

    // Assemble the exact block
    const ejectBlock = [
        '',
        ';============================  AUTO-EJECT (COOL THEN SWEEP)  ============================',
        'M400',
        'G90',
        'M83',
        '',
        `G1 Z${zClear.toFixed(2)} F${fZ}`,
        `G1 X${sweepStartX} Y${sweepStartY} F${fXY}`,
        '',
        `M140 S0`,
        ...fanLines,
        `M117 WAIT_BED_${coolTarget}`,
        ...coolWaitLines,
        `M117 SWEEP_START`,
        '',
        `G1 Z${zSweep.toFixed(2)} F${fZ}`,
        ...laneLines,
        '',
        `G1 Z${zClear.toFixed(2)} F${fZ}`,
        `G1 X${parkX} Y${parkY} F${fXY}`,
        ';============================  END AUTO-EJECT  =====================