// src/gcode/transforms/RemovePrimeLine.js — Remove front purge/prime line
//
// CRITICAL SAFETY RULES:
//   - Only modify lines within the EXACT purge window detected by GcodeParser
//   - P1S window: `;===== nozzle load line` → first subsequent `M400`
//   - A1 window: `;===== extrude cali test` → `;========turn off light...`
//   - If no window detected → do NOTHING (fail-safe)
//   - NEVER modify E-motion lines outside the purge window

/**
 * Remove purge/prime line within the detected purge window.
 * Comments out or deletes the ENTIRE block between start and end anchors.
 *
 * @param {string[]} lines - G-code lines (mutated in place)
 * @param {object|null} purgeWindow - { start, end, method } from detectSections()
 * @returns {{ method_used: string, lines_disabled_count: number, window_start: number, window_end: number, warnings: string[] }}
 */
export function removePrimeLine(lines, purgeWindow) {
    const report = {
        method_used: 'none',
        lines_disabled_count: 0,
        window_start: -1,
        window_end: -1,
        warnings: [],
    };

    if (!purgeWindow) {
        // FAIL-SAFE: no recognized purge window → do not attempt removal
        report.warnings.push('No recognized purge window detected — skipping purge removal (fail-safe)');
        return report;
    }

    report.method_used = purgeWindow.method;
    report.window_start = purgeWindow.start;
    report.window_end = purgeWindow.end;

    // Comment out every line within the window (inclusive)
    for (let i = purgeWindow.start; i <= purgeWindow.end && i < lines.length; i++) {
        const trimmed = lines[i].trim();

        // Skip lines that are already comments
        if (!trimmed || trimmed.startsWith(';')) continue;

        // Comment out the line
        lines[i] = `; [AG_PURGE_DISABLED] ${lines[i]}`;
        report.lines_disabled_count++;
    }

    return report;
}

export default removePrimeLine;
