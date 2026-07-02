-- Merchant portal sign-in (email/password) for the cloud control plane.
-- Merchant users are the humans behind a merchant account: they sign in to the
-- merchant portal with email + password, while pkx_live_ API keys remain the
-- machine credential for the public API. Public clients never access these
-- tables directly — Vercel serverless functions use the Supabase service role.

create table public.merchant_users (
  merchant_user_id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(merchant_id) on delete cascade,
  org_id uuid not null references public.organizations(org_id) on delete cascade,
  email text not null unique,
  display_name text,
  role text not null default 'owner' check (role in ('owner', 'member')),
  status text not null default 'active' check (status in ('active', 'disabled')),
  password_hash text,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (email = lower(email)),
  check (position('@' in email) > 1)
);

create table public.merchant_user_sessions (
  session_id uuid primary key default gen_random_uuid(),
  merchant_user_id uuid not null references public.merchant_users(merchant_user_id) on delete cascade,
  merchant_id uuid not null references public.merchants(merchant_id) on delete cascade,
  token_prefix text not null,
  token_hash text not null unique,
  last_used_at timestamptz,
  revoked_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table public.merchant_user_password_resets (
  reset_token_id uuid primary key default gen_random_uuid(),
  merchant_user_id uuid not null references public.merchant_users(merchant_user_id) on delete cascade,
  token_prefix text not null,
  token_hash text not null unique,
  used_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create trigger merchant_users_set_updated_at
before update on public.merchant_users
for each row execute function public.set_updated_at();

alter table public.merchant_users enable row level security;
alter table public.merchant_user_sessions enable row level security;
alter table public.merchant_user_password_resets enable row level security;

grant all on public.merchant_users to service_role;
grant all on public.merchant_user_sessions to service_role;
grant all on public.merchant_user_password_resets to service_role;

create index merchant_users_email_idx on public.merchant_users(email);
create index merchant_users_merchant_idx on public.merchant_users(merchant_id, status);
create index merchant_user_sessions_hash_idx on public.merchant_user_sessions(token_hash);
create index merchant_user_sessions_user_idx on public.merchant_user_sessions(merchant_user_id, revoked_at, expires_at);
create index merchant_user_password_resets_hash_idx on public.merchant_user_password_resets(token_hash);
create index merchant_user_password_resets_user_idx on public.merchant_user_password_resets(merchant_user_id, used_at, expires_at);
