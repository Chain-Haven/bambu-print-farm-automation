// src/api/routes/filament.js — filament spool inventory + consumption endpoints.
import { Router } from 'express';
import { FilamentSpoolModel } from '../../models/FilamentSpool.js';
import { EventLog } from '../../services/EventLog.js';
import { requireAuth } from '../../auth/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();

// List spools (?low_stock=1 to filter, ?archived=1 to include archived).
router.get('/spools', requireAuth, asyncHandler(async (req, res) => {
    res.json(FilamentSpoolModel.findAll({
        lowStockOnly: req.query.low_stock === '1' || req.query.low_stock === 'true',
        includeArchived: req.query.archived === '1' || req.query.archived === 'true',
    }));
}));

// Low-stock spools (spools at/below their threshold).
router.get('/low-stock', requireAuth, asyncHandler(async (req, res) => {
    res.json(FilamentSpoolModel.findAll({ lowStockOnly: true }));
}));

router.post('/spools', requireAuth, asyncHandler(async (req, res) => {
    const spool = FilamentSpoolModel.create(req.body || {});
    res.status(201).json(spool);
}));

router.get('/spools/:id', requireAuth, asyncHandler(async (req, res) => {
    const spool = FilamentSpoolModel.findById(req.params.id);
    if (!spool) return res.status(404).json({ error: 'spool not found' });
    res.json(spool);
}));

router.patch('/spools/:id', requireAuth, asyncHandler(async (req, res) => {
    if (!FilamentSpoolModel.findById(req.params.id)) return res.status(404).json({ error: 'spool not found' });
    res.json(FilamentSpoolModel.update(req.params.id, req.body || {}));
}));

// Refill: reset remaining to full (or a provided amount).
router.post('/spools/:id/refill', requireAuth, asyncHandler(async (req, res) => {
    const spool = FilamentSpoolModel.findById(req.params.id);
    if (!spool) return res.status(404).json({ error: 'spool not found' });
    const remaining = req.body?.grams != null ? Number(req.body.grams) : spool.total_grams;
    res.json(FilamentSpoolModel.update(req.params.id, { remaining_grams: remaining }));
}));

router.delete('/spools/:id', requireAuth, asyncHandler(async (req, res) => {
    FilamentSpoolModel.remove(req.params.id);
    res.status(204).end();
}));

// Ledger for a spool.
router.get('/spools/:id/consumption', requireAuth, asyncHandler(async (req, res) => {
    if (!FilamentSpoolModel.findById(req.params.id)) return res.status(404).json({ error: 'spool not found' });
    res.json(FilamentSpoolModel.ledger(req.params.id, { limit: req.query.limit }));
}));

// Record consumption against a spool. Emits a low-stock event on threshold crossing.
router.post('/spools/:id/consume', requireAuth, asyncHandler(async (req, res) => {
    if (!FilamentSpoolModel.findById(req.params.id)) return res.status(404).json({ error: 'spool not found' });
    const grams = Number(req.body?.grams);
    if (!Number.isFinite(grams) || grams <= 0) {
        return res.status(400).json({ error: 'grams must be a positive number' });
    }
    const result = FilamentSpoolModel.consume(req.params.id, grams, {
        jobId: req.body?.job_id || null,
        note: req.body?.note || null,
    });
    if (result.crossedLowThreshold || result.depleted) {
        EventLog.record('system', req.params.id, 'filament.low_stock', {
            spool_id: req.params.id,
            material: result.spool.material,
            color_name: result.spool.color_name,
            remaining_grams: result.spool.remaining_grams,
            low_threshold_grams: result.spool.low_threshold_grams,
            depleted: result.depleted,
        });
    }
    res.json(result);
}));

export default router;
