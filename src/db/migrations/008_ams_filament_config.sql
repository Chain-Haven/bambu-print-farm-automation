-- 008_ams_filament_config.sql — Store per-printer AMS tray filament configurations
-- This allows 3DFlow to override what the printer thinks is in each AMS slot

CREATE TABLE IF NOT EXISTS printer_ams_config (
    printer_id TEXT NOT NULL,
    ams_id     INTEGER NOT NULL DEFAULT 0,
    tray_id    INTEGER NOT NULL,
    material   TEXT NOT NULL,
    color_hex  TEXT NOT NULL DEFAULT 'FFFFFFFF',
    color_name TEXT DEFAULT 'White',
    setting_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(printer_id, ams_id, tray_id),
    FOREIGN KEY (printer_id) REFERENCES printers(printer_id) ON DELETE CASCADE
);
