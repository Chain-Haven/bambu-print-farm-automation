// src/api/routes/slice.js — In-browser slicer endpoints.
//
// The browser slicer UI talks to these. The actual compute is pluggable behind
// SliceService (see SLICER_REVIEW.md). On a successful slice the resulting
// `.gcode.3mf` is handed to the SAME JobOrchestrator.submit() pipeline that
// already does looping + cool-release ejection — the slicer is purely additive.

import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { requireAuth } from '../../auth/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { SliceService, SLICER_SETTING_FIELDS, SLICER_MATERIALS } from '../../services/SliceService.js';
import { COLOR_PALETTE } from '../../services/FilamentCatalog.js';
import { FilamentProfileModel } from '../../models/FilamentProfile.js';
import { TextTemplateService } from '../../services/TextTemplateService.js';
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
        // Print colors = the SAME named catalog used to configure AMS tray
        // colors on the printer page, so auto-map at print start is an exact
        // color match ('Transparent' excluded — not a distinct print color).
        color_palette: COLOR_PALETTE.filter(c => c.name !== 'Transparent')
            .map(c => ({ name: c.name, hex: `#${c.hex.slice(0, 6).toLowerCase()}` })),
        // Materials map to bundled Bambu/Generic filament presets per printer
        // model — the engine's preset carries the material's temps/speeds.
        materials: SLICER_MATERIALS,
        filament_profiles: FilamentProfileModel.findAll(),
    });
}));

// ===== Custom filament profiles (reusable filament-setting bundles) =====
// A profile = name + base material + overrides for target:'filament' fields.
router.get('/filament-profiles', requireAuth, asyncHandler(async (req, res) => {
    res.json({ profiles: FilamentProfileModel.findAll() });
}));

// Upsert by name: saving the same name again updates it.
router.post('/filament-profiles', requireAuth, asyncHandler(async (req, res) => {
    const { name, material, settings } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
    const FIL_KEYS = new Set(SLICER_SETTING_FIELDS.filter(f => f.target === 'filament').map(f => f.key));
    const clean = {};
    for (const [k, v] of Object.entries(settings || {})) {
        if (FIL_KEYS.has(k) && v !== '' && v != null) clean[k] = v;
    }
    const existing = FilamentProfileModel.findByName(String(name).trim());
    const profile = existing
        ? FilamentProfileModel.update(existing.profile_id, { material, settings: clean })
        : FilamentProfileModel.create({ name, material, settings: clean });
    res.json({ ok: true, profile });
}));

router.delete('/filament-profiles/:id', requireAuth, asyncHandler(async (req, res) => {
    FilamentProfileModel.delete(req.params.id);
    res.json({ ok: true });
}));

