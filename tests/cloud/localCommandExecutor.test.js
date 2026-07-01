import { describe, expect, it, vi } from 'vitest';
import { executeCloudCommand } from '../../src/cloud/localCommandExecutor.js';

describe('local cloud command executor', () => {
    it('downloads ready print artifacts, wraps raw gcode, uploads to the printer, and starts printing', async () => {
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
                local_printer_id: 'local-printer-1',
                download_url: 'https://signed.example/file',
                original_name: 'part.gcode',
                ams_mapping: [0],
            },
        }, deps);

        expect(deps.downloadArtifact).toHaveBeenCalledWith('https://signed.example/file');
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
            started: true,
            remote_file_name: 'part.gcode.3mf',
            uploaded: { success: true, bytesUploaded: 2048, verified: true },
        });
    });

    it('uploads project artifacts without wrapping them again', async () => {
        const artifact = Buffer.from('PK project bytes');
        const worker = {
            getPreflightStatus: vi.fn().mockReturnValue({ ok: true, errors: [] }),
            _startPrint: vi.fn().mockResolvedValue({ started: true }),
        };
        const deps = {
            getWorker: vi.fn().mockResolvedValue(worker),
            downloadArtifact: vi.fn().mockResolvedValue(artifact),
            uploadToPrinter: vi.fn().mockResolvedValue({ success: true }),
        };

        await executeCloudCommand({
            command_type: 'cloud.print.ready',
            payload: {
                local_printer_id: 'local-printer-1',
                download_url: 'https://signed.example/file',
                original_name: 'part.gcode.3mf',
            },
        }, deps);

        expect(deps.uploadToPrinter).toHaveBeenCalledWith(expect.objectContaining({
            buffer: artifact,
            remoteFileName: 'part.gcode.3mf',
        }));
        expect(worker._startPrint).toHaveBeenCalledWith(expect.objectContaining({
            filename: 'part.gcode.3mf',
            useAms: false,
        }));
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
});
