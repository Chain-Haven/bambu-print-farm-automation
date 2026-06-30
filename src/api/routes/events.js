// src/api/routes/events.js — Event/Timeline endpoints
import { Router } from 'express';
import { EventLog } from '../../services/EventLog.js';
import { requireAuth } from '../../auth/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();

// Get all events (filterable)
router.get('/', requireAuth, asyncHandler(async (req, res) => {
    const { entity_type, event_type, limit, offset } = req.query;
    res.json(EventLog.getAll({
        entity_type, event_type,
        limit: parseInt(limit) || 100,
        offset: parseInt(offset) || 0,
    }));
}));

// Get events for a specific entity
router.get('/:entity_type/:entity_id', requireAuth, asyncHandler(async (req, res) => {
    const { limit, offset } = req.query;
    res.json(EventLog.getByEntity(req.params.entity_type, req.params.entity_id, {
        limit: parseInt(limit) || 50,
        offset: parseInt(offset) || 0,
    }));
}));

export default router;
