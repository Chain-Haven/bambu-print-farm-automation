-- Add covering indexes for cloud control plane foreign keys flagged by Supabase
-- performance advisors.

create index if not exists organization_members_user_idx
  on public.organization_members(user_id);

create index if not exists cloud_printers_org_idx
  on public.cloud_printers(org_id);

create index if not exists job_files_org_idx
  on public.job_files(org_id);

create index if not exists job_files_created_by_idx
  on public.job_files(created_by);

create index if not exists print_jobs_node_idx
  on public.print_jobs(node_id);

create index if not exists print_jobs_printer_idx
  on public.print_jobs(printer_id);

create index if not exists print_jobs_file_idx
  on public.print_jobs(file_id);

create index if not exists print_jobs_created_by_idx
  on public.print_jobs(created_by);

create index if not exists node_commands_org_idx
  on public.node_commands(org_id);

create index if not exists node_commands_printer_idx
  on public.node_commands(printer_id);

create index if not exists node_commands_job_idx
  on public.node_commands(job_id);

create index if not exists node_commands_created_by_idx
  on public.node_commands(created_by);

create index if not exists node_events_node_idx
  on public.node_events(node_id);

create index if not exists node_events_printer_idx
  on public.node_events(printer_id);

create index if not exists node_events_command_idx
  on public.node_events(command_id);
