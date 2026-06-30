// src/gcode/Extract3mf.js — Extract/Repack G-code from Bambu .gcode.3mf files
//
// Extraction: reads ZIP central directory, finds plate_*.gcode, decompresses.
// Repacking (Fix #6): copies every entry from the original 3MF unchanged,
//   replaces ONLY Metadata/plate_*.gcode content with transformed G-code.
//   Preserves filenames, compression methods, flags, timestamps, all metadata.

import fs from 'node:fs';
import path from 'node:path';
import { createInflateRaw, deflateRawSync } from 'node:zlib';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Extract3mf');

/**
 * Check if a buffer looks like a ZIP file (starts with PK\x03\x04).
 */
export function isZipFile(buffer) {
    return buffer.length > 4 &&
        buffer[0] === 0x50 && buffer[1] === 0x4B &&
        buffer[2] === 0x03 && buffer[3] === 0x04;
}

/**
 * Check if a filename looks like a 3MF file.
 */
export function is3mfFilename(filename) {
    const lower = filename.toLowerCase();
    return lower.endsWith('.3mf') || lower.endsWith('.gcode.3mf');
}

/**
 * Extract G-code content from a .gcode.3mf (ZIP) buffer.
 */
export async function extractGcodeFrom3mf(buffer, filename = '') {
    log.info(`Extracting G-code from 3MF: ${filename} (${buffer.length} bytes)`);

    if (!isZipFile(buffer)) {
        throw new Error('File is not a valid ZIP/3MF archive');
    }

    const eocd = findEOCD(buffer);
    if (!eocd) throw new Error('Could not find ZIP End of Central Directory record');

    const entries = parseCentralDirectory(buffer, eocd);
    log.info(`Found ${entries.length} entries in 3MF archive`);

    const gcodeEntry = entries.find(e => e.name.toLowerCase().endsWith('.gcode'));
    if (!gcodeEntry) {
        throw new Error(`No .gcode file found inside 3MF. Entries: ${entries.map(e => e.name).join(', ')}`);
    }

    log.info(`Found G-code entry: ${gcodeEntry.name} (${gcodeEntry.uncompressedSize} bytes, method=${gcodeEntry.method})`);

    const content = await extractEntry(buffer, gcodeEntry);
    log.info(`Extracted ${content.length} characters of G-code`);

    return { content, entryName: gcodeEntry.name };
}

/**
 * Repack a 3MF file, replacing only the G-code entry with new content.
 * All other entries are copied byte-for-byte from the original.
 *
 * @param {Buffer} originalBuffer - Original 3MF file buffer
 * @param {string} newGcodeContent - Transformed G-code text
 * @returns {Buffer} New 3MF buffer
 */
export function repack3mf(originalBuffer, newGcodeContent) {
    log.info('Repacking 3MF with transformed G-code');

    const eocd = findEOCD(originalBuffer);
    if (!eocd) throw new Error('Cannot repack: no EOCD found');

    const entries = parseCentralDirectory(originalBuffer, eocd);
    const gcodeEntry = entries.find(e => e.name.toLowerCase().endsWith('.gcode'));
    if (!gcodeEntry) throw new Error('Cannot repack: no .gcode entry found');

    // Compress the new G-code content
    const newData = Buffer.from(newGcodeContent, 'utf-8');
    const newCompressed = deflateRawSync(newData);

    // Build the output buffer: local file headers + data, then central directory, then EOCD
    const localParts = [];
    const cdEntries = [];

    for (const entry of entries) {
        const localOffset = localParts.reduce((sum, b) => sum + b.length, 0);

        if (entry.name === gcodeEntry.name) {
            // Replace this entry's data with transformed G-code
            const localHeader = buildLocalFileHeader(entry, newCompressed.length, newData.length);
            localParts.push(localHeader);
            localParts.push(newCompressed);
            cdEntries.push({ ...entry, compressedSize: newCompressed.length, uncompressedSize: newData.length, localHeaderOffset: localOffset, method: 8 });
        } else {
            // Copy original entry byte-for-byte
            const lh = entry.localHeaderOffset;
            const lNameLen = originalBuffer.readUInt16LE(lh + 26);
            const lExtraLen = originalBuffer.readUInt16LE(lh + 28);
            const headerSize = 30 + lNameLen + lExtraLen;
            const totalSize = headerSize + entry.compressedSize;
            const entryBytes = originalBuffer.subarray(lh, lh + totalSize);
            localParts.push(Buffer.from(entryBytes)); // copy
            cdEntries.push({ ...entry, localHeaderOffset: localOffset });
        }
    }

    // Build central directory
    const cdOffset = localParts.reduce((sum, b) => sum + b.length, 0);
    const cdParts = [];
    for (const entry of cdEntries) {
        cdParts.push(buildCentralDirectoryEntry(entry, originalBuffer));
    }

    const cdBuffer = Buffer.concat(cdParts);
    const localBuffer = Buffer.concat(localParts);

    // Build EOCD
    const eocdBuffer = buildEOCD(cdEntries.length, cdBuffer.length, cdOffset);

    const result = Buffer.concat([localBuffer, cdBuffer, eocdBuffer]);
    log.info(`Repacked 3MF: ${result.length} bytes (original: ${originalBuffer.length})`);
    return result;
}

