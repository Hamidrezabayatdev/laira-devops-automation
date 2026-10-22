import { z } from 'zod';

/**
 * Storage credentials schema.
 * Credentials must be hidden and non-enumerable in config.
 */
export const StorageCredentialsSchema = z
  .object({
    accessKeyId: z.string().min(1, 'accessKeyId is required'),
    secretAccessKey: z.string().min(1, 'secretAccessKey is required'),
  })
  .strict();

export type StorageCredentials = z.infer<typeof StorageCredentialsSchema>;

/**
 * Storage configuration schema.
 * - Production requires HTTPS.
 * - HTTP is allowed ONLY when explicit localDevelopment is true and endpoint host is localhost/127.0.0.1.
 */
export const StorageConfigSchema = z
  .object({
    endpoint: z.string().url('Endpoint must be a valid URL'),
    region: z.string().min(1, 'Region is required').default('default'),
    bucket: z
      .string()
      .min(3, 'Bucket name must be at least 3 characters')
      .max(63, 'Bucket name must be at most 63 characters')
      .regex(
        /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
        'Bucket name must contain only lowercase letters, numbers, hyphens, and dots, and start/end with letter or number'
      ),
    credentials: StorageCredentialsSchema,
    localDevelopment: z.boolean().default(false),
    forcePathStyle: z.boolean().default(true),
    maxArtifactSizeBytes: z
      .number()
      .int()
      .positive('maxArtifactSizeBytes must be positive')
      .max(100 * 1024 * 1024, 'maxArtifactSizeBytes cannot exceed 100MB bound')
      .default(50 * 1024 * 1024),
    defaultTimeoutMs: z
      .number()
      .int()
      .positive('defaultTimeoutMs must be positive')
      .default(30_000),
  })
  .strict()
  .superRefine((data: { endpoint: string; localDevelopment: boolean }, ctx: z.RefinementCtx) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(data.endpoint);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Endpoint must be a valid URL',
        path: ['endpoint'],
      });
      return;
    }

    const isHttp = parsedUrl.protocol === 'http:';
    const isHttps = parsedUrl.protocol === 'https:';

    if (!isHttp && !isHttps) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Storage endpoint must use HTTPS (or HTTP for localhost when localDevelopment is true)',
        path: ['endpoint'],
      });
      return;
    }

    if (isHttp) {
      const isLocalhost =
        parsedUrl.hostname === 'localhost' ||
        parsedUrl.hostname === '127.0.0.1' ||
        parsedUrl.hostname === '::1';

      if (!data.localDevelopment) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'HTTP storage endpoints are rejected in production. Set localDevelopment: true to allow localhost HTTP for testing.',
          path: ['endpoint'],
        });
      }

      if (!isLocalhost) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Insecure HTTP endpoint '${data.endpoint}' is forbidden for non-localhost hosts. Production requires HTTPS.`,
          path: ['endpoint'],
        });
      }
    }
  });

export type StorageConfigInput = z.input<typeof StorageConfigSchema>;
export type StorageConfigOutput = z.infer<typeof StorageConfigSchema>;

/**
 * Strict Opaque Workspace ID schema.
 * Rejects path traversal, slashes, null bytes.
 */
export const WorkspaceIdSchema = z
  .string()
  .min(3, 'workspaceId must be at least 3 characters')
  .max(64, 'workspaceId must be at most 64 characters')
  .regex(
    /^[a-zA-Z0-9_-]+$/,
    'workspaceId must contain only alphanumeric characters, hyphens, and underscores'
  );

/**
 * Strict Opaque Artifact ID schema.
 * Rejects path traversal, slashes, colons, null bytes.
 */
export const ArtifactIdSchema = z
  .string()
  .min(8, 'artifactId must be at least 8 characters')
  .max(64, 'artifactId must be at most 64 characters')
  .regex(
    /^[a-zA-Z0-9_-]+$/,
    'artifactId must contain only alphanumeric characters, hyphens, and underscores'
  );

/**
 * SHA-256 Digest schema.
 * Accepts lowercase hex with sha256: prefix.
 */
export const Sha256DigestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, 'Digest must match format sha256:<64-char-hex>');

/**
 * ArtifactRef schema.
 * Derived from stored artifact workspace identity.
 */
export const ArtifactRefSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    artifactId: ArtifactIdSchema,
    digest: Sha256DigestSchema,
    size: z.number().int().nonnegative('size must be non-negative integer'),
    mimeType: z.string().min(1, 'mimeType is required'),
    createdAt: z.string().datetime({ message: 'createdAt must be an ISO 8601 UTC date string' }),
    expiry: z
      .string()
      .datetime({ message: 'expiry must be an ISO 8601 UTC date string or null' })
      .nullable(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

/**
 * ArtifactManifest schema.
 * Includes artifact ref plus optional custom metadata.
 */
export const ArtifactManifestSchema = ArtifactRefSchema;
export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;

/**
 * PutArtifactInput schema.
 * Caller cannot pass arbitrary storage path/key; only workspace identity and optional opaque artifactId.
 */
export const PutArtifactInputSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    artifactId: ArtifactIdSchema.optional(),
    mimeType: z.string().min(1).default('application/octet-stream'),
    expectedDigest: z
      .string()
      .regex(/^(?:sha256:)?[a-f0-9]{64}$/i, 'Invalid expected digest format')
      .optional(),
    expiry: z.union([z.string().datetime(), z.date()]).nullable().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    maxSizeBytes: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

export type PutArtifactInput = z.input<typeof PutArtifactInputSchema>;

/**
 * GetArtifactInput schema.
 * Requires caller workspaceId and either artifactId or artifactRef.
 * Default reads strictly enforce expiry. Only explicit internalRetentionScope permits reading expired records.
 */
export const GetArtifactInputSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    artifactId: ArtifactIdSchema.optional(),
    artifactRef: ArtifactRefSchema.optional(),
    internalRetentionScope: z.boolean().optional().default(false),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((data: { workspaceId: string; artifactId?: string; artifactRef?: ArtifactRef }, ctx: z.RefinementCtx) => {
    if (!data.artifactId && !data.artifactRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Either artifactId or artifactRef must be provided to get artifact',
        path: ['artifactId'],
      });
      return;
    }

    if (data.artifactRef && data.artifactRef.workspaceId !== data.workspaceId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Cross-workspace access denied: artifactRef workspace '${data.artifactRef.workspaceId}' does not match caller workspace '${data.workspaceId}'`,
        path: ['workspaceId'],
      });
    }

    if (data.artifactId && data.artifactRef && data.artifactId !== data.artifactRef.artifactId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Conflicting artifact identifiers: artifactId '${data.artifactId}' does not match artifactRef.artifactId '${data.artifactRef.artifactId}'`,
        path: ['artifactId'],
      });
    }
  });

export type GetArtifactInput = z.input<typeof GetArtifactInputSchema>;

/**
 * DeleteArtifactInput schema.
 * Requires workspaceId and artifactId/artifactRef.
 * Unconditionally rejects conflicting artifactId and artifactRef.artifactId.
 */
export const DeleteArtifactInputSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    artifactId: ArtifactIdSchema.optional(),
    artifactRef: ArtifactRefSchema.optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((data: { workspaceId: string; artifactId?: string; artifactRef?: ArtifactRef }, ctx: z.RefinementCtx) => {
    if (!data.artifactId && !data.artifactRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Either artifactId or artifactRef must be provided to delete artifact',
        path: ['artifactId'],
      });
      return;
    }

    if (data.artifactRef && data.artifactRef.workspaceId !== data.workspaceId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Cross-workspace access denied: artifactRef workspace '${data.artifactRef.workspaceId}' does not match caller workspace '${data.workspaceId}'`,
        path: ['workspaceId'],
      });
    }

    if (data.artifactId && data.artifactRef && data.artifactId !== data.artifactRef.artifactId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Conflicting artifact identifiers: artifactId '${data.artifactId}' does not match artifactRef.artifactId '${data.artifactRef.artifactId}'`,
        path: ['artifactId'],
      });
    }
  });

export type DeleteArtifactInput = z.input<typeof DeleteArtifactInputSchema>;

/**
 * HeadArtifactInput schema.
 */
export const HeadArtifactInputSchema = DeleteArtifactInputSchema;
export type HeadArtifactInput = z.input<typeof HeadArtifactInputSchema>;
