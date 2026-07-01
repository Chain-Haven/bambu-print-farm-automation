// src/api/routes/analytics.js — fleet print-history analytics endpoints.
import { Router } from 'express';
import { AnalyticsService } from '../../services/AnalyticsService.js';
import { requireAuth } from '../../auth/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();

// Fleet-wide summary: counts, success rate, print-time totals.
router.get('/summary', requireAuth, asyncHandler(async (req, res) => {
    res.json(AnalyticsService.getSummary({ since: req.query.since || null }));
}));

// Per-printer breakdown.
router.get('/printers', requireAuth, asyncHandler(async (req, res) => {
    res.json(AnalyticsService.getPerPrinter({ since: req.query.since || null }));
}));

// Recent failed runs.
router.get('/failures', requireAuth, asyncHandler(async (req, res) => {
    res.json(AnalyticsService.getRecentFailures({ limit: req.query.limit }));
}));

// Completed/failed counts per day for an activity chart.
router.get('/activity', requireAuth, asyncHandler(async (req, res) => {
    res.json(AnalyticsService.getActivityByDay({ days: req.query.days }));
}));

export default router;
