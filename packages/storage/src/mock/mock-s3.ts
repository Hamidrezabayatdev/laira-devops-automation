import { Readable } from 'node:stream';
import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
  type S3ClientProtocol,
} from '../s3-client.js';

export interface MockStoredObject {
  body: Buffer;
  contentType: string;
  metadata: Record<string, string>;
  acl?: string;
  createdAt: Date;
}

export class MockS3ServiceException extends Error {
  readonly Code?: string;
  readonly $metadata: { httpStatusCode: number };

  constructor(name: string, statusCode: number, message: string) {
    super(message);
    this.name = name;
    this.Code = name;
    this.$metadata = { httpStatusCode: statusCode };
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * In-memory Mock S3 client for tests.
 * Implements S3ClientProtocol and handles genuine @aws-sdk/client-s3 Command instances.
 */
export class MockS3Client implements S3ClientProtocol {
  private objects = new Map<string, MockStoredObject>();
  private buckets = new Set<string>(['test-bucket', 'laira-private', 'laira-artifacts']);

  public recordedCalls: Array<{ commandName: string; input: Record<string, unknown> }> = [];
  public lastPutAcl?: string;
  public lastReturnedBodyStream?: Readable;

  private injectedError?: Error;
  private corruptKeys = new Set<string>();
  private abortStreamAfterBytes?: number;
  private simulateHangingSend = false;

  constructor(initialBuckets: string[] = ['test-bucket', 'laira-private']) {
    for (const b of initialBuckets) {
      this.buckets.add(b);
    }
  }

  setSimulatedError(err: Error | null): void {
    this.injectedError = err ?? undefined;
  }

  setSimulateHangingSend(hang: boolean): void {
    this.simulateHangingSend = hang;
  }

  tamperObject(key: string, updates: { metadata?: Record<string, string>; contentLength?: number }): void {
    for (const [k, stored] of this.objects.entries()) {
      if (k.endsWith(key) || k === key) {
        if (updates.metadata) {
          stored.metadata = { ...stored.metadata, ...updates.metadata };
        }
      }
    }
  }

  setSimulatedCanaryLeak(canaryToken: string): void {
    const canaryErr = new Error(
      `S3 Provider Error: Authorization failed for token canary_${canaryToken}. Internal response: <Error><Code>SignatureDoesNotMatch</Code><Message>Secret key canary_${canaryToken} invalid</Message></Error>`
    );
    (canaryErr as any).$metadata = { httpStatusCode: 403 };
    this.injectedError = canaryErr;
  }

  corruptDataOnRead(key: string): void {
    this.corruptKeys.add(key);
  }

  setStreamAbortAfterBytes(bytes: number | null): void {
    this.abortStreamAfterBytes = bytes ?? undefined;
  }

  reset(): void {
    this.objects.clear();
    this.recordedCalls = [];
    this.lastPutAcl = undefined;
    this.lastReturnedBodyStream = undefined;
    this.injectedError = undefined;
    this.corruptKeys.clear();
    this.abortStreamAfterBytes = undefined;
    this.simulateHangingSend = false;
  }

  async send<TInput extends object, TOutput extends object>(
    command: { input: TInput; resolveMiddleware?: unknown },
    options?: any
  ): Promise<TOutput> {
    const abortSignal = options?.abortSignal as AbortSignal | undefined;
    if (abortSignal?.aborted) {
      const abortErr = new Error('The operation was aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }

    if (this.simulateHangingSend) {
      await new Promise<never>((_, reject) => {
        if (abortSignal) {
          abortSignal.addEventListener(
            'abort',
            () => {
              const abortErr = new Error('The operation was aborted');
              abortErr.name = 'AbortError';
              reject(abortErr);
            },
            { once: true }
          );
        }
      });
    }

    if (this.injectedError) {
      const err = this.injectedError;
      this.injectedError = undefined;
      throw err;
    }

    const commandName = command.constructor.name || 'UnknownCommand';
    const input = command.input as Record<string, unknown>;
    this.recordedCalls.push({ commandName, input });

    const bucket = String(input.Bucket || '');
    const key = String(input.Key || '');

    // 1. PutObjectCommand
    if (command instanceof PutObjectCommand || commandName.startsWith('PutObject')) {
      const storageKey = `${bucket}:${key}`;

      // Check IfNoneMatch for immutable artifact protection
      if (input.IfNoneMatch === '*' && this.objects.has(storageKey)) {
        throw new MockS3ServiceException(
          'PreconditionFailed',
          412,
          'At least one of the pre-conditions you specified did not hold'
        );
      }

      const acl = input.ACL as string | undefined;
      this.lastPutAcl = acl;

      let bodyBuf: Buffer;
      const body = input.Body;

      if (Buffer.isBuffer(body)) {
        bodyBuf = body;
      } else if (body instanceof Uint8Array) {
        bodyBuf = Buffer.from(body);
      } else if (typeof body === 'string') {
        bodyBuf = Buffer.from(body, 'utf8');
      } else if (typeof (body as any)?.on === 'function') {
        const chunks: Buffer[] = [];
        await new Promise<void>((resolve, reject) => {
          (body as NodeJS.ReadableStream).on('data', (c) =>
            chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
          );
          (body as NodeJS.ReadableStream).on('end', () => resolve());
          (body as NodeJS.ReadableStream).on('error', reject);
        });
        bodyBuf = Buffer.concat(chunks);
      } else {
        bodyBuf = Buffer.alloc(0);
      }

      this.objects.set(storageKey, {
        body: bodyBuf,
        contentType: (input.ContentType as string) || 'application/octet-stream',
        metadata: (input.Metadata as Record<string, string>) || {},
        acl,
        createdAt: new Date(),
      });

      return {
        ETag: `"mock-etag-${bodyBuf.length}"`,
      } as unknown as TOutput;
    }

    // 2. GetObjectCommand
    if (command instanceof GetObjectCommand || commandName.startsWith('GetObject')) {
      const storageKey = `${bucket}:${key}`;
      const stored = this.objects.get(storageKey);
      if (!stored) {
        throw new MockS3ServiceException('NoSuchKey', 404, `The specified key does not exist: ${key}`);
      }

      let payload = stored.body;
      if (this.corruptKeys.has(key)) {
        payload = Buffer.from(stored.body);
        if (payload.length > 0) {
          payload[0] = (payload[0] ?? 0) ^ 0xff;
        } else {
          payload = Buffer.from('corrupted-extra-bytes');
        }
      }

      let stream: Readable;
      const abortThreshold = this.abortStreamAfterBytes;

      if (abortThreshold !== undefined) {
        let sent = 0;
        stream = new Readable({
          read(size) {
            if (sent >= abortThreshold) {
              this.destroy(new Error('Network connection aborted prematurely by remote peer'));
              return;
            }
            const toSend = Math.min(size, payload.length - sent, abortThreshold - sent);
            if (toSend <= 0) {
              this.push(null);
              return;
            }
            this.push(payload.subarray(sent, sent + toSend));
            sent += toSend;
          },
        });
      } else {
        stream = Readable.from(payload);
      }

      this.lastReturnedBodyStream = stream;

      return {
        Body: stream,
        ContentType: stored.contentType,
        ContentLength: payload.length,
        ETag: `"mock-etag-${payload.length}"`,
        Metadata: { ...stored.metadata },
        LastModified: stored.createdAt,
      } as unknown as TOutput;
    }

    // 3. HeadObjectCommand
    if (command instanceof HeadObjectCommand || commandName.startsWith('HeadObject')) {
      const storageKey = `${bucket}:${key}`;
      const stored = this.objects.get(storageKey);
      if (!stored) {
        throw new MockS3ServiceException('NotFound', 404, `Not Found: ${key}`);
      }
      return {
        ContentType: stored.contentType,
        ContentLength: stored.body.length,
        ETag: `"mock-etag-${stored.body.length}"`,
        Metadata: { ...stored.metadata },
        LastModified: stored.createdAt,
      } as unknown as TOutput;
    }

    // 4. DeleteObjectCommand
    if (command instanceof DeleteObjectCommand || commandName.startsWith('DeleteObject')) {
      this.objects.delete(`${bucket}:${key}`);
      return {} as unknown as TOutput;
    }

    // 5. CreateBucketCommand
    if (command instanceof CreateBucketCommand || commandName.startsWith('CreateBucket')) {
      this.buckets.add(bucket);
      return { Location: `/${bucket}` } as unknown as TOutput;
    }

    // 6. HeadBucketCommand
    if (command instanceof HeadBucketCommand || commandName.startsWith('HeadBucket')) {
      if (!this.buckets.has(bucket)) {
        throw new MockS3ServiceException('NotFound', 404, `Bucket '${bucket}' does not exist`);
      }
      return {} as unknown as TOutput;
    }

    return {} as unknown as TOutput;
  }
}
