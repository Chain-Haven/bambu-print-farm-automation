import { describe, expect, it, vi } from 'vitest';
import { createPostProcessingHandlers } from '../../src/cloud/merchantPostProcessing.js';
import { createSupabaseRestClient } from '../../src/cloud/supabaseRest.js';

const now = () => new Date('2026-07-01T12:00:00.000Z');

function taskRow(overrides = {}) {
    return {
        task_id: overrides.task_id || 'task-1',
        org_id: 'org-1',
        merchant_id: 'merchant-1',
        job_id: overrides.job_id ?? 'job-1',
        order_id: overrides.order_id ?? 'order-1',
        task_type: overrides.task_type || 'support_removal',
        status: overrides.status || 'pending',
        assigned_to: overrides.assigned_to ?? 'operator-1',
        started_at: overrides.started_at ?? null,
        completed_at: overrides.completed_at ?? null,
        metadata: overrides.metadata || {
            note: 'merchant visible',
            node_id: 'node-secret',
            printer_id: 'printer-secret',
            spool_id: 'spool-secret',
            storage_path: 'internal/task/path',
            signedUrl: 'https://signed.example/task',
        },
        created_at: '2026-07-01T12:00:00.000Z',
        updated_at: '2026-07-01T12:00:00.000Z',
        ...overrides,
    };
}

function createMockStore(overrides = {}) {
    return {
        getMerchantPrintJob: vi.fn().mockImplementation(async ({ jobId }) => (
            jobId === 'missing-job'
                ? null
                : {
                    job_id: jobId,
                    org_id: 'org-1',
                    merchant_id: 'merchant-1',
                    order_id: 'order-1',
                    status: 'completed',
                    node_id: 'node-secret',
                    printer_id: 'printer-secret',
                }
        )),
        getMerchantOrder: vi.fn().mockImplementation(async ({ orderId }) => (
            orderId === 'missing-order'
                ? null
                : {
                    order_id: orderId,
                    org_id: 'org-1',
                    merchant_id: 'merchant-1',
                    status: 'post_processing',
                }
        )),
        createMerchantPostProcessingTask: vi.fn().mockImplementation(async (task) => taskRow(task)),
        listMerchantPostProcessingTasks: vi.fn().mockResolvedValue([
            taskRow({ task_id: 'task-1', task_type: 'support_removal' }),
            taskRow({ task_id: 'task-2', task_type: 'packing', metadata: { note: 'pack carefully' } }),
        ]),
        getMerchantPostProcessingTask: vi.fn().mockImplementation(async ({ taskId }) => (
            taskId === 'missing-task' ? null : taskRow({ task_id: taskId })
        )),
        updateMerchantPostProcessingTaskIfStatus: vi.fn().mockImplementation(async ({
            taskId,
            fields,
        }) => taskRow({ task_id: taskId, ...fields })),
        recordMerchantJobEvent: vi.fn().mockImplementation(async (event) => event),
        ...overrides,
    };
}

function createHandlers(overrides = {}) {
    const store = createMockStore(overrides.store);
    const authenticateMerchant = vi.fn().mockResolvedValue({
        merchant: {
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            status: 'active',
        },
    });

    return {
        store,
        authenticateMerchant,
        ...createPostProcessingHandlers({
            store,
            authenticateMerchant,
            now,
        }),
    };
}

function createScopedBody(body) {
    return Object.defineProperties({ ...body }, {
        org_id: {
            enumerable: true,
            get() {
                throw new Error('body org_id was read');
            },
        },
        merchant_id: {
            enumerable: true,
            get() {
                throw new Error('body merchant_id was read');
            },
        },
    });
}

function createMockResponse() {
    return {
        statusCode: 200,
        body: null,
        headers: {},
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        },
        setHeader(name, value) {
            this.headers[name] = value;
        },
        end(payload) {
            this.body = payload ? JSON.parse(payload) : null;
            return this;
        },
    };
}

