-- One-time setup tokens let an approved/full-auto merchant create the first
-- live API key before a full user-login system exists.

create table public.merchant_setup_tokens (
  setup_token_id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(merchant_id) on delete cascade,
  org_id uuid not null references public.organizations(org_id) on delete cascade,
  token_prefix text not null,
  token_hash text not null unique,
  used_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.merchant_setup_tokens enable row level security;

grant all on public.merchant_setup_tokens to service_role;

create index merchant_setup_tokens_hash_idx on public.merchant_setup_tokens(token_hash);
create index merchant_setup_tokens_merchant_idx on public.merchant_setup_tokens(merchant_id, used_at, expires_at);
