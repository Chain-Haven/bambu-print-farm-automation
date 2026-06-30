// src/api/router.js — Main Express router
import { Router } from 'express';
import { login, requireAuth } from '../auth/auth.js';
import { getSupervisor } from '../runtime/RuntimeSupervisor.js';
import printerRoutes from './routes/printers.js';
import accessoryRoutes from './routes/accessories.js';
import commandRoutes from './routes/commands.js';
import jobRoutes from './routes/jobs.js';
import jobTemplateRoutes from './routes/jobTemplates.js';
import gcodeRoutes from './routes/gcode.js';
import sliceRoutes from './routes/slice.js';
import eventRoutes from './routes/events.js';
import systemRoutes from './routes/system.js';

const router = Router();

// Auth
router.post('/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    const result = login(username, password);
    if (!result) return res.status(401).json({ error: 'Invalid credentials' });
    res.json(result);
});

router.get('/auth/me', requireAuth, (req, res) => {
    res.json(req.user);
});

// System
router.use('/system', systemRoutes);

router.get('/system/status', requireAuth, (req, res) => {
    const supervisor = getSupervisor();
    res.json(supervisor.getStatus());
});

// Resource routes
router.use('/printers', printerRoutes);
router.use('/accessories', accessoryRoutes);
router.use('/commands', commandRoutes);
router.use('/jobs', jobRoutes);
router.use('/job-templates', jobTemplateRoutes);
router.use('/gcode', gcodeRoutes);
router.use('/slic