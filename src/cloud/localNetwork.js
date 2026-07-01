import os from 'node:os';

function ipv4ToInt(address) {
    const parts = String(address || '').split('.').map((part) => Number.parseInt(part, 10));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
        return null;
    }
    return parts.reduce((acc, part) => ((acc << 8) | part) >>> 0, 0);
}

function prefixLengthFromNetmask(netmask) {
    const value = ipv4ToInt(netmask);
    if (value === null) return null;
    let bits = 0;
    for (let i = 31; i >= 0; i -= 1) {
        if (((value >>> i) & 1) === 1) bits += 1;
        else break;
    }
    return bits;
}

function isIpv4Interface(info) {
    return (info?.family === 'IPv4' || info?.family === 4) && info.internal !== true && info.address && info.netmask;
}

export function collectNetworkInterfaces({ networkInterfaces = os.networkInterfaces } = {}) {
    const source = typeof networkInterfaces === 'function' ? networkInterfaces() : {};
    const interfaces = [];

    for (const [name, values] of Object.entries(source || {})) {
        for (const info of values || []) {
            if (!isIpv4Interface(info)) continue;
            const prefix = prefixLengthFromNetmask(info.netmask);
            interfaces.push({
                name,
                family: 'IPv4',
                address: info.address,
                netmask: info.netmask,
                cidr: prefix === null ? `${info.address}/unknown` : `${info.address}/${prefix}`,
                mac: info.mac || null,
            });
        }
    }

    return interfaces;
}

export function findInterfaceForAddress(address, interfaces = collectNetworkInterfaces()) {
    const target = ipv4ToInt(address);
    if (target === null) return null;

    for (const iface of interfaces) {
        const ifaceAddress = ipv4ToInt(iface.address);
        const netmask = ipv4ToInt(iface.netmask);
        if (ifaceAddress === null || netmask === null) continue;
        if ((target & netmask) === (ifaceAddress & netmask)) return iface;
    }

    return null;
}
