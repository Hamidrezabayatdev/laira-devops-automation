import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ingestSourceArchive } from '../src/archive.js';
import {
  createDeployBundle,
  createDeployBundleFromFiles,
} from '../src/bundle.js';
import { SourceImportError, type SourceInventory } from '../src/types.js';

describe('createDeployBundle & determinism', () => {
  it('generates bit-for-bit identical bundles regardless of input file order', async () => {
    const fileA = {
      path: 'package.json',
      bytes: new TextEncoder().encode(JSON.stringify({ name: 'test-app', version: '1.0.0' })),
    };
    const fileB = {
      path: 'src/index.js',
      bytes: new TextEncoder().encode('console.log("hello world");'),
    };
    const fileC = {
      path: 'README.md',
      bytes: new TextEncoder().encode('# Test App Documentation'),
    };

    const bundle1 = await createDeployBundleFromFiles([fileA, fileB, fileC], {
      commitSha: 'a'.repeat(40),
      sourceDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    });

    const bundle2 = await createDeployBundleFromFiles([fileC, fileA, fileB], {
      commitSha: 'a'.repeat(40),
      sourceDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    });

    // Byte-for-byte identical
    expect(Buffer.from(bundle1.bytes).equals(Buffer.from(bundle2.bytes))).toBe(true);
    expect(bundle1.bundleDigest).toBe(bundle2.bundleDigest);
    expect(bundle1.fileCount).toBe(3);
    expect(bundle1.paths).toEqual(['README.md', 'package.json', 'src/index.js']);
  });

  it('keeps sourceDigest and bundleDigest strictly distinct', async () => {
    const rawArchive = new Uint8Array([1, 2, 3, 4, 5]);
    const originalDigest = `sha256:${createHash('sha256').update(rawArchive).digest('hex')}`;

    const inventory: SourceInventory = {
      archiveDigest: originalDigest,
      archiveBytes: rawArchive.byteLength,
      expandedBytes: 100,
      entryCount: 2,
      files: [
        { path: 'index.js', bytes: new TextEncoder().encode('export default 42;') },
        { path: 'package.json', bytes: new TextEncoder().encode('{}') },
      ],
      excludedCount: 0,
      oversizedCount: 0,
    };

    const bundle = await createDeployBundle(inventory, { commitSha: 'b'.repeat(40) });

    expect(bundle.sourceDigest).toBe(originalDigest);
    expect(bundle.bundleDigest).not.toBe(originalDigest);
    expect(bundle.bundleDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(bundle.commitSha).toBe('b'.repeat(40));
  });

  it('preserves src-only layout by default and does not silently strip legitimate directories', async () => {
    const files = [
      { path: 'src/server.ts', bytes: new TextEncoder().encode('export const port = 3000;') },
      { path: 'src/utils.ts', bytes: new TextEncoder().encode('export const ok = true;') },
    ];

    // Generic API defaults stripLeadingDir: false to preserve sole src/ folder
    const bundleDefault = await createDeployBundleFromFiles(files);
    expect(bundleDefault.paths).toEqual(['src/server.ts', 'src/utils.ts']);

    // Explicit opt-in strips single common prefix if requested
    const bundleStripped = await createDeployBundleFromFiles(files, { stripLeadingDir: true });
    expect(bundleStripped.paths).toEqual(['server.ts', 'utils.ts']);
  });

  it('fails closed when inventory has oversizedCount > 0 (no silent incomplete deployment)', async () => {
    const inventory: SourceInventory = {
      archiveDigest: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      archiveBytes: 2_000_000,
      expandedBytes: 2_000_000,
      entryCount: 5,
      files: [
        { path: 'package.json', bytes: new TextEncoder().encode('{}') },
      ],
      excludedCount: 1,
      oversizedCount: 1, // One oversized file was omitted from analysis
    };

    await expect(createDeployBundle(inventory)).rejects.toThrowError(SourceImportError);
    await expect(createDeployBundle(inventory)).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
    });
  });

  it('preserves .gitignore and .gitattributes but excludes secrets, build artifacts, and .gitmodules', async () => {
    const files = [
      { path: '.env', bytes: new TextEncoder().encode('SECRET_KEY=12345') },
      { path: '.env.local', bytes: new TextEncoder().encode('SECRET_KEY=12345') },
      { path: 'credentials.json', bytes: new TextEncoder().encode('{}') },
      { path: 'id_rsa', bytes: new TextEncoder().encode('private key') },
      { path: 'node_modules/dep/index.js', bytes: new TextEncoder().encode('dep') },
      { path: 'dist/bundle.js', bytes: new TextEncoder().encode('dist') },
      { path: '.gitmodules', bytes: new TextEncoder().encode('[submodule]') },
      { path: '.gitignore', bytes: new TextEncoder().encode('node_modules') },
      { path: '.gitattributes', bytes: new TextEncoder().encode('* text=auto') },
      { path: 'src/index.js', bytes: new TextEncoder().encode('console.log("ok");') },
    ];

    const bundle = await createDeployBundleFromFiles(files);
    expect(bundle.paths).toEqual(['.gitattributes', '.gitignore', 'src/index.js']);
    expect(bundle.fileCount).toBe(3);
  });

  it('fails strict on raw backslashes without normalizing them', async () => {
    const files = [
      { path: 'src\\index.js', bytes: new TextEncoder().encode('bad') },
    ];

    await expect(createDeployBundleFromFiles(files)).rejects.toMatchObject({
      code: 'UNSAFE_ENTRY',
    });
  });

  it('detects NFC normalization and case collisions on paths', async () => {
    const files = [
      { path: 'file.txt', bytes: new TextEncoder().encode('a') },
      { path: 'FILE.TXT', bytes: new TextEncoder().encode('b') },
    ];

    await expect(createDeployBundleFromFiles(files)).rejects.toMatchObject({
      code: 'UNSAFE_ENTRY',
    });
  });

  it('enforces standalone 1 MiB per-file limit and 16 MiB total retained limit', async () => {
    const oversizedFile = [
      { path: 'big.dat', bytes: new Uint8Array(1024 * 1024 + 1) },
    ];
    await expect(createDeployBundleFromFiles(oversizedFile)).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
    });

    const file1 = { path: 'f1.dat', bytes: new Uint8Array(9 * 1024 * 1024) };
    const file2 = { path: 'f2.dat', bytes: new Uint8Array(8 * 1024 * 1024) };
    await expect(createDeployBundleFromFiles([file1, file2])).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
    });
  });

  it('rejects paths exceeding strict USTAR framing', async () => {
    // Single path segment > 100 characters cannot fit in USTAR name or prefix
    const longSegmentFile = [
      { path: 'a'.repeat(101), bytes: new Uint8Array([1]) },
    ];
    await expect(createDeployBundleFromFiles(longSegmentFile)).rejects.toMatchObject({
      code: 'UNSAFE_ENTRY',
    });
  });

  it('snapshots input bytes defensively so caller mutations after call do not affect bundle', async () => {
    const rawBytes = new Uint8Array([65, 66, 67]);
    const files = [
      { path: 'data.txt', bytes: rawBytes },
    ];

    const bundlePromise = createDeployBundleFromFiles(files);
    // Mutate caller buffer immediately
    rawBytes[0] = 99;

    const bundle = await bundlePromise;
    const ingested = await ingestSourceArchive(bundle.bytes, 'tar.gz');
    expect(Buffer.from(ingested.files[0]!.bytes).toString()).toBe('ABC');
  });

  it('produces an archive that passes strict USTAR ingestSourceArchive validation', async () => {
    const files = [
      { path: 'package.json', bytes: new TextEncoder().encode('{"name":"my-app"}') },
      { path: 'run.sh', bytes: new TextEncoder().encode('#!/bin/sh\nnode index.js') },
    ];

    const bundle = await createDeployBundleFromFiles(files);

    const ingestedBack = await ingestSourceArchive(bundle.bytes, 'tar.gz');
    expect(ingestedBack.entryCount).toBe(2);
    expect(ingestedBack.files.map((f) => f.path)).toEqual(['package.json', 'run.sh']);
    expect(ingestedBack.oversizedCount).toBe(0);
    expect(ingestedBack.excludedCount).toBe(0);
  });
});
