// src/gcode/AutomatorZip.js — .gcode.3mf ZIP handler
//
// Treats .gcode.3mf as a ZIP archive.
// Extracts Metadata/plate_*.gcode, applies transforms, repacks.
// Preserves ALL other entries byte-for-byte.
// Updates .md5 files if present.

import { createHash } from 'node:crypto';
import { inflateRawSync, deflateRawSync } from 'node:zlib';
import AdmZip from 'adm-zip';
import { createLogger } from '../utils/logger.js';

const log = createLogger('AutomatorZip');

// ============================================================
// BUILD a .gcode.3mf FROM RAW PLATE GCODE (slicer output wrapper)
// ============================================================

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
 <Default Extension="gcode" ContentType="text/x.gcode"/>
</Types>`;

const RELS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

const MODEL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">
 <metadata name="Application">Antigravity-Slicer</metadata>
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <resources/>
 <build/>
</model>`;

/**
 * Build a printer-shaped `.gcode.3mf` from one or more sliced plate gcodes.
 * Mirrors the structure the existing pipeline + Bambu printers expect:
 * OPC boilerplate + Metadata/plate_N.gcode + Metadata/plate_N.gcode.md5 + slice_info.
 *
 * @param {Array<{index:number, gcode:string}>} plates
 * @param {object} [meta] { printerModelId, nozzleDiameter, clientVersion }
 * @returns {Buffer} .gcode.3mf
 */
