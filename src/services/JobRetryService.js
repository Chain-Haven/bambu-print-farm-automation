// src/services/JobRetryService.js — opt-in auto-retry / requeue on failure.
//
// When a print fails, requeue it for another attempt if the job opted in
// (max_retries > 0) and the failure is not a known-blocking hardware fault that
// a retry cannot fix (e.g. a failing SD card). Attempts are counted from
// job_runs, so total tries == max_retries + 1.
import { JobModel } from '../models/Job.js';
import { JobRunModel } from '../models/JobRun.js';
import { EventLog } from './EventLog.js';

// Errors a retry cannot fix — requeuing would just loop. Matches the SD-card /
// blocking HMS faults the printer error decoder flags.
const NON_RETRYABLE = /blocking|micro\s?-?sd|sd card|0500\s?-?c0|read\/write exception|not detected/i;

export function isNonRetryableError(message) {
    return NON_RETRYABLE.test(String(message || ''));
}

/** Pure decision: should a failed job be requeued? */
export function shouldRetry({ attemptCount, maxRetries, error, force = false } = {}) {
    if (force) return { retry: true, reason: 'forced' };
    if (!(maxRetries > 0)) return { retry: false, reason: 'retries_disabled' };
    if (isNonRetryableError(error)) return { retry: false, reason: 'non_retryable_error' };
    if (attemptCount > maxRetries) return { retry: false, reason: 'retries_exhausted' };
    return { retry: true, reason: 'eligible' };
}

export const JobRetryService = {
    shouldRetry,
    isNonRetryableError,

    /**
     * Requeue a failed job if eligible. Returns
     * { requeued, attempt, remaining, reason, printer_id }.
     * Does NOT start the job — it goes back to the queue for the normal
     * next-job flow (or a caller) to pick up.
     */
    maybeRequeue(jobId, { error = null, force = false } = {}) {
        const job = JobModel.findById(jobId);
        if (!job) return { requeued: false, reason: 'job_not_found' };

        const attemptCount = JobRunModel.findByJobId(jobId).length || 1;
        const maxRetries = Number(job.max_retries) || 0;
        const decision = shouldRetry({ attemptCount, maxRetries, error, force });

        if (!decision.retry) {
            return { requeued: false, reason: decision.reason, attempt: attemptCount, printer_id: job.printer_id };
        }

        JobModel.update(jobId, { status: 'queued' });
        EventLog.record('job', jobId, 'job.requeued', {
            attempt: attemptCount,
            max_retries: maxRetries,
            forced: force,
            error: error ? String(error).slice(0, 500) : null,
        });

        return {
            requeued: true,
            reason: decision.reason,
            attempt: attemptCount,
            remaining: Math.max(0, maxRetries - attemptCount + 1),
            printer_id: job.printer_id,
        };
    },
};

export default JobRetryService;