// Slice a model into a `.gcode.3mf`.
//   multipart, either:
//     file  = single model file (engine may auto-place it), or
//     files = one baked STL per placed object (printer coords) — the layout is
//             assembled into a 3MF and sliced with --arrange 0 (exact placement)
//   plus: profile_id?, options?(JSON), backend?
router.post('/', requireAuth, upload.fields([{ name: 'file', maxCount: 1 }, { name: 'files', maxCount: 64 }]), asyncHandler(async (req, res) => {
    const single = req.files?.file?.[0] || null;
    const placed = req.files?.files || [];
    if (!single && !placed.length) return res.status(400).json({ error: 'No model uploaded (field "file" or "files")' });

    if (single && !SliceService.isSupportedInput(single.originalname)) {
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
        modelBuffer: single?.buffer || null,
        modelBuffers: placed.length ? placed.map(f => ({ name: f.originalname, buffer: f.buffer })) : null,
        modelName: single?.originalname || (placed[0]?.originalname || 'plate.3mf'),
        profile,
        options,
    }, req.body.backend || null);

    if (!result.ok) {
        // 503: contract is valid, but no compute is available/enabled yet.
        const status = result.code === 'no_backend' || result.code === 'not_implemented' ? 503 : 400;
        return res.status(status).json({ error: result.error, code: result.code, report: result.report });
    }

    // Optional: hand the sliced .gcode.3mf straight to the job pipeline
    // (loop/eject transform + queue) — the "Slice & Queue" flow in the UI.
    if (req.body.submit === 'true' || req.body.submit === true) {
        // AMS mapping: {slot_map: {"1": trayIdx, "2": trayIdx, ...}} — logical
        // filament slot -> physical AMS tray. Flows to the MQTT start payload's
        // ams_mapping via the existing job.ams_roles path.
        let amsRoles = null;
        if (req.body.ams_roles) {
            try { amsRoles = JSON.parse(req.body.ams_roles); }
            catch { return res.status(400).json({ error: 'ams_roles must be valid JSON' }); }
        }
        const { JobOrchestrator } = await import('../../services/JobOrchestrator.js');
        // No explicit transform profile → pick the one matching the model this
        // plate was SLICED for, so the job doesn't fall back to 'Universal'
        // (user selects "A1" in the slicer, job showed "Universal" profile).
        let jobProfileId = req.body.profile_id || null;
        if (!jobProfileId && options.printer_model) {
            const DB_NAMES = { A1: ['Bambu A1'], A1_MINI: ['Bambu A1 Mini', 'Bambu A1 mini'], P1S: ['Bambu P1S', 'Bambu P1P'], X1: ['Bambu X1C', 'Bambu X1 Carbon', 'Bambu X1'] };
            const wanted = DB_NAMES[options.printer_model] || [];
            const match = GcodeProfileModel.findAll().find(p => p.printer_model === options.printer_model || wanted.includes(p.printer_model));
            if (match) jobProfileId = match.profile_id;
        }
        const job = await JobOrchestrator.submit({
            name: req.body.job_name || result.outputName.replace(/\.gcode\.3mf$/i, ''),
            printer_id: req.body.printer_id || null,
            profile_id: jobProfileId,
            repeat_total: parseInt(req.body.repeat_total, 10) || 1,
            ams_roles: amsRoles,
            fileContent: result.gcode3mf,
            fileName: result.outputName,
            rawBuffer3mf: result.gcode3mf,
            originalFileName3mf: result.outputName,
            // the model this plate was sliced for — the loop/eject transform
            // must use the SAME model's anchors/coordinates (A1 ≠ P1S)
            transform_overrides: options.printer_model ? { printer_model: options.printer_model } : null,
        });
        return res.json({ ok: true, output_name: result.outputName, report: result.report, job_id: job.job_id, job_name: job.name });
    }

    res.json({
        ok: true,
        output_name: result.outputName,
        report: result.report,
        gcode3mf_base64: result.gcode3mf ? result.gcode3mf.toString('base64') : null,
    });
}));

// ===== Text templates (DIRECTIVE §7: customer-text automation) =====

