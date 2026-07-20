import AdmZip from 'adm-zip';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryCloudStore } from '../../src/cloud/memoryCloudStore.js';
import { sendOperatorAlert } from '../../src/cloud/operatorAlerts.js';
import { buyShippingLabel } from '../../src/cloud/shippingLabels.js';
import { createStripeRefund, toStripeForm } from '../../src/cloud/stripePayments.js';
import { buildWooCommercePluginZip } from '../../src/cloud/woocommercePlugin.js';
import { normalizeFarmAutomationSettings } from '../../src/cloud/farmAutomation.js';
import { createEventsHandler } from '../../src/cloud/agentHandlers.js';
import { hashNodeToken } from '../../src/cloud/agentProtocol.js';
import { storeUploadedJobFile } from '../../src/cloud/merchantPrintHandlers.js';

const NOW = () => new Date('2026-07-09T15:00:00.000Z');

function makeRes() {
    return {
        statusCode: 0,
        headers: {},
        body: null,
        setHeader(name, value) { this.headers[name] = value; },
        end(payload) { this.body = payload ? JSON.parse(payload) : null; return this; },
    };
}

describe('operator alerts', () => {
    it('fans out to discord, slack, webhook, and email channels', async () => {
        const store = createMemoryCloudStore();
        await store.upsertPlatformSetting('farm_integrations', {
            alerts: [
                { type: 'discord', url: 'https://discord.example/hook' },
                { type: 'slack', url: 'https://slack.example/hook' },
                { type: 'webhook', url: 'https://ops.example/hook' },
                { type: 'email', email: 'ops@farm.example' },
                { type: 'discord', url: 'https://broken.example/hook' },
            ],
        });
        const calls = [];
        const fetchImpl = vi.fn(async (url) => {
            calls.push(String(url));
            if (String(url).includes('broken')) return { ok: false, status: 500 };
            return { ok: true, status: 200, text: async () => '' };
        });
        const sent = [];
        const mailer = { send: async (message) => { sent.push(message); } };

        const result = await sendOperatorAlert({
            store,
            fetchImpl,
            mailer,
            event: { kind: 'job.failed', severity: 'critical', title: 'Print FAILED', detail: 'reason X' },
        });

        expect(result).toEqual({ delivered: 4, failed: 1 });
        expect(calls).toHaveLength(4); // 3 ok webhooks + 1 broken
        expect(sent[0].subject).toContain('Print FAILED');
    });

    it('is silent with no channels configured', async () => {
        const store = createMemoryCloudStore();
        const result = await sendOperatorAlert({ store, event: { title: 'x' } });
        expect(result).toEqual({ delivered: 0, failed: 0 });
    });
});

describe('shipping labels (EasyPost)', () => {
    it('creates a shipment, picks the cheapest rate, and buys it', async () => {
        const requests = [];
        const fetchImpl = vi.fn(async (url, options) => {
            requests.push({ url: String(url), options });
            if (String(url).endsWith('/shipments')) {
                return {
                    ok: true, status: 200,
                    text: async () => JSON.stringify({
                        id: 'shp_1',
                        rates: [
                            { id: 'rate_expensive', carrier: 'UPS', service: 'Ground', rate: '12.40' },
                            { id: 'rate_cheap', carrier: 'USPS', service: 'GroundAdvantage', rate: '6.10' },
                        ],
                    }),
                };
            }
            return {
                ok: true, status: 200,
                text: async () => JSON.stringify({
                    id: 'shp_1',
                    tracking_code: '9400ABC',
                    postage_label: { label_url: 'https://labels.example/1.pdf' },
                }),
            };
        });

        const label = await buyShippingLabel({
            settings: { shipping: { easypost_api_key: 'EZTKtest' } },
            toAddress: { line1: '1 Print Ln', city: 'Austin', region: 'TX', postal_code: '78701', country: 'US' },
            toName: 'Casey Maker',
            fromAddress: { address_line1: '5151 Mitchelldale St', city: 'Houston', state_or_region: 'TX', postal_code: '77092', country_code: 'US' },
            weightGrams: 350,
            fetchImpl,
        });

        expect(label).toMatchObject({ tracking_code: '9400ABC', carrier: 'USPS', rate_usd: 6.1 });
        const created = JSON.parse(requests[0].options.body);
        expect(created.shipment.to_address.city).toBe('Austin');
        expect(created.shipment.from_address.zip).toBe('77092');
        expect(created.shipment.parcel.weight).toBeCloseTo(12.3, 1); // 350g in oz
        const bought = JSON.parse(requests[1].options.body);
        expect(bought.rate.id).toBe('rate_cheap');
        expect(requests[0].options.headers.Authorization).toContain('Basic ');
    });

    it('mock mode simulates a purchase offline', async () => {
        const label = await buyShippingLabel({
            settings: { shipping: { mock: true } },
            toAddress: {}, fromAddress: {}, weightGrams: 200,
        });
        expect(label.mock).toBe(true);
        expect(label.tracking_code).toContain('MOCKTRACK');
    });
});

