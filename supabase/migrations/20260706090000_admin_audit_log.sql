-- Admin audit log for the cloud control plane. Every privileged mutation made
-- through the operator console / admin API (merchant approvals, API key
-- issue/revoke, node provision/delete, queued commands, settings changes,
-- job cancellations, admin account management) records who did what, to which
-- target, when. Public clients never access this table directly — Vercel
-- serverless functions use the Supabase service role.

create table public.admin_audit_log (
  audit_id uuid primary key default gen_random_uuid(),
  actor_email text not null,
  actor_role text,
  auth_type text,
  action text not null,
  target_type text,
  target_id text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.admin_audit_log enable row level security;

grant all on public.admin_audit_log to service_role;

create index admin_audit_log_created_idx on public.admin_audit_log(created_at desc);
create index admin_audit_log_action_idx on public.admin_audit_log(action, created_at desc);
create index admin_audit_log_target_idx on public.admin_audit_log(target_type, target_id);
create index admin_audit_log_actor_idx on public.admin_audit_log(actor_email, created_at desc);
