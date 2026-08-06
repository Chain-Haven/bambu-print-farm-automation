import crypto from 'crypto';

function timingSafeBearer(header, secret) {
    const expected = `Bearer ${secret}`;
    const a = Buffer.from(header || '');
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

function resolveSecret() {
    return (
        process.env.OVERSIGHT_SERVICE_TOKEN?.trim() ||
        process.env.BAMBU_SERVICE_TOKEN?.trim() ||
        process.env.CLOUD_ADMIN_TOKEN?.trim() ||
        ''
    );
}

function authorize(req, res) {
    const secret = resolveSecret();
    if (!secret) {
        if (process.env.NODE_ENV === 'production' || process.env.VERCEL) {
            res.status(503).json({ ok: false, error: 'Oversight service token not configured' });
            return false;
        }
        if (req.headers['x-oversight-hub'] !== '1') {
            res.status(401).json({ ok: false, error: 'Dev hub requires X-Oversight-Hub: 1' });
            return false;
        }
        return true;
    }
    if (!timingSafeBearer(req.headers.authorization, secret)) {
        res.status(401).json({ ok: false, error: 'Unauthorized' });
        return false;
    }
    return true;
}

/**
 * Oversight Hub summary for PrintKinetix / Bambu farm cloud.
 * GET /api/admin/oversight/summary
 */
export default async function handler(req, res) {
    if (req.method && req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    }
    if (!authorize(req, res)) return;

    // Lightweight stub counts — live farm metrics stay on /api/cloud/overview.
    // When CLOUD store is wired later, replace with getCloudOverview aggregates.
    const failedJobs = 0;
    const readyToShip = 0;
    const filamentApprovals = 0;

    const counts = { failedJobs, readyToShip, filamentApprovals };
    const queues = [];
    if (failedJobs > 0) {
        queues.push({
            id: 'bambu-failed',
            kind: 'print_farm',
            title: `${failedJobs} print jobs failed`,
            priority: 1,
            href: '/cloud',
        });
    }
    if (filamentApprovals > 0) {
        queues.push({
            id: 'bambu-filament',
            kind: 'print_qa',
            title: `${filamentApprovals} filament approvals pending`,
            priority: 2,
            href: '/cloud',
        });
    }
    if (readyToShip > 0) {
        queues.push({
            id: 'bambu-ship',
            kind: 'ship_order',
            title: `${readyToShip} kits ready to ship`,
            priority: 2,
            href: '/cloud',
        });
    }

    return res.status(200).json({
        propertyId: 'bambu',
        generatedAt: new Date().toISOString(),
        counts,
        queues,
        health: { cronsFailing: 0, integrationsDown: [] },
    });
}
