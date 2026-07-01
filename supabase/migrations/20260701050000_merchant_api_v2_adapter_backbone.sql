-- Merchant API v2 adapter-backed resource backbone.

create table public.merchant_files (
  file_id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(org_id) on delete cascade,
  merchant_id uuid not null references public.merchants(merchant_id) on delete cascade,
  original_name text not null,
  content_type text not null default 'application/octet-stream',
  byte_size bigint not null default 0 check (byte_size >= 0),
  checksum_sha256 text,
  file_mode text not null default 'ready_to_print' check (file_mode in ('ready_to_print','source_model')),
  storage_path text,
  status text not null default 'uploaded' check (status in ('uploaded','completed','deleted','rejected')),
  completed_at timestamptz,
  deleted_at timestamptz,
  rejected_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.merchant_slice_jobs (
  slice_job_id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(org_id) on delete cascade,
  merchant_id uuid not null references public.merchants(merchant_id) on delete cascade,
  file_id uuid references public.merchant_files(file_id) on delete set null,
  profile jsonb not null default '{}'::jsonb,
  requirements jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued','running','completed_mock','completed','failed','canceled')),
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  canceled_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.merchant_orders (
  order_id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(org_id) on delete cascade,
  merchant_id uuid not null references public.merchants(merchant_id) on delete cascade,
  external_order_id text,
  idempotency_key text,
  status text not null default 'draft' check (status in ('draft','submitted','partially_routed','in_production','awaiting_quality','post_processing','ready_to_ship','shipped','completed','canceled','failed')),
  customer jsonb not null default '{}'::jsonb,
  shipping_address jsonb not null default '{}'::jsonb,
  billing_address jsonb not null default '{}'::jsonb,
  totals jsonb not null default '{}'::jsonb,
  due_at timestamptz,
  submitted_at timestamptz,
  completed_at timestamptz,
  canceled_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (merchant_id, external_order_id),
  unique (merchant_id, idempotency_key)
);

create table public.merchant_batches (
  batch_id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(org_id) on delete cascade,
  merchant_id uuid not null references public.merchants(merchant_id) on delete cascade,
  name text not null,
  strategy text not null default 'batch_by_material',
  status text not null default 'queued' check (status in ('queued','running','paused','completed','canceled','failed')),
  settings jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  paused_at timestamptz,
  completed_at timestamptz,
  canceled_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.merchant_order_items (
  order_item_id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(org_id) on delete cascade,
  merchant_id uuid not null references public.merchants(merchant_id) on delete cascade,
  order_id uuid not null references public.merchant_orders(order_id) on delete cascade,
  file_id uuid references public.merchant_files(file_id) on delete set null,
  slice_job_id uuid references public.merchant_slice_jobs(slice_job_id) on delete set null,
  job_id uuid references public.print_jobs(job_id) on delete set null,
  sku text,
  name text,
  quantity integer not null default 1 check (quantity > 0),
  unit_amount numeric(12, 2) not null default 0 check (unit_amount >= 0),
  requirements jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.merchant_material_reservations (
  reservation_id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(org_id) on delete cascade,
  merchant_id uuid not null references public.merchants(merchant_id) on delete cascade,
  order_id uuid references public.merchant_orders(order_id) on delete set null,
  batch_id uuid references public.merchant_batches(batch_id) on delete set null,
  file_id uuid references public.merchant_files(file_id) on delete set null,
  job_id uuid references public.print_jobs(job_id) on delete set null,
  material text not null,
  color text,
  grams numeric(12, 3) not null default 0 check (grams >= 0),
  status text not null default 'reserved' check (status in ('reserved','released','expired','consumed')),
  expires_at timestamptz,
  released_at timestamptz,
  consumed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.merchant_batch_items (
  batch_item_id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(org_id) on delete cascade,
  merchant_id uuid not null references public.merchants(merchant_id) on delete cascade,
  batch_id uuid not null references public.merchant_batches(batch_id) on delete cascade,
  order_id uuid references public.merchant_orders(order_id) on delete set null,
  order_item_id uuid references public.merchant_order_items(order_item_id) on delete set null,
  file_id uuid references public.merchant_files(file_id) on delete set null,
  job_id uuid references public.print_jobs(job_id) on delete set null,
  quantity integer not null default 1 check (quantity > 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.merchant_job_events (
  event_id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(org_id) on delete cascade,
  merchant_id uuid not null references public.merchants(merchant_id) on delete cascade,
  job_id uuid references public.print_jobs(job_id) on delete set null,
  order_id uuid references public.merchant_orders(order_id) on delete set null,
  batch_id uuid references public.merchant_batches(batch_id) on delete set null,
  slice_job_id uuid references public.merchant_slice_jobs(slice_job_id) on delete set null,
  file_id uuid references public.merchant_files(file_id) on delete set null,
  event_type text not null,
  message text,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.merchant_job_artifacts (
  artifact_id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(org_id) on delete cascade,
  merchant_id uuid not null references public.merchants(merchant_id) on delete cascade,
  job_id uuid references public.print_jobs(job_id) on delete set null,
  file_id uuid references public.merchant_files(file_id) on delete set null,
  artifact_type text not null,
  storage_path text,
  provider text not null default 'internal',
  payload jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.merchant_inspections (
  inspection_id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(org_id) on delete cascade,
  merchant_id uuid not null references public.merchants(merchant_id) on delete cascade,
  job_id uuid references public.print_jobs(job_id) on delete set null,
  order_id uuid references public.merchant_orders(order_id) on delete set null,
  provider text not null default 'mock',
  status text not null default 'pending' check (status in ('pending','passed','failed','manual_review')),
  decision text,
  inspected_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (merchant_id, job_id)
);

create table public.merchant_post_processing_tasks (
  task_id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(org_id) on delete cascade,
  merchant_id uuid not null references public.merchants(merchant_id) on delete cascade,
  job_id uuid references public.print_jobs(job_id) on delete set null,
  order_id uuid references public.merchant_orders(order_id) on delete set null,
  task_type text not null,
  status text not null default 'pending' check (status in ('pending','running','completed','skipped','failed')),
  assigned_to text,
  started_at timestamptz,
  completed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.merchant_shipments (
  shipment_id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(org_id) on delete cascade,
  merchant_id uuid not null references public.merchants(merchant_id) on delete cascade,
  order_id uuid references public.merchant_orders(order_id) on delete set null,
  status text not null default 'created' check (status in ('created','label_requested','label_created','shipped','delivered','canceled')),
  carrier text,
  service_level text,
  tracking_number text,
  ship_to jsonb not null default '{}'::jsonb,
  packages jsonb not null default '[]'::jsonb,
  shipped_at timestamptz,
  delivered_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.merchant_shipping_labels (
  label_id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(org_id) on delete cascade,
  merchant_id uuid not null references public.merchants(merchant_id) on delete cascade,
  shipment_id uuid not null references public.merchant_shipments(shipment_id) on delete cascade,
  provider text not null default 'mock',
  label_url text,
  tracking_number text,
  label_payload jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.merchant_rate_cards (
  rate_card_id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(org_id) on delete cascade,
  merchant_id uuid not null references public.merchants(merchant_id) on delete cascade,
  name text not null,
  currency text not null default 'USD',
  status text not null default 'active' check (status in ('active','disabled')),
  rates jsonb not null default '{}'::jsonb,
  effective_at timestamptz not null default now(),
  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.merchant_invoices (
  invoice_id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(org_id) on delete cascade,
  merchant_id uuid not null references public.merchants(merchant_id) on delete cascade,
  status text not null default 'draft' check (status in ('draft','issued','void')),
  period_start timestamptz,
  period_end timestamptz,
  currency text not null default 'USD',
  subtotal numeric(12, 2) not null default 0 check (subtotal >= 0),
  total numeric(12, 2) not null default 0 check (total >= 0),
  issued_at timestamptz,
  voided_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.merchant_invoice_lines (
  invoice_line_id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(org_id) on delete cascade,
  merchant_id uuid not null references public.merchants(merchant_id) on delete cascade,
  invoice_id uuid not null references public.merchant_invoices(invoice_id) on delete cascade,
  order_id uuid references public.merchant_orders(order_id) on delete set null,
  job_id uuid references public.print_jobs(job_id) on delete set null,
  file_id uuid references public.merchant_files(file_id) on delete set null,
  shipment_id uuid references public.merchant_shipments(shipment_id) on delete set null,
  slice_job_id uuid references public.merchant_slice_jobs(slice_job_id) on delete set null,
  description text not null,
  quantity numeric(12, 3) not null default 1 check (quantity >= 0),
  unit_amount numeric(12, 2) not null default 0 check (unit_amount >= 0),
  total_amount numeric(12, 2) not null default 0 check (total_amount >= 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.merchant_webhook_endpoints (
  webhook_id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(org_id) on delete cascade,
  merchant_id uuid not null references public.merchants(merchant_id) on delete cascade,
  url text not null,
  description text,
  events jsonb not null default '[]'::jsonb,
  secret_hash text,
  status text not null default 'active' check (status in ('active','disabled')),
  last_delivery_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.merchant_webhook_deliveries (
  delivery_id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(org_id) on delete cascade,
  merchant_id uuid not null references public.merchants(merchant_id) on delete cascade,
  webhook_id uuid references public.merchant_webhook_endpoints(webhook_id) on delete set null,
  event_type text not null,
  status text not null default 'queued' check (status in ('queued','delivered','failed','mock_recorded')),
  request_payload jsonb not null default '{}'::jsonb,
  response_status integer,
  response_body text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_retry_at timestamptz,
  delivered_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.merchant_realtime_tokens (
  token_id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(org_id) on delete cascade,
  merchant_id uuid not null references public.merchants(merchant_id) on delete cascade,
  token_prefix text not null,
  token_hash text not null unique,
  scopes jsonb not null default '[]'::jsonb,
  channel_names jsonb not null default '[]'::jsonb,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.merchant_adapter_events (
  adapter_event_id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(org_id) on delete cascade,
  merchant_id uuid not null references public.merchants(merchant_id) on delete cascade,
  adapter_name text not null,
  event_type text not null,
  resource_type text,
  resource_id uuid,
  payload jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Existing print_jobs.merchant_id is nullable for non-merchant jobs. V2 rows
-- have non-null merchant_id, so this composite reference only permits v2 rows
-- to point at merchant-scoped jobs owned by the same merchant.
alter table public.print_jobs
  add constraint print_jobs_merchant_job_id_unique unique (merchant_id, job_id);

alter table public.merchant_files
  add constraint merchant_files_merchant_file_id_unique unique (merchant_id, file_id);

alter table public.merchant_slice_jobs
  add constraint merchant_slice_jobs_merchant_slice_job_id_unique unique (merchant_id, slice_job_id);

alter table public.merchant_orders
  add constraint merchant_orders_merchant_order_id_unique unique (merchant_id, order_id);

alter table public.merchant_order_items
  add constraint merchant_order_items_merchant_order_item_id_unique unique (merchant_id, order_item_id);

alter table public.merchant_material_reservations
  add constraint merchant_material_reservations_merchant_reservation_id_unique unique (merchant_id, reservation_id);

alter table public.merchant_batches
  add constraint merchant_batches_merchant_batch_id_unique unique (merchant_id, batch_id);

alter table public.merchant_batch_items
  add constraint merchant_batch_items_merchant_batch_item_id_unique unique (merchant_id, batch_item_id);

alter table public.merchant_job_events
  add constraint merchant_job_events_merchant_event_id_unique unique (merchant_id, event_id);

alter table public.merchant_job_artifacts
  add constraint merchant_job_artifacts_merchant_artifact_id_unique unique (merchant_id, artifact_id);

alter table public.merchant_inspections
  add constraint merchant_inspections_merchant_inspection_id_unique unique (merchant_id, inspection_id);

alter table public.merchant_post_processing_tasks
  add constraint merchant_post_processing_tasks_merchant_task_id_unique unique (merchant_id, task_id);

alter table public.merchant_shipments
  add constraint merchant_shipments_merchant_shipment_id_unique unique (merchant_id, shipment_id);

alter table public.merchant_shipping_labels
  add constraint merchant_shipping_labels_merchant_label_id_unique unique (merchant_id, label_id);

alter table public.merchant_rate_cards
  add constraint merchant_rate_cards_merchant_rate_card_id_unique unique (merchant_id, rate_card_id);

alter table public.merchant_invoices
  add constraint merchant_invoices_merchant_invoice_id_unique unique (merchant_id, invoice_id);

alter table public.merchant_invoice_lines
  add constraint merchant_invoice_lines_merchant_invoice_line_id_unique unique (merchant_id, invoice_line_id);

alter table public.merchant_webhook_endpoints
  add constraint merchant_webhook_endpoints_merchant_webhook_id_unique unique (merchant_id, webhook_id);

alter table public.merchant_webhook_deliveries
  add constraint merchant_webhook_deliveries_merchant_delivery_id_unique unique (merchant_id, delivery_id);

alter table public.merchant_realtime_tokens
  add constraint merchant_realtime_tokens_merchant_token_id_unique unique (merchant_id, token_id);

alter table public.merchant_adapter_events
  add constraint merchant_adapter_events_merchant_adapter_event_id_unique unique (merchant_id, adapter_event_id);

alter table public.merchant_slice_jobs
  add constraint merchant_slice_jobs_file_tenant_fk
  foreign key (merchant_id, file_id) references public.merchant_files(merchant_id, file_id)
  on delete set null (file_id);

alter table public.merchant_order_items
  add constraint merchant_order_items_order_tenant_fk
  foreign key (merchant_id, order_id) references public.merchant_orders(merchant_id, order_id)
  on delete cascade,
  add constraint merchant_order_items_file_tenant_fk
  foreign key (merchant_id, file_id) references public.merchant_files(merchant_id, file_id)
  on delete set null (file_id),
  add constraint merchant_order_items_slice_job_tenant_fk
  foreign key (merchant_id, slice_job_id) references public.merchant_slice_jobs(merchant_id, slice_job_id)
  on delete set null (slice_job_id),
  add constraint merchant_order_items_print_job_tenant_fk
  foreign key (merchant_id, job_id) references public.print_jobs(merchant_id, job_id)
  on delete set null (job_id);

alter table public.merchant_material_reservations
  add constraint merchant_material_reservations_order_tenant_fk
  foreign key (merchant_id, order_id) references public.merchant_orders(merchant_id, order_id)
  on delete set null (order_id),
  add constraint merchant_material_reservations_batch_tenant_fk
  foreign key (merchant_id, batch_id) references public.merchant_batches(merchant_id, batch_id)
  on delete set null (batch_id),
  add constraint merchant_material_reservations_file_tenant_fk
  foreign key (merchant_id, file_id) references public.merchant_files(merchant_id, file_id)
  on delete set null (file_id),
  add constraint merchant_material_reservations_print_job_tenant_fk
  foreign key (merchant_id, job_id) references public.print_jobs(merchant_id, job_id)
  on delete set null (job_id);

alter table public.merchant_batch_items
  add constraint merchant_batch_items_batch_tenant_fk
  foreign key (merchant_id, batch_id) references public.merchant_batches(merchant_id, batch_id)
  on delete cascade,
  add constraint merchant_batch_items_order_tenant_fk
  foreign key (merchant_id, order_id) references public.merchant_orders(merchant_id, order_id)
  on delete set null (order_id),
  add constraint merchant_batch_items_order_item_tenant_fk
  foreign key (merchant_id, order_item_id) references public.merchant_order_items(merchant_id, order_item_id)
  on delete set null (order_item_id),
  add constraint merchant_batch_items_file_tenant_fk
  foreign key (merchant_id, file_id) references public.merchant_files(merchant_id, file_id)
  on delete set null (file_id),
  add constraint merchant_batch_items_print_job_tenant_fk
  foreign key (merchant_id, job_id) references public.print_jobs(merchant_id, job_id)
  on delete set null (job_id);

alter table public.merchant_job_events
  add constraint merchant_job_events_print_job_tenant_fk
  foreign key (merchant_id, job_id) references public.print_jobs(merchant_id, job_id)
  on delete set null (job_id),
  add constraint merchant_job_events_order_tenant_fk
  foreign key (merchant_id, order_id) references public.merchant_orders(merchant_id, order_id)
  on delete set null (order_id),
  add constraint merchant_job_events_batch_tenant_fk
  foreign key (merchant_id, batch_id) references public.merchant_batches(merchant_id, batch_id)
  on delete set null (batch_id),
  add constraint merchant_job_events_slice_job_tenant_fk
  foreign key (merchant_id, slice_job_id) references public.merchant_slice_jobs(merchant_id, slice_job_id)
  on delete set null (slice_job_id),
  add constraint merchant_job_events_file_tenant_fk
  foreign key (merchant_id, file_id) references public.merchant_files(merchant_id, file_id)
  on delete set null (file_id);

alter table public.merchant_job_artifacts
  add constraint merchant_job_artifacts_print_job_tenant_fk
  foreign key (merchant_id, job_id) references public.print_jobs(merchant_id, job_id)
  on delete set null (job_id),
  add constraint merchant_job_artifacts_file_tenant_fk
  foreign key (merchant_id, file_id) references public.merchant_files(merchant_id, file_id)
  on delete set null (file_id);

alter table public.merchant_inspections
  add constraint merchant_inspections_print_job_tenant_fk
  foreign key (merchant_id, job_id) references public.print_jobs(merchant_id, job_id)
  on delete set null (job_id),
  add constraint merchant_inspections_order_tenant_fk
  foreign key (merchant_id, order_id) references public.merchant_orders(merchant_id, order_id)
  on delete set null (order_id);

alter table public.merchant_post_processing_tasks
  add constraint merchant_post_processing_tasks_print_job_tenant_fk
  foreign key (merchant_id, job_id) references public.print_jobs(merchant_id, job_id)
  on delete set null (job_id),
  add constraint merchant_post_processing_tasks_order_tenant_fk
  foreign key (merchant_id, order_id) references public.merchant_orders(merchant_id, order_id)
  on delete set null (order_id);

alter table public.merchant_shipments
  add constraint merchant_shipments_order_tenant_fk
  foreign key (merchant_id, order_id) references public.merchant_orders(merchant_id, order_id)
  on delete set null (order_id);

alter table public.merchant_shipping_labels
  add constraint merchant_shipping_labels_shipment_tenant_fk
  foreign key (merchant_id, shipment_id) references public.merchant_shipments(merchant_id, shipment_id)
  on delete cascade;

alter table public.merchant_invoice_lines
  add constraint merchant_invoice_lines_invoice_tenant_fk
  foreign key (merchant_id, invoice_id) references public.merchant_invoices(merchant_id, invoice_id)
  on delete cascade,
  add constraint merchant_invoice_lines_order_tenant_fk
  foreign key (merchant_id, order_id) references public.merchant_orders(merchant_id, order_id)
  on delete set null (order_id),
  add constraint merchant_invoice_lines_print_job_tenant_fk
  foreign key (merchant_id, job_id) references public.print_jobs(merchant_id, job_id)
  on delete set null (job_id),
  add constraint merchant_invoice_lines_file_tenant_fk
  foreign key (merchant_id, file_id) references public.merchant_files(merchant_id, file_id)
  on delete set null (file_id),
  add constraint merchant_invoice_lines_shipment_tenant_fk
  foreign key (merchant_id, shipment_id) references public.merchant_shipments(merchant_id, shipment_id)
  on delete set null (shipment_id),
  add constraint merchant_invoice_lines_slice_job_tenant_fk
  foreign key (merchant_id, slice_job_id) references public.merchant_slice_jobs(merchant_id, slice_job_id)
  on delete set null (slice_job_id);

alter table public.merchant_webhook_deliveries
  add constraint merchant_webhook_deliveries_endpoint_tenant_fk
  foreign key (merchant_id, webhook_id) references public.merchant_webhook_endpoints(merchant_id, webhook_id)
  on delete set null (webhook_id);

create trigger merchant_files_set_updated_at
before update on public.merchant_files
for each row execute function public.set_updated_at();

create trigger merchant_slice_jobs_set_updated_at
before update on public.merchant_slice_jobs
for each row execute function public.set_updated_at();

create trigger merchant_orders_set_updated_at
before update on public.merchant_orders
for each row execute function public.set_updated_at();

create trigger merchant_order_items_set_updated_at
before update on public.merchant_order_items
for each row execute function public.set_updated_at();

create trigger merchant_material_reservations_set_updated_at
before update on public.merchant_material_reservations
for each row execute function public.set_updated_at();

create trigger merchant_batches_set_updated_at
before update on public.merchant_batches
for each row execute function public.set_updated_at();

create trigger merchant_batch_items_set_updated_at
before update on public.merchant_batch_items
for each row execute function public.set_updated_at();

create trigger merchant_job_events_set_updated_at
before update on public.merchant_job_events
for each row execute function public.set_updated_at();

create trigger merchant_job_artifacts_set_updated_at
before update on public.merchant_job_artifacts
for each row execute function public.set_updated_at();

create trigger merchant_inspections_set_updated_at
before update on public.merchant_inspections
for each row execute function public.set_updated_at();

create trigger merchant_post_processing_tasks_set_updated_at
before update on public.merchant_post_processing_tasks
for each row execute function public.set_updated_at();

create trigger merchant_shipments_set_updated_at
before update on public.merchant_shipments
for each row execute function public.set_updated_at();

create trigger merchant_shipping_labels_set_updated_at
before update on public.merchant_shipping_labels
for each row execute function public.set_updated_at();

create trigger merchant_rate_cards_set_updated_at
before update on public.merchant_rate_cards
for each row execute function public.set_updated_at();

create trigger merchant_invoices_set_updated_at
before update on public.merchant_invoices
for each row execute function public.set_updated_at();

create trigger merchant_invoice_lines_set_updated_at
before update on public.merchant_invoice_lines
for each row execute function public.set_updated_at();

create trigger merchant_webhook_endpoints_set_updated_at
before update on public.merchant_webhook_endpoints
for each row execute function public.set_updated_at();

create trigger merchant_webhook_deliveries_set_updated_at
before update on public.merchant_webhook_deliveries
for each row execute function public.set_updated_at();

create trigger merchant_realtime_tokens_set_updated_at
before update on public.merchant_realtime_tokens
for each row execute function public.set_updated_at();

create trigger merchant_adapter_events_set_updated_at
before update on public.merchant_adapter_events
for each row execute function public.set_updated_at();

alter table public.merchant_files enable row level security;
alter table public.merchant_slice_jobs enable row level security;
alter table public.merchant_orders enable row level security;
alter table public.merchant_order_items enable row level security;
alter table public.merchant_material_reservations enable row level security;
alter table public.merchant_batches enable row level security;
alter table public.merchant_batch_items enable row level security;
alter table public.merchant_job_events enable row level security;
alter table public.merchant_job_artifacts enable row level security;
alter table public.merchant_inspections enable row level security;
alter table public.merchant_post_processing_tasks enable row level security;
alter table public.merchant_shipments enable row level security;
alter table public.merchant_shipping_labels enable row level security;
alter table public.merchant_rate_cards enable row level security;
alter table public.merchant_invoices enable row level security;
alter table public.merchant_invoice_lines enable row level security;
alter table public.merchant_webhook_endpoints enable row level security;
alter table public.merchant_webhook_deliveries enable row level security;
alter table public.merchant_realtime_tokens enable row level security;
alter table public.merchant_adapter_events enable row level security;

grant all on public.merchant_files to service_role;
grant all on public.merchant_slice_jobs to service_role;
grant all on public.merchant_orders to service_role;
grant all on public.merchant_order_items to service_role;
grant all on public.merchant_material_reservations to service_role;
grant all on public.merchant_batches to service_role;
grant all on public.merchant_batch_items to service_role;
grant all on public.merchant_job_events to service_role;
grant all on public.merchant_job_artifacts to service_role;
grant all on public.merchant_inspections to service_role;
grant all on public.merchant_post_processing_tasks to service_role;
grant all on public.merchant_shipments to service_role;
grant all on public.merchant_shipping_labels to service_role;
grant all on public.merchant_rate_cards to service_role;
grant all on public.merchant_invoices to service_role;
grant all on public.merchant_invoice_lines to service_role;
grant all on public.merchant_webhook_endpoints to service_role;
grant all on public.merchant_webhook_deliveries to service_role;
grant all on public.merchant_realtime_tokens to service_role;
grant all on public.merchant_adapter_events to service_role;

create index merchant_files_merchant_created_idx on public.merchant_files(merchant_id, created_at desc);
create index merchant_files_merchant_status_idx on public.merchant_files(merchant_id, status, created_at desc);
create index merchant_slice_jobs_merchant_created_idx on public.merchant_slice_jobs(merchant_id, created_at desc);
create index merchant_slice_jobs_merchant_status_idx on public.merchant_slice_jobs(merchant_id, status, created_at desc);
create index merchant_slice_jobs_file_idx on public.merchant_slice_jobs(file_id, created_at desc);
create index merchant_orders_merchant_created_idx on public.merchant_orders(merchant_id, created_at desc);
create index merchant_orders_merchant_status_idx on public.merchant_orders(merchant_id, status, created_at desc);
create index merchant_order_items_order_idx on public.merchant_order_items(order_id, created_at desc);
create index merchant_order_items_merchant_idx on public.merchant_order_items(merchant_id, created_at desc);
create index merchant_material_reservations_merchant_created_idx on public.merchant_material_reservations(merchant_id, created_at desc);
create index merchant_material_reservations_merchant_status_idx on public.merchant_material_reservations(merchant_id, status, created_at desc);
create index merchant_material_reservations_order_idx on public.merchant_material_reservations(order_id, created_at desc);
create index merchant_batches_merchant_created_idx on public.merchant_batches(merchant_id, created_at desc);
create index merchant_batches_merchant_status_idx on public.merchant_batches(merchant_id, status, created_at desc);
create index merchant_batch_items_batch_idx on public.merchant_batch_items(batch_id, created_at desc);
create index merchant_batch_items_merchant_idx on public.merchant_batch_items(merchant_id, created_at desc);
create index merchant_job_events_merchant_created_idx on public.merchant_job_events(merchant_id, created_at desc);
create index merchant_job_events_job_idx on public.merchant_job_events(job_id, occurred_at desc);
create index merchant_job_events_type_idx on public.merchant_job_events(merchant_id, event_type, occurred_at desc);
create index merchant_job_artifacts_merchant_created_idx on public.merchant_job_artifacts(merchant_id, created_at desc);
create index merchant_job_artifacts_job_idx on public.merchant_job_artifacts(job_id, created_at desc);
create index merchant_inspections_merchant_created_idx on public.merchant_inspections(merchant_id, created_at desc);
create index merchant_inspections_merchant_status_idx on public.merchant_inspections(merchant_id, status, created_at desc);
create index merchant_inspections_job_idx on public.merchant_inspections(job_id, created_at desc);
create index merchant_post_processing_tasks_merchant_created_idx on public.merchant_post_processing_tasks(merchant_id, created_at desc);
create index merchant_post_processing_tasks_merchant_status_idx on public.merchant_post_processing_tasks(merchant_id, status, created_at desc);
create index merchant_post_processing_tasks_job_idx on public.merchant_post_processing_tasks(job_id, created_at desc);
create index merchant_shipments_merchant_created_idx on public.merchant_shipments(merchant_id, created_at desc);
create index merchant_shipments_merchant_status_idx on public.merchant_shipments(merchant_id, status, created_at desc);
create index merchant_shipments_order_idx on public.merchant_shipments(order_id, created_at desc);
create index merchant_shipping_labels_merchant_created_idx on public.merchant_shipping_labels(merchant_id, created_at desc);
create index merchant_shipping_labels_shipment_idx on public.merchant_shipping_labels(shipment_id, created_at desc);
create index merchant_rate_cards_merchant_created_idx on public.merchant_rate_cards(merchant_id, created_at desc);
create index merchant_rate_cards_merchant_status_idx on public.merchant_rate_cards(merchant_id, status, effective_at desc);
create index merchant_invoices_merchant_created_idx on public.merchant_invoices(merchant_id, created_at desc);
create index merchant_invoices_merchant_status_idx on public.merchant_invoices(merchant_id, status, created_at desc);
create index merchant_invoice_lines_invoice_idx on public.merchant_invoice_lines(invoice_id, created_at desc);
create index merchant_invoice_lines_merchant_idx on public.merchant_invoice_lines(merchant_id, created_at desc);
create index merchant_webhook_endpoints_merchant_created_idx on public.merchant_webhook_endpoints(merchant_id, created_at desc);
create index merchant_webhook_endpoints_merchant_status_idx on public.merchant_webhook_endpoints(merchant_id, status, created_at desc);
create index merchant_webhook_deliveries_merchant_created_idx on public.merchant_webhook_deliveries(merchant_id, created_at desc);
create index merchant_webhook_deliveries_merchant_status_idx on public.merchant_webhook_deliveries(merchant_id, status, created_at desc);
create index merchant_webhook_deliveries_webhook_idx on public.merchant_webhook_deliveries(webhook_id, created_at desc);
create index merchant_realtime_tokens_merchant_created_idx on public.merchant_realtime_tokens(merchant_id, created_at desc);
create index merchant_realtime_tokens_hash_idx on public.merchant_realtime_tokens(token_hash);
create index merchant_adapter_events_merchant_created_idx on public.merchant_adapter_events(merchant_id, created_at desc);
create index merchant_adapter_events_adapter_idx on public.merchant_adapter_events(merchant_id, adapter_name, created_at desc);
