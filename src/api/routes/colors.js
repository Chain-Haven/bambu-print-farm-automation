// src/api/routes/colors.js — shared color catalog endpoints (/api/colors).
// The built-in palette ships with the app; custom colors are user-saved from
// the full-spectrum picker and appear everywhere the palette does.
import { Router } from 'express';
import { requireAuth } from '../../auth/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { CustomColorModel } from '../../models/CustomColor.js';
import { COLOR_PALETTE } from '../../utils/colors.js';

const router = Router();

// Built-in palette + saved custom colors, both as {name, hex:'#rrggbb'}
router.get('/', requireAuth, asyncHandler(async (req, res) => {
    res.json({
        palette: COLOR_PALETTE.filter(c => c.name !== 'Transparent')
            .map(c => ({ name: c.name, hex: `#${c.hex.slice(0, 6).toLowerCase()}` })),
        custom: CustomColorModel.findAll().map(c => ({ name: c.name, hex: c.hex })),
    });
}));

router.get('/custom', requireAuth, asyncHandler(async (req, res) => {
    res.json(CustomColorModel.findAll().map(c => ({ name: c.name, hex: c.hex })));
}));

// Save (upsert by hex): {name?, hex}
router.post('/custom', requireAuth, asyncHandler(async (req, res) => {
    const { name, hex } = req.body || {};
    if (!CustomColorModel.normalizeHex(hex)) {
        return res.status(400).json({ error: `Invalid color "${hex}" — expected a #rrggbb hex` });
    }
    res.status(201).json({ ok: true, color: CustomColorModel.save(name, hex) });
}));

// hex in the URL without the '#'
router.delete('/custom/:hex', requireAuth, asyncHandler(async (req, res) => {
    const h = CustomColorModel.normalizeHex(req.params.hex);
    if (!h || !CustomColorModel.get(h)) return res.status(404).json({ error: 'Custom color not found' });
    CustomColorModel.delete(h);
    res.json({ deleted: true });
}));

export default router;
