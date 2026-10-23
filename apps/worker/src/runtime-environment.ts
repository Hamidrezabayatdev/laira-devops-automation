import crypto from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import {
  createConnection,
  addCredentialVersion,
} from '@laira/db';
import {
  encryptCredential,
  decryptCredential,
  AppError,
  type CredentialEnvelope,
} from '@laira/security';

export const RESERVED_VARIABLE_KEYS = Object.freeze([
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
] as const);

export const RESERVED_KEYS_SET = new Set<string>(RESERVED_VARIABLE_KEYS);

export const VARIABLE_KEY_REGEX = /^[A-Z][A-Z0-9_]{0,127}$/;

export const MAX_VARIABLES_COUNT = 40;
export const MAX_VARIABLES_TOTAL_BYTES = 32 * 1024; // 32 KiB (32768 bytes)

export interface RuntimeEnvironmentRef {
  connectionId: string;
  credentialVersion: number;
}

export interface ImportRuntimeEnvironmentResult {
  connectionId: string;
  credentialVersion: number;
  keys: string[];
}

export interface RuntimeEnvironmentVariable {
  key: string;
  value: string;
}

export interface RuntimeEnvironmentValidationOptions {
  allowEmpty?: boolean;
}

export const RuntimeEnvironmentRefSchema = z
  .object({
    connectionId: z.string().min(1),
    credentialVersion: z.number().int().positive(),
  })
  .strict();

export const RuntimeEnvironmentVariablesSchema = z.record(
  z.string().regex(VARIABLE_KEY_REGEX).refine(
    (k) => !RESERVED_KEYS_SET.has(k),
    { message: 'Reserved key rejected' }
  ),
  z.string()
);

/**
 * Validates a connection name string.
 * Name must be non-empty, up to 128 chars, and contain only safe alphanumeric and standard delimiter chars.
 * Throws AppError with static message on failure (never echoes untrusted input).
 */
export function validateConnectionName(name: unknown): string {
  if (typeof name !== 'string') {
    throw new AppError({
      code: 'BAD_REQUEST',
      message: 'Connection name must be a string',
      statusCode: 400,
    });
  }
  const trimmed = name.trim();
  if (!trimmed) {
    throw new AppError({
      code: 'BAD_REQUEST',
      message: 'Connection name cannot be empty',
      statusCode: 400,
    });
  }
  if (trimmed.length > 128) {
    throw new AppError({
      code: 'BAD_REQUEST',
      message: 'Connection name exceeds maximum length of 128 characters',
      statusCode: 400,
    });
  }
  if (!/^[a-zA-Z0-9_.\- ]+$/.test(trimmed)) {
    throw new AppError({
      code: 'BAD_REQUEST',
      message: 'Connection name contains invalid characters',
      statusCode: 400,
    });
  }
  return trimmed;
}

/**
 * Validates runtime environment variables:
 * - Must be a plain object
 * - Descriptor-safe: inspects property descriptors to reject getters, setters, non-enumerable properties, and symbols before reading values
 * - count <= 40
 * - total bytes <= 32 KiB
 * - key format ^[A-Z][A-Z0-9_]{0,127}$
 * - rejects reserved NODE_OPTIONS, LD_PRELOAD, LD_LIBRARY_PATH
 * - values must be strings
 * - noempty unless allowEmpty option is explicitly true
 * - Throws static errors, never leaking malformed keys or values
 */
