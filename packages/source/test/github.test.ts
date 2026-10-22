import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  downloadGithubArchive,
  fetchPublicGithubSource,
  GithubSourceError,
  parseGithubUrl,
  resolveGithubCommit,
} from '../src/github.js';

interface ZipTestEntry {
  name: string;
  content: string | Uint8Array;
}

function createZipBuffer(entries: ZipTestEntry[]): Uint8Array {
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const content = typeof entry.content === 'string'
      ? Buffer.from(entry.content, 'utf8')
      : Buffer.from(entry.content);

    const crc = crc32(content);
    const size = content.length;
    const isDir = entry.name.endsWith('/');
    const mode = isDir ? 0o040755 : 0o100644;
    const flags = 0x800; // Bit 11 UTF-8 flag (GitHub standard)
    const extAttrs = ((mode << 16) >>> 0) | (isDir ? 0x10 : 0);

    const local = Buffer.alloc(30 + nameBuf.length + content.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8); // Stored (no compression)
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(size >>> 0, 18);
    local.writeUInt32LE(size >>> 0, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    content.copy(local, 30 + nameBuf.length);
    localHeaders.push(local);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // UNIX
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(size >>> 0, 20);
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

describe('GitHub URL & Input Validation (SSRF / Credentials Protection)', () => {
  it('parses valid HTTPS GitHub URLs', () => {
    const res1 = parseGithubUrl('https://github.com/owner/my-repo');
    expect(res1).toEqual({ owner: 'owner', repo: 'my-repo', ref: undefined });

    const res2 = parseGithubUrl('https://github.com/owner/my-repo.git');
    expect(res2).toEqual({ owner: 'owner', repo: 'my-repo', ref: undefined });

    const res3 = parseGithubUrl('https://github.com/owner/my-repo/tree/main');
    expect(res3).toEqual({ owner: 'owner', repo: 'my-repo', ref: 'main' });

    const res4 = parseGithubUrl('https://github.com/owner/my-repo/tree/feature/nested-branch');
    expect(res4).toEqual({ owner: 'owner', repo: 'my-repo', ref: 'feature/nested-branch' });
  });

  it('rejects SSRF attempts: non-https protocols', () => {
    expect(() => parseGithubUrl('http://github.com/owner/repo')).toThrowError(GithubSourceError);
    expect(() => parseGithubUrl('file:///etc/passwd')).toThrowError(GithubSourceError);
  });

  it('rejects SSRF attempts: unauthorized domains and IP addresses', () => {
    expect(() => parseGithubUrl('https://evil.com/owner/repo')).toThrowError(GithubSourceError);
    expect(() => parseGithubUrl('https://github.com.evil.com/owner/repo')).toThrowError(GithubSourceError);
    expect(() => parseGithubUrl('https://127.0.0.1/owner/repo')).toThrowError(GithubSourceError);
    expect(() => parseGithubUrl('https://localhost/owner/repo')).toThrowError(GithubSourceError);
  });

  it('rejects credentials in URLs', () => {
    expect(() => parseGithubUrl('https://token@github.com/owner/repo')).toThrowError(GithubSourceError);
    expect(() => parseGithubUrl('https://user:pass@github.com/owner/repo')).toThrowError(GithubSourceError);
  });

  it('rejects non-standard ports and path traversal', () => {
    expect(() => parseGithubUrl('https://github.com:8443/owner/repo')).toThrowError(GithubSourceError);
    expect(() => parseGithubUrl('https://github.com/../repo')).toThrowError(GithubSourceError);
  });
});

describe('resolveGithubCommit & fetchBounded guarantees (offline)', () => {
  it('resolves valid 40-character commit SHA via GET /repos/{owner}/{repo}/commits/{ref}', async () => {
    const expectedSha = '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d';
    const mockFetch = (async (url: string | URL | Request) => {
      const urlStr = url.toString();
      expect(urlStr).toContain('https://api.github.com/repos/octocat/Hello-World/commits/main');
      return new Response(JSON.stringify({ sha: expectedSha }), { status: 200 });
    }) as typeof fetch;

    const sha = await resolveGithubCommit('octocat', 'Hello-World', 'main', mockFetch);
    expect(sha).toBe(expectedSha);
  });

  it('rejects 3xx redirects without following (redirect: manual)', async () => {
    const mockFetch = (async () => {
      return new Response('', { status: 301, headers: { Location: 'https://evil.com' } });
    }) as typeof fetch;

    await expect(
      resolveGithubCommit('owner', 'repo', 'HEAD', mockFetch)
    ).rejects.toMatchObject({
      code: 'REDIRECT_REJECTED',
    });
  });

  it('rejects API responses exceeding 1 MiB limit', async () => {
    const hugeJson = JSON.stringify({ sha: 'a'.repeat(40), junk: 'x'.repeat(1024 * 1024 + 10) });
    const mockFetch = (async () => {
      return new Response(hugeJson, { status: 200 });
    }) as typeof fetch;

    await expect(
      resolveGithubCommit('owner', 'repo', 'HEAD', mockFetch)
    ).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
    });
  });

  it('enforces total deadline on stalled body reading even if stream ignores AbortSignal', async () => {
    // Stalled reader: read() returns a promise that never resolves
    const stalledStream = new ReadableStream({
      pull() {
        return new Promise(() => {}); // never resolves
      },
    });

    const mockFetch = (async () => {
      return new Response(stalledStream, { status: 200 });
    }) as typeof fetch;

    await expect(
      resolveGithubCommit('owner', 'repo', 'HEAD', mockFetch, 50)
    ).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
  });

  it('rejects private / nonexistent repositories with honest REPO_NOT_FOUND', async () => {
    const mockFetch = (async () => {
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    }) as typeof fetch;

    await expect(
      resolveGithubCommit('private-org', 'secret-repo', 'HEAD', mockFetch)
    ).rejects.toMatchObject({
      code: 'REPO_NOT_FOUND',
    });
  });

  it('rejects rate-limited requests with RATE_LIMITED', async () => {
    const mockFetch = (async () => {
      return new Response(JSON.stringify({ message: 'API rate limit exceeded' }), { status: 403 });
    }) as typeof fetch;

    await expect(
      resolveGithubCommit('owner', 'repo', 'HEAD', mockFetch)
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });

  it('verifies requested 40-hex commit SHA against resolved SHA and rejects on mismatch', async () => {
    const requestedSha = '1111111111111111111111111111111111111111';
    const serverSha = '2222222222222222222222222222222222222222';
    const mockFetch = (async () => {
      return new Response(JSON.stringify({ sha: serverSha }), { status: 200 });
    }) as typeof fetch;

    await expect(
      resolveGithubCommit('owner', 'repo', requestedSha, mockFetch)
    ).rejects.toMatchObject({
      code: 'INVALID_COMMIT_SHA',
    });
  });

  it('rejects invalid SHA format returned from GitHub API', async () => {
    const mockFetch = (async () => {
      return new Response(JSON.stringify({ sha: 'not-a-40-hex-sha' }), { status: 200 });
    }) as typeof fetch;

    await expect(
      resolveGithubCommit('owner', 'repo', 'HEAD', mockFetch)
    ).rejects.toMatchObject({
      code: 'INVALID_COMMIT_SHA',
    });
  });

  it('never echoes raw URLs or SHAs in error messages', () => {
    const err = new GithubSourceError('REPO_NOT_FOUND');
    expect(err.message).toBe('GitHub source rejected: REPO_NOT_FOUND');
    expect(err.message).not.toContain('http');
  });
});

describe('downloadGithubArchive & ZIP transport (offline)', () => {
  it('rejects tar.gz format as UNSUPPORTED_FORMAT', async () => {
    await expect(
      fetchPublicGithubSource({
        url: 'https://github.com/owner/repo',
        format: 'tar.gz' as 'zip',
      })
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
    });
  });

  it('enforces 50 MiB archive download limit', async () => {
    const mockFetch = (async () => {
      const bigBuf = new Uint8Array(50 * 1024 * 1024 + 1);
      return new Response(bigBuf, { status: 200 });
    }) as typeof fetch;

    await expect(
      downloadGithubArchive('owner', 'repo', 'a'.repeat(40), mockFetch, 50 * 1024 * 1024)
    ).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
    });
  });
});

