-- 017_app_settings.sql — Global key/value settings for the local server
-- (e.g. the cloud-link config: cloud API URL + node token + enabled flag).
CREATE TABLE IF NOT EXISTS app_settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