export function validateRuntimeEnvironmentVariables(
  variables: unknown,
  options?: RuntimeEnvironmentValidationOptions
): Record<string, string> {
  if (
    typeof variables !== 'object' ||
    variables === null ||
    Array.isArray(variables) ||
    (Object.getPrototypeOf(variables) !== Object.prototype &&
      Object.getPrototypeOf(variables) !== null)
  ) {
    throw new AppError({
      code: 'BAD_REQUEST',
      message: 'Runtime environment variables must be a plain object',
      statusCode: 400,
    });
  }

  // Reject symbol properties before accessing descriptors
  if (Object.getOwnPropertySymbols(variables).length > 0) {
    throw new AppError({
      code: 'BAD_REQUEST',
      message: 'Symbol properties are not permitted on runtime environment variables',
      statusCode: 400,
    });
  }

  // Inspect descriptors to prevent getter execution and accessor attacks
  const descriptors = Object.getOwnPropertyDescriptors(variables);
  const keys = Object.keys(descriptors);

  if (keys.length === 0 && !options?.allowEmpty) {
    throw new AppError({
      code: 'BAD_REQUEST',
      message: 'Runtime environment variables cannot be empty unless explicitly allowed',
      statusCode: 400,
    });
  }

  if (keys.length > MAX_VARIABLES_COUNT) {
    throw new AppError({
      code: 'BAD_REQUEST',
      message: `Runtime environment variables count exceeds maximum limit of ${MAX_VARIABLES_COUNT}`,
      statusCode: 400,
    });
  }

  let totalBytes = 0;
  const result: Record<string, string> = {};

  for (const key of keys) {
    if (key === '__proto__') {
      throw new AppError({
        code: 'BAD_REQUEST',
        message: 'Prohibited object property: __proto__',
        statusCode: 400,
      });
    }

    const desc = descriptors[key];
    if (!desc) {
      throw new AppError({
        code: 'BAD_REQUEST',
        message: 'Runtime environment variable descriptor is missing',
        statusCode: 400,
      });
    }

    if (!desc.enumerable) {
      throw new AppError({
        code: 'BAD_REQUEST',
        message: 'Non-enumerable properties are not permitted on runtime environment variables',
        statusCode: 400,
      });
    }

    if (desc.get !== undefined || desc.set !== undefined) {
      throw new AppError({
        code: 'BAD_REQUEST',
        message: 'Property accessors (getters/setters) are not permitted on runtime environment variables',
        statusCode: 400,
      });
    }

    if (!VARIABLE_KEY_REGEX.test(key)) {
      throw new AppError({
        code: 'BAD_REQUEST',
        message: 'Runtime environment variable key violates required format ^[A-Z][A-Z0-9_]{0,127}$',
        statusCode: 400,
      });
    }

    if (RESERVED_KEYS_SET.has(key)) {
      throw new AppError({
        code: 'BAD_REQUEST',
        message: 'Runtime environment variable key is reserved (NODE_OPTIONS, LD_PRELOAD, LD_LIBRARY_PATH)',
        statusCode: 400,
      });
    }

    const value = desc.value;
    if (typeof value !== 'string') {
      throw new AppError({
        code: 'BAD_REQUEST',
        message: 'Runtime environment variable value must be a string',
        statusCode: 400,
      });
    }

    totalBytes += Buffer.byteLength(key, 'utf8') + Buffer.byteLength(value, 'utf8');
    if (totalBytes > MAX_VARIABLES_TOTAL_BYTES) {
      throw new AppError({
        code: 'BAD_REQUEST',
        message: `Runtime environment total size exceeds maximum limit of ${MAX_VARIABLES_TOTAL_BYTES} bytes (32 KiB)`,
        statusCode: 400,
      });
    }

    result[key] = value;
  }

  return result;
}

/**
 * Computes a 64-bit advisory lock key from workspace ID and connection name.
 */
function computeAdvisoryLockKey(workspaceId: string, name: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(`runtime_env:${workspaceId}:${name}`)
    .digest();
  return hash.readBigInt64BE(0).toString();
}

/**
 * Imports a runtime environment secret bundle:
 * 1. Validates connection name and variables (with descriptor safety check).
 * 2. Uses transaction on pool/client.
 * 3. Enforces concurrency-safe no-overwrite rule via transaction-scoped advisory lock:
 *    SELECT pg_advisory_xact_lock($1::bigint) on workspace+name before checking existence.
 * 4. Creates connection under provider 'deployment_env'.
 * 5. Encrypts JSON {variables} with AAD bound to workspaceId, connectionId, and version.
 * 6. Adds credential version via existing addCredentialVersion helper.
 * 7. Wraps unknown/DB errors in a static AppError (never leaks raw SQL/payload data).
 * 8. Returns only connection reference and keys list (NEVER secret values).
 */
