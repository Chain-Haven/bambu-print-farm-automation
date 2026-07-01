// src/api/routes/notifications.js — notification channel management.
import { Router } from 'express';
import { NotificationChannelModel } from '../../models/NotificationChannel.js';
import { createNotificationDispatcher } from '../../services/NotificationService.js';
import { requireAuth } from '../../auth/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();
const dispatcher = createNotificationDispatcher();

router.get('/channels', requireAuth, asyncHandler(async (req, res) => {
    res.json(NotificationChannelModel.findAll());
}));

router.post('/channels', requireAuth, asyncHandler(async (req, res) => {
    try {
        res.status(201).json(NotificationChannelModel.create(req.body || {}));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
}));

router.get('/channels/:id', requireAuth, asyncHandler(async (req, res) => {
    const channel = NotificationChannelModel.findById(req.params.id);
    if (!channel) return res.status(404).json({ error: 'channel not found' });
    res.json(channel);
}));

router.patch('/channels/:id', requireAuth, asyncHandler(async (req, res) => {
    if (!NotificationChannelModel.findById(req.params.id)) return res.status(404).json({ error: 'channel not found' });
    try {
        res.json(NotificationChannelModel.update(req.params.id, req.body || {}));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
}));

router.delete('/channels/:id', requireAuth, asyncHandler(async (req, res) => {
    NotificationChannelModel.remove(req.params.id);
    res.status(204).end();
}));

// Send a test message to a single channel.
router.post('/channels/:id/test', requireAuth, asyncHandler(async (req, res) => {
    const channel = NotificationChannelModel.findById(req.params.id);
    if (!channel) return res.status(404).json({ error: 'channel not found' });
    const result = await dispatcher.deliverOne(channel, {
        event: 'test',
        title: 'PrintKinetix test notification',
        message: 'If you can read this, the channel is wired up correctly.',
        severity: 'info',
    });
    res.json(result);
}));

export default router;
