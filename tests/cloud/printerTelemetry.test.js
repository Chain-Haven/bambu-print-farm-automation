import { describe, expect, it } from 'vitest';
import { buildTelemetryView, buildSyncedPrinterRecord } from '../../src/cloud/localPrinterSnapshot.js';

describe('buildTelemetryView', () => {
    it('packages the full live telemetry surface from a worker status', () => {
        const telemetry = buildTelemetryView({
            nozzle_temp: 219.8, nozzle_target: 220,
            bed_temp: 60.1, bed_target: 60,
            chamber_temp: 41.2,
            fan_speed: 100, aux_fan_speed: 40, chamber_fan_speed: 80, heatbreak_fan_speed: 100,
            speed_level: 2, speed_percent: 124,
            nozzle_diameter: 0.4, nozzle_type: 'hardened_steel',
            print_stage: 2,
            wifi_signal: '-47dBm',
            print_error: 0,
            hms_errors: [{ attr: 1, code: 2 }],
        });

        expect(telemetry).toMatchObject({
            nozzle_temp: 219.8,
            chamber_temp: 41.2,
            aux_fan_speed: 40,
            chamber_fan_speed: 80,
            speed_percent: 124,
            nozzle_diameter: 0.4,
            nozzle_type: 'hardened_steel',
            print_stage: 2,
            wifi_dbm: -47,
            hms_count: 1,
        });
    });

    it('includes AMS dry-box humidity/temperature when reported', () => {
        const telemetry = buildTelemetryView(
            { nozzle_temp: 200 },
            { units: [{ ams_id: 0, humidity: 3, temp: 28 }, { ams_id: 1, humidity: null, temp: null }] },
        );
        expect(telemetry.ams_environment).toEqual([{ ams_id: 0, humidity: 3, temp: 28 }]);
    });

    it('returns null when the status carries no usable telemetry', () => {
        expect(buildTelemetryView({})).toBeNull();
        expect(buildTelemetryView(null)).toBeNull();
    });

    it('mirrors telemetry into the synced printer record status_snapshot', () => {
        const record = buildSyncedPrinterRecord(
            { printer_id: 'p1', name: 'A1', model: 'A1', status_snapshot: {} },
            { connected: true, state: 'printing', latestStatus: { nozzle_temp: 210, chamber_temp: 38 } },
            {},
            null,
        );
        expect(record.status_snapshot.telemetry).toMatchObject({ nozzle_temp: 210, chamber_temp: 38 });
    });
});