export async function importRuntimeEnvironment(
  poolOrClient: pg.Pool | pg.PoolClient,
  workspaceId: string,
  masterKey: Buffer | string,
  variables: Record<string, string>,
  connectionName: string,
  options?: RuntimeEnvironmentValidationOptions
): Promise<ImportRuntimeEnvironmentResult> {
  if (typeof workspaceId !== 'string' || !workspaceId.trim()) {
    throw new AppError({
      code: 'BAD_REQUEST',
      message: 'Workspace ID must be a non-empty string',
      statusCode: 400,
    });
  }
  const cleanWorkspaceId = workspaceId.trim();

  if (!masterKey || (typeof masterKey !== 'string' && !Buffer.isBuffer(masterKey))) {
    throw new AppError({
      code: 'BAD_REQUEST',
      message: 'Master encryption key is required',
      statusCode: 400,
    });
  }

  const validName = validateConnectionName(connectionName);
  const validVariables = validateRuntimeEnvironmentVariables(variables, options);

  const isPool = typeof (poolOrClient as pg.Pool).connect === 'function';
  const client: pg.PoolClient = isPool
    ? await (poolOrClient as pg.Pool).connect()
    : (poolOrClient as pg.PoolClient);

  let inTx = false;
  try {
    await client.query('BEGIN');
    inTx = true;

    // Transaction-level advisory lock serializes concurrent imports for the same workspace+name
    const lockKey = computeAdvisoryLockKey(cleanWorkspaceId, validName);
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockKey]);

    // Check no-overwrite: refuse if connection with same name already exists in workspace
    const existing = await client.query(
      `SELECT id FROM app.connections
       WHERE workspace_id = $1 AND name = $2
       LIMIT 1`,
      [cleanWorkspaceId, validName]
    );

    if (existing.rows && existing.rows.length > 0) {
      throw new AppError({
        code: 'CONFLICT',
        message: 'Connection with this name already exists in workspace. Refusing to overwrite.',
        statusCode: 409,
      });
    }

    const connectionId = `conn_${crypto.randomUUID().replace(/-/g, '')}`;

    await createConnection(
      client,
      { workspaceId: cleanWorkspaceId },
      {
        id: connectionId,
        name: validName,
        provider: 'deployment_env',
      }
    );

    const credentialPlaintext = JSON.stringify({ variables: validVariables });

    let envelope: CredentialEnvelope;
    try {
      envelope = encryptCredential(
        credentialPlaintext,
        masterKey,
        {
          workspaceId: cleanWorkspaceId,
          connectionId,
          version: 1,
          keyVersion: 1,
        },
        1
      );
    } catch {
      throw new AppError({
        code: 'INTERNAL_ERROR',
        message: 'Failed to encrypt runtime environment credentials',
        statusCode: 500,
      });
    }

    await addCredentialVersion(
      client,
      { workspaceId: cleanWorkspaceId },
      connectionId,
      envelope
    );

    await client.query('COMMIT');
    inTx = false;

    const sortedKeys = Object.keys(validVariables).sort();
    return {
      connectionId,
      credentialVersion: 1,
      keys: sortedKeys,
    };
  } catch (err) {
    if (inTx) {
      await client.query('ROLLBACK').catch(() => {});
    }
    if (err instanceof AppError) {
      throw err;
    }
    throw new AppError({
      code: 'INTERNAL_ERROR',
      message: 'Failed to import runtime environment',
      statusCode: 500,
    });
  } finally {
    if (isPool && typeof client.release === 'function') {
      client.release();
    }
  }
}

/**
 * Resolves deployment runtime secrets:
 * - Scoped to workspace and connection
 * - Enforces provider 'deployment_env'
 * - Enforces eligible status ('active' | 'configured_unverified')
 * - Enforces exact active credential version matching ref
 * - Enforces algorithm 'aes-256-gcm'
 * - Strictly requires cred.key_version === 1 (numeric, no aliases, no defaults)
 * - Decrypts with exact AAD context
 * - Enforces strict JSON schema bounded again
 * - Wraps unknown/DB errors in a static AppError (never leaks raw error data)
 * - Returns Array<{ key: string, value: string }> with keys sorted
 * - Static errors, never values/keys from malformed data
 */
