-- 015_job_retry.sql — opt-in auto-retry/requeue on failure.
-- max_retries defaults to 0 (off) so behaviour is unchanged unless an operator
-- opts a job in. Attempts are counted from job_runs, so no counter column is
-- needed. Requeue is skipped for known-blocking hardware faults (e.g. SD card).

ALTER TABLE jobs ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 0;
