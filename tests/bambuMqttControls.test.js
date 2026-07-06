import { describe, expect, it, beforeEach } from 'vitest';
import { BambuMqttClient } from '../src/mqtt/BambuMqttClient.js';

function connectedClient() {
    const client = new BambuMqttClient(
        { printer_id: 'p1', ip_hostname: '192.168.1.5' },
        { serial: 'SN123', access_code: 'code' },
    );
    const published = [];
    client.client = { publish: (_topic, msg) => published.push(JSON.parse(msg)) };
    client.connected = true;
    return { client, published };
}

describe('BambuMqttClient new commands', () => {
    let ctx;
    beforeEach(() => { ctx = connectedClient(); });

    it('requestVersion asks the printer for its firmware/module versions', () => {
        ctx.client.requestVersion();
        expect(ctx.published[0]).toEqual({ info: { sequence_id: '0', command: 'get_version' } });
    });

    it('setXcamControl enables AI monitoring with halt-on-detect', () => {
        ctx.client.setXcamControl({ module: 'printing', control: true, printHalt: true });
        expect(ctx.published[0].xcam).toMatchObject({
            command: 'xcam_control_set',
            module_name: 'printing',
            control: true,
            print_halt: true,
        });
    });

    it('skipObjects sends the plate object ids and ignores garbage', () => {
        ctx.client.skipObjects([1, '3', 'x', 5]);
        expect(ctx.published[0].print).toMatchObject({ command: 'skip_objects', obj_list: [1, 3, 5] });

        const before = ctx.published.length;
        expect(ctx.client.skipObjects([])).toBe(false);
        expect(ctx.published.length).toBe(before); // nothing published for an empty list
    });

    it('startPrint with aiMonitoring enables first-layer inspect + the xcam module', () => {
        ctx.client.startPrint({ filename: 'part.gcode.3mf', aiMonitoring: true });
        // project_file with layer_inspect true, then a follow-up xcam_control_set.
        expect(ctx.published[0].print).toMatchObject({ command: 'project_file', layer_inspect: true });
        expect(ctx.published[1].xcam).toMatchObject({ command: 'xcam_control_set', control: true });
    });

    it('startPrint without aiMonitoring leaves inspection off and sends no xcam command', () => {
        ctx.client.startPrint({ filename: 'part.gcode.3mf' });
        expect(ctx.published[0].print.layer_inspect).toBe(false);
        expect(ctx.published.some((m) => m.xcam)).toBe(false);
    });
});
