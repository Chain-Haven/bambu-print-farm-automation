-- Platform admin auth for the Vercel cloud control plane.
-- Public clients never access these tables directly. Vercel serverless
-- functions use the Supabase service role to issue reset tokens and sessions.

create table public.platform_admin_users (
  admin_user_id uuid primary key default gen_random_uuid(),
  email text not null unique,
  role text not null default 'admin' check (role in ('super_admin', 'admin')),
  status text not null default 'active' check (status in ('active', 'disabled')),
  password_hash text,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (email = lower(email)),
  check (position('@' in email) > 1)
);

create table public.platform_admin_sessions (
  session_id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null references public.platform_admin_users(admin_user_id) on delete cascade,
  token_prefix text not null,
  token_hash text not null unique,
  last_used_at timestamptz,
  revoked_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table public.platform_admin_password_resets (
  reset_token_id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null references public.platform_admin_users(admin_user_id) on delete cascade,
  token_prefix text not null,
  token_hash text not null unique,
  used_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create trigger platform_admin_users_set_updated_at
before update on public.platform_admin_users
for each row execute function public.set_updated_at();

alter table public.platform_admin_users enable row level security;
alter table public.platform_admin_sessions enable row level security;
alter table public.platform_admin_password_resets enable row level security;

grant all on public.platform_admin_users to service_role;
grant all on public.platform_admin_sessions to service_role;
grant all on public.platform_admin_password_resets to service_role;

create index platform_admin_users_email_idx on public.platform_admin_users(email);
create index platform_admin_users_role_status_idx on public.platform_admin_users(role, status);
create index platform_admin_sessions_hash_idx on public.platform_admin_sessions(token_hash);
create index platform_admin_sessions_admin_idx on public.platform_admin_sessions(admin_user_id, revoked_at, expires_at);
create index platform_admin_password_resets_hash_idx on public.platform_admin_password_resets(token_hash);
create index platform_admin_password_resets_admin_idx on public.platform_admin_password_resets(admin_user_id, used_at, expires_at);

insert into public.platform_admin_users (email, role, status)
values
  ('info@chainhaven.co', 'super_admin', 'active'),
  ('ianmebert@gmail.com', 'super_admin', 'active')
on conflict (email) do update
set role = 'super_admin',
    status = 'active',
    updated_at = now();
