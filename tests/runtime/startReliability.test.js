import { beforeAll, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Start-reliability hardening (ported from the hardware-verified local farm
// build): project_file URL forms, calibration defaults, preflight semantics
// for Bambu's dismissed-FAILED state, HMS numeric coercion, and the
// file↔printer model guard.

process.env.MOCK_MODE = 'true';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';
process.env.DB_PATH = path.join(os.tmpdir(), 'start-reliability-test.db');
process.env.UPLOADS_DIR = path.join(os.tmpdir(), 'start-reliability-uploads');

// startJob resolves its worker through RuntimeSupervisor — stub it so the
// pipeline runs against fake workers without booting the whole runtime.
const workers = new Map();
vi.mock('../../src/runtime/RuntimeSupervisor.js', () => ({
    RuntimeSupervisor: {
        getInstance: () => ({ getWorker: (id) => workers.get(id) || null }),
    },
}));

let BambuMqttClient;
let PrinterWorker;
let JobOrchestrator;
let JobModel;
let PrinterModel;
let PrinterErrors;
let PrinterModels;

beforeAll(async () => {
    fs.rmSync(process.env.DB_PATH, { force: true });
    fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });
    const db = await import('../../src/db/database.js');
    await db.initDb();
    db.runMigrations();
    ({ BambuMqttClient } = await import('../../src/mqtt/BambuMqttClient.js'));
    ({ PrinterWorker } = await import('../../src/runtime/PrinterWorker.js'));
    ({ JobOrchestrator } = await import('../../src/services/JobOrchestrator.js'));
    ({ JobModel } = await import('../../src/models/Job.js'));
    ({ PrinterModel } = await import('../../src/models/Printer.js'));
    PrinterErrors = await import('../../src/utils/PrinterErrors.js');
    PrinterModels = await import('../../src/models/PrinterModels.js');
});

describe('BambuMqttClient.startPrint payload', () => {
    function capture() {
        const client = new BambuMqttClient(
            { printer_id: 'mqtt-test', ip_hostname: '127.0.0.1' },
            { serial: 'SER', access_code: 'code' },
        );
        const sent = [];
        client.publish = (cmd) => { sent.push(cmd); return true; };
        return { client, sent };
    }

    it('defaults to the file:///sdcard/cache URL form (the ftp:///sdcard form threw bogus 0500-C010 SD errors)', () => {
        const { client, sent } = capture();
        client.startPrint({ filename: 'part.AG.gcode.3mf' });
        expect(sent[0].print.url).toBe('file:///sdcard/cache/part.AG.gcode.3mf');
    });

    it('honors an explicit url override (retry uses the alternate ftp:///cache form)', () => {
        const { client, sent } = capture();
        client.startPrint({ filename: 'part.AG.gcode.3mf', url: 'ftp:///cache/part.AG.gcode.3mf' });
        expect(sent[0].print.url).toBe('ftp:///cache/part.AG.gcode.3mf');
    });

    it('defaults flow/vibration calibration OFF and bed leveling ON', () => {
        const { client, sent } = capture();
        client.startPrint({ filename: 'part.AG.gcode.3mf' });
        expect(sent[0].print.flow_cali).toBe(false);
        expect(sent[0].print.vibration_cali).toBe(false);
        expect(sent[0].print.bed_leveling).toBe(true);

        client.startPrint({ filename: 'part.AG.gcode.3mf', flowCali: true });
        expect(sent[1].print.flow_cali).toBe(true);
    });
});

describe('PrinterErrors decoding', () => {
    it('decodes the classic SD error and formats it', () => {
        const decoded = PrinterErrors.decodePrintError(83935248); // 0x0500C010
        expect(decoded.formatted).toBe('0500-C010');
        expect(decoded.known).toBe(true);
    });

    it('decodeHms tolerates the NUMERIC attr/code the firmware actually sends', () => {
        const { formatted } = PrinterErrors.decodeHms(0x0C004500, 0x00020002);
        expect(formatted).toBe('0C00-4500-0002-0002');
        // absent attr/code must not throw either
        expect(() => PrinterErrors.decodeHms(undefined, undefined)).not.toThrow();
    });
});

