-- 014_notification_channels.sql — human-facing notification channels.
-- Fans printer alerts / farm events out to Discord, Slack, Telegram, email
-- relays, or a generic webhook, on top of the existing event bus.

CREATE TABLE IF NOT EXISTS notification_channels (
  channel_id  TEXT PRIMARY KEY,
  name        TEXT,
  type        TEXT NOT NULL CHECK(type IN ('discord','slack','telegram','webhook')),
  config      TEXT NOT NULL DEFAULT '{}',        -- JSON: {url} or {bot_token, chat_id}
  events      TEXT NOT NULL DEFAULT '["all"]',   -- JSON array of event types, or ["all"]
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
