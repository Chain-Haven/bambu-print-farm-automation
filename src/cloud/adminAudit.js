// Best-effort admin audit trail. Every privileged mutation on the admin API
// calls recordAdminAudit with the authenticated actor (from
// authenticateCloudAdmin) and a short action descriptor. Recording must never
// break the action itself: stores without the surface (older deployments where
// the admin_audit_log migration hasn't run yet) and transient write failures
// are swallowed.

function truncate(value, max = 200) {
    const text = String(value ?? '');
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Keep detail payloads small and JSON-safe: shallow-copy plain objects, drop
// undefined, stringify-truncate anything that isn't a primitive.
function sanitizeDetail(detail) {
    if (detail === null || detail === undefined) return {};
    if (typeof detail !== 'object' || Array.isArray(detail)) return { value: truncate(detail) };
    const output = {};
    for (const [key, value] of Object.entries(detail)) {
        if (value === undefined) continue;
        if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
            output[key] = typeof value === 'string' ? truncate(value) : value;
        } else {
            try {
                output[key] = truncate(JSON.stringify(value), 400);
            } catch {
                output[key] = '[unserializable]';
            }
        }
    }
    return output;
}

/**
 * Record one audit entry. `actor` is the object returned by
 * authenticateCloudAdmin ({ type, adminUser }). Returns the stored row or null
 * when auditing is unavailable — callers never need to check.
 */
export async function recordAdminAudit({
    store,
    actor = null,
    action,
    targetType = null,
    targetId = null,
    detail = null,
    now = () => new Date(),
}) {
    if (!store || typeof store.recordAuditLogEntry !== 'function' || !action) return null;
    try {
        return await store.recordAuditLogEntry({
            actor_email: actor?.adminUser?.email || 'unknown',
            actor_role: actor?.adminUser?.role || null,
            auth_type: actor?.type || null,
            action: String(action),
            target_type: targetType ? String(targetType) : null,
            target_id: targetId ? String(targetId) : null,
            detail: sanitizeDetail(detail),
            created_at: now().toISOString(),
        });
    } catch {
        return null; // auditing is best-effort by design
    }
}
