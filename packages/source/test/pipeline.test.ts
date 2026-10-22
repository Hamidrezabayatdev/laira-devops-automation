import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import tar from 'tar-stream';
import { ingestSourceArchive } from '../src/archive.js';
import { analyzeSourceFiles } from '../src/analyze.js';

async function makeArchive(entries: Array<{ name: string; text: string }>): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  const collected = new Promise<Buffer>((resolve, reject) => {
    pack.on('data', chunk => chunks.push(Buffer.from(chunk)));
    pack.on('error', reject);
    pack.on('end', () => resolve(Buffer.concat(chunks)));
  });
  for (const entry of entries) {
    await new Promise<void>((resolve, reject) => {
      pack.entry({ name: entry.name }, Buffer.from(entry.text), error => error ? reject(error) : resolve());
    });
  }
  pack.finalize();
  return gzipSync(await collected);
}

describe('archive → static analysis boundary', () => {
  it('binds original digest and excludes recognized secrets before analysis without executing source', async () => {
    const canary = 'SOURCE_PIPELINE_SECRET_CANARY_952';
    const archive = await makeArchive([
      { name: 'app/package.json', text: JSON.stringify({ scripts: { postinstall: `echo ${canary}` }, dependencies: { express: `https://private.invalid/${canary}` } }) },
      { name: 'app/src/server.js', text: 'process.env.DATABASE_URL; process.env.PORT;' },
      { name: 'app/Dockerfile', text: 'FROM node:24\nEXPOSE 8080\n' },
      { name: 'app/.env', text: `DATABASE_URL=${canary}` },
      { name: 'app/node_modules/untrusted/index.js', text: canary },
    ]);
    const inventory = await ingestSourceArchive(archive, 'tar.gz');
    expect(inventory.archiveDigest).toBe(`sha256:${createHash('sha256').update(archive).digest('hex')}`);
    expect(inventory.archiveBytes).toBe(archive.byteLength);
    expect(inventory.excludedCount).toBe(2);
    expect(inventory.files.map(file => file.path)).toEqual(['app/package.json', 'app/src/server.js', 'app/Dockerfile']);
    const analysis = analyzeSourceFiles(inventory.files);
    expect(analysis.provenance).toBe('static_inference');
    expect(analysis.dependencyNames).toContain('express');
    expect(analysis.environmentVariableNames).toEqual(expect.arrayContaining(['DATABASE_URL', 'PORT']));
    expect(analysis.ports).toContain(8080);
    expect(JSON.stringify(analysis)).not.toContain(canary);
    // Candidate files deliberately retain untrusted content; this is NOT a secret-scanned deployment bundle.
    expect(Buffer.from(inventory.files[0].bytes).toString()).toContain(canary);
  });
});
