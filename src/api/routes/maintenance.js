// src/api/routes/maintenance.js — printer maintenance reminders + odometer.
import { Router } from 'express';
import { PrinterMaintenanceModel } from '../../models/PrinterMaintenance.js';
import { requireAuth } from '../../auth/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();

// List maintenance tasks (?printer_id= to scope, ?due=1 for overdue only).
router.get('/', requireAuth, asyncHandler(async (req, res) => {
    res.json(PrinterMaintenanceModel.findAll({
        printerId: req.query.printer_id || null,
        dueOnly: req.query.due === '1' || req.query.due === 'true',
    }));
}));

// Overdue tasks across the fleet.
router.get('/due', requireAuth, asyncHandler(async (req, res) => {
    res.json(PrinterMaintenanceModel.findAll({ dueOnly: true }));
}));

// Current odometer (cumulative completed print hours) for a printer.
router.get('/odometer/:printer_id', requireAuth, asyncHandler(async (req, res) => {
    res.json({ printer_id: req.params.printer_id, odometer_hours: PrinterMaintenanceModel.odometerHours(req.params.printer_id) });
}));

router.post('/', requireAuth, asyncHandler(async (req, res) => {
    try {
        res.status(201).json(PrinterMaintenanceModel.create(req.body || {}));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
}));

router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
    const task = PrinterMaintenanceModel.findById(req.params.id);
    if (!task) return res.status(404).json({ error: 'maintenance task not found' });
    res.json(task);
}));

router.patch('/:id', requireAuth, asyncHandler(async (req, res) => {
    if (!PrinterMaintenanceModel.findById(req.params.id)) return res.status(404).json({ error: 'maintenance task not found' });
    res.json(PrinterMaintenanceModel.update(req.params.id, req.body || {}));
}));

// Mark a task done — resets its odometer baseline.
router.post('/:id/done', requireAuth, asyncHandler(async (req, res) => {
    const task = PrinterMaintenanceModel.markDone(req.params.id);
    if (!task) return res.status(404).json({ error: 'maintenance task not found' });
    res.json(task);
}));

router.delete('/:id', requireAuth, asyncHandler(async (req, res) => {
    PrinterMaintenanceModel.remove(req.params.id);
    res.status(204).end();
}));

export default router;
