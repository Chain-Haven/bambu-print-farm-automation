// src/api/routes/slice.js — In-browser slicer endpoints.
//
// The browser slicer UI talks to these. The actual compute is pluggable behind
// SliceService (see SLICER_REVIEW.md). On a successful slice the resulting
// `.gcode.3mf` is handed to the SAME JobOrchestrator.submit() pipeline that
// already does looping + cool-release ejection — the slicer is purely additive.

import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../../auth/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { SliceService, SLICER_SETTING_FIELDS } from '../../services/SliceService.js';
import { GcodeProfileModel } from '../../models/GcodeProfile.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

// Which compute backends exist and which are currently usable.
router.get('/backends', requireAuth, asyncHandler(async (req, res) => {
    res.json({
        backends: SliceService.getBackends(),
        active: SliceService.getActiveBackend(),
        supported_formats: SliceService.SUPPORTED_INPUT_FORMATS,
        setting_fields: SLICER_SETTING_FIELDS,
    });
}));

// Slice a model into a `.gcode.3mf`.
//   multipart: file=<model>, profile_id?, options?(JSON), backend?
router.post('/', requireAuth, upload.single('file'), asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No model file uploaded (field "file")' });

    if (!SliceService.isSupportedInput(req.file.originalname)) {
        return res.status(415).json({
            error: `Unsupported model format. Accepts: ${SliceService.SUPPORTED_INPUT_FORMATS.join(', ')}`,
        });
    }

    let options = {};
    if (req.body.options) {
        try { options = JSON.parse(req.body.options); }
        catch { return res.status(400).json({ error: 'options must be valid JSON' }); }
    }

    // Resolve the slicing profile (falls back to none — backend uses its default).
    let profile = null;
    if (req.body.profile_id) {
        profile = GcodeProfileModel.findById(req.body.profile_id);
        if (!profile) return res.status(404).json({ error: 'Profile not found' });
    }

    const result = await SliceService.slice({
        modelBuffer: req.file.buffer,
        modelName: req.file.originalname,
        profile,
        options,
    }, req.body.backend || null);

    if (!result.ok) {
        // 503: contract is valid, but no compute is available/enabled yet.
        const status = result.code === 'no_backend' || result.code === 'not_implemented' ? 503 : 400;
        return res.status(status).json({ error: result.error, code: result.code, report: result.report });
    }

    // Phase 1+: stream the `.gcode.3mf` back (or hand straight to submit()).
    res.json({
        ok: true,
        output_name: result.outputName,
        report: result.report,
        // gcode3mf is returned base64 for now; later this can pipe into submit().
        gcode3mf_base64: result.gcode3mf ? result.gcode3mf.toString('base64') : null,
    });
}));

export default router;
