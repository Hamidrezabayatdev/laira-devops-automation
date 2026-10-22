import { createHash } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';
import { crc32, createGunzip } from 'node:zlib';
import tar from 'tar-stream';
import yauzl from 'yauzl';
import { isExcludedSourcePath, validateSourcePath } from './policy.js';
import {
  DEFAULT_SOURCE_LIMITS,
  SourceImportError,
  type SourceFile,
  type SourceInventory,
  type SourceLimits,
} from './types.js';

const VALID_LIMIT_KEYS = new Set<string>([
  'maxArchiveBytes',
  'maxExpandedBytes',
  'maxEntries',
  'maxFileBytes',
  'maxRetainedBytes',
]);

const PARSER_DEADLINE_MS = 10_000;
const fatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true });

function decodeZipFileName(rawBuffer: Buffer, generalPurposeBitFlag: number): string {
  const isUtf8Flag = (generalPurposeBitFlag & 0x800) !== 0;

  if (isUtf8Flag) {
    try {
      return fatalUtf8Decoder.decode(rawBuffer);
    } catch {
      throw new SourceImportError('UNSAFE_ENTRY');
    }
  }

  // Without UTF-8 flag, strict subset requires safe ASCII only.
  // Ambiguous non-ASCII (CP437) paths without explicit UTF-8 flag fail closed.
  for (let i = 0; i < rawBuffer.length; i++) {
    if (rawBuffer[i]! >= 0x80) {
      throw new SourceImportError('UNSAFE_ENTRY');
    }
  }

  return rawBuffer.toString('ascii');
}

function resolveLimits(limits?: Partial<SourceLimits>): SourceLimits {
  if (limits === undefined || limits === null) {
    return { ...DEFAULT_SOURCE_LIMITS };
  }
  if (typeof limits !== 'object' || Array.isArray(limits)) {
    throw new SourceImportError('LIMIT_EXCEEDED');
  }
  for (const key of Object.keys(limits)) {
    if (!VALID_LIMIT_KEYS.has(key)) {
      throw new SourceImportError('LIMIT_EXCEEDED');
    }
    const val = (limits as Record<string, unknown>)[key];
    if (
      typeof val !== 'number' ||
      !Number.isFinite(val) ||
      !Number.isSafeInteger(val) ||
      val <= 0 ||
      val > DEFAULT_SOURCE_LIMITS[key as keyof SourceLimits]
    ) {
      throw new SourceImportError('LIMIT_EXCEEDED');
    }
  }
  return {
    ...DEFAULT_SOURCE_LIMITS,
    ...limits,
  };
}

class PathCollisionTracker {
  private readonly seenEntries = new Set<string>();
  private readonly seenFiles = new Set<string>();
  private readonly seenDirs = new Set<string>();
  private readonly ancestorDirs = new Set<string>();

  checkAndRecord(validatedPath: string, isDir: boolean): void {
    const canonical = validatedPath.normalize('NFC').toLowerCase();

    // Direct collision: identical canonical path seen before (same file or dir, including NFC / case)
    if (this.seenEntries.has(canonical)) {
      throw new SourceImportError('UNSAFE_ENTRY');
    }

    const segments = canonical.split('/');
    const parents: string[] = [];
    for (let i = 1; i < segments.length; i++) {
      parents.push(segments.slice(0, i).join('/'));
    }

    if (isDir) {
      // Cannot declare a directory if a regular file with this name was already seen
      if (this.seenFiles.has(canonical)) {
        throw new SourceImportError('UNSAFE_ENTRY');
      }
      // Cannot declare a directory if any ancestor was declared as a regular file
      for (const parent of parents) {
        if (this.seenFiles.has(parent)) {
          throw new SourceImportError('UNSAFE_ENTRY');
        }
      }
      this.seenEntries.add(canonical);
      this.seenDirs.add(canonical);
      this.ancestorDirs.add(canonical);
      for (const parent of parents) {
        this.ancestorDirs.add(parent);
      }
    } else {
      // Entry is a file
      // Cannot declare a file if a directory with this name was already seen
      if (this.seenDirs.has(canonical)) {
        throw new SourceImportError('UNSAFE_ENTRY');
      }
      // Cannot declare a file if this path was already used as an ancestor directory by an existing entry
      if (this.ancestorDirs.has(canonical)) {
        throw new SourceImportError('UNSAFE_ENTRY');
      }
      // Cannot declare a file if any ancestor was declared as a regular file
      for (const parent of parents) {
        if (this.seenFiles.has(parent)) {
          throw new SourceImportError('UNSAFE_ENTRY');
        }
      }
      this.seenEntries.add(canonical);
      this.seenFiles.add(canonical);
      for (const parent of parents) {
        this.ancestorDirs.add(parent);
      }
    }
  }
}

