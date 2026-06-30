-- 009_printer_overrides.sql — Stores saved printer control settings for future prints
CREATE TABLE IF NOT EXISTS printer_overrides (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    printer_id  TEXT NOT NULL,
    setting_key TEXT NOT NULL,
    setting_value TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(printer_id, setting_key),
    FOREIGN KEY (printer_id) REFERENCES printers(printer_id) ON DELETE CASCADE
);
