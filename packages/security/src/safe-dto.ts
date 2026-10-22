import { z } from 'zod';

/**
 * Generic allowlist helper: extracts ONLY explicitly allowed keys from a source object.
 * Does not rely on blacklists or redactions.
 */
export function allowlistFields<T extends Record<string, unknown>, K extends keyof T>(
  raw: unknown,
  allowedKeys: readonly K[]
): Pick<T, K> {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('allowlistFields expects a non-null object');
  }

  const record = raw as Record<string, unknown>;
  const result = {} as Pick<T, K>;

  for (const key of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      result[key] = record[key as string] as T[K];
    }
  }

  return result;
}

// -------------------------------------------------------------
// Liara App Safe DTO
// -------------------------------------------------------------
export const SafeLiaraAppDtoSchema = z.object({
  project_id: z.string(),
  type: z.string(),
  status: z.string(),
  scale: z.number().int().nonnegative().default(1),
  created_at: z.string(),
  node_version: z.string().optional(),
  port: z.number().int().positive().optional(),
  platform: z.string().optional(),
  bundle_plan: z.string().optional(),
  zone: z.string().optional(),
  is_deploying: z.boolean().optional(),
  hourly_price: z.number().optional(),
}).strict();

export type SafeLiaraAppDto = z.infer<typeof SafeLiaraAppDtoSchema>;

const LIARA_APP_ALLOWED_KEYS = [
  'project_id',
  'type',
  'status',
  'scale',
  'created_at',
  'node_version',
  'port',
  'platform',
  'bundle_plan',
  'zone',
  'is_deploying',
  'hourly_price',
] as const;

/**
 * Produces a safe Liara App DTO by allowlisting safe fields.
 * Explicitly strips all environment values (`envs`, `env`), credentials, and private tokens.
 */
export function toSafeLiaraAppDto(raw: unknown): SafeLiaraAppDto {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Invalid Liara app response: expected an object');
  }

  const extracted = allowlistFields<SafeLiaraAppDto, keyof SafeLiaraAppDto>(
    raw,
    LIARA_APP_ALLOWED_KEYS
  );

  return SafeLiaraAppDtoSchema.parse(extracted);
}

// -------------------------------------------------------------
// Liara Release Safe DTO
// -------------------------------------------------------------
export const SafeLiaraReleaseDtoSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  state: z.string(),
  created_at: z.string(),
  type: z.string().optional(),
  source_type: z.string().optional(),
}).strict();

export type SafeLiaraReleaseDto = z.infer<typeof SafeLiaraReleaseDtoSchema>;

const LIARA_RELEASE_ALLOWED_KEYS = [
  'id',
  'project_id',
  'state',
  'created_at',
  'type',
  'source_type',
] as const;

export function toSafeLiaraReleaseDto(raw: unknown): SafeLiaraReleaseDto {
  const extracted = allowlistFields<SafeLiaraReleaseDto, keyof SafeLiaraReleaseDto>(
    raw,
    LIARA_RELEASE_ALLOWED_KEYS
  );
  return SafeLiaraReleaseDtoSchema.parse(extracted);
}

// -------------------------------------------------------------
// Liara Database Safe DTO
// -------------------------------------------------------------
export const SafeLiaraDatabaseDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  status: z.string(),
  plan: z.string(),
  version: z.string().optional(),
  scale: z.number().int().nonnegative().optional(),
  created_at: z.string().optional(),
  hourly_price: z.number().optional(),
}).strict();

export type SafeLiaraDatabaseDto = z.infer<typeof SafeLiaraDatabaseDtoSchema>;

const LIARA_DB_ALLOWED_KEYS = [
  'id',
  'name',
  'type',
  'status',
  'plan',
  'version',
  'scale',
  'created_at',
  'hourly_price',
] as const;

/**
 * Produces a safe Liara Database DTO by allowlisting metadata.
 * Strips all hostnames, connection strings, passwords, and ports.
 */
export function toSafeLiaraDatabaseDto(raw: unknown): SafeLiaraDatabaseDto {
  const extracted = allowlistFields<SafeLiaraDatabaseDto, keyof SafeLiaraDatabaseDto>(
    raw,
    LIARA_DB_ALLOWED_KEYS
  );
  return SafeLiaraDatabaseDtoSchema.parse(extracted);
}

// -------------------------------------------------------------
// Safe Environment Variable Metadata DTO (Key-only, NEVER values)
// -------------------------------------------------------------
export const SafeEnvVarMetaDtoSchema = z.object({
  key: z.string().min(1),
  isSet: z.boolean(),
}).strict();

export type SafeEnvVarMetaDto = z.infer<typeof SafeEnvVarMetaDtoSchema>;

/**
 * Converts raw environment configurations into key-only metadata.
 * Never stores or transmits plaintext environment variable values.
 */
export function toSafeEnvVarMetadataDto(rawEnvs: unknown): SafeEnvVarMetaDto[] {
  if (!rawEnvs) return [];

  const result: SafeEnvVarMetaDto[] = [];

  if (Array.isArray(rawEnvs)) {
    for (const item of rawEnvs) {
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        const key = typeof record.key === 'string' ? record.key : typeof record.name === 'string' ? record.name : null;
        if (key) {
          result.push({
            key,
            isSet: record.value !== undefined && record.value !== null && record.value !== '',
          });
        }
      }
    }
  } else if (typeof rawEnvs === 'object') {
    for (const key of Object.keys(rawEnvs as Record<string, unknown>)) {
      const val = (rawEnvs as Record<string, unknown>)[key];
      result.push({
        key,
        isSet: val !== undefined && val !== null && val !== '',
      });
    }
  }

  // Sort keys alphabetically for deterministic output
  return result.sort((a, b) => a.key.localeCompare(b.key));
}

// -------------------------------------------------------------
// BoxAPI Usage Safe DTO
// -------------------------------------------------------------
export const SafeBoxApiUsageDtoSchema = z.object({
  model: z.string(),
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  cached_tokens: z.number().int().nonnegative().optional(),
}).strict();

export type SafeBoxApiUsageDto = z.infer<typeof SafeBoxApiUsageDtoSchema>;

const BOX_USAGE_ALLOWED_KEYS = [
  'model',
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'cached_tokens',
] as const;

export function toSafeBoxApiUsageDto(raw: unknown, modelFallback?: string): SafeBoxApiUsageDto {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Invalid BoxAPI usage: expected an object');
  }

  const record = raw as Record<string, unknown>;
  const payload = {
    model: typeof record.model === 'string' ? record.model : modelFallback ?? 'qwen/qwen3.7-flash',
    prompt_tokens: Number(record.prompt_tokens ?? record.promptTokens ?? 0),
    completion_tokens: Number(record.completion_tokens ?? record.completionTokens ?? 0),
    total_tokens: Number(record.total_tokens ?? record.totalTokens ?? 0),
    cached_tokens: record.cached_tokens !== undefined ? Number(record.cached_tokens) : undefined,
  };

  const extracted = allowlistFields<SafeBoxApiUsageDto, keyof SafeBoxApiUsageDto>(
    payload,
    BOX_USAGE_ALLOWED_KEYS
  );

  return SafeBoxApiUsageDtoSchema.parse(extracted);
}
