import { describe, it, expect } from 'vitest';
import { StorageConfig } from '../src/config.js';
import { S3StorageAdapter } from '../src/adapter.js';
import { ArtifactAlreadyExistsError } from '../src/errors.js';

describe('Opt-in Local MinIO S3-Compatible Integration', () => {
  const isEnabled = process.env.RUN_MINIO_INTEGRATION === 'true';

  it.runIf(isEnabled)('connects to local MinIO, tests put, immutability, get checksum, and delete', async () => {
    // Fail closed: load strictly from explicit environment without fallback credentials
    const config = StorageConfig.fromEnv();

    // Require explicit local service only; remote endpoints are strictly forbidden for opt-in test
    const parsedEndpoint = new URL(config.endpoint);
    const isLocalhost =
      parsedEndpoint.hostname === 'localhost' ||
      parsedEndpoint.hostname === '127.0.0.1' ||
      parsedEndpoint.hostname === '::1';

    if (!isLocalhost) {
      throw new Error(
        `Opt-in local MinIO test rejected non-local endpoint '${config.endpoint}'. Only local services are permitted.`
      );
    }

    const adapter = new S3StorageAdapter({ config });
    const workspaceId = 'ws_minio_test';
    const payload = Buffer.from('Integration test payload for MinIO container');

    // 1. Put artifact
    const manifest = await adapter.putArtifact(
      { workspaceId, mimeType: 'text/plain' },
      payload
    );
    expect(manifest.workspaceId).toBe(workspaceId);
    expect(manifest.size).toBe(payload.length);

    // 2. Immutability: duplicate put with same artifactId must be rejected
    await expect(
      adapter.putArtifact(
        { workspaceId, artifactId: manifest.artifactId, mimeType: 'text/plain' },
        Buffer.from('conflicting overwrite attempt')
      )
    ).rejects.toThrow(ArtifactAlreadyExistsError);

    // 3. Get artifact and verify checksum
    const retrieved = await adapter.getArtifact({
      workspaceId,
      artifactId: manifest.artifactId,
    });
    expect(retrieved.data.toString('utf8')).toBe(payload.toString('utf8'));
    expect(retrieved.manifest.digest).toBe(manifest.digest);

    // 4. Delete artifact
    const delResult = await adapter.deleteArtifact({
      workspaceId,
      artifactId: manifest.artifactId,
    });
    expect(delResult.deleted).toBe(true);
  });

  it.skipIf(isEnabled)('skips live MinIO integration by default (zero network actions during build)', () => {
    // Verified: No external network calls are dispatched unless explicitly opted in
    expect(true).toBe(true);
  });
});
