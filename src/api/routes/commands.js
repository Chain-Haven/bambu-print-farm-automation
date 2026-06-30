// src/api/routes/commands.js — Command Bus endpoints
import { Router } from 'express';
import { CommandBus } from '../../services/CommandBus.js';
import { requireAuth } from '../../auth/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();

// Enqueue command
router.post('/', requireAuth, asyncHandler(async (req, res) => {
    const { target_type, target_id, action, params, idempotency_key, timeout_seconds, max_retries } = req.body;
    if (!target_type || !target_id || !action) {
        return res.status(400).json({ error: 'target_type, target_id, and action are required' });
    }
    const cmd = CommandBus.enqueue({
        target_type, target_id, action, params,
        requested_by: req.user?.username || 'api',
        idempotency_key, timeout_seconds, max_retries,
    });
    res.status(201).json(cmd);
}));

// Get commands with filters
router.get('/', requireAuth, asyncHandler(async (req, res) => {
    const { target_type, target_id, status, limit, offset } = req.query;
    let commands;
    if (target_type && target_id) {
        commands = CommandBus.getTimeline(target_type, target_id, { status, limit: parseInt(limit) || 50, offset: parseInt(offset) || 0 });
    } else {
        commands = CommandBus.findAll({ status, limit: parseInt(limit) || 50, offset: parseInt(offset) || 0 });
    }
    res.json(commands);
}));

// Get single command
router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
    const cmd = CommandBus.findById(req.params.id);
    if (!cmd) return res.status(404).json({ error: 'Command not found' });
    res.json(cmd);
}));

// Cancel command
router.post('/:id/cancel', requireAuth, asyncHandler(async (req, res) => {
    const cmd = CommandBus.cancel(req.params.id);
    if (!cmd) return res.status(404).json({ error: 'Command not found' });
    res.json(cmd);
}));

export default router;
