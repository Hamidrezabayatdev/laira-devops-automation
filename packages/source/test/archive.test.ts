import { createHash } from 'node:crypto';
import { crc32, gzipSync } from 'node:zlib';
import { pack } from 'tar-stream';
import { describe, expect, it } from 'vitest';
import { ingestSourceArchive } from '../src/archive.js';
import { DEFAULT_SOURCE_LIMITS, SourceImportError } from '../src/types.js';

interface ZipTestEntry {
  name?: string;
  nameRaw?: Buffer;
  content?: string | Uint8Array;
  mode?: number;
  host?: number;
  flags?: number;
  compressionMethod?: number;
  crc?: number;
  uncompressedSize?: number;
  compressedSize?: number;
  externalFileAttributes?: number;
}

function createZipBuffer(entries: ZipTestEntry[]): Uint8Array {
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = entry.nameRaw || Buffer.from(entry.name || '', 'utf8');
    const content = entry.content
      ? Buffer.isBuffer(entry.content)
        ? entry.content
        : typeof entry.content === 'string'
          ? Buffer.from(entry.content, 'utf8')
          : Buffer.from(entry.content)
      : Buffer.alloc(0);

    const crc = entry.crc !== undefined ? entry.crc : crc32(content);
    const size = entry.uncompressedSize !== undefined ? entry.uncompressedSize : content.length;
    const compSize = entry.compressedSize !== undefined ? entry.compressedSize : content.length;
    const isDir = entry.name ? entry.name.endsWith('/') : false;
    const mode = entry.mode !== undefined ? entry.mode : isDir ? 0o040755 : 0o100644;
    const host = entry.host !== undefined ? entry.host : 3; // UNIX

    const hasNonAscii = [...nameBuf].some((b) => b >= 0x80);
    const defaultFlags = hasNonAscii ? 0x800 : 0;
    const flags = entry.flags !== undefined ? entry.flags : defaultFlags;

    const method = entry.compressionMethod !== undefined ? entry.compressionMethod : 0;
    const extAttrs =
      entry.externalFileAttributes !== undefined
        ? entry.externalFileAttributes
        : ((mode << 16) >>> 0) | (isDir ? 0x10 : 0);

    const local = Buffer.alloc(30 + nameBuf.length + content.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(compSize >>> 0, 18);
    local.writeUInt32LE(size >>> 0, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    content.copy(local, 30 + nameBuf.length);
    localHeaders.push(local);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(((host << 8) | 20) >>> 0, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(compSize >>> 0, 20);
    central.writeUInt32LE(size >>> 0, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(extAttrs >>> 0, 38);
    central.writeUInt32LE(offset >>> 0, 42);
    nameBuf.copy(central, 46);
    centralHeaders.push(central);

    offset += local.length;
  }

  const centralBuf = Buffer.concat(centralHeaders);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return new Uint8Array(Buffer.concat([...localHeaders, centralBuf, eocd]));
}

async function createTarGzBuffer(
  entries: Array<{
    name: string;
    content?: string | Uint8Array;
    type?:
      | 'file'
      | 'directory'
      | 'symlink'
      | 'link'
      | 'character-device'
      | 'block-device'
      | 'fifo';
    linkname?: string;
    size?: number;
    pax?: Record<string, string>;
  }>
): Promise<Uint8Array> {
  const p = pack();
  for (const e of entries) {
    const isDir = e.type === 'directory' || e.name.endsWith('/');
    const content = e.content
      ? Buffer.isBuffer(e.content)
        ? e.content
        : typeof e.content === 'string'
          ? Buffer.from(e.content, 'utf8')
          : Buffer.from(e.content)
      : Buffer.alloc(0);

    const size = e.size !== undefined ? e.size : isDir ? 0 : content.length;

    p.entry(
      {
        name: e.name,
        type: e.type || (isDir ? 'directory' : 'file'),
        linkname: e.linkname,
        size,
        // @ts-expect-error test-only pax injection
        pax: e.pax,
      },
      isDir ? undefined : content
    );
  }
  p.finalize();

  const chunks: Buffer[] = [];
  return new Promise<Uint8Array>((resolve, reject) => {
    p.on('data', (c) => chunks.push(c));
    p.on('end', () => {
      try {
        const tarBuf = Buffer.concat(chunks);
        resolve(new Uint8Array(gzipSync(tarBuf)));
      } catch (err) {
        reject(err);
      }
    });
    p.on('error', reject);
  });
}

function createRawTarBlock(opts: {
  name?: string;
  nameRaw?: Buffer;
  typeflag?: number;
  size?: number;
  sizeFieldRaw?: string;
  corruptNulName?: boolean;
}): Buffer {
  const header = Buffer.alloc(512);
  if (opts.nameRaw) {
    opts.nameRaw.copy(header, 0);
  } else {
    const name = opts.name || 'file.txt';
    const nameBuf = Buffer.from(name, 'utf8');
    nameBuf.copy(header, 0);

    if (opts.corruptNulName) {
      header[nameBuf.length] = 0;
      header[nameBuf.length + 1] = 0x41; // 'A'
    }
  }

  // mode
  Buffer.from('0000644\0').copy(header, 100);
  // uid
  Buffer.from('0000000\0').copy(header, 108);
  // gid
  Buffer.from('0000000\0').copy(header, 116);
  // size
  if (opts.sizeFieldRaw) {
    Buffer.from(opts.sizeFieldRaw).copy(header, 124);
  } else {
    const size = opts.size || 0;
    const sizeStr = size.toString(8).padStart(11, '0') + ' ';
    Buffer.from(sizeStr).copy(header, 124);
  }
  // mtime
  Buffer.from('00000000000\0').copy(header, 136);
  // typeflag
  header[156] = opts.typeflag !== undefined ? opts.typeflag : 0x30;
  // magic
  Buffer.from('ustar\0').copy(header, 257);
  Buffer.from('00').copy(header, 263);

  // checksum
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (let i = 0; i < 512; i++) {
    sum += header[i]!;
  }
  const sumStr = sum.toString(8).padStart(6, '0') + '\0 ';
  Buffer.from(sumStr).copy(header, 148);

  return header;
}

describe('ingestSourceArchive', () => {
  describe('input format, snapshot isolation, and limits validation', () => {
    it('defensive snapshot: caller mutating original bytes immediately does not affect inventory digest or files', async () => {
      const originalContent = 'console.log("unmutated");';
      const zipBytes = createZipBuffer([
        { name: 'main.ts', content: originalContent },
      ]);
      const expectedDigest = `sha256:${createHash('sha256').update(zipBytes).digest('hex')}`;

      // Call importer
      const promise = ingestSourceArchive(zipBytes, 'zip');

      // Immediately mutate original caller buffer before parser finishes
      zipBytes.fill(0);

      const inventory = await promise;
      expect(inventory.archiveDigest).toBe(expectedDigest);
      expect(inventory.files).toHaveLength(1);
      expect(Buffer.from(inventory.files[0]!.bytes).toString('utf8')).toBe(originalContent);
    });

    it('rejects buffers backed by SharedArrayBuffer', async () => {
      if (typeof SharedArrayBuffer !== 'undefined') {
        const sab = new SharedArrayBuffer(100);
        const sabBytes = new Uint8Array(sab);
        await expect(ingestSourceArchive(sabBytes, 'zip')).rejects.toMatchObject({
          code: 'INVALID_ARCHIVE',
        });
      }
    });

    it('rejects unsupported formats', async () => {
      const zip = createZipBuffer([{ name: 'test.txt', content: 'hello' }]);
      // @ts-expect-error testing invalid format
      await expect(ingestSourceArchive(zip, 'rar')).rejects.toMatchObject({
        code: 'UNSUPPORTED_FORMAT',
      });
      // @ts-expect-error testing invalid format
      await expect(ingestSourceArchive(zip, 'tar')).rejects.toMatchObject({
        code: 'UNSUPPORTED_FORMAT',
      });
    });

    it('rejects invalid limit configurations', async () => {
      const zip = createZipBuffer([{ name: 'test.txt', content: 'hello' }]);
      // @ts-expect-error negative limit
      await expect(ingestSourceArchive(zip, 'zip', { maxArchiveBytes: -1 })).rejects.toMatchObject({
        code: 'LIMIT_EXCEEDED',
      });
      // @ts-expect-error zero limit
      await expect(ingestSourceArchive(zip, 'zip', { maxEntries: 0 })).rejects.toMatchObject({
        code: 'LIMIT_EXCEEDED',
      });
      // exceeding default limit
      await expect(
        ingestSourceArchive(zip, 'zip', {
          maxArchiveBytes: DEFAULT_SOURCE_LIMITS.maxArchiveBytes + 1,
        })
      ).rejects.toMatchObject({
        code: 'LIMIT_EXCEEDED',
      });
      // non-integer
      await expect(
        ingestSourceArchive(zip, 'zip', { maxFileBytes: 100.5 })
      ).rejects.toMatchObject({
        code: 'LIMIT_EXCEEDED',
      });
      // @ts-expect-error unknown limit key
      await expect(ingestSourceArchive(zip, 'zip', { unknownOption: 50 })).rejects.toMatchObject({
        code: 'LIMIT_EXCEEDED',
      });
    });

    it('rejects archive exceeding maxArchiveBytes', async () => {
      const zip = createZipBuffer([{ name: 'test.txt', content: 'hello' }]);
      await expect(
        ingestSourceArchive(zip, 'zip', { maxArchiveBytes: 50 })
      ).rejects.toMatchObject({
        code: 'LIMIT_EXCEEDED',
      });
    });

    it('rejects empty input buffers', async () => {
      await expect(ingestSourceArchive(new Uint8Array(0), 'zip')).rejects.toMatchObject({
        code: 'INVALID_ARCHIVE',
      });
      await expect(ingestSourceArchive(new Uint8Array(0), 'tar.gz')).rejects.toMatchObject({
        code: 'INVALID_ARCHIVE',
      });
    });
  });

  describe('valid archives ingestion', () => {
    it('ingests valid ZIP archive and returns inventory with sha256 digest', async () => {
      const zipBytes = createZipBuffer([
        { name: 'src/index.ts', content: 'console.log("hello");' },
        { name: 'package.json', content: '{"name":"demo"}' },
        { name: 'assets/', content: '' },
      ]);

      const expectedDigest = `sha256:${createHash('sha256').update(zipBytes).digest('hex')}`;
      const inventory = await ingestSourceArchive(zipBytes, 'zip');

      expect(inventory.archiveDigest).toBe(expectedDigest);
      expect(inventory.archiveBytes).toBe(zipBytes.byteLength);
      expect(inventory.entryCount).toBe(3);
      expect(inventory.excludedCount).toBe(0);
      expect(inventory.oversizedCount).toBe(0);
      expect(inventory.files).toHaveLength(2);

      const indexFile = inventory.files.find((f) => f.path === 'src/index.ts');
      expect(indexFile).toBeDefined();
      expect(Buffer.from(indexFile!.bytes).toString('utf8')).toBe('console.log("hello");');

      const pkgFile = inventory.files.find((f) => f.path === 'package.json');
      expect(pkgFile).toBeDefined();
      expect(Buffer.from(pkgFile!.bytes).toString('utf8')).toBe('{"name":"demo"}');
    });

    it('ingests valid TAR.GZ archive and returns inventory', async () => {
      const tarGzBytes = await createTarGzBuffer([
        { name: 'app/main.py', content: 'print("hello")' },
        { name: 'app/subdir/', type: 'directory' },
        { name: 'app/subdir/utils.py', content: 'def add(a, b): return a + b' },
      ]);

      const expectedDigest = `sha256:${createHash('sha256').update(tarGzBytes).digest('hex')}`;
      const inventory = await ingestSourceArchive(tarGzBytes, 'tar.gz');

      expect(inventory.archiveDigest).toBe(expectedDigest);
      expect(inventory.archiveBytes).toBe(tarGzBytes.byteLength);
      expect(inventory.entryCount).toBe(3);
      expect(inventory.files).toHaveLength(2);

      const mainFile = inventory.files.find((f) => f.path === 'app/main.py');
      expect(mainFile).toBeDefined();
      expect(Buffer.from(mainFile!.bytes).toString('utf8')).toBe('print("hello")');
    });

    it('accepts valid empty TAR archive (1024 null bytes)', async () => {
      const emptyTarGz = new Uint8Array(gzipSync(Buffer.alloc(1024)));
      const inventory = await ingestSourceArchive(emptyTarGz, 'tar.gz');
      expect(inventory.entryCount).toBe(0);
      expect(inventory.files).toEqual([]);
    });

    it('preserves exact case in paths without normalization changes', async () => {
      const zip = createZipBuffer([
        { name: 'Src/Components/Button.tsx', content: 'export const Button = 1;' },
      ]);
      const inv = await ingestSourceArchive(zip, 'zip');
      expect(inv.files[0]?.path).toBe('Src/Components/Button.tsx');
    });
  });

  describe('string decoding & unicode strictness', () => {
    it('rejects non-ASCII ZIP entry without UTF-8 flag (bit 11)', async () => {
      // Latin-1 / CP437 byte 0xe9 (é) without UTF-8 bit 11 flag (flags = 0)
      const zip = createZipBuffer([
        {
          name: 'caf\xe9.txt',
          content: 'data',
          flags: 0, // bit 11 unset
        },
      ]);
      await expect(ingestSourceArchive(zip, 'zip')).rejects.toMatchObject({
        code: 'UNSAFE_ENTRY',
      });
    });

    it('rejects invalid UTF-8 sequence in ZIP entry even when UTF-8 flag is set', async () => {
      // Invalid UTF-8 sequence [0xc3, 0x28] with flag 0x800
      const invalidUtf8Buf = Buffer.from([0x66, 0x69, 0x6c, 0x65, 0xc3, 0x28, 0x2e, 0x74, 0x78, 0x74]);
      const zip = createZipBuffer([
        {
          nameRaw: invalidUtf8Buf,
          content: 'data',
          flags: 0x800,
        },
      ]);
      await expect(ingestSourceArchive(zip, 'zip')).rejects.toMatchObject({
        code: 'UNSAFE_ENTRY',
      });
    });

    it('rejects invalid UTF-8 bytes in TAR header name', async () => {
      const invalidName = Buffer.from([0x66, 0x69, 0x6c, 0x65, 0xc3, 0x28, 0x2e, 0x74, 0x78, 0x74, 0x00]);
      const header = createRawTarBlock({ nameRaw: invalidName, size: 0 });
      const tarGz = new Uint8Array(gzipSync(Buffer.concat([header, Buffer.alloc(1024)])));
      await expect(ingestSourceArchive(tarGz, 'tar.gz')).rejects.toMatchObject({
        code: 'UNSAFE_ENTRY',
      });
    });
  });

  describe('path safety and traversal rejection', () => {
    it.each([
      '../escape.txt',
      'a/../../escape.txt',
      '/absolute/path.txt',
      'C:/windows/system32.dll',
      'D:file.txt',
      'a\\b\\c.txt',
      'file\0name.txt',
      'file\r\nname.txt',
      'file\x1bname.txt',
      'a//b.txt',
      'a/./b.txt',
      '',
    ])('rejects unsafe ZIP path %j', async (path) => {
      const zip = createZipBuffer([{ name: path, content: 'data' }]);
      await expect(ingestSourceArchive(zip, 'zip')).rejects.toMatchObject({
        code: 'UNSAFE_ENTRY',
      });
    });

    it.each([
      '../escape.txt',
      '/etc/passwd',
      'a/../../x',
      'a\\b',
      'file\0.txt',
      'file\n.txt',
    ])('rejects unsafe TAR.GZ path %j', async (path) => {
      const tarGz = await createTarGzBuffer([{ name: path, content: 'data' }]);
      await expect(ingestSourceArchive(tarGz, 'tar.gz')).rejects.toMatchObject({
        code: 'UNSAFE_ENTRY',
      });
    });
  });

  describe('duplicates and collisions', () => {
    it('rejects exact duplicate file entries in ZIP', async () => {
      const zip = createZipBuffer([
        { name: 'file.txt', content: 'first' },
        { name: 'file.txt', content: 'second' },
      ]);
      await expect(ingestSourceArchive(zip, 'zip')).rejects.toMatchObject({
        code: 'UNSAFE_ENTRY',
      });
    });

    it('rejects case collisions in ZIP and TAR', async () => {
      const zip = createZipBuffer([
        { name: 'readme.txt', content: '1' },
        { name: 'README.TXT', content: '2' },
      ]);
      await expect(ingestSourceArchive(zip, 'zip')).rejects.toMatchObject({
        code: 'UNSAFE_ENTRY',
      });

      const tarGz = await createTarGzBuffer([
        { name: 'config.json', content: '1' },
        { name: 'Config.JSON', content: '2' },
      ]);
      await expect(ingestSourceArchive(tarGz, 'tar.gz')).rejects.toMatchObject({
        code: 'UNSAFE_ENTRY',
      });
    });

    it('rejects NFC vs NFD unicode collisions', async () => {
      const composed = 'caf\u00e9.txt';
      const decomposed = 'cafe\u0301.txt';
      const zip = createZipBuffer([
        { name: composed, content: '1' },
        { name: decomposed, content: '2' },
      ]);
      await expect(ingestSourceArchive(zip, 'zip')).rejects.toMatchObject({
        code: 'UNSAFE_ENTRY',
      });
    });

    it('rejects file and directory collisions in both orders', async () => {
      // Order 1: Directory first, then file collision
      const zipDirFirst = createZipBuffer([
        { name: 'app/', content: '' },
        { name: 'app', content: 'regular file' },
      ]);
      await expect(ingestSourceArchive(zipDirFirst, 'zip')).rejects.toMatchObject({
        code: 'UNSAFE_ENTRY',
      });

      // Order 2: File first, then directory collision
      const zipFileFirst = createZipBuffer([
        { name: 'app', content: 'regular file' },
        { name: 'app/', content: '' },
      ]);
      await expect(ingestSourceArchive(zipFileFirst, 'zip')).rejects.toMatchObject({
        code: 'UNSAFE_ENTRY',
      });

      // Case collision across dir and file
      const zipCaseDir = createZipBuffer([
        { name: 'APP/', content: '' },
        { name: 'app', content: 'file' },
      ]);
      await expect(ingestSourceArchive(zipCaseDir, 'zip')).rejects.toMatchObject({
        code: 'UNSAFE_ENTRY',
      });
    });

    it('rejects ancestor directory collisions across files and directories in both orders', async () => {
      // Order 1: File creates implied directory 'a', then 'a' arrives as a regular file
      const zip1 = createZipBuffer([
        { name: 'a/b.txt', content: 'nested' },
        { name: 'a', content: 'file' },
      ]);
      await expect(ingestSourceArchive(zip1, 'zip')).rejects.toMatchObject({
        code: 'UNSAFE_ENTRY',
      });

      // Order 2: Regular file 'a' arrives, then 'a/b.txt' tries to treat 'a' as a directory
      const zip2 = createZipBuffer([
        { name: 'a', content: 'file' },
        { name: 'a/b.txt', content: 'nested' },
      ]);
      await expect(ingestSourceArchive(zip2, 'zip')).rejects.toMatchObject({
        code: 'UNSAFE_ENTRY',
      });

      // Order 3: Regular file 'a' arrives, then 'a/b/' tries to declare directory inside 'a'
      const zip3 = createZipBuffer([
        { name: 'a', content: 'file' },
        { name: 'a/b/', content: '' },
      ]);
      await expect(ingestSourceArchive(zip3, 'zip')).rejects.toMatchObject({
        code: 'UNSAFE_ENTRY',
      });
    });
  });

  describe('symlinks, links, and special files rejection', () => {
    it('rejects ZIP unix symlink', async () => {
      const zip = createZipBuffer([
        { name: 'symlink.txt', content: 'target.txt', mode: 0o120777 },
      ]);
      await expect(ingestSourceArchive(zip, 'zip')).rejects.toMatchObject({
        code: 'UNSAFE_ENTRY',
      });
    });

    it('rejects ZIP symlink with non-UNIX creator host (fail-closed)', async () => {
      const zip = createZipBuffer([
        {
          name: 'symlink.txt',
          content: 'target.txt',
          host: 0, // DOS host
          externalFileAttributes: (0o120777 << 16) >>> 0,
        },
      ]);
      await expect(ingestSourceArchive(zip, 'zip')).rejects.toMatchObject({
        code: 'UNSAFE_ENTRY',
      });
    });

    it('rejects ZIP special files: char dev, block dev, fifo, socket', async () => {
      const zipChar = createZipBuffer([{ name: 'dev', content: '', mode: 0o020666 }]);
      await expect(ingestSourceArchive(zipChar, 'zip')).rejects.toMatchObject({
        code: 'UNSAFE_ENTRY',
      });

      const zipBlock = createZipBuffer([{ name: 'blk', content: '', mode: 0o060666 }]);
      await expect(ingestSourceArchive(zipBlock, 'zip')).rejects.toMatchObject({
        code: 'UNSAFE_ENTRY',
      });

      const zipFifo = createZipBuffer([{ name: 'fifo', content: '', mode: 0o010666 }]);
      await expect(ingestSourceArchive(zipFifo, 'zip')).rejects.toMatchObject({
        code: 'UNSAFE_ENTRY',
      });

      const zipSock = createZipBuffer([{ name: 'sock', content: '', mode: 0o140666 }]);
      await expect(ingestSourceArchive(zipSock, 'zip')).rejects.toMatchObject({
        code: 'UNSAFE_ENTRY',
      });
    });

    it('rejects ZIP DOS device and volume attributes', async () => {
      const zipDev = createZipBuffer([
        {
          name: 'device',
          content: '',
          externalFileAttributes: 0x40, // DOS device attribute
        },
      ]);
      await expect(ingestSourceArchive(zipDev, 'zip')).rejects.toMatchObject({
        code: 'UNSAFE_ENTRY',
      });

      const zipVol = createZipBuffer([
        {
          name: 'volume',
          content: '',
          externalFileAttributes: 0x08, // DOS volume label
        },
      ]);
      await expect(ingestSourceArchive(zipVol, 'zip')).rejects.toMatchObject({
        code: 'UNSAFE_ENTRY',
      });
    });

    it('rejects TAR symlink, hardlink, and device entries', async () => {
      const tarSymlink = await createTarGzBuffer([
        { name: 'sym', type: 'symlink', linkname: 'target.txt' },
      ]);
      await expect(ingestSourceArchive(tarSymlink, 'tar.gz')).rejects.toMatchObject({
        code: 'UNSAFE_ENTRY',
      });

      const tarHardlink = await createTarGzBuffer([
        { name: 'link', type: 'link', linkname: 'target.txt' },
      ]);
      await expect(ingestSourceArchive(tarHardlink, 'tar.gz')).rejects.toMatchObject({
        code: 'UNSAFE_ENTRY',
      });

      const tarChar = await createTarGzBuffer([
        { name: 'dev', type: 'character-device' },
      ]);
      await expect(ingestSourceArchive(tarChar, 'tar.gz')).rejects.toMatchObject({
        code: 'UNSAFE_ENTRY',
      });

      const tarBlock = await createTarGzBuffer([
        { name: 'blk', type: 'block-device' },
      ]);
      await expect(ingestSourceArchive(tarBlock, 'tar.gz')).rejects.toMatchObject({
        code: 'UNSAFE_ENTRY',
      });

      const tarFifo = await createTarGzBuffer([
        { name: 'fifo', type: 'fifo' },
      ]);
      await expect(ingestSourceArchive(tarFifo, 'tar.gz')).rejects.toMatchObject({
        code: 'UNSAFE_ENTRY',
      });
    });

    it('rejects TAR PAX headers and GNU long metadata (strict USTAR boundary)', async () => {
      const longPath = 'nested/' + 'a'.repeat(120) + '.txt';
      const tarLong = await createTarGzBuffer([{ name: longPath, content: 'data' }]);
      await expect(ingestSourceArchive(tarLong, 'tar.gz')).rejects.toMatchObject({
        code: 'INVALID_ARCHIVE',
      });
    });
  });

  describe('corrupted, encrypted, and malformed archives', () => {
    it('rejects encrypted ZIP archives', async () => {
      const zip = createZipBuffer([
        { name: 'secret.txt', content: 'data', flags: 0x01 }, // encryption flag
      ]);
      await expect(ingestSourceArchive(zip, 'zip')).rejects.toMatchObject({
        code: 'INVALID_ARCHIVE',
      });
    });

    it('rejects ZIP with corrupted CRC32', async () => {
      const zip = createZipBuffer([
        { name: 'file.txt', content: 'hello', crc: 0x12345678 },
      ]);
      await expect(ingestSourceArchive(zip, 'zip')).rejects.toMatchObject({
        code: 'INVALID_ARCHIVE',
      });
    });

    it('rejects ZIP declared size mismatch', async () => {
      const zip = createZipBuffer([
        { name: 'file.txt', content: 'hello', uncompressedSize: 100 },
      ]);
      await expect(ingestSourceArchive(zip, 'zip')).rejects.toMatchObject({
        code: 'INVALID_ARCHIVE',
      });
    });

    it('rejects ZIP directory with non-zero size, non-zero CRC, or non-zero compressed size', async () => {
      const zipSize = createZipBuffer([
        { name: 'dir/', content: 'data', uncompressedSize: 4 },
      ]);
      await expect(ingestSourceArchive(zipSize, 'zip')).rejects.toMatchObject({
        code: 'INVALID_ARCHIVE',
      });

      const zipCrc = createZipBuffer([
        { name: 'dir/', content: '', uncompressedSize: 0, crc: 0x12345678 },
      ]);
      await expect(ingestSourceArchive(zipCrc, 'zip')).rejects.toMatchObject({
        code: 'INVALID_ARCHIVE',
      });

      const zipComp = createZipBuffer([
        { name: 'dir/', content: '', uncompressedSize: 0, crc: 0, compressedSize: 10, compressionMethod: 0 },
      ]);
      await expect(ingestSourceArchive(zipComp, 'zip')).rejects.toMatchObject({
        code: 'INVALID_ARCHIVE',
      });
    });

    it('rejects truncated and corrupted ZIP buffers', async () => {
      const zip = createZipBuffer([{ name: 'test.txt', content: 'hello' }]);
      const truncated = zip.subarray(0, zip.length - 30);
      await expect(ingestSourceArchive(truncated, 'zip')).rejects.toMatchObject({
        code: 'INVALID_ARCHIVE',
      });

      const garbage = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
      await expect(ingestSourceArchive(garbage, 'zip')).rejects.toMatchObject({
        code: 'INVALID_ARCHIVE',
      });
    });

    it('rejects TAR declared size mismatch', async () => {
      // Raw tar header declaring size 100, but truncated before body completes
      const header = createRawTarBlock({ name: 'test.txt', size: 100 });
      const truncatedBody = Buffer.alloc(50);
      const tarGz = new Uint8Array(gzipSync(Buffer.concat([header, truncatedBody])));
      await expect(ingestSourceArchive(tarGz, 'tar.gz')).rejects.toMatchObject({
        code: 'INVALID_ARCHIVE',
      });
    });

    it('rejects TAR with corrupt non-octal size field', async () => {
      const header = createRawTarBlock({ name: 'test.txt', sizeFieldRaw: '00000000018 ' });
      const tarGz = new Uint8Array(gzipSync(Buffer.concat([header, Buffer.alloc(1024)])));
      await expect(ingestSourceArchive(tarGz, 'tar.gz')).rejects.toMatchObject({
        code: 'INVALID_ARCHIVE',
      });
    });

    it('rejects TAR without at least two 512-byte zero EOF blocks', async () => {
      // Only 1 block of 512 zeroes (512 bytes EOF instead of 1024)
      const header = createRawTarBlock({ name: 'test.txt', size: 0 });
      const singleEof = Buffer.alloc(512);
      const tarGz = new Uint8Array(gzipSync(Buffer.concat([header, singleEof])));
      await expect(ingestSourceArchive(tarGz, 'tar.gz')).rejects.toMatchObject({
        code: 'INVALID_ARCHIVE',
      });
    });

    it('rejects TAR directory with declared non-zero size', async () => {
      const tarGz = await createTarGzBuffer([
        { name: 'dir/', type: 'directory', size: 10 },
      ]);
      await expect(ingestSourceArchive(tarGz, 'tar.gz')).rejects.toMatchObject({
        code: 'INVALID_ARCHIVE',
      });
    });

    it('rejects TAR with trailing garbage after NUL terminator in header name field', async () => {
      const header = createRawTarBlock({ name: 'file.txt', corruptNulName: true, size: 0 });
      const tarGz = new Uint8Array(gzipSync(Buffer.concat([header, Buffer.alloc(1024)])));
      await expect(ingestSourceArchive(tarGz, 'tar.gz')).rejects.toMatchObject({
        code: 'UNSAFE_ENTRY',
      });
    });

    it('rejects TAR with non-zero data after EOF blocks', async () => {
      const h1 = createRawTarBlock({ name: 'file1.txt', size: 0 });
      const eof = Buffer.alloc(1024);
      const postEof = createRawTarBlock({ name: 'file2.txt', size: 0 });
      const tarGz = new Uint8Array(gzipSync(Buffer.concat([h1, eof, postEof])));
      await expect(ingestSourceArchive(tarGz, 'tar.gz')).rejects.toMatchObject({
        code: 'INVALID_ARCHIVE',
      });
    });

    it('rejects empty and truncated gzip archives', async () => {
      // Empty gzip decompresses to 0 bytes
      const emptyGz = new Uint8Array(gzipSync(Buffer.alloc(0)));
      await expect(ingestSourceArchive(emptyGz, 'tar.gz')).rejects.toMatchObject({
        code: 'INVALID_ARCHIVE',
      });

      // Truncated gzip
      const validTarGz = await createTarGzBuffer([{ name: 'test.txt', content: 'hello' }]);
      const truncatedGz = validTarGz.subarray(0, 20);
      await expect(ingestSourceArchive(truncatedGz, 'tar.gz')).rejects.toMatchObject({
        code: 'INVALID_ARCHIVE',
      });

      // Trailing junk after gzip stream
      const trailingGz = new Uint8Array(Buffer.concat([Buffer.from(validTarGz), Buffer.from('junk')]));
      await expect(ingestSourceArchive(trailingGz, 'tar.gz')).rejects.toMatchObject({
        code: 'INVALID_ARCHIVE',
      });
    });
  });

  describe('limits enforcement and resource caps', () => {
    it('halts early on GZIP bomb exceeding maxExpandedBytes', async () => {
      const bigTar = Buffer.alloc(2 * 1024 * 1024);
      const bombGz = new Uint8Array(gzipSync(bigTar));
      await expect(
        ingestSourceArchive(bombGz, 'tar.gz', { maxExpandedBytes: 100 * 1024 })
      ).rejects.toMatchObject({
        code: 'LIMIT_EXCEEDED',
      });
    });

    it('rejects archives exceeding maxEntries', async () => {
      const entries = Array.from({ length: 6 }, (_, i) => ({
        name: `file${i}.txt`,
        content: `content${i}`,
      }));
      const zip = createZipBuffer(entries);
      await expect(
        ingestSourceArchive(zip, 'zip', { maxEntries: 5 })
      ).rejects.toMatchObject({
        code: 'LIMIT_EXCEEDED',
      });
    });

    it('rejects TAR archives with many metadata entries exceeding maxEntries', async () => {
      const blocks: Buffer[] = [];
      for (let i = 0; i < 6; i++) {
        blocks.push(createRawTarBlock({ name: `f${i}.txt`, size: 0 }));
      }
      blocks.push(Buffer.alloc(1024)); // EOF
      const tarGz = new Uint8Array(gzipSync(Buffer.concat(blocks)));

      await expect(
        ingestSourceArchive(tarGz, 'tar.gz', { maxEntries: 5 })
      ).rejects.toMatchObject({
        code: 'LIMIT_EXCEEDED',
      });
    });

    it('rejects archives exceeding maxRetainedBytes', async () => {
      const zip = createZipBuffer([
        { name: 'file1.txt', content: Buffer.alloc(600, 'a') },
        { name: 'file2.txt', content: Buffer.alloc(600, 'b') },
      ]);
      await expect(
        ingestSourceArchive(zip, 'zip', { maxRetainedBytes: 1000 })
      ).rejects.toMatchObject({
        code: 'LIMIT_EXCEEDED',
      });
    });

    it('skips retaining oversized files but drains within expansion cap and counts oversizedCount', async () => {
      const zip = createZipBuffer([
        { name: 'small.txt', content: 'small content' },
        { name: 'large.txt', content: Buffer.alloc(5000, 'x') },
      ]);

      const inventory = await ingestSourceArchive(zip, 'zip', {
        maxFileBytes: 1000,
        maxExpandedBytes: 20_000,
      });

      expect(inventory.entryCount).toBe(2);
      expect(inventory.oversizedCount).toBe(1);
      expect(inventory.excludedCount).toBe(0);
      expect(inventory.files).toHaveLength(1);
      expect(inventory.files[0]?.path).toBe('small.txt');
      expect(inventory.expandedBytes).toBe('small content'.length + 5000);
    });
  });

  describe('exclusion policy & security boundaries', () => {
    it('excludes sensitive, generated, credentials, and nested archive paths without retaining them', async () => {
      const zip = createZipBuffer([
        { name: 'src/main.ts', content: 'console.log("safe");' },
        { name: '.env', content: 'SECRET_KEY=12345' },
        { name: '.env.production', content: 'DB_PASS=xyz' },
        { name: 'id_rsa', content: '-----BEGIN RSA PRIVATE KEY-----' },
        { name: 'credentials.json', content: '{"token":"abc"}' },
        { name: 'nested.zip', content: 'PK...' },
        { name: 'node_modules/pkg/index.js', content: 'module.exports = 1;' },
        { name: 'dist/bundle.js', content: 'var x = 1;' },
      ]);

      const inventory = await ingestSourceArchive(zip, 'zip');

      expect(inventory.entryCount).toBe(8);
      expect(inventory.excludedCount).toBe(7);
      expect(inventory.files).toHaveLength(1);
      expect(inventory.files[0]?.path).toBe('src/main.ts');

      const paths = inventory.files.map((f) => f.path);
      expect(paths).not.toContain('.env');
      expect(paths).not.toContain('.env.production');
      expect(paths).not.toContain('id_rsa');
      expect(paths).not.toContain('credentials.json');
      expect(paths).not.toContain('nested.zip');
    });

    it('ensures errors contain only static codes and never raw paths or secret content', async () => {
      const secretName = '.env.' + 's'.repeat(50);
      const zip = createZipBuffer([{ name: '../' + secretName, content: 'secret' }]);

      try {
        await ingestSourceArchive(zip, 'zip');
        expect.unreachable('should have failed');
      } catch (err) {
        expect(err).toBeInstanceOf(SourceImportError);
        const sourceErr = err as SourceImportError;
        expect(sourceErr.code).toBe('UNSAFE_ENTRY');
        expect(sourceErr.message).toBe('Source import rejected: UNSAFE_ENTRY');
        expect(sourceErr.message).not.toContain(secretName);
      }
    });

    it('static analysis boundary: malicious scripts and hooks are static bytes, never executed', async () => {
      const maliciousScript = 'rm -rf / || exit 1';
      const zip = createZipBuffer([
        { name: 'package.json', content: '{"scripts":{"postinstall":"exit 1"}}' },
        { name: 'postinstall.sh', content: maliciousScript },
      ]);

      const inventory = await ingestSourceArchive(zip, 'zip');
      expect(inventory.files).toHaveLength(2);
      const postinstall = inventory.files.find((f) => f.path === 'postinstall.sh');
      expect(postinstall).toBeDefined();
      expect(Buffer.from(postinstall!.bytes).toString('utf8')).toBe(maliciousScript);
    });
  });
});
