import type { StorageConfig } from './config.js';
import {
  PutArtifactInputSchema,
  GetArtifactInputSchema,
  DeleteArtifactInputSchema,
  HeadArtifactInputSchema,
  ArtifactManifestSchema,
  type PutArtifactInput,
  type GetArtifactInput,
  type DeleteArtifactInput,
  type HeadArtifactInput,
  type ArtifactManifest,
  type ArtifactRef,
} from './schemas.js';
import {
  StorageError,
  ArtifactExpiredError,
  ArtifactNotFoundError,
  ArtifactSizeLimitExceededError,
  StorageIntegrityError,
  StorageOperationError,
  StorageTimeoutError,
  UnsupportedStorageOperationError,
} from './errors.js';
import {
  computeArtifactStorageKey,
  generateArtifactId,
  validateWorkspaceId,
  validateArtifactId,
  assertWorkspaceMatch,
} from './utils/validation.js';
import { assertChecksumMatch, normalizeDigest } from './utils/hash.js';
import {
  collectBoundedData,
  destroyStream,
  type PutArtifactData,
} from './utils/stream.js';
import {
  createAwsS3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  type S3ClientProtocol,
  type PutObjectCommandInput,
  type PutObjectCommandOutput,
  type GetObjectCommandInput,
  type GetObjectCommandOutput,
  type DeleteObjectCommandInput,
  type DeleteObjectCommandOutput,
  type HeadObjectCommandInput,
  type HeadObjectCommandOutput,
} from './s3-client.js';

export interface S3StorageAdapterOptions {
  config: StorageConfig;
  s3Client?: S3ClientProtocol;
}

export interface GetArtifactResult {
  readonly manifest: ArtifactManifest;
  readonly data: Buffer;
}

export interface DeleteArtifactResult {
  readonly deleted: boolean;
  readonly workspaceId: string;
  readonly artifactId: string;
}

/**
 * Tenant-scoped S3-compatible artifact storage adapter.
 *
 * Security & Isolation Guarantees:
 * - Scope derived strictly from workspace identity; callers cannot choose arbitrary paths.
 * - Underlying S3 key strictly locked to 'workspaces/{workspaceId}/artifacts/{artifactId}'.
 * - Rejects path traversal and cross-workspace access attempts.
 * - Immutability: PutObjectCommand enforces 'IfNoneMatch: *' preventing silent overwrites.
 * - Absolute operation deadlines wrap all S3 client.send calls with AbortSignal.
 * - Per-request byte limit cannot exceed instance maxArtifactSizeBytes.
 * - Enforces exact byte length match (collected === manifest.size / ContentLength) on read.
 * - Early expiry or integrity failure destroys live response body stream to avoid leaks.
 * - Conflicting artifactId and artifactRef are unconditionally rejected.
 * - Enforces SHA-256 integrity checks on put and get before data is returned.
 * - Enforces private storage: objects are stored as private with no public ACL.
 * - Rejects presigned public URLs in Phase 0.
 * - No filesystem persistence.
 * - Static generic error messages on unknown failures (no raw SDK messages/keys/dumps).
 */
export class S3StorageAdapter {
  readonly config: StorageConfig;
  private s3Client?: S3ClientProtocol;

  constructor(options: S3StorageAdapterOptions) {
    this.config = options.config;
    if (options.s3Client) {
      this.s3Client = options.s3Client;
    }
  }

  private getClient(): S3ClientProtocol {
    if (!this.s3Client) {
      this.s3Client = createAwsS3Client(this.config);
    }
    return this.s3Client;
  }

