-- Merchant API v1 platform tables.

create table public.platform_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.merchants (
  merchant_id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(org_id) on delete cascade,
  company_name text not null,
  contact_email text not null,
  contact_name text,
  website text,
  status text not null default 'pending' check (status in ('pending', 'active', 'rejected', 'suspended')),
  approval_mode text not null default 'approval_required' check (approval_mode in ('approval_required', 'full_auto')),
  metadata jsonb not null default '{}'::jsonb,
  approved_at timestamptz,
  rejected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (contact_email)
);

create table public.merchant_api_keys (
  key_id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(merchant_id) on delete cascade,
  org_id uuid not null references public.organizations(org_id) on delete cascade,
  name text not null,
  key_prefix text not null,
  key_hash text not null unique,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.routing_decisions (
  decision_id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(org_id) on delete cascade,
  merchant_id uuid references public.merchants(merchant_id) on delete set null,
  job_id uuid references public.print_jobs(job_id) on delete cascade,
  selected_node_id uuid references public.farm_nodes(node_id) on delete set null,
  selected_printer_id uuid references public.cloud_printers(printer_id) on delete set null,
  status text not null check (status in ('routed', 'no_capacity', 'waiting_for_capacity', 'needs_review', 'needs_slicing')),
  strategy text not null default 'fastest_fulfillment',
  score jsonb not null default '{}'::jsonb,
  rejected_candidates jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table public.merchant_usage_events (
  usage_event_id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(org_id) on delete cascade,
  merchant_id uuid not null references public.merchants(merchant_id) on delete cascade,
  job_id uuid references public.print_jobs(job_id) on delete set null,
  file_id uuid references public.job_files(file_id) on delete set null,
  event_type text not null,
  quantity numeric not null default 1,
  metrics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.print_job_status_history (
  history_id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(org_id) on delete cascade,
  merchant_id uuid references public.merchants(merchant_id) on delete set null,
  job_id uuid not null references public.print_jobs(job_id) on delete cascade,
  status text not null,
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.job_files
  add column if not exists merchant_id uuid references public.merchants(merchant_id) on delete set null,
  add column if not exists file_mode text not null default 'ready_to_print' check (file_mode in ('ready_to_print', 'source_model')),
  add column if not exists requirements jsonb not null default '{}'::jsonb;

alter table public.print_jobs
  add column if not exists merchant_id uuid references public.merchants(merchant_id) on delete set null,
  add column if not exists routing_summary jsonb not null default '{}'::jsonb;

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

create trigger platform_settings_set_updated_at
before update on public.platform_settings
for each row execute function public.set_updated_at();

create trigger merchants_set_updated_at
before update on public.merchants
for each row execute function public.set_updated_at();

alter table public.platform_settings enable row level security;
alter table public.merchants enable row level security;
alter table public.merchant_api_keys enable row level security;
alter table public.routing_decisions enable row level security;
alter table public.merchant_usage_events enable row level security;
alter table public.print_job_status_history enable row level security;

grant all on public.platform_settings to service_role;
grant all on public.merchants to service_role;
grant all on public.merchant_api_keys to service_role;
grant all on public.routing_decisions to service_role;
grant all on public.merchant_usage_events to service_role;
grant all on public.print_job_status_history to service_role;

create index platform_settings_updated_idx on public.platform_settings(updated_at desc);
create index merchants_org_status_idx on public.merchants(org_id, status, created_at desc);
create index merchants_email_idx on public.merchants(contact_email);
create index merchant_api_keys_merchant_idx on public.merchant_api_keys(merchant_id, revoked_at);
create index merchant_api_keys_hash_idx on public.merchant_api_keys(key_hash);
create index routing_decisions_job_idx on public.routing_decisions(job_id, created_at desc);
create index routing_decisions_merchant_idx on public.routing_decisions(merchant_id, created_at desc);
create index merchant_usage_events_merchant_idx on public.merchant_usage_events(merchant_id, created_at desc);
create index merchant_usage_events_job_idx on public.merchant_usage_events(job_id, created_at desc);
create index print_job_status_history_job_idx on public.print_job_status_history(job_id, created_at desc);
create index job_files_merchant_idx on public.job_files(merchant_id, created_at desc);
create index print_jobs_merchant_idx on public.print_jobs(merchant_id, created_at desc);

insert into public.platform_settings (key, value)
values ('full_auto_merchant_mode', '{"enabled": false}'::jsonb)
on conflict (key) do nothing;