describe('stripe extras', () => {
    it('refunds by payment intent (and mocks offline)', async () => {
        const fetchImpl = vi.fn(async (url, options) => {
            expect(String(url)).toContain('/v1/refunds');
            expect(options.body).toContain('payment_intent=pi_123');
            return { ok: true, status: 200, text: async () => JSON.stringify({ id: 're_1', status: 'succeeded' }) };
        });
        const refund = await createStripeRefund({
            settings: { stripe: { secret_key: 'sk_test' } },
            paymentIntentId: 'pi_123',
            fetchImpl,
        });
        expect(refund.id).toBe('re_1');

        const mock = await createStripeRefund({ settings: { stripe: { mock: true } }, paymentIntentId: 'pi_x' });
        expect(mock.mock).toBe(true);
    });

    it('encodes automatic_tax for Stripe Tax', () => {
        const form = toStripeForm({ automatic_tax: { enabled: 'true' } });
        expect(form.get('automatic_tax[enabled]')).toBe('true');
    });
});

describe('auto-retry + maintenance via agent events', () => {
    async function seedNodeAndJob(store) {
        const org = await store.createOrganization({ name: 'Retry Farm' });
        const merchant = await store.createMerchant({ org_id: org.org_id, company_name: 'M', status: 'active' });
        const pepper = 'pep';
        const token = 'pkx_node_retry';
        const node = await store.createFarmNode({
            org_id: org.org_id, name: 'N', token_hash: hashNodeToken(token, pepper), capabilities: {},
        });
        const file = await storeUploadedJobFile({
            store,
            merchant: { org_id: org.org_id, merchant_id: merchant.merchant_id },
            upload: {
                name: 'widget',
                requirements: { material: 'PLA' },
                options: {},
                file: {
                    originalName: 'widget.gcode.3mf',
                    contentType: 'application/octet-stream',
                    buffer: Buffer.from('gcode'),
                    byteSize: 5,
                    checksum: 'c1',
                    fileMode: 'ready_to_print',
                },
            },
            now: NOW,
        });
        const job = await store.createPrintJob({
            org_id: org.org_id,
            merchant_id: merchant.merchant_id,
            file_id: file.file_id,
            name: 'widget',
            status: 'printing',
            printer_id: 'printer-uuid-1',
            options: {},
        });
        return { store, org, merchant, node, job, token, pepper, file };
    }

    async function postEvents({ store, token, pepper }, events, { fetchImpl = vi.fn(), mailer = null } = {}) {
        const handler = createEventsHandler({ store, pepper, now: NOW, fetchImpl, mailer });
        const res = makeRes();
        await handler({ method: 'POST', headers: { authorization: `Bearer ${token}` }, body: { events } }, res);
        return res;
    }

    it('a failed job is retried once through the real pipeline, then alerts as final', async () => {
        const farm = await seedNodeAndJob(createMemoryCloudStore());
        const alertUrls = [];
        const fetchImpl = vi.fn(async (url) => { alertUrls.push(String(url)); return { ok: true, status: 200, text: async () => '' }; });
        await farm.store.upsertPlatformSetting('farm_integrations', { alerts: [{ type: 'webhook', url: 'https://ops.example/hook' }] });

        const res = await postEvents(farm, [{
            event_type: 'print_job.failed',
            payload: { print_job_id: farm.job.job_id, reason: 'adhesion' },
        }], { fetchImpl });
        expect(res.statusCode).toBe(200);

        // Original marked failed; one retry job created via the router.
        const failed = await farm.store.getPrintJobById(farm.job.job_id);
        expect(failed.status).toBe('failed');
        const retryJobs = (await farm.store.getCloudOverview({ limit: 50 })).jobs
            .filter((job) => job.options?.retry_of === farm.job.job_id);
        expect(retryJobs).toHaveLength(1);
        expect(retryJobs[0].options.retry_count).toBe(1);
        expect(alertUrls.length).toBeGreaterThan(0);

        // The retry fails too -> no second retry, critical alert instead.
        const res2 = await postEvents(farm, [{
            event_type: 'print_job.failed',
            payload: { print_job_id: retryJobs[0].job_id, reason: 'adhesion again' },
        }], { fetchImpl });
        expect(res2.statusCode).toBe(200);
        const retriesOfRetry = (await farm.store.getCloudOverview({ limit: 50 })).jobs
            .filter((job) => job.options?.retry_of === retryJobs[0].job_id);
        expect(retriesOfRetry).toHaveLength(0);
    });

    it('completed prints increment the per-printer service counter and alert at the interval', async () => {
        const farm = await seedNodeAndJob(createMemoryCloudStore());
        await farm.store.upsertPlatformSetting('farm_automation_policy', { maintenance_alert_every_prints: 2 });
        await farm.store.upsertPlatformSetting('farm_integrations', { alerts: [{ type: 'webhook', url: 'https://ops.example/hook' }] });
        const alerts = [];
        const fetchImpl = vi.fn(async (url, options) => {
            alerts.push(JSON.parse(options.body));
            return { ok: true, status: 200, text: async () => '' };
        });

        // Two completions on the same printer -> one maintenance alert.
        for (let i = 0; i < 2; i += 1) {
            const job = await farm.store.createPrintJob({
                org_id: farm.org.org_id, merchant_id: farm.merchant.merchant_id,
                file_id: farm.file.file_id, name: `j${i}`, status: 'printing', printer_id: 'printer-uuid-1', options: {},
            });
            await postEvents(farm, [{ event_type: 'print_job.completed', payload: { print_job_id: job.job_id } }], { fetchImpl });
        }

        const state = await farm.store.getPlatformSetting('printer_service_state', null);
        expect(state.printers['printer-uuid-1'].completed_prints).toBe(2);
        expect(alerts.some((alert) => alert.kind === 'printer.maintenance_due')).toBe(true);
    });

    it('policy knobs normalize with the new automation defaults', () => {
        const { policy } = normalizeFarmAutomationSettings({ policy: {}, inventory: {}, integrations: {} });
        expect(policy.auto_retry_failed_jobs).toBe(true);
        expect(policy.auto_retry_max).toBe(1);
        expect(policy.maintenance_alert_every_prints).toBe(200);
        const { policy: tuned } = normalizeFarmAutomationSettings({ policy: { auto_retry_max: 0 }, inventory: {}, integrations: {} });
        expect(tuned.auto_retry_max).toBe(0);
    });
});

describe('WooCommerce plugin package', () => {
    it('builds a self-contained plugin zip with the 3D viewer bundled', () => {
        const buffer = buildWooCommercePluginZip({ rootDir: process.cwd() });
        const zip = new AdmZip(buffer);
        const entries = zip.getEntries().map((entry) => entry.entryName);

        expect(entries).toContain('printkinetix-print-on-demand/printkinetix-print-on-demand.php');
        expect(entries).toContain('printkinetix-print-on-demand/assets/pkx-customizer.js');
        expect(entries).toContain('printkinetix-print-on-demand/assets/pkx-model-viewer.js');
        expect(entries).toContain('printkinetix-print-on-demand/readme.txt');

        const main = zip.readAsText('printkinetix-print-on-demand/printkinetix-print-on-demand.php');
        expect(main).toContain('Plugin Name: PrintKinetix Print-on-Demand');
        expect(main).toContain('/api/public/orders');       // paid orders go to the farm
        expect(main).toContain('/api/public/files');        // model uploads
        expect(main).toContain("'auto_submit' => true");    // our pickup sweep prints them
        const viewer = zip.readAsText('printkinetix-print-on-demand/assets/pkx-model-viewer.js');
        expect(viewer).toContain('PKXModelViewer');
    });
});
