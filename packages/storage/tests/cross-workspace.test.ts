import { describe, it, expect, beforeEach } from 'vitest';
import { S3StorageAdapter } from '../src/adapter.js';
import { StorageConfig } from '../src/config.js';
import { MockS3Client } from '../src/mock/mock-s3.js';
import {
  CrossWorkspaceAccessError,
  PathInjectionError,
  InvalidStorageKeyError,
  ArtifactNotFoundError,
} from '../src/errors.js';

describe('Cross-Workspace Isolation & Path Injection Rejection', () => {
  let mockS3: MockS3Client;
  let adapter: S3StorageAdapter;

  beforeEach(() => {
    mockS3 = new MockS3Client();
    const config = new StorageConfig({
      endpoint: 'https://storage.iran.liara.ir',
      bucket: 'test-bucket',
      credentials: {
        accessKeyId: 'test-access',
        secretAccessKey: 'test-secret',
      },
    });
    adapter = new S3StorageAdapter({ config, s3Client: mockS3 });
  });

  it('strictly isolates artifacts between workspaces', async () => {
    // 1. Put artifact in workspace-alpha
    const manifestAlpha = await adapter.putArtifact(
      { workspaceId: 'ws_alpha', mimeType: 'text/plain' },
      Buffer.from('alpha secret content')
    );

    // 2. Workspace-beta attempting to read with its own workspaceId but alpha artifactId fails (404)
    await expect(
      adapter.getArtifact({
        workspaceId: 'ws_beta',
        artifactId: manifestAlpha.artifactId,
      })
    ).rejects.toThrow(ArtifactNotFoundError);

    // 3. Workspace-alpha can read its own artifact
    const retrievedAlpha = await adapter.getArtifact({
      workspaceId: 'ws_alpha',
      artifactId: manifestAlpha.artifactId,
    });
    expect(retrievedAlpha.data.toString('utf8')).toBe('alpha secret content');
  });

  it('rejects cross-workspace artifactRef access in getArtifact', async () => {
    const manifestBeta = await adapter.putArtifact(
      { workspaceId: 'ws_beta', mimeType: 'text/plain' },
      Buffer.from('beta secret content')
    );

    // Caller ws_alpha passes artifactRef belonging to ws_beta
    await expect(
      adapter.getArtifact({
        workspaceId: 'ws_alpha',
        artifactRef: manifestBeta,
      })
    ).rejects.toThrow(CrossWorkspaceAccessError);
  });

  it('rejects cross-workspace artifactRef access in deleteArtifact', async () => {
    const manifestBeta = await adapter.putArtifact(
      { workspaceId: 'ws_beta', mimeType: 'text/plain' },
      Buffer.from('beta content')
    );

    await expect(
      adapter.deleteArtifact({
        workspaceId: 'ws_alpha',
        artifactRef: manifestBeta,
      })
    ).rejects.toThrow(CrossWorkspaceAccessError);
  });

  it('rejects path injection via dot-dot traversal in workspaceId', async () => {
    await expect(
      adapter.putArtifact(
        { workspaceId: '../ws_evil', mimeType: 'text/plain' },
        Buffer.from('evil')
      )
    ).rejects.toThrow(PathInjectionError);

    await expect(
      adapter.getArtifact({
        workspaceId: 'ws_alpha/../../ws_beta',
        artifactId: 'art_12345678',
      })
    ).rejects.toThrow(PathInjectionError);
  });

  it('rejects path injection via slashes, backslashes, and null bytes', async () => {
    await expect(
      adapter.putArtifact(
        { workspaceId: 'ws_alpha/nested', mimeType: 'text/plain' },
        Buffer.from('evil')
      )
    ).rejects.toThrow(PathInjectionError);

    await expect(
      adapter.putArtifact(
        { workspaceId: 'ws_alpha\\backslash', mimeType: 'text/plain' },
        Buffer.from('evil')
      )
    ).rejects.toThrow(PathInjectionError);

    await expect(
      adapter.putArtifact(
        { workspaceId: 'ws_alpha\0nullbyte', mimeType: 'text/plain' },
        Buffer.from('evil')
      )
    ).rejects.toThrow(PathInjectionError);

    await expect(
      adapter.putArtifact(
        { workspaceId: 'ws_alpha%2fescape', mimeType: 'text/plain' },
        Buffer.from('evil')
      )
    ).rejects.toThrow(PathInjectionError);
  });

  it('rejects path injection in artifactId', async () => {
    await expect(
      adapter.putArtifact(
        {
          workspaceId: 'ws_alpha',
          artifactId: '../../etc/passwd',
          mimeType: 'text/plain',
        },
        Buffer.from('evil')
      )
    ).rejects.toThrow(PathInjectionError);

    await expect(
      adapter.putArtifact(
        {
          workspaceId: 'ws_alpha',
          artifactId: 'art_normal/subpath',
          mimeType: 'text/plain',
        },
        Buffer.from('evil')
      )
    ).rejects.toThrow(PathInjectionError);
  });

  it('rejects non-opaque arbitrary artifactId formats', async () => {
    await expect(
      adapter.putArtifact(
        {
          workspaceId: 'ws_alpha',
          artifactId: 'short', // less than 8 chars
          mimeType: 'text/plain',
        },
        Buffer.from('content')
      )
    ).rejects.toThrow(InvalidStorageKeyError);
  });

  it('maps underlying S3 key to exact prefix format', async () => {
    const manifest = await adapter.putArtifact(
      { workspaceId: 'ws_prod_99', mimeType: 'application/json' },
      Buffer.from('{"data": 123}')
    );

    const recordedCall = mockS3.recordedCalls.find(
      (c) => c.commandName.startsWith('PutObject')
    );
    expect(recordedCall).toBeDefined();
    expect(recordedCall?.input.Key).toBe(
      `workspaces/ws_prod_99/artifacts/${manifest.artifactId}`
    );
    expect(recordedCall?.input.Bucket).toBe('test-bucket');
  });

  it('unconditionally rejects conflicting artifactId and artifactRef in getArtifact, deleteArtifact, and headArtifact', async () => {
    const manifest = await adapter.putArtifact(
      { workspaceId: 'ws_alpha', mimeType: 'text/plain' },
      Buffer.from('alpha content')
    );

    // Caller passes artifactId 'art_conflicting_id' and artifactRef with manifest.artifactId
    await expect(
      adapter.getArtifact({
        workspaceId: 'ws_alpha',
        artifactId: 'art_conflicting_id',
        artifactRef: manifest,
      })
    ).rejects.toThrow();

    await expect(
      adapter.deleteArtifact({
        workspaceId: 'ws_alpha',
        artifactId: 'art_conflicting_id',
        artifactRef: manifest,
      })
    ).rejects.toThrow();

    await expect(
      adapter.headArtifact({
        workspaceId: 'ws_alpha',
        artifactId: 'art_conflicting_id',
        artifactRef: manifest,
      })
    ).rejects.toThrow();
  });
});