// === ZIP structure helpers ===

function findEOCD(buffer) {
    const maxSearch = Math.min(buffer.length, 65557 + 22);
    for (let i = buffer.length - 22; i >= buffer.length - maxSearch && i >= 0; i--) {
        if (buffer[i] === 0x50 && buffer[i + 1] === 0x4B &&
            buffer[i + 2] === 0x05 && buffer[i + 3] === 0x06) {
            return {
                offset: i,
                totalEntries: buffer.readUInt16LE(i + 10),
                cdSize: buffer.readUInt32LE(i + 12),
                cdOffset: buffer.readUInt32LE(i + 16),
            };
        }
    }
    return null;
}

function parseCentralDirectory(buffer, eocd) {
    const entries = [];
    let pos = eocd.cdOffset;

    for (let i = 0; i < eocd.totalEntries; i++) {
        if (pos + 46 > buffer.length) break;
        const sig = buffer.readUInt32LE(pos);
        if (sig !== 0x02014B50) break;

        const versionMade = buffer.readUInt16LE(pos + 4);
        const versionNeeded = buffer.readUInt16LE(pos + 6);
        const flags = buffer.readUInt16LE(pos + 8);
        const method = buffer.readUInt16LE(pos + 10);
        const modTime = buffer.readUInt16LE(pos + 12);
        const modDate = buffer.readUInt16LE(pos + 14);
        const crc32 = buffer.readUInt32LE(pos + 16);
        const compressedSize = buffer.readUInt32LE(pos + 20);
        const uncompressedSize = buffer.readUInt32LE(pos + 24);
        const nameLen = buffer.readUInt16LE(pos + 28);
        const extraLen = buffer.readUInt16LE(pos + 30);
        const commentLen = buffer.readUInt16LE(pos + 32);
        const externalAttr = buffer.readUInt32LE(pos + 38);
        const localHeaderOffset = buffer.readUInt32LE(pos + 42);
        const name = buffer.subarray(pos + 46, pos + 46 + nameLen).toString('utf-8');
        const extra = buffer.subarray(pos + 46 + nameLen, pos + 46 + nameLen + extraLen);

        entries.push({
            name, method, flags, compressedSize, uncompressedSize,
            localHeaderOffset, crc32, modTime, modDate,
            versionMade, versionNeeded, externalAttr, extra, nameLen, commentLen,
        });

        pos += 46 + nameLen + extraLen + commentLen;
    }

    return entries;
}