async function importTaskRoute(path, store = createMockStore()) {
    vi.resetModules();
    vi.doMock('../../src/cloud/supabaseRest.js', () => ({
        createSupabaseRestClient: vi.fn(() => store),
    }));
    const route = await import(path);
    vi.doUnmock('../../src/cloud/supabaseRest.js');
    return route.default;
}

describe('merchant post-processing handlers', () => {
    it('creates, lists, and gets merchant-scoped finishing tasks with safe public projections', async () => {
        const {
            createTask,
            listTasks,
            getTask,
            store,
        } = createHandlers();

        const created = await createTask(createScopedBody({
            task_type: 'support_removal',
            job_id: 'job-1',
            order_id: 'order-1',
            assigned_to: 'operator-1',
            metadata: {
                note: 'merchant visible',
                printer_serial: 'printer-serial-secret',
                node_name: 'node-name-secret',
                spool_material: 'spool-material-secret',
                storage_bucket: 'storage-bucket-secret',
                node_id: 'node-secret',
                printer_id: 'printer-secret',
                spool_id: 'spool-secret',
                storage_path: 'internal/body/path',
                signedUrl: 'https://signed.example/body',
            },
        }));
        const listed = await listTasks({
            job_id: 'job-1',
            order_id: 'order-1',
            status: 'pending',
            limit: '2',
        });
        const fetched = await getTask({ task_id: 'task-1' });

        expect(created).toMatchObject({
            ok: true,
            task_id: expect.any(String),
            job_id: 'job-1',
            order_id: 'order-1',
            task_type: 'support_removal',
            status: 'pending',
            assigned_to: 'operator-1',
            metadata: { note: 'merchant visible' },
        });
        expect(created._http_status).toBe(201);
        expect(listed).toMatchObject({
            ok: true,
            tasks: [
                { task_id: 'task-1', task_type: 'support_removal', status: 'pending' },
                { task_id: 'task-2', task_type: 'packing', status: 'pending' },
            ],
        });
        expect(fetched).toMatchObject({ ok: true, task_id: 'task-1', status: 'pending' });
        expect(store.getMerchantPrintJob).toHaveBeenCalledWith({
            merchantId: 'merchant-1',
            jobId: 'job-1',
        });
        expect(store.getMerchantOrder).toHaveBeenCalledWith({
            merchantId: 'merchant-1',
            orderId: 'order-1',
        });
        expect(store.createMerchantPostProcessingTask).toHaveBeenCalledWith(expect.objectContaining({
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            job_id: 'job-1',
            order_id: 'order-1',
            task_type: 'support_removal',
            status: 'pending',
        }));
        expect(store.recordMerchantJobEvent).toHaveBeenCalledWith(expect.objectContaining({
            event_type: 'post_processing.created',
            job_id: 'job-1',
            order_id: 'order-1',
        }));
        expect(store.listMerchantPostProcessingTasks).toHaveBeenCalledWith({
            merchantId: 'merchant-1',
            jobId: 'job-1',
            orderId: 'order-1',
            status: 'pending',
            limit: 2,
        });
        expect(JSON.stringify({ created, listed, fetched })).not.toContain('org-1');
        expect(JSON.stringify({ created, listed, fetched })).not.toContain('merchant-1');
        expect(JSON.stringify({ created, listed, fetched })).not.toContain('printer-serial-secret');
        expect(JSON.stringify({ created, listed, fetched })).not.toContain('node-name-secret');
        expect(JSON.stringify({ created, listed, fetched })).not.toContain('spool-material-secret');
        expect(JSON.stringify({ created, listed, fetched })).not.toContain('storage-bucket-secret');
        expect(JSON.stringify({ created, listed, fetched })).not.toContain('node-secret');
        expect(JSON.stringify({ created, listed, fetched })).not.toContain('printer-secret');
        expect(JSON.stringify({ created, listed, fetched })).not.toContain('spool-secret');
        expect(JSON.stringify({ created, listed, fetched })).not.toContain('internal/');
        expect(JSON.stringify({ created, listed, fetched })).not.toContain('signed.example');
    });

    it('validates task payloads and ownership checks before writing', async () => {
        const { createTask, store } = createHandlers();

        await expect(createTask({ task_type: '' })).rejects.toMatchObject({
            statusCode: 400,
            code: 'invalid_payload',
        });
        await expect(createTask({ task_type: 'painting' })).rejects.toMatchObject({
            statusCode: 400,
            code: 'invalid_payload',
        });
        await expect(createTask({ task_type: 'packing', job_id: 'missing-job' })).rejects.toMatchObject({
            statusCode: 404,
            code: 'print_job_not_found',
        });
        await expect(createTask({ task_type: 'packing', order_id: 'missing-order' })).rejects.toMatchObject({
            statusCode: 404,
            code: 'order_not_found',
        });
        expect(store.createMerchantPostProcessingTask).not.toHaveBeenCalled();
    });

    it('rejects detectable job/order relationship mismatches before creating tasks', async () => {
        const { createTask, store } = createHandlers({
            store: {
                getMerchantPrintJob: vi.fn().mockResolvedValue({
                    job_id: 'job-1',
                    order_id: 'order-expected',
                    status: 'completed',
                }),
                getMerchantOrder: vi.fn().mockResolvedValue({
                    order_id: 'order-unrelated',
                    job_id: 'other-job',
                    status: 'post_processing',
                }),
            },
        });

        await expect(createTask({
            task_type: 'packing',
            job_id: 'job-1',
            order_id: 'order-unrelated',
        })).rejects.toMatchObject({
            statusCode: 409,
            code: 'post_processing_reference_mismatch',
        });
        expect(store.createMerchantPostProcessingTask).not.toHaveBeenCalled();
    });

    it('starts, completes, skips, and fails tasks through conditional status updates', async () => {
        const { startTask, completeTask, skipTask, failTask, store } = createHandlers({
            store: {
                getMerchantPostProcessingTask: vi.fn()
                    .mockResolvedValueOnce(taskRow({ task_id: 'task-start', status: 'pending' }))
                    .mockResolvedValueOnce(taskRow({ task_id: 'task-complete', status: 'running' }))
                    .mockResolvedValueOnce(taskRow({ task_id: 'task-skip', status: 'pending' }))
                    .mockResolvedValueOnce(taskRow({
                        task_id: 'task-fail',
                        status: 'running',
                        metadata: { note: 'keep', signedUrl: 'https://signed.example/old' },
                    })),
            },
        });

        const started = await startTask({ task_id: 'task-start' });
        const completed = await completeTask({ task_id: 'task-complete' });
        const skipped = await skipTask({ task_id: 'task-skip' });
        const failed = await failTask({
            task_id: 'task-fail',
            error: 'label printer jammed',
            error_code: 'label_jam',
            metadata: { retryable: false, signedUrl: 'https://signed.example/new' },
        });

        expect(started).toMatchObject({ status: 'running', started_at: '2026-07-01T12:00:00.000Z' });
        expect(completed).toMatchObject({ status: 'completed', completed_at: '2026-07-01T12:00:00.000Z' });
        expect(skipped).toMatchObject({ status: 'skipped', completed_at: '2026-07-01T12:00:00.000Z' });
        expect(failed).toMatchObject({
            status: 'failed',
            completed_at: '2026-07-01T12:00:00.000Z',
            metadata: {
                note: 'keep',
                retryable: false,
                error: 'label printer jammed',
                error_code: 'label_jam',
            },
        });
        expect(store.updateMerchantPostProcessingTaskIfStatus.mock.calls.map(([call]) => call.allowedStatuses)).toEqual([
            ['pending'],
            ['running'],
            ['pending'],
            ['pending', 'running'],
        ]);
        expect(store.recordMerchantJobEvent.mock.calls.map(([event]) => event.event_type)).toEqual([
            'post_processing.started',
            'post_processing.completed',
            'post_processing.skipped',
            'post_processing.failed',
        ]);
        expect(JSON.stringify(failed)).not.toContain('signed.example');
    });

    it('keeps durable task state when post-processing event writes fail', async () => {
        const { createTask, startTask, store } = createHandlers({
            store: {
                recordMerchantJobEvent: vi.fn().mockRejectedValue(new Error('event write failed')),
            },
        });

        await expect(createTask({ task_type: 'packing', job_id: 'job-1' })).resolves.toMatchObject({
            status: 'pending',
            task_type: 'packing',
        });
        await expect(startTask({ task_id: 'task-1' })).resolves.toMatchObject({
            status: 'running',
        });
        expect(store.recordMerchantJobEvent).toHaveBeenCalled();
    });

    it('replays same-state post-processing transitions without duplicate updates', async () => {
        const { startTask, completeTask, skipTask, failTask, store } = createHandlers({
            store: {
                getMerchantPostProcessingTask: vi.fn()
                    .mockResolvedValueOnce(taskRow({ task_id: 'task-started', status: 'running' }))
                    .mockResolvedValueOnce(taskRow({ task_id: 'task-completed', status: 'completed' }))
                    .mockResolvedValueOnce(taskRow({ task_id: 'task-skipped', status: 'skipped' }))
                    .mockResolvedValueOnce(taskRow({ task_id: 'task-failed', status: 'failed' })),
            },
        });

        await expect(startTask({ task_id: 'task-started' })).resolves.toMatchObject({ status: 'running' });
        await expect(completeTask({ task_id: 'task-completed' })).resolves.toMatchObject({ status: 'completed' });
        await expect(skipTask({ task_id: 'task-skipped' })).resolves.toMatchObject({ status: 'skipped' });
        await expect(failTask({ task_id: 'task-failed' })).resolves.toMatchObject({ status: 'failed' });
        expect(store.updateMerchantPostProcessingTaskIfStatus).not.toHaveBeenCalled();
        expect(store.recordMerchantJobEvent).not.toHaveBeenCalled();
    });

    it('rejects invalid terminal transitions and stale conditional updates', async () => {
        const { startTask, completeTask, store } = createHandlers({
            store: {
                getMerchantPostProcessingTask: vi.fn()
                    .mockResolvedValueOnce(taskRow({ task_id: 'completed-task', status: 'completed' }))
                    .mockResolvedValueOnce(taskRow({ task_id: 'stale-task', status: 'pending' })),
                updateMerchantPostProcessingTaskIfStatus: vi.fn().mockResolvedValue(null),
            },
        });

        await expect(startTask({ task_id: 'completed-task' })).rejects.toMatchObject({
            statusCode: 409,
            code: 'post_processing_transition_invalid',
        });
        await expect(startTask({ task_id: 'stale-task' })).rejects.toMatchObject({
            statusCode: 409,
            code: 'post_processing_transition_invalid',
        });
        await expect(completeTask({ task_id: 'missing-task' })).rejects.toMatchObject({
            statusCode: 404,
            code: 'post_processing_task_not_found',
        });
        expect(store.updateMerchantPostProcessingTaskIfStatus).toHaveBeenCalledTimes(1);
    });
});