// Save a template / print job: multipart files[] = baked base STLs (printer
// coords), fields: name, printer_model, profile_id?, text_def? (JSON — omit
// for a textless saved print), settings? (JSON), files_meta? (JSON aligned
// with files: [{name, color, filament}]).
router.post('/templates', requireAuth, upload.fields([{ name: 'files', maxCount: 32 }]), asyncHandler(async (req, res) => {
    const files = req.files?.files || [];
    if (!files.length) return res.status(400).json({ error: 'No base model files (field "files")' });
    let textDef = null, settings = {}, filesMeta = [];
    if (req.body.text_def) { try { textDef = JSON.parse(req.body.text_def); } catch { return res.status(400).json({ error: 'text_def must be valid JSON' }); } }
    if (req.body.settings) { try { settings = JSON.parse(req.body.settings); } catch { return res.status(400).json({ error: 'settings must be valid JSON' }); } }
    if (req.body.files_meta) { try { filesMeta = JSON.parse(req.body.files_meta); } catch { return res.status(400).json({ error: 'files_meta must be valid JSON' }); } }
    try {
        const t = TextTemplateService.create({
            name: req.body.name,
            printer_model: req.body.printer_model || 'P1S',
            profile_id: req.body.profile_id || null,
            baseFiles: files.map((f, i) => ({
                name: f.originalname, buffer: f.buffer,
                color: filesMeta[i]?.color || null,
                filament: filesMeta[i]?.filament || 1,
                insert: !!filesMeta[i]?.insert,
            })),
            textDef, settings,
        });
        res.json({ ok: true, template: { ...t, base_files: undefined } });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
}));

const templateSummary = (t) => ({
    template_id: t.template_id, name: t.name, printer_model: t.printer_model,
    mode: t.text_def?.mode, font: t.text_def?.fontId,
    has_text: !!t.text_def?.fontId && t.text_def?.mode !== 'none',
    objects: (t.base_files || []).length,
    settings: t.settings, created_at: t.created_at, updated_at: t.updated_at,
});

router.get('/templates', requireAuth, asyncHandler(async (req, res) => {
    res.json(TextTemplateService.list().map(templateSummary));
}));

// Full detail (base file meta + text_def) for the saved-print page.
router.get('/templates/:id', requireAuth, asyncHandler(async (req, res) => {
    const t = TextTemplateService.get(req.params.id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    res.json({ ...templateSummary(t), text_def: t.text_def, base_files: (t.base_files || []).map((f, i) => ({ index: i, name: f.name, color: f.color, filament: f.filament })) });
}));

// Serve a stored base STL for the browser preview.
router.get('/templates/:id/files/:index', requireAuth, asyncHandler(async (req, res) => {
    const p = TextTemplateService.filePath(req.params.id, parseInt(req.params.index, 10));
    if (!p || !fs.existsSync(p)) return res.status(404).json({ error: 'File not found' });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.sendFile(path.resolve(p));
}));

// Update name / print settings / text params (size, thickness, maxChars) —
// placement is fixed at save time.
router.patch('/templates/:id', requireAuth, asyncHandler(async (req, res) => {
    const { name, settings, printer_model, text_def } = req.body || {};
    const t = TextTemplateService.update(req.params.id, { name, settings, printer_model, text_def });
    if (!t) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, template: templateSummary(t) });
}));

router.delete('/templates/:id', requireAuth, asyncHandler(async (req, res) => {
    res.json({ ok: TextTemplateService.remove(req.params.id) });
}));

// Website webhook auth: an external site can call the fill endpoint with
// `X-Webhook-Token: <SLICE_WEBHOOK_TOKEN from .env>` instead of a user JWT.
// Falls through to normal auth when the header/env is absent.
const requireAuthOrWebhookToken = (req, res, next) => {
    const token = req.headers['x-webhook-token'];
    if (token && process.env.SLICE_WEBHOOK_TOKEN && token === process.env.SLICE_WEBHOOK_TOKEN) return next();
    return requireAuth(req, res, next);
};

// Fill a template with a customer's text (this is the website-facing hook):
//   { text, submit?, printer_id?, name?, repeat_total? }
// Always slices via the real engine; with submit=true the .gcode.3mf goes
// straight into JobOrchestrator.submit() — the existing loop/eject pipeline.
router.post('/templates/:id/fill', requireAuthOrWebhookToken, asyncHandler(async (req, res) => {
    const { text, submit = false, printer_id = null, name = null, repeat_total = 1, ams_roles = null } = req.body || {};
    const result = await TextTemplateService.fill(req.params.id, { text });
    if (!result.ok) {
        const status = result.code === 'not_found' ? 404 : result.code === 'invalid_text' ? 400 : 502;
        return res.status(status).json({ error: result.error, code: result.code });
    }

    if (!submit) {
        return res.json({
            ok: true, output_name: result.outputName, report: result.report,
            gcode3mf_base64: result.gcode3mf.toString('base64'),
        });
    }

    // Queue as a job: same path as a manual .gcode.3mf upload.
    const template = TextTemplateService.get(req.params.id);
    const { JobOrchestrator } = await import('../../services/JobOrchestrator.js');
    const job = await JobOrchestrator.submit({
        name: name || result.outputName.replace(/\.gcode\.3mf$/i, ''),
        printer_id: printer_id || null,
        profile_id: template?.profile_id || null,
        repeat_total,
        ams_roles: ams_roles || null,
        fileContent: result.gcode3mf,
        fileName: result.outputName,
        rawBuffer3mf: result.gcode3mf,
        originalFileName3mf: result.outputName,
    });
    res.json({ ok: true, output_name: result.outputName, report: result.report, job_id: job.job_id, job_name: job.name });
}));

export default router;