/**
 * Strict USTAR framing transform:
 * Observes 512-byte headers before tar-stream parser to:
 * 1. Count ALL metadata/file entries against maxEntries before tar-stream internally absorbs them.
 * 2. Reject all non-file/dir types (links, symlinks, char/block devices, fifos, PAX headers, GNU long metadata).
 * 3. Validate name and prefix fields using fatal UTF-8 and reject ambiguous trailing bytes after NUL terminator.
 * 4. Parse size using strict octal digits (/^[0-7]+$/) to prevent partial parseInt suffixes.
 * 5. Require at least two 512-byte zero EOF blocks and reject trailing non-zero blocks.
 */
class TarFramingTransform extends Transform {
  private readonly bufferQueue: Buffer[] = [];
  private bufferedLen = 0;
  private state: 'AWAITING_HEADER' | 'STREAMING_BODY' = 'AWAITING_HEADER';
  private bodyBytesRemaining = 0;
  private consecutiveZeroBlocks = 0;
  private rawEntryCount = 0;
  private readonly limits: SourceLimits;
  private readonly onExpandedBytes: (added: number) => void;

  constructor(
    limits: SourceLimits,
    onExpandedBytes: (added: number) => void
  ) {
    super();
    this.limits = limits;
    this.onExpandedBytes = onExpandedBytes;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.onExpandedBytes(chunk.length);
    } catch (err) {
      callback(err instanceof Error ? err : new SourceImportError('LIMIT_EXCEEDED'));
      return;
    }

    this.bufferQueue.push(chunk);
    this.bufferedLen += chunk.length;

