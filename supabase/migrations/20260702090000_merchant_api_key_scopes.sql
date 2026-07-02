-- Add a scopes column to merchant_api_keys so API keys can be scoped to a
-- subset of operations (e.g. print:submit, print:control, files:write) instead
-- of always being unrestricted. Defaults to ["*"] for backward compatibility
-- with keys created before this migration. The application only reads/writes
-- this column when MERCHANT_API_KEY_SCOPES_ENABLED=true, so environments that
-- have not yet applied this migration keep working unchanged.

alter table public.merchant_api_keys
  add column if not exists scopes jsonb not null default '["*"]'::jsonb;

grant all on public.merchant_api_keys to service_role;
