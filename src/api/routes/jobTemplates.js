// src/api/routes/jobTemplates.js — Job Template CRUD endpoints (with file upload)
import { Router } from 'express';
import { JobTemplateModel } from '../../models/JobTemplate.js';
import { JobModel } from '../../models/Job.js';
import { repack3mf, buildGcode3mf } from '../../gcode/AutomatorZip.js';
import { requireAuth } from '../../auth/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { getUploadRoot, getUploadPath } from '../../utils/uploadPaths.js';

const router = Router();
// Vercel-aware paths (this repo runs the API serverless too).
const UPLOADS_DIR = getUploadRoot();
const TEMPLATES_DIR = getUploadPath('templates');
const AG_MARKER = ';===== ANTIGRAVITY AUTOMATION START =====';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } }); // 200MB

// Ensure templates directory exists
if (!fs.existsSync(TEMPLATES_DIR)) fs.mkdirSync(TEMPLATES_DIR, { recursive: true });

// List all templates
router.get('/', requireAuth, asyncHandler(async (req, res) => {
    const templates = JobTemplateModel.findAll();
    res.json(templates);
}));

// Get single template
router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
    const tmpl = JobTemplateModel.findById(req.params.id);
    if (!tmpl) return res.status(404).json({ error: 'Template not found' });
    res.json(tmpl);
}));

// Create template (with optional file upload)
router.post('/', requireAuth, upload.single('file'), asyncHandler(async (req, res) => {
    const { name, description, profile_id, printer_id, repeat_total, tags, ams_roles, transform_overrides } = req.body;
    const parsedTags = typeof tags === 'string' ? (tags.includes('[') ? JSON.parse(tags) : tags.split(',').map(t => t.trim()).filter(Boolean)) : tags;
    const parsedOverrides = typeof transform_overrides === 'string' ? JSON.parse(transform_overrides) : transform_overrides;

    let source_file_name = null;
    let source_file_path = null;

    // Handle file upload
    if (req.file) {
        source_file_name = req.file.originalname;
        // We'll save the file with a unique prefix to avoid collisions
        const tmpl = JobTemplateModel.create({
            name, description,
            profile_id: profile_id || null,
            printer_id: printer_id || null,
            source_file_name,
            source_file_path: null, // will set after we have the template_id
            ams_roles: ams_roles ? (typeof ams_roles === 'string' ? JSON.parse(ams_roles) : ams_roles) : null,
            repeat_total: parseInt(repeat_total) || 1,
            tags: parsedTags || [],
            transform_overrides: parsedOverrides || {},
        });

        // Save file with template_id prefix
        source_file_path = path.join(TEMPLATES_DIR, `${tmpl.template_id}_${source_file_name}`);
        fs.writeFileSync(source_file_path, req.file.buffer);

        // Update the template record with file path
        const updated = JobTemplateModel.update(tmpl.template_id, { source_file_name, source_file_path });
        return res.status(201).json(updated);
    }

    // No file — just save the config
    const tmpl = JobTemplateModel.create({
        name, description,
        profile_id: profile_id || null,
        printer_id: printer_id || null,
        source_file_name: null,
        source_file_path: null,
        ams_roles: ams_roles ? (typeof ams_roles === 'string' ? JSON.parse(ams_roles) : ams_roles) : null,
        repeat_total: parseInt(repeat_total) || 1,
        tags: parsedTags || [],
        transform_overrides: parsedOverrides || {},
    });
    res.status(201).json(tmpl);
}));

// Update template (with optional file replacement)
router.patch('/:id', requireAuth, upload.single('file'), asyncHandler(async (req, res) => {
    const existing = JobTemplateModel.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Template not found' });

    const updates = { ...req.body };
    if (updates.tags && typeof updates.tags === 'string') {
        updates.tags = updates.tags.includes('[') ? JSON.parse(updates.tags) : updates.tags.split(',').map(t => t.trim()).filter(Boolean);
    }
    if (updates.ams_roles && typeof updates.ams_roles === 'string') {
        updates.ams_roles = JSON.parse(updates.ams_roles);
    }

    // Handle file replacement
    if (req.file) {
        // Remove old file if exists
        if (existing.source_file_path && fs.existsSync(existing.source_file_path)) {
            fs.unlinkSync(existing.source_file_path);
        }
        updates.source_file_name = req.file.originalname;
        updates.source_file_path = path.join(TEMPLATES_DIR, `${req.params.id}_${req.file.originalname}`);
        fs.writeFileSync(updates.source_file_path, req.file.buffer);
    }

    const tmpl = JobTemplateModel.update(req.params.id, updates);
    res.json(tmpl);
}));

// Delete template (also deletes stored file)
router.delete('/:id', requireAuth, asyncHandler(async (req, res) => {
    const existing = JobTemplateModel.findById(req.params.id);
    if (existing?.source_file_path && fs.existsSync(existing.source_file_path)) {
        fs.unlinkSync(existing.source_file_path);
    }
    JobTemplateModel.delete(req.params.id);
    res.json({ deleted: true });
}));

// Download template file
router.get('/:id/file', requireAuth, asyncHandler(async (req, res) => {
    const tmpl = JobTemplateModel.findById(req.params.id);
    if (!tmpl) return res.status(404).json({ error: 'Template not found' });
    if (!tmpl.source_file_path || !fs.existsSync(tmpl.source_file_path)) {
        return res.status(404).json({ error: 'No file stored for this template' });
    }
    res.download(tmpl.source_file_path, tmpl.source_file_name);
}));

