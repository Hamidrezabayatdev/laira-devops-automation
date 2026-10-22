import { describe, it, expect, beforeEach } from 'vitest';
import { S3StorageAdapter } from '../src/adapter.js';
import { StorageConfig } from '../src/config.js';
import { MockS3Client } from '../src/mock/mock-s3.js';
import { StorageOperationError, sanitizeErrorMessage } from '../src/errors.js';

describe('Canary Errors & Secrets Redaction', () => {
  let mockS3: MockS3Client;
  let adapter: S3StorageAdapter;

  beforeEach(() => {
    mockS3 = new MockS3Client();
    const config = new StorageConfig({
      endpoint: 'https://storage.iran.liara.ir',
      bucket: 'test-bucket',
      credentials: {
        accessKeyId: 'test-key',
        secretAccessKey: 'test-secret',
      },
    });
    adapter = new S3StorageAdapter({ config, s3Client: mockS3 });
  });

  it('sanitizes canary secrets and raw XML error bodies from underlying S3 exceptions', async () => {
    const canaryToken = 'alpha_secret_canary_xyz_12345';
    mockS3.setSimulatedCanaryLeak(canaryToken);

    try {
      await adapter.putArtifact(
        { workspaceId: 'ws_prod', mimeType: 'text/plain' },
        Buffer.from('data')
      );
      expect.fail('Should have thrown StorageOperationError');
    } catch (err) {
      expect(err).toBeInstanceOf(StorageOperationError);
      const storageErr = err as StorageOperationError;

      // 1. Must NOT contain canary token
      expect(storageErr.message).not.toContain(canaryToken);
      expect(storageErr.message).not.toContain('canary_');

      // 2. Must NOT contain raw XML tags
      expect(storageErr.message).not.toContain('<Error>');
      expect(storageErr.message).not.toContain('</Error>');
      expect(storageErr.message).not.toContain('<Code>');

      // 3. Stringified error must not leak canary
      expect(JSON.stringify(storageErr)).not.toContain(canaryToken);
    }
  });

  it('sanitizes AWS access key and secret key patterns', () => {
    const rawError =
      'Request to S3 failed for key AKIAIOSFODNN7EXAMPLE with secretAccessKey=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY and Bearer eyJhbGciOiJIUzI1NiJ9.test';
    const sanitized = sanitizeErrorMessage(rawError);

    expect(sanitized).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(sanitized).not.toContain('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
    expect(sanitized).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(sanitized).toContain('[REDACTED_ACCESS_KEY]');
    expect(sanitized).toContain('secret=[REDACTED]');
    expect(sanitized).toContain('Bearer [REDACTED]');
  });

  it('redacts S3 auth query parameters and signatures', () => {
    const rawError = 'URL failed: https://s3.liara.ir/bucket/file?X-Amz-Signature=d4c5e6f7a8b9c0&X-Amz-Credential=AKIA123';
    const sanitized = sanitizeErrorMessage(rawError);

    expect(sanitized).not.toContain('d4c5e6f7a8b9c0');
    expect(sanitized).not.toContain('AKIA123');
  });

  it('guarantees StorageOperationError.from returns static generic message and drops unknown error details', () => {
    const rawErrorWithCanary = new Error(
      'Fatal: internal leak sensitive_token_xyz_99999 connection to https://super-secret-host.internal'
    );
    (rawErrorWithCanary as any).statusCode = 500;
    (rawErrorWithCanary as any).rawHeaders = { authorization: 'Bearer secret_auth_header' };

    const mapped = StorageOperationError.from(rawErrorWithCanary, {
      workspaceId: 'ws_prod',
      artifactId: 'art_12345',
      operation: 'customOp',
    });

    expect(mapped.message).toBe(
      "Underlying S3 storage during 'customOp' failed: An internal storage provider error occurred"
    );
    expect(mapped.message).not.toContain('sensitive_token_xyz_99999');
    expect(mapped.message).not.toContain('super-secret-host');
    expect((mapped as any).cause).toBeUndefined();
    expect(JSON.stringify(mapped)).not.toContain('sensitive_token_xyz_99999');
    expect(JSON.stringify(mapped)).not.toContain('secret_auth_header');
  });
});