    while (this.bufferedLen > 0) {
      if (this.state === 'AWAITING_HEADER') {
        if (this.bufferedLen < 512) {
          break; // wait for full 512-byte header
        }

        const header = this.shiftBytes(512);

        // Check if block is all zeroes (EOF block)
        let isZero = true;
        for (let i = 0; i < 512; i++) {
          if (header[i] !== 0) {
            isZero = false;
            break;
          }
        }

        if (isZero) {
          this.consecutiveZeroBlocks++;
          this.push(header);
          continue;
        }

        // Non-zero block after an EOF block was already seen is malformed
        if (this.consecutiveZeroBlocks > 0) {
          callback(new SourceImportError('INVALID_ARCHIVE'));
          return;
        }

        this.rawEntryCount++;
        if (this.rawEntryCount > this.limits.maxEntries) {
          callback(new SourceImportError('LIMIT_EXCEEDED'));
          return;
        }

        // Check typeflag at offset 156
        const typeflag = header[156];
        // Hardlinks (0x31 '1'), Symlinks (0x32 '2'), Char dev (0x33 '3'), Block dev (0x34 '4'), Fifo (0x36 '6')
        if (
          typeflag === 0x31 ||
          typeflag === 0x32 ||
          typeflag === 0x33 ||
          typeflag === 0x34 ||
          typeflag === 0x36
        ) {
          callback(new SourceImportError('UNSAFE_ENTRY'));
          return;
        }

        // Only regular files (0x30 '0' or 0x00 '\0') and directories (0x35 '5') are accepted
        // GNU long metadata ('L', 'K'), PAX ('x', 'g'), or other types reject as INVALID_ARCHIVE
        if (typeflag !== 0x30 && typeflag !== 0x00 && typeflag !== 0x35) {
          callback(new SourceImportError('INVALID_ARCHIVE'));
          return;
        }

        // Check name field (bytes 0..100) for trailing garbage after NUL terminator & fatal UTF-8
        let firstNul = -1;
        for (let i = 0; i < 100; i++) {
          if (header[i] === 0) {
            firstNul = i;
            break;
          }
        }
        if (firstNul >= 0) {
          for (let i = firstNul + 1; i < 100; i++) {
            if (header[i] !== 0) {
              callback(new SourceImportError('UNSAFE_ENTRY'));
              return;
            }
          }
        }
        const nameLen = firstNul >= 0 ? firstNul : 100;
        try {
          fatalUtf8Decoder.decode(header.subarray(0, nameLen));
        } catch {
          callback(new SourceImportError('UNSAFE_ENTRY'));
          return;
        }

        // Check prefix field (bytes 345..500) for trailing garbage after NUL terminator & fatal UTF-8
        let firstNulPrefix = -1;
        for (let i = 345; i < 500; i++) {
          if (header[i] === 0) {
            firstNulPrefix = i;
            break;
          }
        }
        if (firstNulPrefix >= 0) {
          for (let i = firstNulPrefix + 1; i < 500; i++) {
            if (header[i] !== 0) {
              callback(new SourceImportError('UNSAFE_ENTRY'));
              return;
            }
          }
        }
        const prefixLen = firstNulPrefix >= 0 ? firstNulPrefix - 345 : 155;
        if (prefixLen > 0) {
          try {
            fatalUtf8Decoder.decode(header.subarray(345, 345 + prefixLen));
          } catch {
            callback(new SourceImportError('UNSAFE_ENTRY'));
            return;
          }
        }

        // Parse size field strictly (bytes 124..136, octal)
        const sizeField = header.subarray(124, 136).toString('ascii');
        const trimmedSize = sizeField.replace(/[\0 ]+$/, '').replace(/^ +/, '');
        let entrySize = 0;
        if (trimmedSize.length > 0) {
          if (!/^[0-7]+$/.test(trimmedSize)) {
            callback(new SourceImportError('INVALID_ARCHIVE'));
            return;
          }
          entrySize = parseInt(trimmedSize, 8);
          if (!Number.isSafeInteger(entrySize) || entrySize < 0) {
            callback(new SourceImportError('INVALID_ARCHIVE'));
            return;
          }
        }

        if (typeflag === 0x35 && entrySize !== 0) {
          callback(new SourceImportError('INVALID_ARCHIVE'));
          return;
        }

        this.push(header);

        const bodyBytes = Math.ceil(entrySize / 512) * 512;
        if (bodyBytes > 0) {
          this.state = 'STREAMING_BODY';
          this.bodyBytesRemaining = bodyBytes;
        }
      } else {
        // STREAMING_BODY
        const take = Math.min(this.bufferedLen, this.bodyBytesRemaining);
        const bodyChunk = this.shiftBytes(take);
        this.bodyBytesRemaining -= take;
        this.push(bodyChunk);
        if (this.bodyBytesRemaining === 0) {
          this.state = 'AWAITING_HEADER';
        }
      }
    }

    callback();
  }

  override _flush(callback: TransformCallback): void {
    if (this.bufferedLen > 0 || this.state === 'STREAMING_BODY') {
      callback(new SourceImportError('INVALID_ARCHIVE'));
      return;
    }
    // Strict USTAR requirement: must contain at least 2 consecutive zero EOF blocks (1024 null bytes)
    if (this.consecutiveZeroBlocks < 2) {
      callback(new SourceImportError('INVALID_ARCHIVE'));
      return;
    }
    callback();
  }

  private shiftBytes(n: number): Buffer {
    const res = Buffer.allocUnsafe(n);
    let offset = 0;
    while (offset < n) {
      const first = this.bufferQueue[0];
      if (!first) break;
      const take = Math.min(first.length, n - offset);
      first.copy(res, offset, 0, take);
      offset += take;
      if (take === first.length) {
        this.bufferQueue.shift();
      } else {
        this.bufferQueue[0] = first.subarray(take);
      }
    }
    this.bufferedLen -= n;
    return res;
  }
}

