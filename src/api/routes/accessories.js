// src/api/routes/accessories.js — Accessory CRUD + driver operations
import { Router } from 'express';
import { AccessoryRegistry } from '../../services/AccessoryRegistry.js';
import { requireAuth, requireAdmin } from '../../auth/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();

router.get('/', requireAuth, asyncHandler(async (req, res) => {
    res.json(AccessoryRegistry.findAll());
}));

router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
    const acc = AccessoryRegistry.findById(req.params.id);
    if (!acc) return res.status(404).json({ error: 'Accessory not found' });
    // Attach driver capabilities + state
    const driver = AccessoryRegistry.getDriver(req.params.id);
    res.json({
        ...acc,
        live_state: driver ? driver.getState() : null,
        live_capabilities: driver ? driver.getCapabilities() : null,
    });
}));

router.post('/', requireAdmin, asyncHandler(async (req, res) => {
    const { type, printer_id, connection_type, endpoint, capabilities, calibration } = req.body;
    if (!type || !connection_type || !endpoint) {
        return res.status(400).json({ error: 'type, connection_type, and endpoint are required' });
    }
    const acc = AccessoryRegistry.create({ type, printer_id, connection_type, endpoint, capabilities, calibration });
    res.status(201).json(acc);
}));

router.patch('/:id', requireAdmin, asyncHandler(async (req, res) => {
    const acc = AccessoryRegistry.update(req.params.id, req.body);
    if (!acc) return res.status(404).json({ error: 'Accessory not found' });
    res.json(acc);
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
    const acc = await AccessoryRegistry.delete(req.params.id);
    if (!acc) return res.status(404).json({ error: 'Accessory not found' });
    res.json({ deleted: true });
}));

router.post('/:id/test-connection', requireAuth, asyncHandler(async (req, res) => {
    const result = await AccessoryRegistry.testConnection(req.params.id);
    res.json(result);
}));

router.post('/:id/calibrate', requireAdmin, asyncHandler(async (req, res) => {
    const result = await AccessoryRegistry.executeAction(req.params.id, `${req.body.type || 'accessory'}.calibrate`, req.body);
    res.json(result);
}));

router.post('/:id/execute', requireAuth, asyncHandler(async (req, res) => {
    const { action, params } = req.body;
    if (!action) return res.status(400).json({ error: 'action is required' });
    const result = await AccessoryRegistry.executeAction(req.params.id, action, params || {});
    res.json(result);
}));

export default router;
