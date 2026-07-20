-- Custom colors (2026-07-16): user-saved print colors from the full-spectrum
-- picker. Shown as a separate "Custom colors" list next to the built-in
-- palette in the slicer, the printer AMS tray config and the order color
-- pairings. Keyed by hex — saving the same color twice just renames it.

CREATE TABLE IF NOT EXISTS custom_colors (
  hex        TEXT PRIMARY KEY,   -- '#rrggbb' lowercase
  name       TEXT NOT NULL,      -- user label (defaults to the hex)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
