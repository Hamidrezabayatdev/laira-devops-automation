import { StorageConfigSchema, type StorageConfigInput } from './schemas.js';
import { StorageConfigError } from './errors.js';

/**
 * StorageConfig encapsulates validated configuration for S3-compatible artifact store.
 * Guarantees:
 * - Credentials are hidden and not publicly enumerable via Object.keys(), Object.entries(), or for..in.
 * - toJSON() and Node util.inspect redact credentials to [REDACTED].
 * - Enforces HTTPS in production; localhost HTTP permitted ONLY when localDevelopment is true.
 */
export class StorageConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly localDevelopment: boolean;
  readonly forcePathStyle: boolean;
  readonly maxArtifactSizeBytes: number;
  readonly defaultTimeoutMs: number;

  #accessKeyId: string;
  #secretAccessKey: string;

  constructor(input: StorageConfigInput) {
    const parseResult = StorageConfigSchema.safeParse(input);
    if (!parseResult.success) {
      const issues = parseResult.error.issues
        .map((issue: { path: (string | number)[]; message: string }) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ');
      throw new StorageConfigError(`Storage configuration error: ${issues}`, {
        safeDetails: { issues: parseResult.error.issues.map((i: { message: string }) => i.message) },
      });
    }

    const val = parseResult.data;
    this.endpoint = val.endpoint;
    this.region = val.region;
    this.bucket = val.bucket;
    this.localDevelopment = val.localDevelopment;
    this.forcePathStyle = val.forcePathStyle;
    this.maxArtifactSizeBytes = val.maxArtifactSizeBytes;
    this.defaultTimeoutMs = val.defaultTimeoutMs;

    this.#accessKeyId = val.credentials.accessKeyId;
    this.#secretAccessKey = val.credentials.secretAccessKey;

    Object.defineProperty(this, 'credentials', {
      get: () => ({
        accessKeyId: this.#accessKeyId,
        secretAccessKey: this.#secretAccessKey,
      }),
      enumerable: false,
      configurable: false,
    });
  }

  get credentials(): { accessKeyId: string; secretAccessKey: string } {
    return {
      accessKeyId: this.#accessKeyId,
      secretAccessKey: this.#secretAccessKey,
    };
  }

  toJSON(): Record<string, unknown> {
    return {
      endpoint: this.endpoint,
      region: this.region,
      bucket: this.bucket,
      localDevelopment: this.localDevelopment,
      forcePathStyle: this.forcePathStyle,
      maxArtifactSizeBytes: this.maxArtifactSizeBytes,
      defaultTimeoutMs: this.defaultTimeoutMs,
      credentials: {
        accessKeyId: '[REDACTED]',
        secretAccessKey: '[REDACTED]',
      },
    };
  }

  [Symbol.for('nodejs.util.inspect.custom')](): Record<string, unknown> {
    return this.toJSON();
  }

  /**
   * Creates a StorageConfig from server environment variables.
   * Never prints or exposes secret values.
   */
  static fromEnv(env: Record<string, string | undefined> = process.env): StorageConfig {
    const endpoint =
      env.S3_ENDPOINT ||
      env.LIARA_STORAGE_ENDPOINT ||
      env.STORAGE_ENDPOINT ||
      env.MINIO_ENDPOINT;

    const bucket =
      env.S3_BUCKET ||
      env.LIARA_STORAGE_BUCKET ||
      env.STORAGE_BUCKET ||
      env.MINIO_BUCKET;

    const accessKeyId =
      env.S3_ACCESS_KEY_ID ||
      env.MINIO_ROOT_USER ||
      env.LIARA_STORAGE_ACCESS_KEY ||
      env.STORAGE_ACCESS_KEY ||
      env.AWS_ACCESS_KEY_ID;

    const secretAccessKey =
      env.S3_SECRET_ACCESS_KEY ||
      env.MINIO_ROOT_PASSWORD ||
      env.LIARA_STORAGE_SECRET_KEY ||
      env.STORAGE_SECRET_KEY ||
      env.AWS_SECRET_ACCESS_KEY;

    const region = env.S3_REGION || env.STORAGE_REGION || env.AWS_REGION || 'us-east-1';

    let localDev = env.STORAGE_LOCAL_DEVELOPMENT === 'true';
    if (!localDev && endpoint) {
      try {
        const u = new URL(endpoint);
        if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) {
          // If launched with .env in local development/test
          localDev = env.NODE_ENV !== 'production';
        }
      } catch {
        // ignore
      }
    }

    const maxArtifactSizeBytes = env.STORAGE_MAX_ARTIFACT_SIZE_BYTES
      ? Number.parseInt(env.STORAGE_MAX_ARTIFACT_SIZE_BYTES, 10)
      : undefined;

    const defaultTimeoutMs = env.STORAGE_DEFAULT_TIMEOUT_MS
      ? Number.parseInt(env.STORAGE_DEFAULT_TIMEOUT_MS, 10)
      : undefined;

    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
      throw new StorageConfigError(
        'Missing required storage environment variables. Ensure endpoint, bucket, accessKey, and secretKey are set.',
        {
          safeDetails: {
            hasEndpoint: Boolean(endpoint),
            hasBucket: Boolean(bucket),
            hasAccessKey: Boolean(accessKeyId),
            hasSecretKey: Boolean(secretAccessKey),
          },
        }
      );
    }

    return new StorageConfig({
      endpoint,
      region,
      bucket,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
      localDevelopment: localDev,
      forcePathStyle: env.STORAGE_FORCE_PATH_STYLE !== 'false',
      maxArtifactSizeBytes,
      defaultTimeoutMs,
    });
  }
}
