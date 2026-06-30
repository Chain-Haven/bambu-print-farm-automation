-- Add transform_overrides to job_templates
ALTER TABLE job_templates ADD COLUMN transform_overrides TEXT DEFAULT '{}';
