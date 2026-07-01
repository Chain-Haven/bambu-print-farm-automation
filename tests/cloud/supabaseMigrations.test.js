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
});
