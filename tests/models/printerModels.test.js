import { describe, expect, it } from 'vitest';
import {
    PRINTER_MODELS,
    adoptableModels,
    automatorModelKey,
    cameraFamilyFor,
    capabilitiesFor,
    chassisFamilyFor,
    getModelById,
    normalizeModel,
} from '../../src/models/PrinterModels.js';
import { MODEL_DEFAULTS } from '../../src/gcode/Automator.js';

describe('printer model registry', () => {
    it('normalizes every naming style to the same record', () => {
        for (const value of ['Bambu X1C', 'X1C', 'x1 carbon', 'BAMBU LAB X1C', '3DPrinter-X1-Carbon']) {
            expect(normalizeModel(value)?.id, value).toBe('X1C');
        }
        for (const value of ['A1_MINI', 'A1 Mini', 'Bambu A1 Mini', 'bambu lab a1 mini']) {
            expect(normalizeModel(value)?.id, value).toBe('A1_MINI');
        }
        expect(normalizeModel('Bambu P1S 2')?.id).toBe('P1S');
        expect(normalizeModel('')).toBeNull();
        expect(normalizeModel('Prusa MK4')).toBeNull();
    });

    it('covers the 2026 lineup (X2D, P2S, H2S/H2D/H2C, A2L)', () => {
        for (const id of ['X2D', 'P2S', 'H2S', 'H2D', 'H2C', 'A2L']) {
            expect(getModelById(id), id).toBeTruthy();
        }
        // "X2C" does not exist — it resolves to the real X2D.
        expect(normalizeModel('X2C')?.id).toBe('X2D');
    });

    it('maps every registry model to a real Automator geometry key', () => {
        for (const model of PRINTER_MODELS) {
            const key = automatorModelKey(model.name);
            expect(MODEL_DEFAULTS[key], `${model.name} -> ${key}`).toBeTruthy();
        }
        // The historical bug: DB names like "Bambu X1C" fell back to P1S.
        expect(automatorModelKey('Bambu X1C')).toBe('X1');
        expect(automatorModelKey('Bambu A1 Mini')).toBe('A1_MINI');
        expect(automatorModelKey('Bambu H2C')).toBe('H2D');
        expect(automatorModelKey('unknown model')).toBe('P1S');
    });

    it('assigns the right camera transport per model', () => {
        expect(cameraFamilyFor('Bambu P1S')).toBe('p1');
        expect(cameraFamilyFor('A1 Mini')).toBe('p1');
        expect(cameraFamilyFor('Bambu X1C')).toBe('x1');
        expect(cameraFamilyFor('X2D')).toBe('x1');
        expect(cameraFamilyFor('P2S')).toBe('x1');
        expect(cameraFamilyFor('H2S')).toBe('x1');
        expect(cameraFamilyFor('mystery')).toBe('p1');
    });

    it('exposes chassis families, adoptable list, and build-volume capabilities', () => {
        expect(chassisFamilyFor('Bambu A2L')).toBe('a2');
        expect(chassisFamilyFor('X2D')).toBe('x2');
        expect(adoptableModels()).toEqual(expect.arrayContaining(['A1', 'P1S', 'P2S', 'X2D', 'H2S', 'H2D', 'H2C', 'A2L']));

        const h2 = capabilitiesFor('Bambu H2D');
        expect(h2).toMatchObject({ max_x: 325, max_y: 320, max_z: 325, camera: true });
        expect(capabilitiesFor('who knows')).toBeNull();
    });

    it('keeps sweep lanes and park positions inside each model bed', () => {
        for (const model of PRINTER_MODELS) {
            const geometry = MODEL_DEFAULTS[automatorModelKey(model.name)];
            for (const lane of geometry.sweepLanesX) {
                expect(lane, `${model.id} lane ${lane}`).toBeGreaterThanOrEqual(0);
                expect(lane, `${model.id} lane ${lane}`).toBeLessThanOrEqual(model.bed.x);
            }
            expect(geometry.zMax).toBeLessThanOrEqual(model.bed.z);
        }
    });
});
