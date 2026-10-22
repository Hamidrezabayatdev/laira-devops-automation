import crypto from 'node:crypto';
import { WorkspaceIdSchema, ArtifactIdSchema } from '../schemas.js';
import {
  PathInjectionError,
  InvalidStorageKeyError,
  CrossWorkspaceAccessError,
} from '../errors.js';

// Dangerous patterns for path traversal or injection
const SUSPICIOUS_PATH_PATTERNS = [
  /\.\./,          // dot-dot traversal
  /[/\\]/,         // slashes
  /%2e%2e/i,       // percent encoded dot-dot
  /%2f/i,          // percent encoded slash
  /%5c/i,          // percent encoded backslash
  /\0/,            // null byte
  /%00/i,          // percent encoded null byte
  /[<>:"|?*]/,     // filesystem restricted characters
];

/**
 * Validates a workspaceId strictly.
 * Rejects path traversal and invalid characters.
 */
export function validateWorkspaceId(workspaceId: unknown): string {
  if (typeof workspaceId !== 'string') {
    throw new InvalidStorageKeyError('workspaceId must be a string');
  }

  for (const pattern of SUSPICIOUS_PATH_PATTERNS) {
    if (pattern.test(workspaceId)) {
      throw new PathInjectionError(
        `workspaceId contains illegal path or traversal characters: '${workspaceId}'`,
        { workspaceId }
      );
    }
  }

  const parsed = WorkspaceIdSchema.safeParse(workspaceId);
  if (!parsed.success) {
    throw new InvalidStorageKeyError(
      `workspaceId does not conform to opaque format: ${parsed.error.issues[0]?.message}`,
      { workspaceId }
    );
  }

  return parsed.data;
}

/**
 * Validates an artifactId strictly.
 * Rejects arbitrary user paths, slashes, dot-dot traversal.
 */
export function validateArtifactId(artifactId: unknown, workspaceId?: string): string {
  if (typeof artifactId !== 'string') {
    throw new InvalidStorageKeyError('artifactId must be a string', { workspaceId });
  }

  for (const pattern of SUSPICIOUS_PATH_PATTERNS) {
    if (pattern.test(artifactId)) {
      throw new PathInjectionError(
        `artifactId contains illegal path or traversal characters: '${artifactId}'`,
        { workspaceId, artifactId }
      );
    }
  }

  const parsed = ArtifactIdSchema.safeParse(artifactId);
  if (!parsed.success) {
    throw new InvalidStorageKeyError(
      `artifactId does not conform to opaque format: ${parsed.error.issues[0]?.message}`,
      { workspaceId, artifactId }
    );
  }

  return parsed.data;
}

/**
 * Generates an opaque, cryptographically secure artifact ID.
 * Follows the pattern: art_<32-hex-chars>
 */
export function generateArtifactId(): string {
  const randomHex = crypto.randomBytes(16).toString('hex');
  return `art_${randomHex}`;
}

/**
 * Computes underlying validated S3 object key.
 * Format: workspaces/{workspaceId}/artifacts/{artifactId}
 */
export function computeArtifactStorageKey(workspaceId: string, artifactId: string): string {
  const validWorkspace = validateWorkspaceId(workspaceId);
  const validArtifact = validateArtifactId(artifactId, workspaceId);

  return `workspaces/${validWorkspace}/artifacts/${validArtifact}`;
}

/**
 * Verifies that the requested workspace matches the artifact reference workspace.
 * Throws CrossWorkspaceAccessError if mismatch.
 */
export function assertWorkspaceMatch(
  callerWorkspaceId: string,
  targetWorkspaceId: string,
  artifactId?: string
): void {
  const validCaller = validateWorkspaceId(callerWorkspaceId);
  const validTarget = validateWorkspaceId(targetWorkspaceId);

  if (validCaller !== validTarget) {
    throw new CrossWorkspaceAccessError({
      callerWorkspaceId: validCaller,
      targetWorkspaceId: validTarget,
      artifactId,
    });
  }
}

/**
 * Parses an S3 key back into workspaceId and artifactId.
 */
export function parseArtifactStorageKey(key: string): {
  workspaceId: string;
  artifactId: string;
} {
  if (!key || typeof key !== 'string') {
    throw new InvalidStorageKeyError('Storage key must be a non-empty string');
  }

  const parts = key.split('/');
  if (parts.length !== 4 || parts[0] !== 'workspaces' || parts[2] !== 'artifacts') {
    throw new InvalidStorageKeyError(
      `Key '${key}' does not match prefix format 'workspaces/{workspaceId}/artifacts/{artifactId}'`
    );
  }

  const workspaceId = validateWorkspaceId(parts[1]);
  const artifactId = validateArtifactId(parts[3], workspaceId);

  return { workspaceId, artifactId };
}
