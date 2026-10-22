import crypto from 'node:crypto';
import { ArtifactSizeLimitExceededError, StorageTimeoutError } from '../errors.js';

export type PutArtifactData =
  | Buffer
  | Uint8Array
  | string
  | NodeJS.ReadableStream
  | ReadableStream<Uint8Array>
  | unknown;

export interface CollectedArtifactData {
  readonly buffer: Buffer;
  readonly digest: string;
  readonly size: number;
}

/**
 * Safely cancels or destroys a readable stream (Node.js stream or Web ReadableStream)
 * to avoid resource or socket leaks on errors or timeouts.
 */
export function destroyStream(stream: unknown): void {
  if (!stream) return;
  try {
    if (typeof (stream as any).destroy === 'function') {
      (stream as any).destroy();
    } else if (typeof (stream as any).cancel === 'function') {
      (stream as any).cancel('Resource released').catch(() => {});
    }
  } catch {
    // ignore
  }
}


/**
 * Collects input artifact data into a bounded Buffer while simultaneously
 * computing sha256 checksum, enforcing byte length bounds, and applying a deadline.
 *
 * If incoming data exceeds maxBytes:
 * - Destroys/cancels the input stream immediately
 * - Rejects with ArtifactSizeLimitExceededError
 *
 * If the stream hangs or exceeds timeoutMs:
 * - Destroys/cancels the input stream immediately
 * - Rejects with StorageTimeoutError
 */
export async function collectBoundedData(
  data: PutArtifactData,
  options: {
    maxBytes: number;
    timeoutMs?: number;
    workspaceId: string;
    artifactId?: string;
  }
): Promise<CollectedArtifactData> {
  const { maxBytes, timeoutMs = 30_000, workspaceId, artifactId } = options;

  if (data === null || data === undefined) {
    const emptyBuf = Buffer.alloc(0);
    const emptyDigest = `sha256:${crypto.createHash('sha256').update(emptyBuf).digest('hex')}`;
    return { buffer: emptyBuf, digest: emptyDigest, size: 0 };
  }

  // 1. Direct Buffer or Uint8Array
  if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length > maxBytes) {
      throw new ArtifactSizeLimitExceededError({
        workspaceId,
        artifactId,
        actualBytes: buf.length,
        maxBytes,
      });
    }
    const digest = `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`;
    return { buffer: buf, digest, size: buf.length };
  }

  // 2. String
  if (typeof data === 'string') {
    const buf = Buffer.from(data, 'utf8');
    if (buf.length > maxBytes) {
      throw new ArtifactSizeLimitExceededError({
        workspaceId,
        artifactId,
        actualBytes: buf.length,
        maxBytes,
      });
    }
    const digest = `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`;
    return { buffer: buf, digest, size: buf.length };
  }

  // 3. Web ReadableStream
  if (typeof ReadableStream !== 'undefined' && data instanceof ReadableStream) {
    const reader = data.getReader();
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const hash = crypto.createHash('sha256');

    let timeoutTimer: NodeJS.Timeout | null = null;
    let timedOut = false;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        reader.cancel('Deadline exceeded').catch(() => {});
        reject(new StorageTimeoutError({ workspaceId, artifactId, timeoutMs }));
      }, timeoutMs);
    });

    const readPromise = (async () => {
      try {
        while (true) {
          if (timedOut) break;
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = Buffer.from(value);
          totalBytes += chunk.length;

          if (totalBytes > maxBytes) {
            await reader.cancel('Artifact size limit exceeded');
            throw new ArtifactSizeLimitExceededError({
              workspaceId,
              artifactId,
              actualBytes: totalBytes,
              maxBytes,
            });
          }

          hash.update(chunk);
          chunks.push(chunk);
        }
      } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        reader.releaseLock();
      }

      const buffer = Buffer.concat(chunks, totalBytes);
      const digest = `sha256:${hash.digest('hex')}`;
      return { buffer, digest, size: totalBytes };
    })();

    return Promise.race([readPromise, timeoutPromise]);
  }

  // 4. Node.js ReadableStream
  if (typeof (data as NodeJS.ReadableStream)?.on === 'function') {
    const nodeStream = data as NodeJS.ReadableStream;
    return new Promise<CollectedArtifactData>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      const hash = crypto.createHash('sha256');
      let isSettled = false;

      const timer = setTimeout(() => {
        if (isSettled) return;
        isSettled = true;
        cleanup();
        if (typeof (nodeStream as any).destroy === 'function') {
          (nodeStream as any).destroy();
        }
        reject(new StorageTimeoutError({ workspaceId, artifactId, timeoutMs }));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        nodeStream.removeListener('data', onData);
        nodeStream.removeListener('end', onEnd);
        nodeStream.removeListener('error', onError);
      };

      const onData = (chunk: Buffer | string | Uint8Array) => {
        if (isSettled) return;
        const buf = Buffer.isBuffer(chunk)
          ? chunk
          : typeof chunk === 'string'
            ? Buffer.from(chunk, 'utf8')
            : Buffer.from(chunk);

        totalBytes += buf.length;

        if (totalBytes > maxBytes) {
          isSettled = true;
          cleanup();
          if (typeof (nodeStream as any).destroy === 'function') {
            (nodeStream as any).destroy();
          }
          reject(
            new ArtifactSizeLimitExceededError({
              workspaceId,
              artifactId,
              actualBytes: totalBytes,
              maxBytes,
            })
          );
          return;
        }

        hash.update(buf);
        chunks.push(buf);
      };

      const onEnd = () => {
        if (isSettled) return;
        isSettled = true;
        cleanup();
        const buffer = Buffer.concat(chunks, totalBytes);
        const digest = `sha256:${hash.digest('hex')}`;
        resolve({ buffer, digest, size: totalBytes });
      };

      const onError = (err: Error) => {
        if (isSettled) return;
        isSettled = true;
        cleanup();
        reject(err);
      };

      nodeStream.on('data', onData);
      nodeStream.on('end', onEnd);
      nodeStream.on('error', onError);
    });
  }

  throw new TypeError('Unsupported data format provided to collectBoundedData');
}