describe('PrinterWorker preflight semantics', () => {
    function makeWorker(id) {
        const worker = new PrinterWorker({ printer_id: id, name: `PF-${id}`, model: 'Bambu A1' });
        worker.connected = true;
        worker.lastReportTime = Date.now();
        return worker;
    }

    it('treats the dismissed-FAILED screen (error state, no active code) as startable', () => {
        const worker = makeWorker('pf1');
        worker.state = 'error';
        worker.latestStatus = {};
        const pf = worker.getPreflightStatus();
        expect(pf.ok).toBe(true);
        expect(pf.warnings.join(' ')).toMatch(/dismissed/i);
    });

    it('still blocks the error state when a real print_error is active', () => {
        const worker = makeWorker('pf2');
        worker.state = 'error';
        worker.latestStatus = { print_error: 83935248 };
        const pf = worker.getPreflightStatus();
        expect(pf.ok).toBe(false);
    });

    it('blocks on a paused print (starting over it would wreck the part on the bed)', () => {
        const worker = makeWorker('pf3');
        worker.state = 'paused';
        worker.latestStatus = {};
        const pf = worker.getPreflightStatus();
        expect(pf.ok).toBe(false);
        expect(pf.errors.join(' ')).toMatch(/paused/i);
    });

    it('flags storage-module (0500) HMS errors as SD faults but NOT motion-module (0300) ones', () => {
        const sd = makeWorker('pf4');
        sd.state = 'idle';
        sd.latestStatus = { hms_errors: [{ attr: 0x05000001, code: 131074 }] };
        expect(sd.getPreflightStatus().ok).toBe(false);

        const motion = makeWorker('pf5');
        motion.state = 'idle';
        // numeric attr/code exactly as the firmware sends them — must neither
        // throw nor be misclassified as an SD fault
        motion.latestStatus = { hms_errors: [{ attr: 0x03000001, code: 131074 }] };
        expect(motion.getPreflightStatus().ok).toBe(true);
    });
});

describe('slice_info model registry mapping', () => {
    it('maps Bambu printer_model_id values to registry models', () => {
        expect(PrinterModels.modelFromSliceInfoId('N2S')?.id).toBe('A1');
        expect(PrinterModels.modelFromSliceInfoId('N1')?.id).toBe('A1_MINI');
        expect(PrinterModels.modelFromSliceInfoId('C12')?.id).toBe('P1S');
        expect(PrinterModels.modelFromSliceInfoId('BL-P001')?.id).toBe('X1C');
        expect(PrinterModels.modelFromSliceInfoId('TOTALLY-NEW')).toBeNull();
    });

    it('P1P and P1S share Automator geometry (guard treats them as compatible)', () => {
        expect(PrinterModels.automatorModelKey('P1P')).toBe(PrinterModels.automatorModelKey('P1S'));
    });
});

describe('file↔printer model guard in startJob', () => {
    function setupJob({ fileModel, allowMismatch = false, worker = null }) {
        const printer = PrinterModel.create({ name: `A1 Bay ${Math.random().toString(36).slice(2, 6)}`, model: 'Bambu A1', ip_hostname: '127.0.0.1' });
        const job = JobModel.create({
            name: 'guard-test', printer_id: printer.printer_id, profile_id: null,
            source_file_name: 'part.gcode.3mf', ams_roles: null, repeat_total: 1,
        });
        JobModel.update(job.job_id, {
            status: 'assigned',
            transformed_file_name: 'part.AG.gcode.3mf',
            transform_report: {
                gcode_entry_name: 'Metadata/plate_1.gcode',
                file_model: fileModel,
                allow_model_mismatch: allowMismatch || undefined,
            },
        });
        fs.writeFileSync(path.join(process.env.UPLOADS_DIR, `${job.job_id}_part.AG.gcode.3mf`), 'dummy');
        workers.set(printer.printer_id, worker || {
            mockMode: true,
            state: 'idle',
            latestStatus: {},
            getPreflightStatus: () => ({ ok: true, errors: [], warnings: [] }),
        });
        return { printer, job };
    }

    it('refuses to start a P1S-sliced file on an A1 with a readable 409', async () => {
        const { job } = setupJob({ fileModel: 'P1S' });
        await expect(JobOrchestrator.startJob(job.job_id)).rejects.toThrow(/sliced for a P1S/);
        expect(JobModel.findById(job.job_id).status).toBe('failed');
    });

    it('starts normally when the file and printer models agree (mock pipeline, positive ACK)', async () => {
        const worker = {
            mockMode: true,
            state: 'idle',
            latestStatus: {},
            getPreflightStatus: () => ({ ok: true, errors: [], warnings: [] }),
            _startPrint: vi.fn(async function () { worker.state = 'printing'; return { started: true, mock: true }; }),
        };
        const { job } = setupJob({ fileModel: 'A1', worker });
        await JobOrchestrator.startJob(job.job_id);
        expect(worker._startPrint).toHaveBeenCalledOnce();
        expect(JobModel.findById(job.job_id).status).toBe('printing');
    });

    it('lets a mismatch through when allow_model_mismatch is set', async () => {
        const worker = {
            mockMode: true,
            state: 'idle',
            latestStatus: {},
            getPreflightStatus: () => ({ ok: true, errors: [], warnings: [] }),
            _startPrint: vi.fn(async function () { worker.state = 'printing'; return { started: true, mock: true }; }),
        };
        const { job } = setupJob({ fileModel: 'P1S', allowMismatch: true, worker });
        await JobOrchestrator.startJob(job.job_id);
        expect(JobModel.findById(job.job_id).status).toBe('printing');
    });
});
