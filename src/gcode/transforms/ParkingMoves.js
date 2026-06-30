// src/gcode/transforms/ParkingMoves.js — Optional parking move insertion
//
// Inserts G-code commands to park the toolhead before ejection.
// This is a transform-time insertion of actual G-code (not just comments).

/**
 * Insert parking moves into G-code before the AG marker block.
 *
 * @param {string[]} lines - G-code lines (modified in place)
 * @param {object} profile - Profile with park coordinates
 * @returns {{ inserted: boolean, insertedAt: number }}
 */
export function insertParkingMoves(lines, profile) {
    if (!profile.park_before_eject) {
        return { inserted: false, insertedAt: -1 };
    }

    const {
        park_x_mm = 5,
        park_y_mm = 200,
        park_z_mm = 25,
        park_feed_mm_min = 6000,
    } = profile;

    const parkBlock = [
        '',
        '; --- ANTIGRAVITY: Park toolhead for ejection ---',
        'G91 ; relative positioning',
        `G1 Z${park_z_mm} F${park_feed_mm_min} ; raise Z`,
        'G90 ; absolute positioning',
        `G1 X${park_x_mm} Y${park_y_mm} F${park_feed_mm_min} ; park XY`,
        '; --- End park ---',
        '',
    ];

    // Find the AG marker block and insert just before it
    let agStart = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('ANTIGRAVITY AUTOMATION')) {
            agStart = i;
            break;
        }
    }

    const insertAt = agStart >= 0 ? agStart : lines.length;
    lines.splice(insertAt, 0, ...parkBlock);

    return { inserted: true, insertedAt: insertAt + 1 };
}

export default insertParkingMoves;