async function ingestZip(
  buffer: Buffer,
  limits: SourceLimits,
  archiveDigest: string
): Promise<SourceInventory> {
  return new Promise<SourceInventory>((resolve, reject) => {
    let expandedBytes = 0;
    let entryCount = 0;
    let excludedCount = 0;
    let oversizedCount = 0;
    let retainedBytes = 0;
    const files: SourceFile[] = [];
    const tracker = new PathCollisionTracker();

    let settled = false;
    let zip: yauzl.ZipFile | null = null;
    let activeStream: { destroy?: () => void } | null = null;

    const cleanup = () => {
      clearTimeout(timer);
      if (activeStream) {
        try {
          activeStream.destroy?.();
        } catch {
          // ignore cleanup errors
        }
        activeStream = null;
      }
      if (zip) {
        try {
          zip.close();
        } catch {
          // ignore cleanup errors
        }
        zip = null;
      }
    };

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err instanceof SourceImportError) {
        reject(err);
      } else {
        reject(new SourceImportError('INVALID_ARCHIVE'));
      }
    };

    const timer = setTimeout(() => {
      fail(new SourceImportError('LIMIT_EXCEEDED'));
    }, PARSER_DEADLINE_MS);
    timer.unref?.();

    yauzl.fromBuffer(
      buffer,
      { lazyEntries: true, autoClose: false, decodeStrings: false, validateEntrySizes: true },
      (err, zipfile) => {
        if (settled) {
          if (zipfile) {
            try {
              zipfile.close();
            } catch {
              // ignore
            }
          }
          return;
        }

        if (err || !zipfile) {
          fail(err || new SourceImportError('INVALID_ARCHIVE'));
          return;
        }

        zip = zipfile;

        zipfile.on('error', (zipErr) => fail(zipErr));

        zipfile.on('end', () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve({
            archiveDigest,
            archiveBytes: buffer.byteLength,
            expandedBytes,
            entryCount,
            files,
            excludedCount,
            oversizedCount,
          });
        });

        zipfile.on('entry', (entry: yauzl.Entry) => {
          if (settled) return;

          try {
            entryCount++;
            if (entryCount > limits.maxEntries) {
              throw new SourceImportError('LIMIT_EXCEEDED');
            }

            // Reject encrypted entries
            if (entry.isEncrypted() || (entry.generalPurposeBitFlag & 0x1) !== 0) {
              throw new SourceImportError('INVALID_ARCHIVE');
            }

            // Compression method must be 0 (stored) or 8 (deflated)
            if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
              throw new SourceImportError('INVALID_ARCHIVE');
            }

            const host = entry.versionMadeBy >>> 8;
            const extAttrs = entry.externalFileAttributes >>> 0;
            const unixMode = (extAttrs >>> 16) & 0xffff;
            const unixType = unixMode & 0o170000;
            const dosAttrs = extAttrs & 0xff;

            // Reject symlinks (0o120000) and special files (char dev 0o020000, block dev 0o060000, fifo 0o010000, socket 0o140000)
            if (
              unixType === 0o120000 ||
              unixType === 0o020000 ||
              unixType === 0o060000 ||
              unixType === 0o010000 ||
              unixType === 0o140000
            ) {
              throw new SourceImportError('UNSAFE_ENTRY');
            }

            // DOS attributes: reject device attribute (0x40) or volume label (0x08)
            if ((dosAttrs & 0x40) !== 0 || (dosAttrs & 0x08) !== 0) {
              throw new SourceImportError('UNSAFE_ENTRY');
            }

            // If creator host was UNIX (host === 3), unixType must be regular (0o100000), directory (0o040000), or 0
            if (host === 3 && unixType !== 0 && unixType !== 0o100000 && unixType !== 0o040000) {
              throw new SourceImportError('UNSAFE_ENTRY');
            }

            // Strict string decoding: fatal UTF-8 when flag bit 11 is set; safe ASCII only when unset
            const rawNameBuf = Buffer.isBuffer(entry.fileName)
              ? entry.fileName
              : (entry as { fileNameRaw?: Buffer }).fileNameRaw || Buffer.from(entry.fileName);

            const decodedFileName = decodeZipFileName(rawNameBuf, entry.generalPurposeBitFlag);

            const isDir =
              decodedFileName.endsWith('/') ||
              unixType === 0o040000 ||
              (dosAttrs & 0x10) !== 0;

            const validatedPath = validateSourcePath(decodedFileName, isDir);
            tracker.checkAndRecord(validatedPath, isDir);

            if (isDir) {
              // Validate directory metadata: uncompressedSize 0, crc32 0, compressedSize 0 (for stored)
              if (entry.uncompressedSize !== 0 || entry.crc32 !== 0) {
                throw new SourceImportError('INVALID_ARCHIVE');
              }
              if (entry.compressionMethod === 0 && entry.compressedSize !== 0) {
                throw new SourceImportError('INVALID_ARCHIVE');
              }
            }

            const excluded = !isDir && isExcludedSourcePath(validatedPath);
            if (excluded) {
              excludedCount++;
            }

            zipfile.openReadStream(entry, (streamErr, stream) => {
              if (settled) {
                if (stream) {
                  try {
                    stream.destroy();
                  } catch {
                    // ignore
                  }
                }
                return;
              }

              if (streamErr || !stream) {
                fail(streamErr || new SourceImportError('INVALID_ARCHIVE'));
                return;
              }

              activeStream = stream;
              let entryBytes = 0;
              let runningCrc = 0;
              const chunks: Buffer[] = [];
              let isOversized = false;

              stream.on('data', (chunk: Buffer) => {
                if (settled) return;

                entryBytes += chunk.length;
                expandedBytes += chunk.length;
                if (expandedBytes > limits.maxExpandedBytes) {
                  fail(new SourceImportError('LIMIT_EXCEEDED'));
                  return;
                }

                runningCrc = crc32(chunk, runningCrc);

                if (!isDir && !excluded && !isOversized) {
                  if (entryBytes > limits.maxFileBytes) {
                    isOversized = true;
                    chunks.length = 0;
                  } else {
                    chunks.push(chunk);
                  }
                }
              });

              stream.on('end', () => {
                activeStream = null;
                if (settled) return;

                // Validate declared vs actual size
                if (entryBytes !== entry.uncompressedSize) {
                  fail(new SourceImportError('INVALID_ARCHIVE'));
                  return;
                }

                // Validate actual CRC32 against metadata
                if ((runningCrc >>> 0) !== (entry.crc32 >>> 0)) {
                  fail(new SourceImportError('INVALID_ARCHIVE'));
                  return;
                }

                // Directory must decompress to 0 bytes
                if (isDir && entryBytes !== 0) {
                  fail(new SourceImportError('INVALID_ARCHIVE'));
                  return;
                }

                if (!isDir && !excluded) {
                  if (isOversized || entryBytes > limits.maxFileBytes) {
                    oversizedCount++;
                  } else {
                    if (retainedBytes + entryBytes > limits.maxRetainedBytes) {
                      fail(new SourceImportError('LIMIT_EXCEEDED'));
                      return;
                    }
                    retainedBytes += entryBytes;
                    files.push({
                      path: validatedPath,
                      bytes: new Uint8Array(Buffer.concat(chunks)),
                    });
                  }
                }

                zipfile.readEntry();
              });

              stream.on('error', (err) => fail(err));
            });
          } catch (err) {
            fail(err);
          }
        });

        zipfile.readEntry();
      }
    );
  });
}