export function buildGcode3mf(plates, meta = {}) {
    if (!plates?.length) throw new Error('buildGcode3mf: no plates supplied');
    const zip = new AdmZip();

    zip.addFile('[Content_Types].xml', Buffer.from(CONTENT_TYPES_XML, 'utf-8'));
    zip.addFile('_rels/.rels', Buffer.from(RELS_XML, 'utf-8'));
    zip.addFile('3D/3dmodel.model', Buffer.from(MODEL_XML, 'utf-8'));

    const plateBlocks = [];
    for (const { index, gcode } of plates) {
        const gbuf = Buffer.from(gcode, 'utf-8');
        const md5 = createHash('md5').update(gbuf).digest('hex'); // lowercase hex, as Bambu
        zip.addFile(`Metadata/plate_${index}.gcode`, gbuf);
        zip.addFile(`Metadata/plate_${index}.gcode.md5`, Buffer.from(md5, 'utf-8'));
        plateBlocks.push(
            `  <plate>\n` +
            `    <metadata key="index" value="${index}"/>\n` +
            `    <metadata key="nozzle_diameters" value="${meta.nozzleDiameter ?? '0.4'}"/>\n` +
            (meta.printerModelId ? `    <metadata key="printer_model_id" value="${meta.printerModelId}"/>\n` : '') +
            `  </plate>`
        );
    }

    const sliceInfo = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header>
    <header_item key="X-BBL-Client-Type" value="slicer"/>
    <header_item key="X-BBL-Client-Version" value="${meta.clientVersion ?? '01.09.03.50'}"/>
  </header>
${plateBlocks.join('\n')}
</config>`;
    zip.addFile('Metadata/slice_info.config', Buffer.from(sliceInfo, 'utf-8'));

    const buf = zip.toBuffer();
    log.info(`Built .gcode.3mf: ${plates.length} plate(s), ${buf.length} bytes`);
    return buf;
}

// ============================================================
// ZIP CONSTANTS
// ============================================================

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIR_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

// ============================================================
// EXTRACT plate_*.gcode FROM .gcode.3mf BUFFER
// ============================================================

/**
 * Extract the first plate_*.gcode file from a .gcode.3mf buffer.
 *
 * @param {Buffer} buf - Raw .gcode.3mf file content
 * @returns {{ gcodeText: string, gcodeEntryName: string, entries: object[] }}
 */
export function extractGcodeFrom3mf(buf) {
    const entries = parseZipEntries(buf);
    log.info(`Parsed ${entries.length} ZIP entries`);

    // Find the gcode file
    const gcodeEntry = entries.find(e =>
        e.fileName.match(/^Metadata\/plate_\d+\.gcode$/i) ||
        e.fileName.match(/plate_\d+\.gcode$/i)
    );

    if (!gcodeEntry) {
        // Try any .gcode file
        const fallback = entries.find(e => e.fileName.endsWith('.gcode'));
        if (!fallback) {
            throw new Error('No plate_*.gcode found in 3MF archive');
        }
        log.warn(`No Metadata/plate_*.gcode found, using fallback: ${fallback.fileName}`);
        return {
            gcodeText: decompressEntry(buf, fallback),
            gcodeEntryName: fallback.fileName,
            entries,
        };
    }

    return {
        gcodeText: decompressEntry(buf, gcodeEntry),
        gcodeEntryName: gcodeEntry.fileName,
        entries,
    };
}

// ============================================================
// REPACK .gcode.3mf WITH NEW GCODE CONTENT
// ============================================================

/**
 * Repack a .gcode.3mf by replacing the gcode entry content.
 *
 * @param {Buffer} originalBuf - Original .gcode.3mf buffer
 * @param {string} gcodeEntryName - Entry name to replace (e.g. "Metadata/plate_1.gcode")
 * @param {string} newGcodeContent - New gcode text
 * @returns {Buffer} - New .gcode.3mf buffer
 */
export function repack3mf(originalBuf, gcodeEntryName, newGcodeContent) {
    const entries = parseZipEntries(originalBuf);
    const parts = [];          // { fileName, buf, crc32, uncompressedSize, compressionMethod }
    const newGcodeBuf = Buffer.from(newGcodeContent, 'utf-8');
    const newGcodeCrc = crc32(newGcodeBuf);

    // MD5 entry name for the gcode
    const md5EntryName = gcodeEntryName + '.md5';

    for (const entry of entries) {
        if (entry.fileName === gcodeEntryName) {
            // Replace gcode content
            parts.push({
                fileName: entry.fileName,
                buf: newGcodeBuf,
                crc32: newGcodeCrc,
                uncompressedSize: newGcodeBuf.length,
                compressionMethod: 8,  // always deflate for gcode
                externalAttrs: entry.externalAttrs,
                lastModTime: entry.lastModTime,
                lastModDate: entry.lastModDate,
            });
        } else if (entry.fileName === md5EntryName) {
            // Update MD5 hash
            const md5Hash = createHash('md5').update(newGcodeBuf).digest('hex');
            const md5Buf = Buffer.from(md5Hash, 'utf-8');
            parts.push({
                fileName: entry.fileName,
                buf: md5Buf,
                crc32: crc32(md5Buf),
                uncompressedSize: md5Buf.length,
                compressionMethod: 0,  // store
                externalAttrs: entry.externalAttrs,
                lastModTime: entry.lastModTime,
                lastModDate: entry.lastModDate,
            });
        } else {
            // Copy original entry byte-for-byte
            const rawData = extractRawEntry(originalBuf, entry);
            parts.push({
                fileName: entry.fileName,
                buf: null,
                rawCompressed: rawData,
                crc32: entry.crc32,
                uncompressedSize: entry.uncompressedSize,
                compressionMethod: entry.compressionMethod,
                externalAttrs: entry.externalAttrs,
                lastModTime: entry.lastModTime,
                lastModDate: entry.lastModDate,
            });
        }
    }

    return buildZip(parts);
}

// ============================================================
// LOW-LEVEL ZIP PARSING
// ============================================================

function parseZipEntries(buf) {
    // Find EOCD
    let eocdOffset = -1;
    for (let i = buf.length - 22; i >= 0; i--) {
        if (buf.readUInt32LE(i) === EOCD_SIG) {
            eocdOffset = i;
            break;
        }
    }
    if (eocdOffset < 0) throw new Error('Not a valid ZIP: EOCD not found');

    const cdOffset = buf.readUInt32LE(eocdOffset + 16);
    const cdSize = buf.readUInt32LE(eocdOffset + 12);
    const totalEntries = buf.readUInt16LE(eocdOffset + 10);

    const entries = [];
    let pos = cdOffset;

    for (let i = 0; i < totalEntries; i++) {
        if (buf.readUInt32LE(pos) !== CENTRAL_DIR_SIG) {
            throw new Error(`Invalid central directory at offset ${pos}`);
        }

        const compressionMethod = buf.readUInt16LE(pos + 10);
        const lastModTime = buf.readUInt16LE(pos + 12);
        const lastModDate = buf.readUInt16LE(pos + 14);
        const entryCrc32 = buf.readUInt32LE(pos + 16);
        const compressedSize = buf.readUInt32LE(pos + 20);
        const uncompressedSize = buf.readUInt32LE(pos + 24);
        const fileNameLen = buf.readUInt16LE(pos + 28);
        const extraFieldLen = buf.readUInt16LE(pos + 30);
        const commentLen = buf.readUInt16LE(pos + 32);
        const externalAttrs = buf.readUInt32LE(pos + 38);
        const localHeaderOffset = buf.readUInt32LE(pos + 42);
        const fileName = buf.toString('utf-8', pos + 46, pos + 46 + fileNameLen);

        entries.push({
            compressionMethod,
            lastModTime,
            lastModDate,
            crc32: entryCrc32,
            compressedSize,
            uncompressedSize,
            fileNameLen,
            extraFieldLen,
            commentLen,
            externalAttrs,
            localHeaderOffset,
            fileName,
            cdOffset: pos,
        });

        pos += 46 + fileNameLen + extraFieldLen + commentLen;
    }

    return entries;
}

function decompressEntry(buf, entry) {
    // Read local file header to find actual data
    const lhOffset = entry.localHeaderOffset;
    if (buf.readUInt32LE(lhOffset) !== LOCAL_FILE_HEADER_SIG) {
        throw new Error(`Invalid local header at ${lhOffset}`);
    }

    const lhFileNameLen = buf.readUInt16LE(lhOffset + 26);
    const lhExtraLen = buf.readUInt16LE(lhOffset + 28);
    const dataStart = lhOffset + 30 + lhFileNameLen + lhExtraLen;
    const compressedData = buf.subarray(dataStart, dataStart + entry.compressedSize);

    if (entry.compressionMethod === 0) {
        return compressedData.toString('utf-8');
    } else if (entry.compressionMethod === 8) {
        return inflateRawSync(compressedData).toString('utf-8');
    } else {
        throw new Error(`Unsupported compression method: ${entry.compressionMethod}`);
    }
}

function extractRawEntry(buf, entry) {
    const lhOffset = entry.localHeaderOffset;
    const lhFileNameLen = buf.readUInt16LE(lhOffset + 26);
    const lhExtraLen = buf.readUInt16LE(lhOffset + 28);
    const dataStart = lhOffset + 30 + lhFileNameLen + lhExtraLen;
    return buf.subarray(dataStart, dataStart + entry.compressedSize);
}

// ============================================================
// ZIP BUILDING
// ============================================================

function buildZip(parts) {
    const localHeaders = [];
    const centralDirs = [];
    let offset = 0;

    for (const part of parts) {
        const fileNameBuf = Buffer.from(part.fileName, 'utf-8');
        let compressedBuf;

        if (part.rawCompressed) {
            // Byte-for-byte copy
            compressedBuf = part.rawCompressed;
        } else if (part.compressionMethod === 8) {
            compressedBuf = deflateRawSync(part.buf);
        } else {
            compressedBuf = part.buf;
        }

        const compressedSize = compressedBuf.length;
        const uncompressedSize = part.uncompressedSize;
        const entryCrc = part.crc32;

        // Local file header (30 bytes + filename)
        const lh = Buffer.alloc(30 + fileNameBuf.length);
        lh.writeUInt32LE(LOCAL_FILE_HEADER_SIG, 0);
        lh.writeUInt16LE(20, 4);   // version needed
        lh.writeUInt16LE(0, 6);    // flags
        lh.writeUInt16LE(part.compressionMethod, 8);
        lh.writeUInt16LE(part.lastModTime || 0, 10);
        lh.writeUInt16LE(part.lastModDate || 0, 12);
        lh.writeUInt32LE(entryCrc, 14);
        lh.writeUInt32LE(compressedSize, 18);
        lh.writeUInt32LE(uncompressedSize, 22);
        lh.writeUInt16LE(fileNameBuf.length, 26);
        lh.writeUInt16LE(0, 28); // no extra field
        fileNameBuf.copy(lh, 30);

        const cd = Buffer.alloc(46 + fileNameBuf.length);
        cd.writeUInt32LE(CENTRAL_DIR_SIG, 0);
        cd.writeUInt16LE(20, 4);   // version made by
        cd.writeUInt16LE(20, 6);   // version needed
        cd.writeUInt16LE(0, 8);    // flags
        cd.writeUInt16LE(part.compressionMethod, 10);
        cd.writeUInt16LE(part.lastModTime || 0, 12);
        cd.writeUInt16LE(part.lastModDate || 0, 14);
        cd.writeUInt32LE(entryCrc, 16);
        cd.writeUInt32LE(compressedSize, 20);
        cd.writeUInt32LE(uncompressedSize, 24);
        cd.writeUInt16LE(fileNameBuf.length, 28);
        cd.writeUInt16LE(0, 30);   // extra field length
        cd.writeUInt16LE(0, 32);   // comment length
        cd.writeUInt16LE(0, 34);   // disk number
        cd.writeUInt16LE(0, 36);   // internal attributes
        cd.writeUInt32LE(part.externalAttrs || 0, 38);
        cd.writeUInt32LE(offset, 42);
        fileNameBuf.copy(cd, 46);

        localHeaders.push(lh, compressedBuf);
        centralDirs.push(cd);
        offset += lh.length + compressedBuf.length;
    }

    const centralDirOffset = offset;
    const centralDirSize = centralDirs.reduce((sum, buf) => sum + buf.length, 0);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(0, 4); // disk number
    eocd.writeUInt16LE(0, 6); // central directory disk
    eocd.writeUInt16LE(parts.length, 8);
    eocd.writeUInt16LE(parts.length, 10);
    eocd.writeUInt32LE(centralDirSize, 12);
    eocd.writeUInt32LE(centralDirOffset, 16);
    eocd.writeUInt16LE(0, 20); // no zip comment

    return Buffer.concat([...localHeaders, ...centralDirs, eocd]);
}

const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let value = i;
        for (let bit = 0; bit < 8; bit++) {
            value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
        }
        table[i] = value >>> 0;
    }
    return table;
})();

function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (const byte of buf) {
        crc = CRC32_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}