describe('fetchPublicGithubSource end-to-end integration (offline fixtures)', () => {
  it('fetches ZIP, strips GitHub wrapper prefix once, and returns root files in inventory and bundle', async () => {
    const commitSha = '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d';
    const fakeZip = createZipBuffer([
      { name: 'Hello-World-7fd1a60b01f91b314f59955a4e4d4e80d8edf11d/package.json', content: '{"name":"hello"}' },
      { name: 'Hello-World-7fd1a60b01f91b314f59955a4e4d4e80d8edf11d/src/main.js', content: 'console.log("app");' },
      { name: 'Hello-World-7fd1a60b01f91b314f59955a4e4d4e80d8edf11d/.env', content: 'SECRET=exposed' },
    ]);

    const mockFetch = (async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('api.github.com/repos/octocat/Hello-World/commits/HEAD')) {
        return new Response(JSON.stringify({ sha: commitSha }), { status: 200 });
      }
      if (urlStr.includes('codeload.github.com/octocat/Hello-World/zip/' + commitSha)) {
        return new Response(fakeZip, { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    const result = await fetchPublicGithubSource('https://github.com/octocat/Hello-World', mockFetch);

    // Commit matches
    expect(result.commit).toBe(commitSha);

    // Inventory has wrapper stripped ONCE so files are at root (and .env excluded)
    expect(result.inventory.excludedCount).toBe(1);
    expect(result.inventory.files.map((f) => f.path)).toEqual([
      'package.json',
      'src/main.js',
    ]);

    // Inventory archiveDigest matches pristine downloaded ZIP
    const expectedOriginalDigest = `sha256:${createHash('sha256').update(fakeZip).digest('hex')}`;
    expect(result.inventory.archiveDigest).toBe(expectedOriginalDigest);
    expect(result.inventory.archiveBytes).toBe(fakeZip.byteLength);

    // Bundle contains the exact same root files without double stripping
    expect(result.bundle.paths).toEqual(['package.json', 'src/main.js']);
    expect(result.bundle.commitSha).toBe(commitSha);
    expect(result.bundle.sourceDigest).toBe(expectedOriginalDigest);
    expect(result.bundle.bundleDigest).not.toBe(expectedOriginalDigest);
  });
});