async function ingestTarGz(
  buffer: Buffer,
  limits: SourceLimits,
  archiveDigest: string
): Promise<SourceInventory> {
  return new Promise<SourceInventory>((resolve, reject) => {
    let expandedBytes = 0;
    let entryCount = 0;
    let excludedCount = 0;
    let oversizedCount = 0;
    let retainedBytes = 0;
    const files: SourceFile[] = [];
    const tracker = new PathCollisionTracker();

    let settled = false;
    let activeStream: { destroy?: () => void } | null = null;
    let gunzipEnded = false;

    const gunzip = createGunzip();
    const extract = tar.extract();

    const framing = new TarFramingTransform(limits, (added) => {
      expandedBytes += added;
      if (expandedBytes > limits.maxExpandedBytes) {
        throw new SourceImportError('LIMIT_EXCEEDED');
      }
    });

    const cleanup = () => {
      clearTimeout(timer);
      if (activeStream) {
        try {
          activeStream.destroy?.();
        } catch {
          // ignore cleanup errors
        }
        activeStream = null;
      }
      try {
        framing.destroy();
      } catch {
        // ignore
      }
      try {
        gunzip.destroy();
      } catch {
        // ignore
      }
      try {
        extract.destroy();
      } catch {
        // ignore
      }
    };

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err instanceof SourceImportError) {
        reject(err);
      } else {
        reject(new SourceImportError('INVALID_ARCHIVE'));
      }
    };

    const timer = setTimeout(() => {
      fail(new SourceImportError('LIMIT_EXCEEDED'));
    }, PARSER_DEADLINE_MS);
    timer.unref?.();

    gunzip.on('error', (err) => fail(err));
    framing.on('error', (err) => fail(err));
    extract.on('error', (err) => fail(err));

    gunzip.on('end', () => {
      gunzipEnded = true;
    });

    extract.on('finish', () => {
      if (!gunzipEnded) {
        fail(new SourceImportError('INVALID_ARCHIVE'));
        return;
      }
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        archiveDigest,
        archiveBytes: buffer.byteLength,
        expandedBytes,
        entryCount,
        files,
        excludedCount,
        oversizedCount,
      });
    });

    extract.on('entry', (header, stream, next) => {
      if (settled) return;

      try {
        entryCount++;
        if (entryCount > limits.maxEntries) {
          throw new SourceImportError('LIMIT_EXCEEDED');
        }

        if (header.type !== 'file' && header.type !== 'directory') {
          throw new SourceImportError('UNSAFE_ENTRY');
        }

        if (header.linkname) {
          throw new SourceImportError('UNSAFE_ENTRY');
        }

        const isDir = header.type === 'directory' || header.name.endsWith('/');
        const validatedPath = validateSourcePath(header.name, isDir);
        tracker.checkAndRecord(validatedPath, isDir);

        if (isDir) {
          if (header.size !== undefined && header.size !== 0) {
            throw new SourceImportError('INVALID_ARCHIVE');
          }
          stream.resume();
          stream.on('end', () => next());
          return;
        }

        // File entry
        const excluded = isExcludedSourcePath(validatedPath);
        if (excluded) {
          excludedCount++;
        }

        activeStream = stream;
        let entryBytes = 0;
        const chunks: Buffer[] = [];
        let isOversized = false;

        stream.on('data', (chunk: unknown) => {
          if (settled) return;

          const chunkBuf = Buffer.isBuffer(chunk)
            ? chunk
            : typeof chunk === 'string'
              ? Buffer.from(chunk)
              : Buffer.from(
                  (chunk as Uint8Array).buffer,
                  (chunk as Uint8Array).byteOffset,
                  (chunk as Uint8Array).byteLength
                );
          entryBytes += chunkBuf.length;
          if (!excluded && !isOversized) {
            if (entryBytes > limits.maxFileBytes) {
              isOversized = true;
              chunks.length = 0;
            } else {
              chunks.push(chunkBuf);
            }
          }
        });

        stream.on('end', () => {
          activeStream = null;
          if (settled) return;

          if (header.size !== undefined && entryBytes !== header.size) {
            fail(new SourceImportError('INVALID_ARCHIVE'));
            return;
          }

          if (!excluded) {
            if (isOversized || entryBytes > limits.maxFileBytes) {
              oversizedCount++;
            } else {
              if (retainedBytes + entryBytes > limits.maxRetainedBytes) {
                fail(new SourceImportError('LIMIT_EXCEEDED'));
                return;
              }
              retainedBytes += entryBytes;
              files.push({
                path: validatedPath,
                bytes: new Uint8Array(Buffer.concat(chunks)),
              });
            }
          }

          next();
        });

        stream.on('error', (err) => fail(err));
      } catch (err) {
        fail(err);
      }
    });

    gunzip.pipe(framing).pipe(extract);
    gunzip.end(buffer);
  });
}

