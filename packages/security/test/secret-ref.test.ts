import { describe, it, expect } from 'vitest';
import {
  createSecretRef,
  SecretRefSchema,
  assertNoCanaryOrSecret,
} from '../src/secret-ref.js';

describe('SecretRef Only Models', () => {
  it('creates a valid opaque SecretRef without secrets', () => {
    const ref = createSecretRef({
      secretId: 'sec_123',
      name: 'LIARA_API_TOKEN',
      version: 1,
      workspaceId: 'ws_demo',
    });

    expect(ref.secretId).toBe('sec_123');
    expect(ref.name).toBe('LIARA_API_TOKEN');
    expect(ref.version).toBe(1);
    expect(ref.workspaceId).toBe('ws_demo');
    expect(ref.isConcealed).toBe(true);
    expect(SecretRefSchema.safeParse(ref).success).toBe(true);
  });

  it('rejects SecretRef containing forbidden plaintext or value keys', () => {
    const invalidRefWithVal = {
      secretId: 'sec_123',
      name: 'DATABASE_PASSWORD',
      version: 1,
      workspaceId: 'ws_demo',
      createdAt: new Date().toISOString(),
      isConcealed: true,
      value: 'canary_secret_12345',
    };

    const parseResult1 = SecretRefSchema.safeParse(invalidRefWithVal);
    expect(parseResult1.success).toBe(false);

    const invalidRefWithToken = {
      secretId: 'sec_123',
      name: 'API_TOKEN',
      version: 1,
      workspaceId: 'ws_demo',
      createdAt: new Date().toISOString(),
      isConcealed: true,
      token: 'canary_token_5678',
    };

    const parseResult2 = SecretRefSchema.safeParse(invalidRefWithToken);
    expect(parseResult2.success).toBe(false);
  });

  it('assertNoCanaryOrSecret throws static safe message without leaking canary string', () => {
    const payload = {
      id: 'plan_1',
      details: 'connecting to host with canary_pass_xyz',
    };

    let caughtError: Error | null = null;
    try {
      assertNoCanaryOrSecret(payload, ['canary_pass_xyz']);
    } catch (err) {
      caughtError = err as Error;
    }

    expect(caughtError).toBeInstanceOf(Error);
    expect(caughtError?.message).toBe(
      'Security verification failed: sensitive credential or canary token detected in payload'
    );
    // Regression check: strictly verify canary string or payload details are NOT present in error message
    expect(caughtError?.message).not.toContain('canary_pass_xyz');
    expect(caughtError?.message).not.toContain('plan_1');

    expect(() =>
      assertNoCanaryOrSecret(payload, ['safe_non_present_value'])
    ).not.toThrow();
  });
});