// Create a template FROM an existing job. Copies the job's ORIGINAL
// (pre-transform) print file into the template so it is immediately
// submittable — a template without a file cannot be sent to the queue.
router.post('/from-job/:jobId', requireAuth, asyncHandler(async (req, res) => {
    const job = JobModel.findById(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const sourcePath = job.source_file_name ? path.join(UPLOADS_DIR, `${job.job_id}_${job.source_file_name}`) : null;
    if (!sourcePath || !fs.existsSync(sourcePath)) {
        return res.status(410).json({
            error: `The original file for job "${job.name}" is no longer on disk — cannot save a submittable template. Re-slice the model, or create a template manually with a file upload.`,
        });
    }
    const originalGcode = fs.readFileSync(sourcePath, 'utf-8');

    // Recover the original .gcode.3mf. The pre-transform package is never kept
    // on disk, but the transformed one is — swapping the untransformed gcode
    // back into it reproduces the original (thumbnails/slice metadata intact).
    // Plain-gcode jobs get a minimal printer-shaped wrapper instead; a bare
    // .gcode can never start (startJob requires a .gcode.3mf artifact).
    const entryName = job.transform_report?.gcode_entry_name || null;
    const transformedPath = job.transformed_file_name ? path.join(UPLOADS_DIR, `${job.job_id}_${job.transformed_file_name}`) : null;
    let fileBuffer, source_file_name;
    if (entryName && transformedPath && /\.3mf$/i.test(transformedPath) && fs.existsSync(transformedPath)) {
        fileBuffer = repack3mf(fs.readFileSync(transformedPath), entryName, originalGcode);
        source_file_name = job.transformed_file_name.replace(/\.AG\.gcode\.3mf$/i, '.gcode.3mf');
    } else {
        fileBuffer = buildGcode3mf([{ index: 1, gcode: originalGcode }]);
        source_file_name = job.source_file_name.replace(/\.gcode$/i, '') + '.gcode.3mf';
    }

    // Carry over the settings the job ACTUALLY ran with (from the transform
    // report), so re-submitting the template reproduces the same ejection.
    const r = job.transform_report;
    let transform_overrides = {};
    if (originalGcode.includes(AG_MARKER) || r?.skipped) {
        // Source already contains ejection gcode — transforming again would
        // double the cooldown/eject blocks.
        transform_overrides.skip_transform = true;
    } else if (r) {
        // printer_model is deliberately NOT copied: the source job's report
        // can carry a wrong/stale model (a P1S-configured job that ran on an
        // A1 gave the A1 P1S eject coordinates AND compounded the filament-
        // cutter drift). Leaving it unset lets submit resolve the model from
        // the ACTUAL assigned printer every time.
        transform_overrides = {
            n_loops: r.loopsN,
            cooldown_mode: r.cooldownMode,
            release_temp_c: r.releaseTempC,
            sweep_z_mm: r.sweepZMm,
            z_clear_travel_mm: r.zClearClamped,
        };
        if (r.cooldownMode === 'time') transform_overrides.cool_time_min = r.coolTimeMin;
        else if (r.m190RepeatCount) transform_overrides.max_wait_min = Math.round(r.m190RepeatCount * 1.5); // each M190 line covers ~90s
        for (const k of Object.keys(transform_overrides)) {
            if (transform_overrides[k] === undefined || transform_overrides[k] === null) delete transform_overrides[k];
        }
    }

    const tmpl = JobTemplateModel.create({
        name: req.body.name || `${job.name} (template)`,
        description: req.body.description || `Saved from job ${job.job_id.slice(0, 8)}`,
        profile_id: job.profile_id || null,
        printer_id: job.printer_id || null,
        source_file_name,
        source_file_path: null,
        ams_roles: job.ams_roles || null,
        repeat_total: job.repeat_total || 1,
        tags: [],
        transform_overrides,
    });
    const source_file_path = path.join(TEMPLATES_DIR, `${tmpl.template_id}_${source_file_name}`);
    fs.writeFileSync(source_file_path, fileBuffer);
    const updated = JobTemplateModel.update(tmpl.template_id, { source_file_name, source_file_path });
    res.status(201).json(updated);
}));

// Submit job directly from template (uses stored file). The heavy lifting
// (file read, 3MF extract, override merge, submit) lives in the shared
// JobOrchestrator.submitFromJobTemplate() — order intake uses the same path.
router.post('/:id/submit', requireAuth, asyncHandler(async (req, res) => {
    const { name, printer_id, profile_id, repeat_total, transform_overrides: bodyOverrides, ams_roles: bodyAmsRoles } = req.body;

    // Spool selection override — the UI prompts for trays BEFORE submitting,
    // because a template with a printer assigned auto-starts immediately and
    // would otherwise always print with the template's SAVED mapping.
    const amsRoles = bodyAmsRoles !== undefined
        ? (typeof bodyAmsRoles === 'string' ? JSON.parse(bodyAmsRoles) : bodyAmsRoles)
        : undefined; // undefined = keep template default
    const runtimeOverrides = typeof bodyOverrides === 'string' ? JSON.parse(bodyOverrides) : (bodyOverrides || {});

    const { JobOrchestrator } = await import('../../services/JobOrchestrator.js');
    const job = await JobOrchestrator.submitFromJobTemplate(req.params.id, {
        name,
        printer_id: printer_id || undefined,
        profile_id,
        repeat_total,
        ams_roles: amsRoles,
        transform_overrides: runtimeOverrides,
        skip_transform: req.body.skip_transform,
    });

    res.status(201).json(job);
}));

export default router;