export async function ingestSourceArchive(
  bytes: Uint8Array,
  format: 'zip' | 'tar.gz',
  limits?: Partial<SourceLimits>
): Promise<SourceInventory> {
  if (format !== 'zip' && format !== 'tar.gz') {
    throw new SourceImportError('UNSUPPORTED_FORMAT');
  }

  const effectiveLimits = resolveLimits(limits);

  if (!(bytes instanceof Uint8Array)) {
    throw new SourceImportError('INVALID_ARCHIVE');
  }

  // Reject SharedArrayBuffer backing
  if (
    typeof SharedArrayBuffer !== 'undefined' &&
    (bytes.buffer instanceof SharedArrayBuffer ||
      Object.prototype.toString.call(bytes.buffer) === '[object SharedArrayBuffer]')
  ) {
    throw new SourceImportError('INVALID_ARCHIVE');
  }

  if (bytes.byteLength > effectiveLimits.maxArchiveBytes) {
    throw new SourceImportError('LIMIT_EXCEEDED');
  }

  // Immediate defensive copy snapshot: caller cannot concurrently mutate during await
  const snapshot = Buffer.allocUnsafe(bytes.byteLength);
  snapshot.set(bytes);

  const archiveDigest = `sha256:${createHash('sha256').update(snapshot).digest('hex')}`;

  if (format === 'zip') {
    return ingestZip(snapshot, effectiveLimits, archiveDigest);
  } else {
    return ingestTarGz(snapshot, effectiveLimits, archiveDigest);
  }
}
