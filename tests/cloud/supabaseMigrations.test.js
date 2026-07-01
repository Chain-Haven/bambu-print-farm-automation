import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

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
            expect(sql).toContain(`public.${table}`);
            expect(sql).toContain(`grant all on public.${table} to service_role`);
            expect(sql).toContain(`alter table public.${table} enable row level security`);
        }
    });

    it('enforces Merchant API v2 tenant-safe relationships', () => {
        const sql = fs.readFileSync('supabase/migrations/20260701050000_merchant_api_v2_adapter_backbone.sql', 'utf8');

        for (const constraint of [
            'merchant_files_merchant_file_id_unique unique (merchant_id, file_id)',
            'merchant_slice_jobs_merchant_slice_job_id_unique unique (merchant_id, slice_job_id)',
            'merchant_orders_merchant_order_id_unique unique (merchant_id, order_id)',
            'merchant_order_items_merchant_order_item_id_unique unique (merchant_id, order_item_id)',
            'merchant_batches_merchant_batch_id_unique unique (merchant_id, batch_id)',
            'merchant_shipments_merchant_shipment_id_unique unique (merchant_id, shipment_id)',
            'merchant_invoices_merchant_invoice_id_unique unique (merchant_id, invoice_id)',
            'merchant_webhook_endpoints_merchant_webhook_id_unique unique (merchant_id, webhook_id)',
            'print_jobs_merchant_job_id_unique unique (merchant_id, job_id)',
        ]) {
            expect(sql).toContain(`constraint ${constraint}`);
        }

        for (const foreignKey of [
            'foreign key (merchant_id, file_id) references public.merchant_files(merchant_id, file_id)',
            'foreign key (merchant_id, slice_job_id) references public.merchant_slice_jobs(merchant_id, slice_job_id)',
            'foreign key (merchant_id, order_id) references public.merchant_orders(merchant_id, order_id)',
            'foreign key (merchant_id, order_item_id) references public.merchant_order_items(merchant_id, order_item_id)',
            'foreign key (merchant_id, batch_id) references public.merchant_batches(merchant_id, batch_id)',
            'foreign key (merchant_id, job_id) references public.print_jobs(merchant_id, job_id)',
            'foreign key (merchant_id, shipment_id) references public.merchant_shipments(merchant_id, shipment_id)',
            'foreign key (merchant_id, invoice_id) references public.merchant_invoices(merchant_id, invoice_id)',
            'foreign key (merchant_id, webhook_id) references public.merchant_webhook_endpoints(merchant_id, webhook_id)',
        ]) {
            expect(sql).toContain(foreignKey);
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
