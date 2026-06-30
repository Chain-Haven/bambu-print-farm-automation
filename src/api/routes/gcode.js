// src/api/routes/gcode.js — G-code transform standalone endpoint
import { Router } from 'express';
import { transformGcode } from '../../gcode/GcodeTransformer.js';
import { GcodeProfileModel } from '../../models/GcodeProfile.js';
import { requireAuth } from '../../auth/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();

// Transform G-code (standalone API)
router.post('/transform', requireAuth, asyncHandler(async (req, res) => {
    const { profile_id, profile_name, filename, content_base64 } = req.body;

    if (!content_base64) {
        return res.status(400).json({ error: 'content_base64 is required' });
    }

    // Resolve profile
    let profile;
    if (profile_id) profile = GcodeProfileModel.findById(profile_id);
    if (!profile && profile_name) profile = GcodeProfileModel.findByName(profile_name);
    if (!profile) profile = GcodeProfileModel.findByName('universal');
    if (!profile) return res.status(400).json({ error: 'No profile found' });

    const content = Buffer.from(content_base64, 'base64').toString('utf-8');
    const result = transformGcode(content, profile, { filename: filename || 'input.gcode', job_id: 'standalone' });

    res.json({
        output_filename: result.outputFilename,
        output_content_base64: Buffer.from(result.output).toString('base64'),
        report: result.report,
        diff_summary: result.diffSummary,
    });
}));

// List profiles
router.get('/profiles', requireAuth, asyncHandler(async (req, res) => {
    res.json(GcodeProfileModel.findAll());
}));

// Get single profile
router.get('/profiles/:id', requireAuth, asyncHandler(async (req, res) => {
    const profile = GcodeProfileModel.findById(req.params.id);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    res.json(profile);
}));

// Create profile
router.post('/profiles', requireAuth, asyncHandler(async (req, res) => {
    const profile = GcodeProfileModel.create(req.body);
    res.status(201).json(profile);
}));

// Update profile
router.patch('/profiles/:id', requireAuth, asyncHandler(async (req, res) => {
    const profile = GcodeProfileModel.update(req.params.id, req.body);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    res.json(profile);
}));

// Delete profile
router.delete('/profiles/:id', requireAuth, asyncHandler(async (req, res) => {
    const profile = GcodeProfileModel.findById(req.params.id);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    if (profile.is_system) {
        return res.status(403).json({ error: 'Cannot delete system profile' });
    }
    GcodeProfileModel.delete(req.params.id);
    res.json({ deleted: true });
}));

export default router;
