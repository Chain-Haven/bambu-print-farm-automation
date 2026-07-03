// Single source of truth for product naming. Historically the codebase mixed
// three brands — "Antigravity" (server logs / package.json), "3DFLOW" (local
// SPA), and "PrintKinetix" (cloud console + landing). User-facing surfaces
// standardize on PrintKinetix; internal identifiers (package name, DB paths,
// gcode markers) are intentionally left alone so nothing breaks.
export const PRODUCT_NAME = 'PrintKinetix';
export const LOCAL_APP_NAME = 'PrintKinetix Farm Manager';
