// src/gcode/transforms/InsertAgMarkers.js — Insert Antigravity automation comment markers
//
// Appends AG comment block near end of file with automation parameters.
// These are comments only — no custom M-codes. The runtime interprets them.

import crypto from 'node:crypto';

/**
 * Insert AG automation markers into G-code lines.
 *
 * @param {string[]} lines - G-code lines (modified in place)
 * @param {object} profile - G-code transform profile
 * @param {object} meta - Job metadata { job_id, profile_id }
 * @returns {{ inserted: boolean, insertedAt: number, markers: object }}
 */
export function insertAgMarkers(lines, profile, meta = {}) {
    const {
        release_bed_temp_c = 27.0,
        eject_mode = 'printhead_push',
        park_before_eject = true,
        park_x_mm = 5,
        park_y_mm = 200,
        park_z_mm = 25,
        profile_id,
    } = profile;

    const jobId = meta.job_id || 'UNKNOWN';
    const profId = meta.profile_id || profile_id || 'UNKNOWN';

    // Compute content hash for integrity
    const contentForHash = lines.join('\n');
    const hash = crypto.createHash('sha256').update(contentForHash).digest('hex').slice(0, 16);

    const markerBlock = [
        '',
        ';================= ANTIGRAVITY AUTOMATION =================',
        ';AG_JOB_END=1',
        ';AG_EJECT_REQUESTED=1',
        `;AG_RELEASE_TEMP_C=${release_bed_temp_c}`,
        `;AG_EJECT_MODE=${eject_mode.toUpperCase()}`,
        `;AG_PARK_BEFORE_EJECT=${park_before_eject ? 1 : 0}`,
        `;AG_PARK_X=${park_x_mm}`,
        `;AG_PARK_Y=${park_y_mm}`,
        `;AG_PARK_Z=${park_z_mm}`,
        `;AG_PROFILE_ID=${profId}`,
        `;AG_JOB_ID=${jobId}`,
        `;AG_HASH=${hash}`,
        ';==========================================================',
        '',
    ];

    // Insert just before the very last line (or append if file is empty)
    // Find insertion point: before any trailing empty lines or after last real code
    let insertAt = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) {
        const trimmed = lines[i].trim();
        if (trimmed.length > 0) {
            insertAt = i + 1;
            break;
        }
    }

    lines.splice(insertAt, 0, ...markerBlock);

    return {
        inserted: true,
        insertedAt: insertAt + 1, // 1-indexed
        markers: {
            AG_JOB_END: 1,
            AG_EJECT_REQUESTED: 1,
            AG_RELEASE_TEMP_C: release_bed_temp_c,
            AG_EJECT_MODE: eject_mode.toUpperCase(),
            AG_PARK_BEFORE_EJECT: park_before_eject ? 1 : 0,
            AG_PARK_X: park_x_mm,
            AG_PARK_Y: park_y_mm,
            AG_PARK_Z: park_z_mm,
            AG_PROFILE_ID: profId,
            AG_JOB_ID: jobId,
            AG_HASH: hash,
        },
    };
}

export default insertAgMarkers;
