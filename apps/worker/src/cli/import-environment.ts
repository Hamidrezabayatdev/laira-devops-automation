import fs from 'node:fs';
import { open } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import type { OperatorCliDependencies } from './types.js';
import { authenticateOperator } from './auth.js';
import { resolveDatabasePool, resolveOperatorWorkspace } from './db.js';
import {
  importRuntimeEnvironment,
  validateRuntimeEnvironmentVariables,
  validateConnectionName,
  type ImportRuntimeEnvironmentResult,
} from '../runtime-environment.js';

export const MAX_ENV_FILE_BYTES = 64 * 1024; // 64 KiB (65536 bytes)

export interface ImportEnvironmentArgs {
  name: string;
  file: string;
  keys: string;
}

/**
 * Safely reads a local environment file, bounded to <= 64 KiB, with symlink rejection (O_NOFOLLOW)
 * and non-blocking open (O_NONBLOCK) to prevent hanging on FIFO/named pipes.
 * Performs a loop-bounded read up to 64 KiB + 1 to avoid partial reads and detect oversized files.
 * Parses file contents using Node 24 `util.parseEnv` (pure parser, no shell expansion/execution).
 * Strictly picks only allowlisted keys and validates that all requested allowlist keys exist.
 * Validates selected variables through the runtime vault validator.
 * Static errors only: file path, raw contents, and secret values are never printed.
 */
export async function readSelectedEnvironment(
  filePath: string,
  allowedKeys: string[] | string
): Promise<Record<string, string>> {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('Environment file path is required');
  }
  const cleanPath = filePath.trim();

  let keyList: string[];
  if (typeof allowedKeys === 'string') {
    keyList = allowedKeys
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
  } else if (Array.isArray(allowedKeys)) {
    keyList = allowedKeys.map((k) => (typeof k === 'string' ? k.trim() : '')).filter(Boolean);
  } else {
    throw new Error('No environment variable keys specified in allowlist');
  }

  if (keyList.length === 0) {
    throw new Error('No environment variable keys specified in allowlist');
  }

  let handle: fs.promises.FileHandle | null = null;
  let fileBuffer: Buffer;

  try {
    const flags =
      fs.constants.O_RDONLY |
      (fs.constants.O_NOFOLLOW ?? 0) |
      (fs.constants.O_NONBLOCK ?? 0);
    handle = await open(cleanPath, flags);

    const stats = await handle.stat();

    if (!stats.isFile()) {
      throw new Error('Failed to read environment file: not a regular file');
    }

    if (stats.size > MAX_ENV_FILE_BYTES) {
      throw new Error('Failed to read environment file: file exceeds maximum size of 64 KiB');
    }

    // Read loop up to MAX_ENV_FILE_BYTES + 1 to prevent partial reads and enforce hard limit
    const chunks: Buffer[] = [];
    let totalRead = 0;
    const CHUNK_SIZE = 16 * 1024;
    const readLimit = MAX_ENV_FILE_BYTES + 1;

    while (totalRead < readLimit) {
      const toRead = Math.min(CHUNK_SIZE, readLimit - totalRead);
      const chunkBuf = Buffer.alloc(toRead);
      const { bytesRead } = await handle.read(chunkBuf, 0, toRead, null);
      if (bytesRead === 0) {
        break; // EOF
      }
      chunks.push(chunkBuf.subarray(0, bytesRead));
      totalRead += bytesRead;
    }

    if (totalRead > MAX_ENV_FILE_BYTES) {
      throw new Error('Failed to read environment file: file exceeds maximum size of 64 KiB');
    }

    fileBuffer = Buffer.concat(chunks);
  } catch (err: any) {
    if (handle) {
      await handle.close().catch(() => {});
      handle = null;
    }

    if (err instanceof Error && err.message.startsWith('Failed to read environment file:')) {
      throw err;
    }

    if (err?.code === 'ELOOP') {
      throw new Error('Failed to read environment file: symlinks are not permitted');
    }
    if (err?.code === 'ENOENT') {
      throw new Error('Failed to read environment file: file not found');
    }
    throw new Error('Failed to read environment file: unreadable or inaccessible file');
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
  }

  const fileContent = fileBuffer.toString('utf8');

  let parsed: Record<string, string | undefined>;
  try {
    parsed = parseEnv(fileContent);
  } catch {
    throw new Error('Failed to parse environment file');
  }

  // Ensure every allowlisted key exists in the parsed file (no missing allowlisted keys)
  const selected: Record<string, string> = {};
  for (const key of keyList) {
    const val = parsed[key];
    if (!Object.prototype.hasOwnProperty.call(parsed, key) || val === undefined) {
      throw new Error('Missing allowlisted environment variable in file');
    }
    selected[key] = val;
  }

  // Validate selected variables through vault validator
  validateRuntimeEnvironmentVariables(selected);

  return selected;
}

/**
 * Handles the operator environment import command:
 * 1. Validates connection name and inputs.
 * 2. Authenticates verified GitHub operator BEFORE reading local file.
 * 3. Reads and extracts allowlisted environment secrets from local file.
 * 4. Resolves database pool and owner workspace.
 * 5. Calls vault importRuntimeEnvironment to store encrypted credentials atomically.
 * 6. Emits reference output to stdout (NEVER values, file paths, or raw payload contents).
 */
export async function executeImportEnvironmentCommand(
  args: ImportEnvironmentArgs,
  deps?: OperatorCliDependencies
): Promise<ImportRuntimeEnvironmentResult> {
  if (!args?.name || typeof args.name !== 'string' || !args.name.trim()) {
    throw new Error('Connection name is required');
  }
  const validName = validateConnectionName(args.name);

  if (!args?.file || typeof args.file !== 'string' || !args.file.trim()) {
    throw new Error('Environment file path is required');
  }

  if (!args?.keys || typeof args.keys !== 'string' || !args.keys.trim()) {
    throw new Error('Environment keys allowlist is required');
  }

  // Authenticate operator BEFORE accessing any local files
  const user = await authenticateOperator(deps);

  const env = deps?.env ?? process.env;
  const masterKey = env.ENCRYPTION_MASTER_KEY?.trim();
  if (!masterKey) {
    throw new Error('ENCRYPTION_MASTER_KEY environment variable is required');
  }

  const selectedVariables = await readSelectedEnvironment(args.file, args.keys);

  const managedPool = resolveDatabasePool(deps);

  try {
    const { workspace } = await resolveOperatorWorkspace(managedPool.pool, user);

    const result = await importRuntimeEnvironment(
      managedPool.pool,
      workspace.id,
      masterKey,
      selectedVariables,
      validName
    );

    const outJson = JSON.stringify(result, null, 2);
    if (deps?.stdout) {
      deps.stdout(outJson);
    } else {
      console.log(outJson);
    }

    return result;
  } finally {
    if (managedPool.shouldClose) {
      await managedPool.pool.end().catch(() => {});
    }
  }
}
