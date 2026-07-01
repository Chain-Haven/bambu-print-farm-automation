// Shared SSRF guard for merchant-controlled outbound URLs (webhook endpoints).
//
// Merchant webhook URLs are fetched server-side from the Vercel runtime, so an
// attacker-supplied URL pointing at a loopback / private / link-local address or
// the cloud metadata endpoint would let a merchant drive requests into internal
// infrastructure. This rejects HTTPS URLs whose host is an obviously-internal
// literal. It does NOT defend against DNS rebinding (a public hostname that
// resolves to a private IP at delivery time) — that requires resolve-and-pin at
// fetch time and is tracked as a follow-up.

import { createHttpError } from './merchantApiV2.js';

function isPrivateIpv4(host) {
    const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!match) return false;
    const octets = match.slice(1).map(Number);
    if (octets.some((n) => n > 255)) return true; // malformed → treat as unsafe
    const [a, b] = octets;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10/8
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
    return false;
}

function isPrivateIpv6(rawHost) {
    // URL hostnames wrap IPv6 in brackets; new URL() strips them into .hostname.
    const host = rawHost.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === '::1' || host === '::') return true; // loopback / unspecified
    if (host.startsWith('fe80:')) return true; // link-local
    if (host.startsWith('fc') || host.startsWith('fd')) return true; // fc00::/7 ULA
    // IPv4-mapped IPv6, e.g. ::ffff:127.0.0.1
    const mapped = /::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(host);
    if (mapped) return isPrivateIpv4(mapped[1]);
    return false;
}

function isBlockedHost(hostname) {
    const host = hostname.toLowerCase();
    if (!host) return true;
    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    if (host.endsWith('.local') || host.endsWith('.internal')) return true;
    if (host.includes(':')) return isPrivateIpv6(host);
    return isPrivateIpv4(host);
}

// Validates a merchant-supplied webhook URL and returns its normalized string.
// Throws an HTTP 400 error if the URL is not a public HTTPS endpoint.
export function assertSafeWebhookUrl(value) {
    let parsed;
    try {
        parsed = new URL(String(value));
    } catch {
        throw createHttpError(400, 'invalid_payload', 'url must be a valid HTTPS URL');
    }
    if (parsed.protocol !== 'https:') {
        throw createHttpError(400, 'invalid_payload', 'url must use https');
    }
    if (isBlockedHost(parsed.hostname)) {
        throw createHttpError(400, 'invalid_payload', 'url must not target an internal or private host');
    }
    return parsed.toString();
}
