import { describe, it, expect, beforeEach } from 'vitest';
import { S3StorageAdapter } from '../src/adapter.js';
import { StorageConfig } from '../src/config.js';
import { MockS3Client } from '../src/mock/mock-s3.js';
import { ChecksumMismatchError, StorageIntegrityError } from '../src/errors.js';
import { computeSha256 } from '../src/utils/hash.js';

describe('Artifact SHA-256 Checksum Verification', () => {
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

  it('computes accurate sha256 digest on put and records in manifest', async () => {
    const content = Buffer.from('Important DevOps deployment archive payload');
    const expectedHash = computeSha256(content);

    const manifest = await adapter.putArtifact(
      { workspaceId: 'ws_prod', mimeType: 'application/octet-stream' },
      content
    );

    expect(manifest.digest).toBe(expectedHash);
    expect(manifest.size).toBe(content.length);
  });

  it('succeeds when expectedDigest matches payload hash', async () => {
    const content = Buffer.from('Verified artifact payload');
    const validDigest = computeSha256(content);

    const manifest = await adapter.putArtifact(
      {
        workspaceId: 'ws_prod',
        mimeType: 'text/plain',
        expectedDigest: validDigest,
      },
      content
    );

    expect(manifest.digest).toBe(validDigest);
  });

  it('rejects putArtifact when expectedDigest does not match payload', async () => {
    const content = Buffer.from('Legitimate payload');
    const bogusDigest = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';

    await expect(
      adapter.putArtifact(
        {
          workspaceId: 'ws_prod',
          mimeType: 'text/plain',
          expectedDigest: bogusDigest,
        },
        content
      )
    ).rejects.toThrow(ChecksumMismatchError);

    // Verify object was NOT stored in S3
    expect(mockS3.recordedCalls.filter((c) => c.commandName.startsWith('PutObject')).length).toBe(0);
  });

  it('detects corrupted payload on getArtifact and throws ChecksumMismatchError', async () => {
    const content = Buffer.from('Sensitive pristine release payload');
    const manifest = await adapter.putArtifact(
      { workspaceId: 'ws_prod', mimeType: 'application/octet-stream' },
      content
    );

    // Corrupt the object in mock storage
    const s3Key = `workspaces/ws_prod/artifacts/${manifest.artifactId}`;
    mockS3.corruptDataOnRead(s3Key);

    // Reading corrupted object must be detected and rejected
    await expect(
      adapter.getArtifact({
        workspaceId: 'ws_prod',
        artifactId: manifest.artifactId,
      })
    ).rejects.toThrow(ChecksumMismatchError);
  });

  it('detects digest mismatch between S3 metadata and expected artifactRef', async () => {
    const content = Buffer.from('Legitimate verified payload');
    const manifest = await adapter.putArtifact(
      { workspaceId: 'ws_prod', mimeType: 'text/plain' },
      content
    );

    // Tampered artifactRef with conflicting digest
    const tamperedRef = {
      ...manifest,
      digest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    };

    await expect(
      adapter.getArtifact({
        workspaceId: 'ws_prod',
        artifactId: manifest.artifactId,
        artifactRef: tamperedRef,
      })
    ).rejects.toThrow(StorageIntegrityError);
  });

  it('detects size mismatch between S3 metadata and expected artifactRef', async () => {
    const content = Buffer.from('Legitimate verified payload');
    const manifest = await adapter.putArtifact(
      { workspaceId: 'ws_prod', mimeType: 'text/plain' },
      content
    );

    // Tampered artifactRef with conflicting size
    const tamperedRef = {
      ...manifest,
      size: manifest.size + 999,
    };

    await expect(
      adapter.getArtifact({
        workspaceId: 'ws_prod',
        artifactId: manifest.artifactId,
        artifactRef: tamperedRef,
      })
    ).rejects.toThrow(StorageIntegrityError);
  });

  it('rejects getArtifact when collected byte size does not match manifest size claim', async () => {
    const content = Buffer.from('Legitimate verified payload');
    const manifest = await adapter.putArtifact(
      { workspaceId: 'ws_prod', mimeType: 'text/plain' },
      content
    );

    // Tamper the stored S3 metadata size claim to be false
    mockS3.tamperObject(manifest.artifactId, {
      metadata: { size: '999999' },
    });

    await expect(
      adapter.getArtifact({
        workspaceId: 'ws_prod',
        artifactId: manifest.artifactId,
      })
    ).rejects.toThrow(StorageIntegrityError);
  });
});
