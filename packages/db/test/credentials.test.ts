import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  encryptCredential,
  decryptCredential,
} from '@laira/security';

describe('Connection Credential Envelope Integration', () => {
  const masterKey = crypto.randomBytes(32);

  it('encrypts credentials binding workspaceId, connectionId, and version as AAD', () => {
    const workspaceId = 'ws_test_1';
    const connectionId = 'conn_liara_1';
    const version = 1;
    const rawSecret = JSON.stringify({ token: 'liara_api_secret_token_12345' });

    const envelope = encryptCredential(
      rawSecret,
      masterKey,
      { workspaceId, connectionId, version },
      1
    );

    expect(envelope.algorithm).toBe('aes-256-gcm');
    expect(envelope.workspaceId).toBe(workspaceId);
    expect(envelope.connectionId).toBe(connectionId);
    expect(envelope.version).toBe('1');
    expect(envelope.ciphertext).toBeDefined();
    expect(envelope.tag).toBeDefined();

    // Successful decryption with matching AAD context
    const decrypted = decryptCredential(envelope, masterKey, {
      workspaceId,
      connectionId,
      version,
    });
    expect(decrypted.toString('utf8')).toBe(rawSecret);
  });

  it('fails decryption if attempted with a different workspaceId (cross-tenant leak prevention)', () => {
    const rawSecret = JSON.stringify({ token: 'tenant_a_token' });
    const envelope = encryptCredential(
      rawSecret,
      masterKey,
      { workspaceId: 'ws_tenant_a', connectionId: 'conn_1', version: 1 }
    );

    // Cross-tenant attacker attempts to decrypt using tenant B's context
    expect(() => {
      decryptCredential(envelope, masterKey, {
        workspaceId: 'ws_tenant_b',
        connectionId: 'conn_1',
        version: 1,
      });
    }).toThrow();
  });
});
