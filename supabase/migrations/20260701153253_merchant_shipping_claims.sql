alter table public.merchant_shipments
  add column if not exists idempotency_key text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'merchant_shipments_org_merchant_idempotency_key_unique'
      and conrelid = 'public.merchant_shipments'::regclass
  ) then
    alter table public.merchant_shipments
      add constraint merchant_shipments_org_merchant_idempotency_key_unique
      unique (org_id, merchant_id, idempotency_key);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'merchant_shipping_labels_org_merchant_shipment_id_unique'
      and conrelid = 'public.merchant_shipping_labels'::regclass
  ) then
    alter table public.merchant_shipping_labels
      add constraint merchant_shipping_labels_org_merchant_shipment_id_unique
      unique (org_id, merchant_id, shipment_id);
  end if;
end $$;
