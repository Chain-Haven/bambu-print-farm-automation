import { normalizeFarmAutomationSettings } from './farmAutomation.js';
import {
    getEstimatedGrams,
    getPrimaryColor,
    getPrimaryMaterial,
} from './printIntake.js';

const UNAVAILABLE_DRY_STATES = new Set(['wet', 'needs_drying']);

function isAvailable(spool) {
    return spool.grams_remaining > 0
        && !spool.reserved_for_job_id
        && !UNAVAILABLE_DRY_STATES.has(String(spool.dry_status || '').toLowerCase());
}

export function reserveFilamentForJob({ inventory = {}, jobId, requirements = {} } = {}) {
    const normalized = normalizeFarmAutomationSettings({ inventory }).inventory;
    const material = getPrimaryMaterial(requirements);
    const color = getPrimaryColor(requirements);
    const estimatedGrams = getEstimatedGrams(requirements);
    const candidates = normalized.spools
        .filter(isAvailable)
        .filter((spool) => !material || spool.material === material)
        .filter((spool) => !color || spool.color_hex === color)
        .sort((a, b) => (
            (b.grams_remaining >= estimatedGrams) - (a.grams_remaining >= estimatedGrams)
            || a.grams_remaining - b.grams_remaining
            || a.spool_id.localeCompare(b.spool_id)
        ));

    const selected = candidates[0] || null;
    if (!selected) {
        return {
            status: 'unavailable',
            reservation: null,
            inventory: normalized,
        };
    }

    const nextSpools = normalized.spools.map((spool) => (
        spool.spool_id === selected.spool_id
            ? { ...spool, reserved_for_job_id: jobId }
            : spool
    ));
    const reservation = {
        spool_id: selected.spool_id,
        material: selected.material,
        color_hex: selected.color_hex,
        color_name: selected.color_name,
        reserved_grams: estimatedGrams,
    };

    return {
        status: 'reserved',
        reservation,
        inventory: { spools: nextSpools },
    };
}

export function releaseFilamentReservation({ inventory = {}, jobId } = {}) {
    const normalized = normalizeFarmAutomationSettings({ inventory }).inventory;
    const released = [];
    const spools = normalized.spools.map((spool) => {
        if (spool.reserved_for_job_id !== jobId) return spool;
        released.push(spool.spool_id);
        return { ...spool, reserved_for_job_id: null };
    });

    return {
        released,
        inventory: { spools },
    };
}
