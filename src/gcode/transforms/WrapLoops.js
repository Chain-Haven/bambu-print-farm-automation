// src/gcode/transforms/WrapLoops.js — N-copy loop concatenation
//
// Concatenates N_LOOPS copies of the transformed single-print G-code.
// No goto/jumps/macros — each loop replays the slicer's full startup.

/**
 * Wrap G-code in N loops by concatenation.
 *
 * @param {string} singlePrintGcode - The fully transformed single-print G-code
 * @param {object} options
 * @param {number} options.n_loops - Number of loops (1 = no looping)
 * @param {number} options.inter_loop_dwell_sec - Dwell seconds between loops
 * @returns {{ output: string, loopCount: number }}
 */
export function wrapLoops(singlePrintGcode, options = {}) {
    const {
        n_loops = 1,
        inter_loop_dwell_sec = 2,
    } = options;

    if (n_loops <= 1) {
        return { output: singlePrintGcode, loopCount: 1 };
    }

    const parts = [];

    for (let i = 1; i <= n_loops; i++) {
        parts.push(`; === LOOP ${i} OF ${n_loops} ===`);
        parts.push(singlePrintGcode);

        if (i < n_loops) {
            parts.push(`; === END OF LOOP ${i} ===`);
            parts.push(`G4 S${inter_loop_dwell_sec}`);
        }
    }

    return {
        output: parts.join('\n'),
        loopCount: n_loops,
    };
}

export default wrapLoops;