export async function resolveRuntimeEnvironment(
  poolOrClient: pg.Pool | pg.PoolClient,
  workspaceId: string,
  masterKey: Buffer | string,
  ref: RuntimeEnvironmentRef
): Promise<RuntimeEnvironmentVariable[]> {
  if (typeof workspaceId !== 'string' || !workspaceId.trim()) {
    throw new AppError({
      code: 'BAD_REQUEST',
      message: 'Workspace ID must be a non-empty string',
      statusCode: 400,
    });
  }
  const cleanWorkspaceId = workspaceId.trim();

  if (
    !ref ||
    typeof ref !== 'object' ||
    typeof ref.connectionId !== 'string' ||
    !ref.connectionId.trim() ||
    typeof ref.credentialVersion !== 'number' ||
    !Number.isInteger(ref.credentialVersion) ||
    ref.credentialVersion < 1
  ) {
    throw new AppError({
      code: 'BAD_REQUEST',
      message: 'Invalid runtime environment reference',
      statusCode: 400,
    });
  }

  if (!masterKey || (typeof masterKey !== 'string' && !Buffer.isBuffer(masterKey))) {
    throw new AppError({
      code: 'BAD_REQUEST',
      message: 'Master encryption key is required',
      statusCode: 400,
    });
  }

  const isPool = typeof (poolOrClient as pg.Pool).connect === 'function';
  const client: pg.PoolClient = isPool
    ? await (poolOrClient as pg.Pool).connect()
    : (poolOrClient as pg.PoolClient);

  try {
    const connRes = await client.query(
      `SELECT id, workspace_id, name, provider, status, active_version
       FROM app.connections
       WHERE id = $1 AND workspace_id = $2
       LIMIT 1`,
      [ref.connectionId, cleanWorkspaceId]
    );

    if (!connRes.rows || connRes.rows.length === 0) {
      throw new AppError({
        code: 'NOT_FOUND',
        message: 'Connection not found in workspace',
        statusCode: 404,
      });
    }

    const conn = connRes.rows[0];

    if (conn.provider !== 'deployment_env') {
      throw new AppError({
        code: 'PRECONDITION_FAILED',
        message: 'Connection provider must be "deployment_env"',
        statusCode: 412,
      });
    }

    const ELIGIBLE_STATUSES = new Set(['active', 'configured_unverified']);
    if (!ELIGIBLE_STATUSES.has(conn.status)) {
      throw new AppError({
        code: 'PRECONDITION_FAILED',
        message: 'Connection status is not eligible for resolution',
        statusCode: 412,
      });
    }

    if (Number(conn.active_version) !== ref.credentialVersion) {
      throw new AppError({
        code: 'PRECONDITION_FAILED',
        message: 'Credential version does not match active connection version',
        statusCode: 412,
      });
    }

    const credRes = await client.query(
      `SELECT id, workspace_id, connection_id, version, algorithm, ciphertext, iv, tag, key_version
       FROM app.connection_credential_versions
       WHERE workspace_id = $1 AND connection_id = $2 AND version = $3
       LIMIT 1`,
      [cleanWorkspaceId, ref.connectionId, ref.credentialVersion]
    );

    if (!credRes.rows || credRes.rows.length === 0) {
      throw new AppError({
        code: 'NOT_FOUND',
        message: 'Connection credential version record not found',
        statusCode: 404,
      });
    }

    const cred = credRes.rows[0];

    if (cred.algorithm !== 'aes-256-gcm') {
      throw new AppError({
        code: 'PRECONDITION_FAILED',
        message: 'Unsupported encryption algorithm',
        statusCode: 412,
      });
    }

    // Require cred.key_version === 1 exactly numeric, no aliases, no defaults (prevent fail-open)
    if (typeof cred.key_version !== 'number' || cred.key_version !== 1) {
      throw new AppError({
        code: 'PRECONDITION_FAILED',
        message: 'Unsupported key version',
        statusCode: 412,
      });
    }

    const keyVer = cred.key_version;

    const envelope: CredentialEnvelope = {
      algorithm: 'aes-256-gcm',
      ciphertext: cred.ciphertext,
      iv: cred.iv,
      tag: cred.tag,
      keyVersion: keyVer,
      workspaceId: cleanWorkspaceId,
      connectionId: ref.connectionId,
      version: String(ref.credentialVersion),
    };

    let decryptedBuf: Buffer;
    try {
      decryptedBuf = decryptCredential(envelope, masterKey, {
        workspaceId: cleanWorkspaceId,
        connectionId: ref.connectionId,
        version: ref.credentialVersion,
        keyVersion: keyVer,
      });
    } catch {
      throw new AppError({
        code: 'DECRYPTION_FAILED',
        message: 'Failed to decrypt runtime environment credentials',
        statusCode: 500,
      });
    }

    let parsedPayload: unknown;
    try {
      parsedPayload = JSON.parse(decryptedBuf.toString('utf8'));
    } catch {
      throw new AppError({
        code: 'INTERNAL_ERROR',
        message: 'Decrypted payload is not valid JSON',
        statusCode: 500,
      });
    }

    if (
      typeof parsedPayload !== 'object' ||
      parsedPayload === null ||
      Array.isArray(parsedPayload) ||
      (Object.getPrototypeOf(parsedPayload) !== Object.prototype &&
        Object.getPrototypeOf(parsedPayload) !== null)
    ) {
      throw new AppError({
        code: 'INTERNAL_ERROR',
        message: 'Decrypted runtime environment payload does not match expected schema',
        statusCode: 500,
      });
    }

    const payloadObj = parsedPayload as Record<string, unknown>;
    const payloadKeys = Object.keys(payloadObj);
    if (payloadKeys.length !== 1 || payloadKeys[0] !== 'variables') {
      throw new AppError({
        code: 'INTERNAL_ERROR',
        message: 'Decrypted runtime environment payload contains unexpected properties',
        statusCode: 500,
      });
    }

    let validatedVariables: Record<string, string>;
    try {
      validatedVariables = validateRuntimeEnvironmentVariables(payloadObj.variables, {
        allowEmpty: true,
      });
    } catch {
      throw new AppError({
        code: 'INTERNAL_ERROR',
        message: 'Decrypted runtime environment variables failed schema validation',
        statusCode: 500,
      });
    }

    const sortedKeys = Object.keys(validatedVariables).sort();
    return sortedKeys.map((key) => ({
      key,
      value: validatedVariables[key]!,
    }));
  } catch (err) {
    if (err instanceof AppError) {
      throw err;
    }
    throw new AppError({
      code: 'INTERNAL_ERROR',
      message: 'Failed to resolve runtime environment',
      statusCode: 500,
    });
  } finally {
    if (isPool && typeof client.release === 'function') {
      client.release();
    }
  }
}
