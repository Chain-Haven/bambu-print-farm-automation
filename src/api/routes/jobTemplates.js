// src/api/routes/jobTemplates.js — Job Template CRUD endpoints (with file upload)
import { Router } from 'express';
import { JobTemplateModel } from '../../models/JobTemplate.js';
import { requireAuth } from '../../auth/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';

const router = Router();
const TEMPLATES_DIR = path.resolve(process.env.UPLOADS_DIR || './uploads', 'templates');
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

// Submit job directly from template (uses stored file)
router.post('/:id/submit', requireAuth, asyncHandler(async (req, res) => {
    const tmpl = JobTemplateModel.findById(req.params.id);
    if (!tmpl) return res.status(404).json({ error: 'Template not found' });
    if (!tmpl.source_file_path || !fs.existsSync(tmpl.source_file_path)) {
        return res.status(400).json({ error: 'Template has no stored file — upload a G-code file first' });
    }

    // Read the stored file as binary buffer (might be 3MF/ZIP)
    const rawBuffer = fs.readFileSync(tmpl.source_file_path);
    let fileContent;
    let fileName = tmpl.source_file_name;

    // Track if input is 3MF — MUST pass raw buffer for repacking
    let rawBuffer3mf = null;
    let originalFileName3mf = null;

    // Check if it's a 3MF file
    const { isZipFile, is3mfFilename, extractGcodeFrom3mf } = await import('../../gcode/Extract3mf.js');
    if (isZipFile(rawBuffer) || is3mfFilename(fileName)) {
        rawBuffer3mf = rawBuffer;
        originalFileName3mf = tmpl.source_file_name;
        const extracted = await extractGcodeFrom3mf(rawBuffer, fileName);
        fileContent = extracted.content;
        if (extracted.entryName) {
            fileName = extracted.entryName.split('/').pop() || fileName;
        }
    } else {
        fileContent = rawBuffer.toString('utf-8');
    }

    // Allow overrides from request body
    const { name, printer_id, profile_id, repeat_total, transform_overrides: bodyOverrides } = req.body;

    // Merge: request body overrides take precedence over template defaults
    const templateOverrides = tmpl.transform_overrides || {};
    const runtimeOverrides = typeof bodyOverrides === 'string' ? JSON.parse(bodyOverrides) : (bodyOverrides || {});
    const overrides = { ...templateOverrides, ...runtimeOverrides };

    // Handle skip_transform flag
    const skipTransform = overrides.skip_transform || req.body.skip_transform;

    // Import and use JobOrchestrator to submit
    const { JobOrchestrator } = await import('../../services/JobOrchestrator.js');
    const job = await JobOrchestrator.submit({
        name: name || tmpl.name,
        printer_id: printer_id || tmpl.printer_id || null,
        profile_id: profile_id || tmpl.profile_id || null,
        repeat_total: parseInt(repeat_total) || tmpl.repeat_total || 1,
        ams_roles: tmpl.ams_roles || null,
        fileContent,
        fileName,
        skip_transform: skipTransform ? true : false,
        transform_overrides: overrides,
        rawBuffer3mf,
        originalFileName3mf,
    });

    // Record template usage
    JobTemplateModel.recordUse(tmpl.template_id);

    res.status(201).json(job);
}));

export default router;
