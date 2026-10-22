import { describe, it, expect, beforeEach } from 'vitest';
import { S3StorageAdapter } from '../src/adapter.js';
import { StorageConfig } from '../src/config.js';
import { MockS3Client } from '../src/mock/mock-s3.js';
import { ArtifactAlreadyExistsError, UnsupportedStorageOperationError } from '../src/errors.js';

describe('Default Private Storage & Prohibition of Public URLs', () => {
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

  it('enforces private ACL by default on PutObjectCommand', async () => {
    await adapter.putArtifact(
      { workspaceId: 'ws_prod', mimeType: 'application/octet-stream' },
      Buffer.from('private payload')
    );

    expect(mockS3.lastPutAcl).toBe('private');

    const putCall = mockS3.recordedCalls.find((c) =>
      c.commandName.startsWith('PutObject')
    );
    expect(putCall).toBeDefined();
    expect(putCall?.input.ACL).toBe('private');
    expect(putCall?.input.ACL).not.toBe('public-read');
  });

  it('strictly rejects presigned public URLs in Phase 0', () => {
    expect(() => {
      adapter.getPresignedPublicUrl();
    }).toThrow(UnsupportedStorageOperationError);
  });

  it('enforces immutable IfNoneMatch: * and rejects overwrite with ArtifactAlreadyExistsError', async () => {
    const artifactId = 'art_fixed_immutable_123';
    // 1. Initial put
    await adapter.putArtifact(
      { workspaceId: 'ws_prod', artifactId, mimeType: 'text/plain' },
      Buffer.from('original artifact')
    );

    // Verify IfNoneMatch: '*' was passed in PutObjectCommand
    const putCall = mockS3.recordedCalls.find(
      (c) => c.commandName.startsWith('PutObject') && (c.input as any).Key?.includes(artifactId)
    );
    expect(putCall).toBeDefined();
    expect(putCall?.input.IfNoneMatch).toBe('*');

    // 2. Overwrite attempt with same artifactId must be rejected
    await expect(
      adapter.putArtifact(
        { workspaceId: 'ws_prod', artifactId, mimeType: 'text/plain' },
        Buffer.from('attempted overwrite')
      )
    ).rejects.toThrow(ArtifactAlreadyExistsError);
  });
});
