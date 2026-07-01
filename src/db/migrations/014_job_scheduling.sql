-- 013_job_scheduling.sql — deferred (scheduled) printing + queue priority.
-- A queued job with scheduled_for in the future is not "ready" until that time.
-- priority orders the ready queue (higher runs first); default 0 preserves FIFO.

ALTER TABLE jobs ADD COLUMN scheduled_for TEXT;
ALTER TABLE jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_jobs_queue ON jobs(status, priority, created_at);