  /**
   * Dispatches an S3 command bounded by an absolute operation timeout and AbortSignal.
   * Prevents hanging connections or indefinite delays during header / handshake phase.
   */
  private async sendWithTimeout<TInput extends object, TOutput extends object>(
    command: { input: TInput; resolveMiddleware?: unknown },
    options: {
      timeoutMs: number;
      workspaceId: string;
      artifactId?: string;
      operation: string;
    }
  ): Promise<TOutput> {
    const { timeoutMs, workspaceId, artifactId, operation } = options;
    const client = this.getClient();
    const controller = new AbortController();
    let timer: NodeJS.Timeout | null = null;
    let didTimeout = false;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        didTimeout = true;
        try {
          controller.abort(new StorageTimeoutError({ workspaceId, artifactId, timeoutMs }));
        } catch {
          // ignore
        }
        reject(new StorageTimeoutError({ workspaceId, artifactId, timeoutMs }));
      }, timeoutMs);
    });

    try {
      const sendPromise = client.send<TInput, TOutput>(command, { abortSignal: controller.signal });
      return await Promise.race([sendPromise, timeoutPromise]);
    } catch (err) {
      if (didTimeout) {
        throw new StorageTimeoutError({ workspaceId, artifactId, timeoutMs });
      }
      const anyErr = err as Record<string, unknown> | null;
      if (
        anyErr?.name === 'AbortError' ||
        anyErr?.name === 'TimeoutError' ||
        controller.signal.aborted
      ) {
        throw new StorageTimeoutError({ workspaceId, artifactId, timeoutMs });
      }
      if (err instanceof StorageError) throw err;
      throw StorageOperationError.from(err, {
        workspaceId,
        artifactId,
        operation,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Stores an artifact in the workspace-scoped private S3 store.
   *
   * @param input Metadata options (workspaceId required, arbitrary key forbidden)
   * @param data Payload (Buffer, Uint8Array, string, or stream)
   * @returns ArtifactManifest
   */
  async putArtifact(
    input: PutArtifactInput,
    data: PutArtifactData
  ): Promise<ArtifactManifest> {
    if (input?.workspaceId !== undefined) {
      validateWorkspaceId(input.workspaceId);
    }
    if (input?.artifactId !== undefined) {
      validateArtifactId(input.artifactId, input.workspaceId);
    }

    const validatedInput = PutArtifactInputSchema.parse(input);
    const workspaceId = validateWorkspaceId(validatedInput.workspaceId);

    // Enforce per-request maxSizeBytes cannot exceed configured max
    if (
      validatedInput.maxSizeBytes !== undefined &&
      validatedInput.maxSizeBytes > this.config.maxArtifactSizeBytes
    ) {
      throw new ArtifactSizeLimitExceededError({
        workspaceId,
        maxBytes: this.config.maxArtifactSizeBytes,
        actualBytes: validatedInput.maxSizeBytes,
      });
    }

    const effectiveMaxBytes = Math.min(
      validatedInput.maxSizeBytes ?? this.config.maxArtifactSizeBytes,
      this.config.maxArtifactSizeBytes
    );

    const timeoutMs = validatedInput.timeoutMs ?? this.config.defaultTimeoutMs;

    const artifactId = validatedInput.artifactId
      ? validateArtifactId(validatedInput.artifactId, workspaceId)
      : generateArtifactId();

    // 1. Collect bounded data with deadline and compute sha256
    const collected = await collectBoundedData(data, {
      maxBytes: effectiveMaxBytes,
      timeoutMs,
      workspaceId,
      artifactId,
    });

    // 2. Verify expected digest if supplied
    if (validatedInput.expectedDigest) {
      assertChecksumMatch(collected.digest, validatedInput.expectedDigest, {
        workspaceId,
        artifactId,
      });
    }

    let expiryIso: string | null = null;
    if (validatedInput.expiry) {
      const expDate =
        typeof validatedInput.expiry === 'string'
          ? new Date(validatedInput.expiry)
          : validatedInput.expiry;
      expiryIso = expDate.toISOString();
    }

    const nowIso = new Date().toISOString();

    const manifest: ArtifactManifest = {
      workspaceId,
      artifactId,
      digest: collected.digest,
      size: collected.size,
      mimeType: validatedInput.mimeType,
      createdAt: nowIso,
      expiry: expiryIso,
      metadata: validatedInput.metadata ?? {},
    };

    const s3Key = computeArtifactStorageKey(workspaceId, artifactId);

    const s3Metadata: Record<string, string> = {
      'workspace-id': workspaceId,
      'artifact-id': artifactId,
      digest: collected.digest,
      size: String(collected.size),
      'mime-type': validatedInput.mimeType,
      'created-at': nowIso,
      expiry: expiryIso ?? '',
    };

    if (validatedInput.metadata) {
      for (const [k, v] of Object.entries(validatedInput.metadata)) {
        s3Metadata[`custom-${k.toLowerCase()}`] = String(v);
      }
    }

    // 3. PutObjectCommand with private ACL, absolute deadline, and IfNoneMatch: '*' for immutability
    await this.sendWithTimeout<PutObjectCommandInput, PutObjectCommandOutput>(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: s3Key,
        Body: collected.buffer,
        ContentType: validatedInput.mimeType,
        ContentLength: collected.size,
        Metadata: s3Metadata,
        ACL: 'private',
        IfNoneMatch: '*', // Immutable: rejects if object already exists
      }),
      {
        timeoutMs,
        workspaceId,
        artifactId,
        operation: 'putArtifact',
      }
    );

    return ArtifactManifestSchema.parse(manifest);
  }

  /**
   * Retrieves an artifact by workspaceId and artifactId/artifactRef.
   * Enforces expiry by default. Verifies SHA-256 and exact byte length before returning bytes.
   * Ensures output stream is destroyed on early validation failure or expiry.
   */
  async getArtifact(input: GetArtifactInput): Promise<GetArtifactResult> {
    if (input?.workspaceId !== undefined) {
      validateWorkspaceId(input.workspaceId);
    }
    if (input?.artifactRef) {
      assertWorkspaceMatch(
        input.workspaceId,
        input.artifactRef.workspaceId,
        input.artifactRef.artifactId
      );
    }
    if (input?.artifactId && input?.artifactRef && input.artifactId !== input.artifactRef.artifactId) {
      throw new StorageIntegrityError(
        `Conflicting artifact identifiers: artifactId '${input.artifactId}' does not match artifactRef.artifactId '${input.artifactRef.artifactId}'`,
        { workspaceId: input.workspaceId, artifactId: input.artifactId }
      );
    }
    if (input?.artifactId !== undefined) {
      validateArtifactId(input.artifactId, input.workspaceId);
    }

    const validatedInput = GetArtifactInputSchema.parse(input);
    const workspaceId = validateWorkspaceId(validatedInput.workspaceId);

    if (validatedInput.artifactRef) {
      assertWorkspaceMatch(
        workspaceId,
        validatedInput.artifactRef.workspaceId,
        validatedInput.artifactRef.artifactId
      );
    }

    const artifactId = validateArtifactId(
      validatedInput.artifactRef ? validatedInput.artifactRef.artifactId : validatedInput.artifactId!,
      workspaceId
    );

    const s3Key = computeArtifactStorageKey(workspaceId, artifactId);
    const timeoutMs = validatedInput.timeoutMs ?? this.config.defaultTimeoutMs;

    let bodyStream: unknown = undefined;

    try {
      const output = await this.sendWithTimeout<GetObjectCommandInput, GetObjectCommandOutput>(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: s3Key,
        }),
        {
          timeoutMs,
          workspaceId,
          artifactId,
          operation: 'getArtifact',
        }
      );

      bodyStream = output.Body;

      // Validate manifest metadata against expected artifactRef if both are present
      this.validateMetadataAgainstRef(output.Metadata, validatedInput.artifactRef, workspaceId, artifactId);

      const manifest = this.parseManifestFromS3Output(
        output,
        workspaceId,
        artifactId,
        validatedInput.artifactRef
      );

      // Default reads strictly enforce expiry
      if (!validatedInput.internalRetentionScope && manifest.expiry) {
        const expTime = new Date(manifest.expiry).getTime();
        if (!Number.isNaN(expTime) && expTime <= Date.now()) {
          throw new ArtifactExpiredError({
            workspaceId,
            artifactId,
            expiry: manifest.expiry,
          });
        }
      }

      // Collect data with byte bounding and deadline
      const collected = await collectBoundedData(output.Body, {
        maxBytes: this.config.maxArtifactSizeBytes,
        timeoutMs,
        workspaceId,
        artifactId,
      });

      // 1. Verify integrity against manifest digest before returning bytes
      assertChecksumMatch(collected.digest, manifest.digest, {
        workspaceId,
        artifactId,
      });

      // 2. Verify exact byte size vs manifest.size
      if (collected.size !== manifest.size) {
        throw new StorageIntegrityError(
          `Artifact byte size mismatch: collected ${collected.size} bytes does not match manifest size ${manifest.size}`,
          { workspaceId, artifactId }
        );
      }

      // 3. Verify exact byte size vs S3 ContentLength header if present
      if (output.ContentLength !== undefined && output.ContentLength !== collected.size) {
        throw new StorageIntegrityError(
          `Artifact byte size mismatch: S3 ContentLength ${output.ContentLength} does not match collected size ${collected.size}`,
          { workspaceId, artifactId }
        );
      }

      return {
        manifest,
        data: collected.buffer,
      };
    } catch (err) {
      destroyStream(bodyStream);
      if (err instanceof StorageError) throw err;
      throw StorageOperationError.from(err, {
        workspaceId,
        artifactId,
        operation: 'getArtifact',
      });
    }
  }

  /**
   * Deletes an artifact from the workspace store.
   * If artifactRef is provided, selects artifactRef.artifactId to guarantee reference integrity.
   */
  async deleteArtifact(input: DeleteArtifactInput): Promise<DeleteArtifactResult> {
    if (input?.workspaceId !== undefined) {
      validateWorkspaceId(input.workspaceId);
    }
    if (input?.artifactRef) {
      assertWorkspaceMatch(
        input.workspaceId,
        input.artifactRef.workspaceId,
        input.artifactRef.artifactId
      );
    }
    if (input?.artifactId && input?.artifactRef && input.artifactId !== input.artifactRef.artifactId) {
      throw new StorageIntegrityError(
        `Conflicting artifact identifiers: artifactId '${input.artifactId}' does not match artifactRef.artifactId '${input.artifactRef.artifactId}'`,
        { workspaceId: input.workspaceId, artifactId: input.artifactId }
      );
    }
    if (input?.artifactId !== undefined) {
      validateArtifactId(input.artifactId, input.workspaceId);
    }

    const validatedInput = DeleteArtifactInputSchema.parse(input);
    const workspaceId = validateWorkspaceId(validatedInput.workspaceId);

    if (validatedInput.artifactRef) {
      assertWorkspaceMatch(
        workspaceId,
        validatedInput.artifactRef.workspaceId,
        validatedInput.artifactRef.artifactId
      );
    }

    const artifactId = validateArtifactId(
      validatedInput.artifactRef ? validatedInput.artifactRef.artifactId : validatedInput.artifactId!,
      workspaceId
    );

    const s3Key = computeArtifactStorageKey(workspaceId, artifactId);
    const timeoutMs = validatedInput.timeoutMs ?? this.config.defaultTimeoutMs;

    await this.sendWithTimeout<DeleteObjectCommandInput, DeleteObjectCommandOutput>(
      new DeleteObjectCommand({
        Bucket: this.config.bucket,
        Key: s3Key,
      }),
      {
        timeoutMs,
        workspaceId,
        artifactId,
        operation: 'deleteArtifact',
      }
    );

    return {
      deleted: true,
      workspaceId,
      artifactId,
    };
  }

  /**
   * Reads metadata manifest of an artifact without retrieving payload.
   */
  async headArtifact(input: HeadArtifactInput): Promise<ArtifactManifest | null> {
    if (input?.workspaceId !== undefined) {
      validateWorkspaceId(input.workspaceId);
    }
    if (input?.artifactRef) {
      assertWorkspaceMatch(
        input.workspaceId,
        input.artifactRef.workspaceId,
        input.artifactRef.artifactId
      );
    }
    if (input?.artifactId && input?.artifactRef && input.artifactId !== input.artifactRef.artifactId) {
      throw new StorageIntegrityError(
        `Conflicting artifact identifiers: artifactId '${input.artifactId}' does not match artifactRef.artifactId '${input.artifactRef.artifactId}'`,
        { workspaceId: input.workspaceId, artifactId: input.artifactId }
      );
    }
    if (input?.artifactId !== undefined) {
      validateArtifactId(input.artifactId, input.workspaceId);
    }

    const validatedInput = HeadArtifactInputSchema.parse(input);
    const workspaceId = validateWorkspaceId(validatedInput.workspaceId);

    if (validatedInput.artifactRef) {
      assertWorkspaceMatch(
        workspaceId,
        validatedInput.artifactRef.workspaceId,
        validatedInput.artifactRef.artifactId
      );
    }

    const artifactId = validateArtifactId(
      validatedInput.artifactRef ? validatedInput.artifactRef.artifactId : validatedInput.artifactId!,
      workspaceId
    );

    const s3Key = computeArtifactStorageKey(workspaceId, artifactId);
    const timeoutMs = validatedInput.timeoutMs ?? this.config.defaultTimeoutMs;

    try {
      const output = await this.sendWithTimeout<HeadObjectCommandInput, HeadObjectCommandOutput>(
        new HeadObjectCommand({
          Bucket: this.config.bucket,
          Key: s3Key,
        }),
        {
          timeoutMs,
          workspaceId,
          artifactId,
          operation: 'headArtifact',
        }
      );

      this.validateMetadataAgainstRef(output.Metadata, validatedInput.artifactRef, workspaceId, artifactId);

      return this.parseManifestFromS3Output(
        output,
        workspaceId,
        artifactId,
        validatedInput.artifactRef
      );
    } catch (err) {
      if (err instanceof ArtifactNotFoundError) {
        return null;
      }
      const anyErr = err as Record<string, unknown> | null;
      if (
        anyErr?.name === 'NoSuchKey' ||
        anyErr?.name === 'NotFound' ||
        (anyErr?.$metadata && (anyErr.$metadata as any).httpStatusCode === 404)
      ) {
        return null;
      }
      if (err instanceof StorageError) throw err;
      throw StorageOperationError.from(err, {
        workspaceId,
        artifactId,
        operation: 'headArtifact',
      });
    }
  }

  /**
   * Checks if an artifact exists.
   */
  async exists(input: HeadArtifactInput): Promise<boolean> {
    const manifest = await this.headArtifact(input);
    return manifest !== null;
  }

  /**
   * Presigned public URLs are unsupported in Phase 0.
   */
  getPresignedPublicUrl(): never {
    throw new UnsupportedStorageOperationError('Presigned public URLs are not supported in Phase 0');
  }

  /**
   * Validates stored S3 metadata against caller expected artifactRef.
   */
  private validateMetadataAgainstRef(
    metadata: Record<string, string> | undefined,
    ref: ArtifactRef | undefined,
    workspaceId: string,
    artifactId: string
  ): void {
    if (!metadata || !ref) return;

    if (metadata.digest && normalizeDigest(metadata.digest) !== normalizeDigest(ref.digest)) {
      throw new StorageIntegrityError(
        `Artifact digest in S3 metadata '${metadata.digest}' does not match expected reference '${ref.digest}'` || '',
        { workspaceId, artifactId }
      );
    }

    if (metadata.size !== undefined && Number.parseInt(metadata.size, 10) !== ref.size) {
      throw new StorageIntegrityError(
        `Artifact size in S3 metadata '${metadata.size}' does not match expected reference '${ref.size}'`,
        { workspaceId, artifactId }
      );
    }
  }

  private parseManifestFromS3Output(
    output: {
      Metadata?: Record<string, string>;
      ContentType?: string;
      ContentLength?: number;
      LastModified?: Date;
    },
    workspaceId: string,
    artifactId: string,
    fallbackRef?: ArtifactRef
  ): ArtifactManifest {
    const meta = output.Metadata || {};

    const digest =
      meta.digest ||
      fallbackRef?.digest ||
      '';

    const size =
      meta.size !== undefined
        ? Number.parseInt(meta.size, 10)
        : output.ContentLength ?? fallbackRef?.size ?? 0;

    const mimeType =
      meta['mime-type'] ||
      output.ContentType ||
      fallbackRef?.mimeType ||
      'application/octet-stream';

    const createdAt =
      meta['created-at'] ||
      (output.LastModified ? output.LastModified.toISOString() : undefined) ||
      fallbackRef?.createdAt ||
      new Date().toISOString();

    const expiry =
      meta.expiry && meta.expiry.length > 0
        ? meta.expiry
        : fallbackRef?.expiry ?? null;

    const customMeta: Record<string, string> = {};
    for (const [k, v] of Object.entries(meta)) {
      if (k.startsWith('custom-')) {
        customMeta[k.slice(7)] = v;
      }
    }

    return ArtifactManifestSchema.parse({
      workspaceId,
      artifactId,
      digest,
      size,
      mimeType,
      createdAt,
      expiry,
      metadata: Object.keys(customMeta).length > 0 ? customMeta : fallbackRef ? fallbackRef.size ? {} : undefined : undefined,
    });
  }
}
