import { describe, it, expect, beforeEach } from 'vitest';
import { S3StorageAdapter } from '../src/adapter.js';
import { StorageConfig } from '../src/config.js';
import { MockS3Client } from '../src/mock/mock-s3.js';
import { ArtifactExpiredError } from '../src/errors.js';

describe('Artifact Expiry & Retention Checks', () => {
  let mockS3: MockS3Client;
  let adapter: S3StorageAdapter;

  beforeEach(() => {
    mockS3 = new MockS3Client();
    const config = new StorageConfig({
      endpoint: 'https://storage.iran.liara.ir',
      bucket: 'test-bucket',
      credentials: {
        accessKeyId: 'test-key',
        secretAccessKey: 'test-secret',
      },
    });
    adapter = new S3StorageAdapter({ config, s3Client: mockS3 });
  });

  it('rejects read of expired artifact with ArtifactExpiredError', async () => {
    const pastDate = new Date(Date.now() - 60_000); // 1 minute in the past
    const manifest = await adapter.putArtifact(
      {
        workspaceId: 'ws_prod',
        mimeType: 'text/plain',
        expiry: pastDate,
      },
      Buffer.from('temporary diagnostics log')
    );

    expect(manifest.expiry).toBe(pastDate.toISOString());

    // Reading expired artifact must be blocked
    await expect(
      adapter.getArtifact({
        workspaceId: 'ws_prod',
        artifactId: manifest.artifactId,
      })
    ).rejects.toThrow(ArtifactExpiredError);

    // Verify response body stream was destroyed to prevent socket/resource leaks
    expect(mockS3.lastReturnedBodyStream).toBeDefined();
    expect(mockS3.lastReturnedBodyStream?.destroyed).toBe(true);
  });

  it('allows reading expired artifact when internalRetentionScope is explicitly set to true', async () => {
    const pastDate = new Date(Date.now() - 120_000);
    const manifest = await adapter.putArtifact(
      {
        workspaceId: 'ws_prod',
        mimeType: 'text/plain',
        expiry: pastDate,
      },
      Buffer.from('archived diagnostics')
    );

    const retrieved = await adapter.getArtifact({
      workspaceId: 'ws_prod',
      artifactId: manifest.artifactId,
      internalRetentionScope: true,
    });

    expect(retrieved.data.toString('utf8')).toBe('archived diagnostics');
    expect(retrieved.manifest.expiry).toBe(pastDate.toISOString());
  });

  it('allows reading active unexpired artifact', async () => {
    const futureDate = new Date(Date.now() + 3_600_000); // 1 hour in future
    const manifest = await adapter.putArtifact(
      {
        workspaceId: 'ws_prod',
        mimeType: 'text/plain',
        expiry: futureDate,
      },
      Buffer.from('valid unexpired content')
    );

    const retrieved = await adapter.getArtifact({
      workspaceId: 'ws_prod',
      artifactId: manifest.artifactId,
    });

    expect(retrieved.data.toString('utf8')).toBe('valid unexpired content');
  });
});
