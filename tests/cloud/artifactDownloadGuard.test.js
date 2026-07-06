import { describe, expect, it, vi } from 'vitest';
import { classifyNodeFetchUrl } from '../../src/cloud/urlGuard.js';
import { __testables } from '../../src/cloud/localCommandExecutor.js';

const { defaultDownloadArtifact } = __testables;

function streamResponse(bytes, { headers = {}, ok = true, status = 200 } = {}) {
    const buffer = Buffer.from(bytes);
    return {
        ok,
        status,
        headers: { get: (name) => headers[name.toLowerCase()] ?? null },
        body: {
            getReader() {
                let sent = false;
                return {
                    read() {
                        if (sent) return Promise.resolve({ done: true, value: undefined });
                        sent = true;
                        return Promise.resolve({ done: false, value: new Uint8Array(buffer) });
                    },
                    cancel() { return Promise.resolve(); },
                };
            },
        },
        arrayBuffer() { return Promise.resolve(buffer); },
    };
}

describe('classifyNodeFetchUrl (SSRF guard for node downloads)', () => {
    it('allows public HTTPS hosts', () => {
        expect(classifyNodeFetchUrl('https://project.supabase.co/storage/file').ok).toBe(true);
    });

    it('allows loopback over http (self-hosted artifact server)', () => {
        const result = classifyNodeFetchUrl('http://127.0.0.1:4620/artifacts/x');
        expect(result.ok).toBe(true);
        expect(result.loopback).toBe(true);
    });

    it('rejects private / link-local / metadata hosts', () => {
        for (const url of [
            'http://192.168.1.1/admin',
            'https://10.0.0.5/',
            'http://169.254.169.254/latest/meta-data/',
            'https://172.16.9.9/',
            'http://printer.local/',
            'https://db.internal/',
        ]) {
            const result = classifyNodeFetchUrl(url);
            expect(result.ok, url).toBe(false);
        }
    });

    it('rejects http for non-loopback hosts and unsupported protocols', () => {
        expect(classifyNodeFetchUrl('http://example.com/f').ok).toBe(false);
        expect(classifyNodeFetchUrl('file:///etc/passwd').ok).toBe(false);
        expect(classifyNodeFetchUrl('ftp://example.com/f').ok).toBe(false);
        expect(classifyNodeFetchUrl('not a url').ok).toBe(false);
    });
});

describe('defaultDownloadArtifact', () => {
    it('downloads from an allowed host with redirect:error and returns the bytes', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(streamResponse('G28\nG1 X10'));
        const buffer = await defaultDownloadArtifact('https://signed.example/file', { fetchImpl });
        expect(buffer.toString()).toBe('G28\nG1 X10');
        expect(fetchImpl).toHaveBeenCalledWith(
            'https://signed.example/file',
            expect.objectContaining({ redirect: 'error' }),
        );
    });

    it('refuses an SSRF target before making any request', async () => {
        const fetchImpl = vi.fn();
        await expect(defaultDownloadArtifact('https://169.254.169.254/latest/meta-data/', { fetchImpl }))
            .rejects.toThrow(/blocked_internal_host/);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('rejects a body that exceeds the size cap (declared content-length)', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(
            streamResponse('x', { headers: { 'content-length': String(999 * 1024 * 1024) } }),
        );
        await expect(defaultDownloadArtifact('https://signed.example/big', { fetchImpl }))
            .rejects.toThrow(/download limit/);
    });

    it('surfaces a clear error when the URL issues a redirect', async () => {
        const fetchImpl = vi.fn().mockRejectedValue(new Error('unexpected redirect'));
        await expect(defaultDownloadArtifact('https://signed.example/file', { fetchImpl }))
            .rejects.toThrow(/redirect/i);
    });
});
