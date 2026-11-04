import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  filename: string;
  content: string | Buffer;
}

/**
 * Creates a standard PKZIP archive buffer in memory without external dependencies.
 * Uses node:zlib for DEFLATE compression and CRC32 calculation.
 * Encodes filenames as UTF-8 (bit 11).
 */
export function createZipArchive(entries: ZipEntry[]): Buffer {
  const localHeadersAndData: Buffer[] = [];
  const centralDirHeaders: Buffer[] = [];
  let currentOffset = 0;

  for (const entry of entries) {
    const rawContent = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, 'utf8');
    const filenameBuf = Buffer.from(entry.filename, 'utf8');
    const uncompressedSize = rawContent.length;
    const checksum = uncompressedSize > 0 ? crc32(rawContent) : 0;

    // Use Deflate for non-empty files; store method (0) for empty
    const isCompressed = uncompressedSize > 0;
    const compressedData = isCompressed ? deflateRawSync(rawContent) : Buffer.alloc(0);
    const compressedSize = compressedData.length;
    const compressionMethod = isCompressed ? 8 : 0;

    // Local File Header (30 bytes + filename)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4);         // version needed (2.0)
    localHeader.writeUInt16LE(0x0800, 6);     // general purpose flag: bit 11 UTF-8
    localHeader.writeUInt16LE(compressionMethod, 8);
    localHeader.writeUInt16LE(0, 10);        // mod time
    localHeader.writeUInt16LE(0, 12);        // mod date
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressedSize, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(filenameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);        // extra length

    const fullLocal = Buffer.concat([localHeader, filenameBuf, compressedData]);
    localHeadersAndData.push(fullLocal);

    // Central Directory File Header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // signature
    centralHeader.writeUInt16LE(20, 4);          // version made by
    centralHeader.writeUInt16LE(20, 6);          // version needed
    centralHeader.writeUInt16LE(0x0800, 8);      // flags UTF-8
    centralHeader.writeUInt16LE(compressionMethod, 10);
    centralHeader.writeUInt16LE(0, 12);         // mod time
    centralHeader.writeUInt16LE(0, 14);         // mod date
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressedSize, 20);
    centralHeader.writeUInt32LE(uncompressedSize, 24);
    centralHeader.writeUInt16LE(filenameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);         // extra length
    centralHeader.writeUInt16LE(0, 32);         // comment length
    centralHeader.writeUInt16LE(0, 34);         // disk start
    centralHeader.writeUInt16LE(0, 36);         // internal attrs
    centralHeader.writeUInt32LE(0, 38);         // external attrs
    centralHeader.writeUInt32LE(currentOffset, 42); // local header offset

    const fullCentral = Buffer.concat([centralHeader, filenameBuf]);
    centralDirHeaders.push(fullCentral);

    currentOffset += fullLocal.length;
  }

  const centralDirBuffer = Buffer.concat(centralDirHeaders);
  const centralDirSize = centralDirBuffer.length;
  const centralDirOffset = currentOffset;

  // End of Central Directory Record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);                 // signature
  eocd.writeUInt16LE(0, 4);                          // disk number
  eocd.writeUInt16LE(0, 6);                          // disk start
  eocd.writeUInt16LE(entries.length, 8);             // entries on this disk
  eocd.writeUInt16LE(entries.length, 10);            // total entries
  eocd.writeUInt32LE(centralDirSize, 12);            // size of central directory
  eocd.writeUInt32LE(centralDirOffset, 16);          // offset of central directory
  eocd.writeUInt16LE(0, 20);                         // comment length

  return Buffer.concat([...localHeadersAndData, centralDirBuffer, eocd]);
}

