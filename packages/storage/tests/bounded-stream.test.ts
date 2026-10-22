import { describe, it, expect, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { S3StorageAdapter } from '../src/adapter.js';
import { StorageConfig } from '../src/config.js';
import { MockS3Client } from '../src/mock/mock-s3.js';
import { ArtifactSizeLimitExceededError, StorageOperationError, StorageTimeoutError } from '../src/errors.js';

describe('Bounded Byte Lengths & Stream Abort Handling', () => {
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
      maxArtifactSizeBytes: 1024, // Set small 1KB bound for unit test
    });
    adapter = new S3StorageAdapter({ config, s3Client: mockS3 });
  });

  it('rejects oversized Buffer on putArtifact', async () => {
    const oversized = Buffer.alloc(2048, 'a'); // 2KB exceeds 1KB

    await expect(
      adapter.putArtifact(
        { workspaceId: 'ws_prod', mimeType: 'application/octet-stream' },
        oversized
      )
    ).rejects.toThrow(ArtifactSizeLimitExceededError);
  });

  it('bounds Node.js stream and destroys stream midway when exceeding maxBytes', async () => {
    let chunksPushed = 0;
    let wasDestroyed = false;

    const unboundedStream = new Readable({
      read() {
        chunksPushed++;
        if (chunksPushed > 50) {
          this.push(null);
          return;
        }
        // Push 100 bytes chunks
        this.push(Buffer.alloc(100, 'x'));
      },
      destroy(err, cb) {
        wasDestroyed = true;
        cb(err);
      },
    });

    await expect(
      adapter.putArtifact(
        { workspaceId: 'ws_prod', mimeType: 'application/octet-stream' },
        unboundedStream
      )
    ).rejects.toThrow(ArtifactSizeLimitExceededError);

    expect(wasDestroyed).toBe(true);
    // Verified stream did NOT push all 50 chunks
    expect(chunksPushed).toBeLessThan(50);
  });

  it('bounds Web ReadableStream and cancels reader when exceeding maxBytes', async () => {
    let wasCancelled = false;
    let count = 0;

    const webStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        count++;
        if (count > 20) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(200));
      },
      cancel() {
        wasCancelled = true;
      },
    });

    await expect(
      adapter.putArtifact(
        { workspaceId: 'ws_prod', mimeType: 'application/octet-stream' },
        webStream
      )
    ).rejects.toThrow(ArtifactSizeLimitExceededError);

    expect(wasCancelled).toBe(true);
  });

  it('handles remote stream network abort cleanly during getArtifact', async () => {
    // 1. Put valid small artifact
    const manifest = await adapter.putArtifact(
      { workspaceId: 'ws_prod', mimeType: 'text/plain' },
      Buffer.from('Small valid artifact that will be interrupted during read')
    );

    // 2. Instruct mock S3 to abort stream after 10 bytes
    mockS3.setStreamAbortAfterBytes(10);

    // 3. getArtifact must fail safely with sanitized error and not hang
    await expect(
      adapter.getArtifact({
        workspaceId: 'ws_prod',
        artifactId: manifest.artifactId,
      })
    ).rejects.toThrow(StorageOperationError);
  });

  it('rejects putArtifact when request maxSizeBytes exceeds configured instance limit', async () => {
    // Config limit is 1024 bytes; caller tries to request 5000 bytes
    await expect(
      adapter.putArtifact(
        {
          workspaceId: 'ws_prod',
          mimeType: 'application/octet-stream',
          maxSizeBytes: 5000,
        },
        Buffer.from('small-payload')
      )
    ).rejects.toThrow(ArtifactSizeLimitExceededError);
  });

  it('enforces stream deadline and rejects hanging stream with StorageTimeoutError', async () => {
    let wasDestroyed = false;
    // Hanging Node.js stream that never emits 'data' or 'end'
    const hangingStream = new Readable({
      read() {
        // intentionally do nothing (hang)
      },
      destroy(err, cb) {
        wasDestroyed = true;
        cb(err);
      },
    });

    await expect(
      adapter.putArtifact(
        {
          workspaceId: 'ws_prod',
          mimeType: 'text/plain',
          timeoutMs: 100, // 100ms deadline for fast test
        },
        hangingStream
      )
    ).rejects.toThrow(StorageTimeoutError);

    expect(wasDestroyed).toBe(true);
  });

  it('bounds S3 client.send connection/header phase with AbortSignal and throws StorageTimeoutError', async () => {
    // Simulate hanging S3 header/handshake
    mockS3.setSimulateHangingSend(true);

    const startTime = Date.now();
    await expect(
      adapter.putArtifact(
        {
          workspaceId: 'ws_prod',
          mimeType: 'text/plain',
          timeoutMs: 100,
        },
        Buffer.from('fast-buffer')
      )
    ).rejects.toThrow(StorageTimeoutError);

    const duration = Date.now() - startTime;
    expect(duration).toBeLessThan(1000); // Settled within reasonable deadline
  });

  it('bounds S3 client.send during getArtifact with AbortSignal and throws StorageTimeoutError', async () => {
    mockS3.setSimulateHangingSend(true);

    await expect(
      adapter.getArtifact({
        workspaceId: 'ws_prod',
        artifactId: 'art_12345678',
        timeoutMs: 100,
      })
    ).rejects.toThrow(StorageTimeoutError);
  });
});