describe('merchant post-processing store helpers', () => {
    it('filters merchant post-processing tasks and conditionally updates by allowed statuses', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                text: async () => JSON.stringify([{ task_id: 'task-1' }]),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                text: async () => JSON.stringify([{ task_id: 'task-1', status: 'running' }]),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                text: async () => JSON.stringify([{ task_id: 'task-1', status: 'completed' }]),
            });
        const store = createSupabaseRestClient({
            supabaseUrl: 'https://example.supabase.co',
            serviceRoleKey: 'service_role',
            fetchImpl,
        });

        await store.listMerchantPostProcessingTasks({
            merchantId: 'merchant-1',
            jobId: 'job-1',
            orderId: 'order-1',
            status: 'pending',
            limit: 250,
        });
        await store.getMerchantPostProcessingTask({ merchantId: 'merchant-1', taskId: 'task-1' });
        await store.updateMerchantPostProcessingTaskIfStatus({
            merchantId: 'merchant-1',
            taskId: 'task-1',
            allowedStatuses: ['pending', 'running'],
            fields: { status: 'failed', completed_at: '2026-07-01T12:00:00.000Z' },
        });

        const listUrl = new URL(fetchImpl.mock.calls[0][0]);
        const getUrl = new URL(fetchImpl.mock.calls[1][0]);
        const [updateUrl, updateInit] = fetchImpl.mock.calls[2];
        const updateRequestUrl = new URL(updateUrl);
        expect(listUrl.pathname).toBe('/rest/v1/merchant_post_processing_tasks');
        expect(listUrl.searchParams.get('merchant_id')).toBe('eq.merchant-1');
        expect(listUrl.searchParams.get('job_id')).toBe('eq.job-1');
        expect(listUrl.searchParams.get('order_id')).toBe('eq.order-1');
        expect(listUrl.searchParams.get('status')).toBe('eq.pending');
        expect(listUrl.searchParams.get('limit')).toBe('100');
        expect(getUrl.searchParams.get('task_id')).toBe('eq.task-1');
        expect(updateRequestUrl.searchParams.get('merchant_id')).toBe('eq.merchant-1');
        expect(updateRequestUrl.searchParams.get('task_id')).toBe('eq.task-1');
        expect(updateRequestUrl.searchParams.get('status')).toBe('in.(pending,running)');
        expect(updateInit).toMatchObject({
            method: 'PATCH',
            headers: expect.objectContaining({ Prefer: 'return=representation' }),
            body: JSON.stringify({
                status: 'failed',
                completed_at: '2026-07-01T12:00:00.000Z',
            }),
        });
    });
});

