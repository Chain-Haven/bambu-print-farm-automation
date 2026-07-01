import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

function compactSql(sql) {
    return sql.replace(/\s+/g, ' ').trim();
}

describe('Supabase migrations', () => {
    it('allows every print job lifecycle status emitted by the merchant API', () => {
        const baseline = fs.readFileSync('supabase/migrations/20260701004316_merchant_api_v1.sql', 'utf8');
        const reprintMigration = fs.readFileSync('supabase/migrations/20260701032143_allow_reprint_requested_status.sql', 'utf8');

        for (const sql of [baseline, reprintMigration]) {
            expect(sql).toContain('print_jobs_status_check');
            expect(sql).toContain("'reprint_requested'");
        }
    });

    it('adds service-role-only platform admin auth tables and seeds super admins', () => {
        const adminMigration = fs.readFileSync('supabase/migrations/20260701034630_platform_admin_auth.sql', 'utf8');

        for (const table of [
            'platform_admin_users',
            'platform_admin_sessions',
            'platform_admin_password_resets',
        ]) {
            expect(adminMigration).toContain(`create table public.${table}`);
            expect(adminMigration).toContain(`alter table public.${table} enable row level security`);
            expect(adminMigration).toContain(`grant all on public.${table} to service_role`);
        }

        expect(adminMigration).toContain("'info@chainhaven.co'");
        expect(adminMigration).toContain("'ianmebert@gmail.com'");
        expect(adminMigration).toContain("'super_admin'");
    });

    it('includes Merchant API v2 adapter backbone tables', () => {
        const sql = fs.readFileSync('supabase/migrations/20260701050000_merchant_api_v2_adapter_backbone.sql', 'utf8');
        for (const table of [
            'merchant_files',
            'merchant_slice_jobs',
            'merchant_orders',
            'merchant_order_items',
            'merchant_material_reservations',
            'merchant_batches',
            'merchant_batch_items',
            'merchant_job_events',
            'merchant_job_artifacts',
            'merchant_inspections',
            'merchant_post_processing_tasks',
            'merchant_shipments',
            'merchant_shipping_labels',
            'merchant_rate_cards',
            'merchant_invoices',
            'merchant_invoice_lines',
            'merchant_webhook_endpoints',
            'merchant_webhook_deliveries',
            'merchant_realtime_tokens',
            'merchant_adapter_events',
        ]) {
            expect(sql).toContain(`create table public.${table}`);
            expect(sql).toContain(`grant all on public.${table} to service_role`);
            expect(sql).toContain(`alter table public.${table} enable row level security`);
        }
    });

    it('enforces Merchant API v2 tenant-safe relationships', () => {
        const sql = fs.readFileSync('supabase/migrations/20260701050000_merchant_api_v2_adapter_backbone.sql', 'utf8');
        const compact = compactSql(sql);

        for (const constraint of [
            'merchants_org_merchant_id_unique unique (org_id, merchant_id)',
            'print_jobs_org_merchant_job_id_unique unique (org_id, merchant_id, job_id)',
            'merchant_files_org_merchant_file_id_unique unique (org_id, merchant_id, file_id)',
            'merchant_slice_jobs_org_merchant_slice_job_id_unique unique (org_id, merchant_id, slice_job_id)',
            'merchant_orders_org_merchant_order_id_unique unique (org_id, merchant_id, order_id)',
            'merchant_orders_org_merchant_external_order_unique unique (org_id, merchant_id, external_order_id)',
            'merchant_orders_org_merchant_idempotency_key_unique unique (org_id, merchant_id, idempotency_key)',
            'merchant_order_items_org_merchant_order_item_id_unique unique (org_id, merchant_id, order_item_id)',
            'merchant_material_reservations_org_merchant_reservation_id_unique unique (org_id, merchant_id, reservation_id)',
            'merchant_batches_org_merchant_batch_id_unique unique (org_id, merchant_id, batch_id)',
            'merchant_batch_items_org_merchant_batch_item_id_unique unique (org_id, merchant_id, batch_item_id)',
            'merchant_job_events_org_merchant_event_id_unique unique (org_id, merchant_id, event_id)',
            'merchant_job_artifacts_org_merchant_artifact_id_unique unique (org_id, merchant_id, artifact_id)',
            'merchant_inspections_org_merchant_inspection_id_unique unique (org_id, merchant_id, inspection_id)',
            'merchant_inspections_org_merchant_job_unique unique (org_id, merchant_id, job_id)',
            'merchant_post_processing_tasks_org_merchant_task_id_unique unique (org_id, merchant_id, task_id)',
            'merchant_shipments_org_merchant_shipment_id_unique unique (org_id, merchant_id, shipment_id)',
            'merchant_shipping_labels_org_merchant_label_id_unique unique (org_id, merchant_id, label_id)',
            'merchant_rate_cards_org_merchant_rate_card_id_unique unique (org_id, merchant_id, rate_card_id)',
            'merchant_invoices_org_merchant_invoice_id_unique unique (org_id, merchant_id, invoice_id)',
            'merchant_invoice_lines_org_merchant_invoice_line_id_unique unique (org_id, merchant_id, invoice_line_id)',
            'merchant_webhook_endpoints_org_merchant_webhook_id_unique unique (org_id, merchant_id, webhook_id)',
            'merchant_webhook_deliveries_org_merchant_delivery_id_unique unique (org_id, merchant_id, delivery_id)',
            'merchant_realtime_tokens_org_merchant_token_id_unique unique (org_id, merchant_id, token_id)',
            'merchant_adapter_events_org_merchant_adapter_event_id_unique unique (org_id, merchant_id, adapter_event_id)',
        ]) {
            expect(sql).toContain(`constraint ${constraint}`);
        }

        for (const constraintName of [
            'merchant_files_merchant_scope_fk',
            'merchant_slice_jobs_merchant_scope_fk',
            'merchant_orders_merchant_scope_fk',
            'merchant_order_items_merchant_scope_fk',
            'merchant_material_reservations_merchant_scope_fk',
            'merchant_batches_merchant_scope_fk',
            'merchant_batch_items_merchant_scope_fk',
            'merchant_job_events_merchant_scope_fk',
            'merchant_job_artifacts_merchant_scope_fk',
            'merchant_inspections_merchant_scope_fk',
            'merchant_post_processing_tasks_merchant_scope_fk',
            'merchant_shipments_merchant_scope_fk',
            'merchant_shipping_labels_merchant_scope_fk',
            'merchant_rate_cards_merchant_scope_fk',
            'merchant_invoices_merchant_scope_fk',
            'merchant_invoice_lines_merchant_scope_fk',
            'merchant_webhook_endpoints_merchant_scope_fk',
            'merchant_webhook_deliveries_merchant_scope_fk',
            'merchant_realtime_tokens_merchant_scope_fk',
            'merchant_adapter_events_merchant_scope_fk',
            'merchant_slice_jobs_file_tenant_fk',
            'merchant_order_items_order_tenant_fk',
            'merchant_order_items_file_tenant_fk',
            'merchant_order_items_slice_job_tenant_fk',
            'merchant_order_items_print_job_tenant_fk',
            'merchant_material_reservations_order_tenant_fk',
            'merchant_material_reservations_batch_tenant_fk',
            'merchant_material_reservations_file_tenant_fk',
            'merchant_material_reservations_print_job_tenant_fk',
            'merchant_batch_items_batch_tenant_fk',
            'merchant_batch_items_order_tenant_fk',
            'merchant_batch_items_order_item_tenant_fk',
            'merchant_batch_items_file_tenant_fk',
            'merchant_batch_items_print_job_tenant_fk',
            'merchant_job_events_print_job_tenant_fk',
            'merchant_job_events_order_tenant_fk',
            'merchant_job_events_batch_tenant_fk',
            'merchant_job_events_slice_job_tenant_fk',
            'merchant_job_events_file_tenant_fk',
            'merchant_job_artifacts_print_job_tenant_fk',
            'merchant_job_artifacts_file_tenant_fk',
            'merchant_inspections_print_job_tenant_fk',
            'merchant_inspections_order_tenant_fk',
            'merchant_post_processing_tasks_print_job_tenant_fk',
            'merchant_post_processing_tasks_order_tenant_fk',
            'merchant_shipments_order_tenant_fk',
            'merchant_shipping_labels_shipment_tenant_fk',
            'merchant_invoice_lines_invoice_tenant_fk',
            'merchant_invoice_lines_order_tenant_fk',
            'merchant_invoice_lines_print_job_tenant_fk',
            'merchant_invoice_lines_file_tenant_fk',
            'merchant_invoice_lines_shipment_tenant_fk',
            'merchant_invoice_lines_slice_job_tenant_fk',
            'merchant_webhook_deliveries_endpoint_tenant_fk',
        ]) {
            expect(sql).toContain(`constraint ${constraintName}`);
        }

        for (const foreignKey of [
            'foreign key (org_id, merchant_id) references public.merchants(org_id, merchant_id)',
            'foreign key (org_id, merchant_id, file_id) references public.merchant_files(org_id, merchant_id, file_id)',
            'foreign key (org_id, merchant_id, slice_job_id) references public.merchant_slice_jobs(org_id, merchant_id, slice_job_id)',
            'foreign key (org_id, merchant_id, order_id) references public.merchant_orders(org_id, merchant_id, order_id)',
            'foreign key (org_id, merchant_id, order_item_id) references public.merchant_order_items(org_id, merchant_id, order_item_id)',
            'foreign key (org_id, merchant_id, batch_id) references public.merchant_batches(org_id, merchant_id, batch_id)',
            'foreign key (org_id, merchant_id, job_id) references public.print_jobs(org_id, merchant_id, job_id)',
            'foreign key (org_id, merchant_id, shipment_id) references public.merchant_shipments(org_id, merchant_id, shipment_id)',
            'foreign key (org_id, merchant_id, invoice_id) references public.merchant_invoices(org_id, merchant_id, invoice_id)',
            'foreign key (org_id, merchant_id, webhook_id) references public.merchant_webhook_endpoints(org_id, merchant_id, webhook_id)',
        ]) {
            expect(compact).toContain(foreignKey);
        }

        expect(sql).toContain('Existing print_jobs.merchant_id is nullable for non-merchant jobs');
    });

    it('requires Merchant API v2 lifecycle statuses', () => {
        const sql = fs.readFileSync('supabase/migrations/20260701050000_merchant_api_v2_adapter_backbone.sql', 'utf8');

        for (const statusCheck of [
            "check (status in ('uploaded','completed','deleted','rejected'))",
            "check (status in ('queued','running','completed_mock','completed','failed','canceled'))",
            "check (status in ('draft','submitted','partially_routed','in_production','awaiting_quality','post_processing','ready_to_ship','shipped','completed','canceled','failed'))",
            "check (status in ('reserved','released','expired','consumed'))",
            "check (status in ('queued','running','paused','completed','canceled','failed'))",
            "check (status in ('pending','passed','failed','manual_review'))",
            "check (status in ('pending','running','completed','skipped','failed'))",
            "check (status in ('created','label_requested','label_created','shipped','delivered','canceled'))",
            "check (status in ('draft','issued','void'))",
            "check (status in ('active','disabled'))",
            "check (status in ('queued','delivered','failed','mock_recorded'))",
        ]) {
            expect(sql).toContain(statusCheck);
        }
    });
});
