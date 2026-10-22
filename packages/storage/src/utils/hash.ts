import crypto from 'node:crypto';
import { ChecksumMismatchError } from '../errors.js';

/**
 * Computes sha256 hex digest prefixed with 'sha256:'.
 */
export function computeSha256(data: Buffer | Uint8Array | string): string {
  const hash = crypto.createHash('sha256');
  if (typeof data === 'string') {
    hash.update(data, 'utf8');
  } else {
    hash.update(data);
  }
  return `sha256:${hash.digest('hex')}`;
}

/**
 * Normalizes a sha256 digest string to canonical 'sha256:<64-lowercase-hex>'.
 */
export function normalizeDigest(digest: string): string {
  const trimmed = digest.trim().toLowerCase();
  if (trimmed.startsWith('sha256:')) {
    return trimmed;
  }
  if (/^[a-f0-9]{64}$/.test(trimmed)) {
    return `sha256:${trimmed}`;
  }
  return trimmed;
}

/**
 * Verifies that two sha256 digests match.
 * Throws ChecksumMismatchError on inequality.
 */
export function assertChecksumMatch(
  actualDigest: string,
  expectedDigest: string,
  context: { workspaceId: string; artifactId?: string }
): void {
  const normActual = normalizeDigest(actualDigest);
  const normExpected = normalizeDigest(expectedDigest);

  // If length matches, use constant-time comparison
  const actualBuf = Buffer.from(normActual, 'utf8');
  const expectedBuf = Buffer.from(normExpected, 'utf8');

  const matches =
    actualBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(actualBuf, expectedBuf);

  if (!matches) {
    throw new ChecksumMismatchError({
      workspaceId: context.workspaceId,
      artifactId: context.artifactId,
      expectedDigest: normExpected,
      actualDigest: normActual,
    });
  }
}