describe('merchant post-processing public routes', () => {
    it('imports route handlers and returns v2 method envelopes', async () => {
        const indexHandler = await importTaskRoute('../../api/public/post-processing/tasks/index.js');
        const detailHandler = await importTaskRoute('../../api/public/post-processing/tasks/[task_id].js');
        const startHandler = await importTaskRoute('../../api/public/post-processing/tasks/[task_id]/start.js');
        const completeHandler = await importTaskRoute('../../api/public/post-processing/tasks/[task_id]/complete.js');
        const skipHandler = await importTaskRoute('../../api/public/post-processing/tasks/[task_id]/skip.js');
        const failHandler = await importTaskRoute('../../api/public/post-processing/tasks/[task_id]/fail.js');
        const responses = Array.from({ length: 6 }, () => createMockResponse());

        await indexHandler({ method: 'DELETE', headers: {} }, responses[0]);
        await detailHandler({ method: 'POST', headers: {}, query: { task_id: 'task-1' } }, responses[1]);
        await startHandler({ method: 'GET', headers: {}, query: { task_id: 'task-1' } }, responses[2]);
        await completeHandler({ method: 'GET', headers: {}, query: { task_id: 'task-1' } }, responses[3]);
        await skipHandler({ method: 'GET', headers: {}, query: { task_id: 'task-1' } }, responses[4]);
        await failHandler({ method: 'GET', headers: {}, query: { task_id: 'task-1' } }, responses[5]);

        expect(responses[0].statusCode).toBe(405);
        expect(responses[0].headers.Allow).toBe('GET, POST');
        expect(responses[0].body).toMatchObject({ ok: false, error: 'method_not_allowed' });
        expect(responses[1].statusCode).toBe(405);
        expect(responses[1].headers.Allow).toBe('GET');
        expect(responses[1].body).toMatchObject({ ok: false, error: 'method_not_allowed' });
        for (const response of responses.slice(2)) {
            expect(response.statusCode).toBe(405);
            expect(response.headers.Allow).toBe('POST');
            expect(response.body).toMatchObject({ ok: false, error: 'method_not_allowed' });
        }
    });
});
