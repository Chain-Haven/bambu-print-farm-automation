-- 011_job_metadata.sql — free-form job metadata (JSON)
-- Used to link locally-executed jobs back to their origin, e.g. cloud/merchant
-- print jobs: { "origin": "cloud", "cloud_job_id": "...", "cloud_command_id": "..." }
ALTER TABLE jobs ADD COLUMN metadata TEXT;
