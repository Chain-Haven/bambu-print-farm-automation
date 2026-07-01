// src/api/routes/jobs.js — Job endpoints
import { Router } from 'express';
import { JobOrchestrator } from '../../services/JobOrchestrator.js';
import { JobRunModel } from '../../models/JobRun.js';
import { JobModel } from '../../models/Job.js';
import { requireAuth } from '../../auth/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { isZipFile, is3mfFilename, extractGcodeFrom3mf } from '../../gcode/Extract3mf.js';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { getUploadRoot } from '../../utils/uploadPaths.js';

const UPLOADS_DIR = getUploadRoot();

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } }); // 200MB

// Submit job (with file upload — supports .gcode and .gcode.3mf)
router.post('/submit', requireAuth, upload.single('file'), asyncHandler(async (req, res) => {
    let fileContent, fileName;

    if (req.file) {
        const rawBuffer = req.file.buffer;
        fileName = req.file.originalname;

        // Detect 3MF (ZIP) files by magic bytes or filename
        if (isZipFile(rawBuffer) || is3mfFilename(fileName)) {
            // Extract G-code from inside the 3MF archive
            const extracted = await extractGcodeFrom3mf(rawBuffer, fileName);
            fileContent = extracted.content;
            // Use the inner .gcode filename for the job
            if (extracted.entryName) {
                fileName = extracted.entryName.split('/').pop() || fileName;
            }
        } else {
            // Plain .gcode text file
            fileContent = rawBuffer.toString('utf-8');
        }
    } else if (req.body.file_upload) {
        const uploadData = typeof req.body.file_upload === 'string' ? JSON.parse(req.body.file_upload) : req.body.file_upload;
        const rawBuffer = Buffer.from(uploadData.content_base64, 'base64');
        fileName = uploadData.filename;

        if (isZipFile(rawBuffer) || is3mfFilename(fileName)) {
            const extracted = await extractGcodeFrom3mf(rawBuffer, fileName);
            fileContent = extracted.content;
            if (extracted.entryName) {
                fileName = extracted.entryName.split('/').pop() || fileName;
            }
        } else {
            fileContent = rawBuffer.toString('utf-8');
        }
    } else {
        return res.status(400).json({ error: 'File is required (multipart upload or file_upload.content_base64)' });
    }

    // Track if input was a 3MF (need raw buffer for repacking)
    let rawBuffer3mf = null;
    let originalFileName3mf = null;
    if (req.file && (isZipFile(req.file.buffer) || is3mfFilename(req.file.originalname))) {
        rawBuffer3mf = req.file.buffer;
        originalFileName3mf = req.file.originalname;
    } else if (req.body.file_upload) {
        const uploadData = typeof req.body.file_upload === 'string' ? JSON.parse(req.body.file_upload) : req.body.file_upload;
        const buf = Buffer.from(uploadData.content_base64, 'base64');
        if (isZipFile(buf) || is3mfFilename(uploadData.filename)) {
            rawBuffer3mf = buf;
            originalFileName3mf = uploadData.filename;
        }
    }

    const { name, printer_id, profile_id, repeat_total, ams_roles, skip_transform, transform_overrides } = req.body;
    const parsedAmsRoles = typeof ams_roles === 'string' ? JSON.parse(ams_roles) : ams_roles;
    const parsedOverrides = typeof transform_overrides === 'string' ? JSON.parse(transform_overrides) : transform_overrides;

    const job = await JobOrchestrator.submit({
        name: name || fileName,
        printer_id: printer_id || null,
        profile_id: profile_id || null,
        repeat_total: parseInt(repeat_total) || 1,
        ams_roles: parsedAmsRoles || null,
        fileContent,
        fileName,
        skip_transform: skip_transform === 'true' || skip_transform === true,
        transform_overrides: parsedOverrides || null,
        rawBuffer3mf,
        originalFileName3mf,
    });

    res.status(201).json(job);
}));

// List jobs
router.get('/', requireAuth, asyncHandler(async (req, res) => {
    const { status, printer_id, limit, offset } = req.query;
    res.json(JobOrchestrator.findAll({ status, printer_id, limit: parseInt(limit) || 50, offset: parseInt(offset) || 0 }));
}));

// Get single job
router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
    const job = JobOrchestrator.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const runs = JobRunModel.findByJobId(req.params.id);
    res.json({ ...job, runs });
}));

// Update job (printer assignment, status changes)
router.patch('/:id', requireAuth, asyncHandler(async (req, res) => {
    const existing = JobModel.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Job not found' });

    // Only allow updating certain fields
    const { printer_id, name } = req.body;
    const updates = {};
    if (printer_id !== undefined) {
        updates.printer_id = printer_id || null;
        // Auto-set status to 'assigned' when a printer is assigned to a queued job
        if (printer_id && existing.status === 'queued') {
            updates.status = 'assigned';
        } else if (!printer_id && existing.status === 'assigned') {
            updates.status = 'queued';
        }
    }
    if (name !== undefined) updates.name = name;

    const job = JobModel.update(req.params.id, updates);
    res.json(job);
}));

// Download job file (transformed or original)
router.get('/:id/download', requireAuth, asyncHandler(async (req, res) => {
    const job = JobModel.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const type = req.query.type || 'transformed';
    let filePath, downloadName;

    if (type === 'original') {
        filePath = path.join(UPLOADS_DIR, `${job.job_id}_${job.source_file_name}`);
        downloadName = job.source_file_name;
    } else {
        filePath = path.join(UPLOADS_DIR, `${job.job_id}_${job.transformed_file_name || job.source_file_name}`);
        downloadName = job.transformed_file_name || job.source_file_name;
    }

    if (!filePath || !fs.existsSync(filePath)) {
        return res.status(404).json({ error: `No ${type} file found for this job` });
    }

    res.download(filePath, downloadName);
}));

// Cancel job
router.post('/:id/cancel', requireAuth, asyncHandler(async (req, res) => {
    const job = JobOrchestrator.cancelJob(req.params.id);
    res.json(job);
}));

// Start job (if queued/assigned)
router.post('/:id/start', requireAuth, asyncHandler(async (req, res) => {
    const result = await JobOrchestrator.startJob(req.params.id);
    res.json(result);
}));

// Get printer queue
router.get('/queue/:printer_id', requireAuth, asyncHandler(async (req, res) => {
    res.json(JobOrchestrator.getQueue(req.params.printer_id));
}));

// Clear history (MUST be before /:id to prevent Express matching "history" as an ID)
router.delete('/history', requireAuth, asyncHandler(async (req, res) => {
    const count = await JobOrchestrator.clearHistory();
    res.json({ success: true, count });
}));

// Delete job
router.delete('/:id', requireAuth, asyncHandler(async (req, res) => {
    await JobOrchestrator.deleteJob(req.params.id);
    res.json({ success: true });
}));

export default router;