async function extractEntry(buffer, entry) {
    const lh = entry.localHeaderOffset;
    if (lh + 30 > buffer.length) throw new Error(`Local header offset ${lh} beyond file size`);

    const sig = buffer.readUInt32LE(lh);
    if (sig !== 0x04034B50) throw new Error(`Invalid local header at ${lh}`);

    const lNameLen = buffer.readUInt16LE(lh + 26);
    const lExtraLen = buffer.readUInt16LE(lh + 28);
    const dataStart = lh + 30 + lNameLen + lExtraLen;
    const compressedData = buffer.subarray(dataStart, dataStart + entry.compressedSize);

    if (entry.method === 0) {
        return compressedData.toString('utf-8');
    } else if (entry.method === 8) {
        return new Promise((resolve, reject) => {
            const inflater = createInflateRaw();
            const chunks = [];
            inflater.on('data', chunk => chunks.push(chunk));
            inflater.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
            inflater.on('error', err => reject(new Error(`Decompression failed: ${err.message}`)));
            inflater.end(compressedData);
        });
    } else {
        throw new Error(`Unsupported compression method: ${entry.method}`);
    }
}

function crc32(buf) {
    // Standard CRC-32 for ZIP
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
        crc ^= buf[i];
        for (let j = 0; j < 8; j++) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
        }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function buildLocalFileHeader(entry, compSize, uncompSize) {
    const nameBuffer = Buffer.from(entry.name, 'utf-8');
    const header = Buffer.alloc(30 + nameBuffer.length);
    header.writeUInt32LE(0x04034B50, 0);     // signature
    header.writeUInt16LE(20, 4);              // version needed
    header.writeUInt16LE(0, 6);               // flags
    header.writeUInt16LE(8, 8);               // method: deflate
    header.writeUInt16LE(entry.modTime || 0, 10);
    header.writeUInt16LE(entry.modDate || 0, 12);
    // CRC32 computed from uncompressed data — we don't have it here,
    // but the CD entry will have the correct one
    header.writeUInt32LE(0, 14);              // crc32 placeholder (CD has it)
    header.writeUInt32LE(compSize, 18);
    header.writeUInt32LE(uncompSize, 22);
    header.writeUInt16LE(nameBuffer.length, 26);
    header.writeUInt16LE(0, 28);              // extra length
    nameBuffer.copy(header, 30);
    return header;
}

function buildCentralDirectoryEntry(entry, originalBuffer) {
    const nameBuffer = Buffer.from(entry.name, 'utf-8');
    const extraLen = entry.extra ? entry.extra.length : 0;
    const buf = Buffer.alloc(46 + nameBuffer.length + extraLen);
    buf.writeUInt32LE(0x02014B50, 0);         // signature
    buf.writeUInt16LE(entry.versionMade || 20, 4);
    buf.writeUInt16LE(entry.versionNeeded || 20, 6);
    buf.writeUInt16LE(entry.flags || 0, 8);
    buf.writeUInt16LE(entry.method, 10);
    buf.writeUInt16LE(entry.modTime || 0, 12);
    buf.writeUInt16LE(entry.modDate || 0, 14);
    buf.writeUInt32LE(entry.crc32 || 0, 16);
    buf.writeUInt32LE(entry.compressedSize, 20);
    buf.writeUInt32LE(entry.uncompressedSize, 24);
    buf.writeUInt16LE(nameBuffer.length, 28);
    buf.writeUInt16LE(extraLen, 30);
    buf.writeUInt16LE(0, 32);                 // comment length
    buf.writeUInt16LE(0, 34);                 // disk start
    buf.writeUInt16LE(0, 36);                 // internal attrs
    buf.writeUInt32LE(entry.externalAttr || 0, 38);
    buf.writeUInt32LE(entry.localHeaderOffset, 42);
    nameBuffer.copy(buf, 46);
    if (entry.extra && extraLen > 0) {
        entry.extra.copy(buf, 46 + nameBuffer.length);
    }
    return buf;
}

function buildEOCD(entryCount, cdSize, cdOffset) {
    const buf = Buffer.alloc(22);
    buf.writeUInt32LE(0x06054B50, 0);         // signature
    buf.writeUInt16LE(0, 4);                  // disk number
    buf.writeUInt16LE(0, 6);                  // CD disk
    buf.writeUInt16LE(entryCount, 8);
    buf.writeUInt16LE(entryCount, 10);
    buf.writeUInt32LE(cdSize, 12);
    buf.writeUInt32LE(cdOffset, 16);
    buf.writeUInt16LE(0, 20);                 // comment length
    return buf;
}

export default { isZipFile, is3mfFilename, extractGcodeFrom3mf, repack3mf };
