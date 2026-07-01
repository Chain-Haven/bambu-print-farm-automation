alter table public.print_jobs
  drop constraint if exists print_jobs_status_check;

alter table public.print_jobs
  add constraint print_jobs_status_check
  check (status in (
    'queued',
    'assigned',
    'transforming',
    'uploading',
    'printing',
    'completed',
    'failed',
    'canceled',
    'needs_slicing',
    'needs_review',
    'waiting_for_capacity',
    'reprint_requested'
  ));
