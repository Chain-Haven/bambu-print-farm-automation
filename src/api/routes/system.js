
import { Router } from 'express';
import TunnelService from '../../services/TunnelService.js';
import { requireAuth } from '../../auth/auth.js';

const router = Router();

router.get('/tunnel/status', requireAuth, (req, res) => {
    res.json(TunnelService.getStatus());
});

router.post('/tunnel/start', requireAuth, async (req, res) => {
    try {
        const status = await TunnelService.start();
        res.json(status);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/tunnel/stop', requireAuth, (req, res) => {
    const status = TunnelService.stop();
    res.json(status);
});

export default router;
