import { describe, expect, it, vi } from 'vitest';
import { executeCloudCommand } from '../../src/cloud/localCommandExecutor.js';

describe('local cloud command executor', () => {
    it('routes cloud print jobs through the JobOrchestrator pipeline by default', async () => {
        const worker = {
            state: 'idle',
            getPreflightStatus: vi.fn().mockReturnValue({ ok: true, errors: [] }),
            _startPrint: vi.fn(),
        };
        const submitJob = vi.fn().mockResolvedValue({
            job_id: 'local-job-1',
            status: 'printing',
            transformed_file_name: 'part.AG.gcode.3mf',
            transform_report: { skipped: false },
            diff_summary: { loops: 1 },
        });
        const deps = {
            getWorker: vi.fn().mockResolvedValue(worker),
            downloadArtifact: vi.fn().mockResolvedValue(Buffer.from('G28\nG1 X10')),
            uploadToPrinter: vi.fn(),
            submitJob,
        };

        const result = await executeCloudCommand({
            command_id: 'cmd-77',
            command_type: 'cloud.print.ready',
            job_id: 'cloud-job-77',
            org_id: 'org-1',
            payload: {
                local_printer_id: 'local-printer-1',
                download_url: 'https://signed.example/file',
                original_name: 'part.gcode',
                ams_mapping: [2],
            },
        }, deps);

        expect(deps.downloadArtifact).toHaveBeenCalledWith('https://signed.example/file');
        // orchestrated path never uses the raw one-shot upload/start
        expect(deps.uploadToPrinter).not.toHaveBeenCalled();
        expect(worker._startPrint).not.toHaveBeenCalled();

        const submitted = submitJob.mock.calls[0][0];
        expect(submitted).toMatchObject({
            printer_id: 'local-printer-1',
            fileName: 'part.gcode.3mf',
            originalFileName3mf: 'part.gcode.3mf',
            transform_mode: 'optional',
            auto_start: true,
            ams_roles: { slot_map: { 0: 2 } },
            metadata: {
                origin: 'cloud',
                cloud_job_id: 'cloud-job-77',
                cloud_command_id: 'cmd-77',
                org_id: 'org-1',
            },
        });
        // raw gcode is wrapped into a .gcode.3mf container for the orchestrator
        expect(submitted.rawBuffer3mf.subarray(0, 2).toString()).toBe('PK');

        expect(result).toMatchObject({
            pipeline: 'orchestrated',
            started: true,
            queued: false,
            local_job_id: 'local-job-1',
            remote_file_name: 'part.AG.gcode.3mf',
            transform: { applied: true, error: null, loops: 1 },
        });
    });

    it('queues (does not start) when the selected printer is mid-print', async () => {
        const worker = {
            state: 'printing',
            getPreflightStatus: vi.fn().mockReturnValue({ ok: false, errors: ['Printer is currently printing'] }),
        };
        const submitJob = vi.fn().mockResolvedValue({
            job_id: 'local-job-2',
            status: 'assigned',
            transformed_file_name: 'part.AG.gcode.3mf',
            transform_report: { skipped: false },
            diff_summary: { loops: 1 },
        });
        const deps = {
            getWorker: vi.fn().mockResolvedValue(worker),
            downloadArtifact: vi.fn().mockResolvedValue(Buffer.from('PK project bytes')),
            submitJob,
        };

        const result = await executeCloudCommand({
            command_type: 'cloud.print.ready',
            payload: {
                local_printer_id: 'local-printer-1',
                download_url: 'https://signed.example/file',
                original_name: 'part.gcode.3mf',
            },
        }, deps);

        expect(submitJob.mock.calls[0][0].auto_start).toBe(false);
        expect(result).toMatchObject({ queued: true, started: false, job_status: 'assigned' });
    });

    it('keeps the legacy raw path behind payload.pipeline="raw"', async () => {
        const worker = {
            getPreflightStatus: vi.fn().mockReturnValue({ ok: true, errors: [] }),
            _startPrint: vi.fn().mockResolvedValue({ started: true }),
        };
        const deps = {
            getWorker: vi.fn().mockResolvedValue(worker),
            downloadArtifact: vi.fn().mockResolvedValue(Buffer.from('G28\nG1 X10')),
            uploadToPrinter: vi.fn().mockResolvedValue({ success: true, bytesUploaded: 2048, verified: true }),
        };

        const result = await executeCloudCommand({
            command_type: 'cloud.print.ready',
            payload: {
                pipeline: 'raw',
                local_printer_id: 'local-printer-1',
                download_url: 'https://signed.example/file',
                original_name: 'part.gcode',
                ams_mapping: [0],
            },
        }, deps);

        expect(deps.uploadToPrinter).toHaveBeenCalledWith(expect.objectContaining({
            localPrinterId: 'local-printer-1',
            remoteFileName: 'part.gcode.3mf',
            buffer: expect.any(Buffer),
        }));
        expect(deps.uploadToPrinter.mock.calls[0][0].buffer.subarray(0, 2).toString()).toBe('PK');
        expect(worker._startPrint).toHaveBeenCalledWith({
            filename: 'part.gcode.3mf',
            plateNumber: 1,
            useAms: true,
            amsMapping: [0],
        });
        expect(result).toMatchObject({
            pipeline: 'raw',
            started: true,
            remote_file_name: 'part.gcode.3mf',
            uploaded: { success: true, bytesUploaded: 2048, verified: true },
        });
    });

    it('fails before upload when preflight reports printer errors', async () => {
        const worker = {
            getPreflightStatus: vi.fn().mockReturnValue({ ok: false, errors: ['door open'] }),
            _startPrint: vi.fn(),
        };
        const deps = {
            getWorker: vi.fn().mockResolvedValue(worker),
            downloadArtifact: vi.fn().mockResolvedValue(Buffer.from('PK project bytes')),
            uploadToPrinter: vi.fn(),
        };

        await expect(executeCloudCommand({
            command_type: 'cloud.print.ready',
            payload: {
                local_printer_id: 'local-printer-1',
                download_url: 'https://signed.example/file',
                original_name: 'part.gcode.3mf',
            },
        }, deps)).rejects.toThrow('Preflight failed: door open');

        expect(deps.uploadToPrinter).not.toHaveBeenCalled();
        expect(worker._startPrint).not.toHaveBeenCalled();
    });

    it('discovers LAN printers through the local Windows node', async () => {
        const discovered = [
            {
                serial: '00M00A123',
                name: 'P1S Rack 01',
                model: 'Bambu P1S',
                ip: '192.168.20.45',
                network_interface: 'Ethernet',
            },
        ];
        const deps = {
            discoverPrinters: vi.fn().mockResolvedValue(discovered),
        };

        const result = await executeCloudCommand({
            command_type: 'cloud.printers.discover',
            payload: {
                scan_cidrs: ['192.168.20.0/24'],
                wait_ms: 250,
            },
        }, deps);

        expect(deps.discoverPrinters).toHaveBeenCalledWith({
            scan_cidrs: ['192.168.20.0/24'],
            wait_ms: 250,
        });
        expect(result).toEqual({
            discovered: 1,
            printers: discovered,
            scan_cidrs: ['192.168.20.0/24'],
        });
    });

    it('syncs registered printer inventory and AMS state through the local Windows node', async () => {
        const syncedPrinters = [
            {
                local_printer_id: 'printer-1',
                name: 'A1 Mini 01',
                status: 'online',
                model: 'Bambu A1 Mini',
                ip_hostname: '192.168.20.46',
                status_snapshot: {
                    ams: { trays: [{ color: '#ff0000', material: 'PLA' }] },
                },
            },
        ];
        const deps = {
            syncPrinters: vi.fn().mockResolvedValue({
                printers: syncedPrinters,
                summary: {
                    registered: 1,
                    online: 1,
                    ams_trays: 1,
                },
            }),
        };

        const result = await executeCloudCommand({
            command_type: 'cloud.printers.sync',
            payload: {
                scan_cidrs: ['192.168.20.0/24'],
                include_saved_printers: true,
                sync_ams: true,
                sync_filament: true,
            },
        }, deps);

        expect(deps.syncPrinters).toHaveBeenCalledWith({
            scan_cidrs: ['192.168.20.0/24'],
            include_saved_printers: true,
            sync_ams: true,
            sync_filament: true,
        });
        expect(result).toEqual({
            synced: 1,
            printers: syncedPrinters,
            summary: {
                registered: 1,
                online: 1,
                ams_trays: 1,
            },
        });
    });

    it('sets an AMS slot assignment from the cloud and pushes it to a connected printer', async () => {
        const amsService = {
            setTray: vi.fn().mockReturnValue({
                ams_id: 0, tray_id: 1, material: 'PETG', color_hex: '0000FFFF', color_name: 'Blue', setting_id: 'GFSG99_04',
            }),
            syncToDevice: vi.fn().mockResolvedValue([{ tray_id: 1, status: 'sent', material: 'PETG' }]),
            getFullStatus: vi.fn().mockReturnValue({ printer_id: 'local-printer-1', slots: [] }),
        };
        const worker = { mqttClient: { connected: true } };
        const deps = {
            getWorker: vi.fn().mockResolvedValue(worker),
            getAmsService: vi.fn().mockResolvedValue(amsService),
        };

        const result = await executeCloudCommand({
            command_type: 'printer.ams.set',
            payload: {
                local_printer_id: 'local-printer-1',
                ams_id: 0,
                tray_id: 1,
                material: 'PETG',
                color_hex: '0000FFFF',
                color_name: 'Blue',
            },
        }, deps);

        expect(amsService.setTray).toHaveBeenCalledWith('local-printer-1', 0, 1, {
            material: 'PETG',
            colorHex: '0000FFFF',
            colorName: 'Blue',
        });
        expect(amsService.syncToDevice).toHaveBeenCalled();
        expect(result).toMatchObject({
            ok: true,
            pushed_to_printer: true,
            updated: { material: 'PETG', tray_id: 1 },
        });
    });

    it('decomposes flat AMS slot indexes (unit = idx/4, tray = idx%4)', async () => {
        const amsService = {
            setTray: vi.fn().mockReturnValue({ ams_id: 1, tray_id: 2, material: 'PLA' }),
            getFullStatus: vi.fn().mockReturnValue({ slots: [] }),
        };
        const deps = {
            getWorker: vi.fn().mockResolvedValue(null),
            getAmsService: vi.fn().mockResolvedValue(amsService),
        };

        await executeCloudCommand({
            command_type: 'printer.ams.set',
            payload: { local_printer_id: 'p1', tray_id: 6, material: 'PLA', push_to_printer: false },
        }, deps);

        expect(amsService.setTray).toHaveBeenCalledWith('p1', 1, 2, expect.any(Object));
    });

    it('reads the merged AMS status for a printer', async () => {
        const status = { printer_id: 'p1', ams_available: true, slots: [{ ams_id: 0, tray_id: 0 }] };
        const amsService = { getFullStatus: vi.fn().mockReturnValue(status) };
        const deps = { getAmsService: vi.fn().mockResolvedValue(amsService) };

        const result = await executeCloudCommand({
            command_type: 'printer.ams.get',
            payload: { local_printer_id: 'p1' },
        }, deps);

        expect(result).toEqual(status);
    });
});
