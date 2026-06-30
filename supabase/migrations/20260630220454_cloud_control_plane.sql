-- PrintKinetix cloud control plane
-- Vercel owns server-side writes with the Supabase service key. Downloaded
-- Windows/NUC agents authenticate to Vercel with opaque node tokens; they do
-- not receive Supabase service credentials.

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.set_updated_at() from public, anon, authenticated;

create table public.organizations (
  org_id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organization_members (
  org_id uuid not null references public.organizations(org_id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'operator' check (role in ('owner', 'admin', 'operator', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create table public.farm_nodes (
  node_id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(org_id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  status text not null default 'offline' check (status in ('online', 'degraded', 'offline')),
  agent_version text,
  host_info jsonb not null default '{}'::jsonb,
  capabilities jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.cloud_printers (
  printer_id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(org_id) on delete cascade,
  node_id uuid not null references public.farm_nodes(node_id) on delete cascade,
  local_printer_id text not null,
  name text not null,
  model text not null,
  status text not null default 'unknown' check (status in ('online', 'offline', 'printing', 'paused', 'degraded', 'unknown')),
  status_snapshot jsonb not null default '{}'::jsonb,
  capabilities jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (node_id, local_printer_id)
);

create table public.job_files (
  file_id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(org_id) on delete cascade,
  storage_path text not null unique,
  original_name text not null,
  content_type text not null default 'application/octet-stream',
  byte_size bigint not null check (byte_size >= 0),
  checksum_sha256 text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.print_jobs (
  job_id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(org_id) on delete cascade,
  node_id uuid references public.farm_nodes(node_id) on delete set null,
  printer_id uuid references public.cloud_printers(printer_id) on delete set null,
  file_id uuid references public.job_files(file_id) on delete set null,
  name text not null,
  status text not null default 'queued' check (status in ('queued', 'assigned', 'transforming', 'uploading', 'printing', 'completed', 'failed', 'canceled')),
  options jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.node_commands (
  command_id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(org_id) on delete cascade,
  node_id uuid not null references public.farm_nodes(node_id) on delete cascade,
  printer_id uuid references public.cloud_printers(printer_id) on delete set null,
  job_id uuid references public.print_jobs(job_id) on delete set null,
  command_type text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued', 'claimed', 'running', 'succeeded', 'failed', 'canceled')),
  claimed_at timestamptz,
  finished_at timestamptz,
  result jsonb,
  error text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.node_events (
  event_id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(org_id) on delete cascade,
  node_id uuid references public.farm_nodes(node_id) on delete set null,
  printer_id uuid references public.cloud_printers(printer_id) on delete set null,
  command_id uuid references public.node_commands(command_id) on delete set null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index farm_nodes_org_status_idx on public.farm_nodes(org_id, status);
create index farm_nodes_token_hash_idx on public.farm_nodes(token_hash);
create index cloud_printers_node_idx on public.cloud_printers(node_id);
create index print_jobs_org_status_idx on public.print_jobs(org_id, status, created_at desc);
create index node_commands_node_status_idx on public.node_commands(node_id, status, created_at);
create index node_events_org_created_idx on public.node_events(org_id, created_at desc);

create trigger organizations_set_updated_at
before update on public.organizations
for each row execute function public.set_updated_at();

create trigger farm_nodes_set_updated_at
before update on public.farm_nodes
for each row execute function public.set_updated_at();

create trigger cloud_printers_set_updated_at
before update on public.cloud_printers
for each row execute function public.set_updated_at();

create trigger print_jobs_set_updated_at
before update on public.print_jobs
for each row execute function public.set_updated_at();

create trigger node_commands_set_updated_at
before update on public.node_commands
for each row execute function public.set_updated_at();

alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.farm_nodes enable row level security;
alter table public.cloud_printers enable row level security;
alter table public.job_files enable row level security;
alter table public.print_jobs enable row level security;
alter table public.node_commands enable row level security;
alter table public.node_events enable row level security;

grant select on public.organizations to authenticated;
grant select on public.organization_members to authenticated;
grant select on public.farm_nodes to authenticated;
grant select on public.cloud_printers to authenticated;
grant select on public.job_files to authenticated;
grant select on public.print_jobs to authenticated;
grant select on public.node_commands to authenticated;
grant select on public.node_events to authenticated;

grant all on public.organizations to service_role;
grant all on public.organization_members to service_role;
grant all on public.farm_nodes to service_role;
grant all on public.cloud_printers to service_role;
grant all on public.job_files to service_role;
grant all on public.print_jobs to service_role;
grant all on public.node_commands to service_role;
grant all on public.node_events to service_role;

create policy "members can view their organizations"
on public.organizations
for select
to authenticated
using (
  exists (
    select 1
    from public.organization_members m
    where m.org_id = organizations.org_id
      and m.user_id = (select auth.uid())
  )
);

create policy "members can view own memberships"
on public.organization_members
for select
to authenticated
using (user_id = (select auth.uid()));

create policy "members can view farm nodes"
on public.farm_nodes
for select
to authenticated
using (
  org_id in (
    select m.org_id
    from public.organization_members m
    where m.user_id = (select auth.uid())
  )
);

create policy "members can view cloud printers"
on public.cloud_printers
for select
to authenticated
using (
  org_id in (
    select m.org_id
    from public.organization_members m
    where m.user_id = (select auth.uid())
  )
);

create policy "members can view job files"
on public.job_files
for select
to authenticated
using (
  org_id in (
    select m.org_id
    from public.organization_members m
    where m.user_id = (select auth.uid())
  )
);

create policy "members can view print jobs"
on public.print_jobs
for select
to authenticated
using (
  org_id in (
    select m.org_id
    from public.organization_members m
    where m.user_id = (select auth.uid())
  )
);

create policy "members can view node commands"
on public.node_commands
for select
to authenticated
using (
  org_id in (
    select m.org_id
    from public.organization_members m
    where m.user_id = (select auth.uid())
  )
);

create policy "members can view node events"
on public.node_events
for select
to authenticated
using (
  org_id in (
    select m.org_id
    from public.organization_members m
    where m.user_id = (select auth.uid())
  )
);

create or replace function public.claim_node_commands(p_node_id uuid, p_limit integer default 10)
returns setof public.node_commands
language sql
security definer
set search_path = public
as $$
  update public.node_commands
     set status = 'claimed',
         claimed_at = now(),
         updated_at = now()
   where command_id in (
     select command_id
       from public.node_commands
      where node_id = p_node_id
        and status = 'queued'
      order by created_at asc
      limit greatest(1, least(coalesce(p_limit, 10), 50))
      for update skip locked
   )
   returning *;
$$;

revoke all on function public.claim_node_commands(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_node_commands(uuid, integer) to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'print-artifacts',
  'print-artifacts',
  false,
  524288000,
  array[
    'application/octet-stream',
    'application/x-3mf',
    'model/3mf',
    'text/plain'
  ]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy "members can read org print artifacts"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'print-artifacts'
  and (storage.foldername(name))[1] in (
    select m.org_id::text
    from public.organization_members m
    where m.user_id = (select auth.uid())
  )
);

create policy "service role manages print artifacts"
on storage.objects
for all
to service_role
using (bucket_id = 'print-artifacts')
with check (bucket_id = 'print-artifacts');

create policy "members can receive org broadcasts"
on realtime.messages
for select
to authenticated
using (
  realtime.messages.extension in ('broadcast', 'presence')
  and split_part((select realtime.topic()), ':', 1) = 'org'
  and split_part((select realtime.topic()), ':', 2) in (
    select m.org_id::text
    from public.organization_members m
    where m.user_id = (select auth.uid())
  )
);

create policy "members can send org broadcasts"
on realtime.messages
for insert
to authenticated
with check (
  realtime.messages.extension in ('broadcast', 'presence')
  and split_part((select realtime.topic()), ':', 1) = 'org'
  and split_part((select realtime.topic()), ':', 2) in (
    select m.org_id::text
    from public.organization_members m
    where m.user_id = (select auth.uid())
  )
);
