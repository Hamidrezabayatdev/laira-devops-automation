import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  encryptCredential,
  decryptCredential,
  CredentialDecryptionError,
  CredentialEncryptionError,
  normalizeKey,
} from '../src/cipher.js';

describe('AES-256-GCM Credential Envelope with Contextual AAD', () => {
  const masterKey = crypto.randomBytes(32);
  const context = {
    workspaceId: 'ws_tenant_123',
    connectionId: 'conn_liara_abc',
    version: 1,
  };
  const secretPayload = 'super_secret_api_token_value_xyz';

  it('encrypts and decrypts successfully with matching key and AAD context', () => {
    const envelope = encryptCredential(secretPayload, masterKey, context);
    expect(envelope.algorithm).toBe('aes-256-gcm');
    expect(envelope.workspaceId).toBe(context.workspaceId);
    expect(envelope.connectionId).toBe(context.connectionId);
    expect(envelope.version).toBe('1');
    expect(envelope.ciphertext).toBeDefined();
    expect(envelope.tag).toBeDefined();
    expect(envelope.iv).toBeDefined();

    const decrypted = decryptCredential(envelope, masterKey, context);
    expect(decrypted.toString('utf8')).toBe(secretPayload);
  });

  it('fails decryption when ciphertext is tampered with', () => {
    const envelope = encryptCredential(secretPayload, masterKey, context);
    const cipherBuf = Buffer.from(envelope.ciphertext, 'base64');
    cipherBuf[0] ^= 0xff; // flip bits
    const tamperedEnvelope = { ...envelope, ciphertext: cipherBuf.toString('base64') };

    expect(() => decryptCredential(tamperedEnvelope, masterKey, context)).toThrow(
      CredentialDecryptionError
    );
  });

  it('fails decryption when auth tag is tampered with', () => {
    const envelope = encryptCredential(secretPayload, masterKey, context);
    const tagBuf = Buffer.from(envelope.tag, 'base64');
    tagBuf[0] ^= 0xff;
    const tamperedEnvelope = { ...envelope, tag: tagBuf.toString('base64') };

    expect(() => decryptCredential(tamperedEnvelope, masterKey, context)).toThrow(
      CredentialDecryptionError
    );
  });

  it('fails decryption when IV is tampered with', () => {
    const envelope = encryptCredential(secretPayload, masterKey, context);
    const ivBuf = Buffer.from(envelope.iv, 'base64');
    ivBuf[0] ^= 0xff;
    const tamperedEnvelope = { ...envelope, iv: ivBuf.toString('base64') };

    expect(() => decryptCredential(tamperedEnvelope, masterKey, context)).toThrow(
      CredentialDecryptionError
    );
  });

  it('fails decryption when workspaceId in AAD mismatches', () => {
    const envelope = encryptCredential(secretPayload, masterKey, context);
    const wrongContext = { ...context, workspaceId: 'ws_tenant_ATTACKER' };

    expect(() => decryptCredential(envelope, masterKey, wrongContext)).toThrow(
      /AAD mismatch: workspaceId does not match/
    );
  });

  it('fails decryption when connectionId in AAD mismatches', () => {
    const envelope = encryptCredential(secretPayload, masterKey, context);
    const wrongContext = { ...context, connectionId: 'conn_other_target' };

    expect(() => decryptCredential(envelope, masterKey, wrongContext)).toThrow(
      /AAD mismatch: connectionId does not match/
    );
  });

  it('fails decryption when version in AAD mismatches', () => {
    const envelope = encryptCredential(secretPayload, masterKey, context);
    const wrongContext = { ...context, version: 2 };

    expect(() => decryptCredential(envelope, masterKey, wrongContext)).toThrow(
      /AAD mismatch: version does not match/
    );
  });

  it('fails decryption when a different key is used', () => {
    const envelope = encryptCredential(secretPayload, masterKey, context);
    const differentKey = crypto.randomBytes(32);

    expect(() => decryptCredential(envelope, differentKey, context)).toThrow(
      CredentialDecryptionError
    );
  });

  it('fails decryption if envelope keyVersion metadata is tampered with', () => {
    const envelope = encryptCredential(secretPayload, masterKey, context, 1);
    expect(envelope.keyVersion).toBe(1);

    // Attacker tampers with keyVersion metadata in the envelope
    const tamperedEnvelope = { ...envelope, keyVersion: 2 };

    // Decryption MUST fail because keyVersion is authenticated in the AAD context
    expect(() => decryptCredential(tamperedEnvelope, masterKey, context)).toThrow(
      CredentialDecryptionError
    );
  });

  it('fails decryption when expectedContext keyVersion mismatches', () => {
    const envelope = encryptCredential(secretPayload, masterKey, context, 1);
    const wrongContext = { ...context, keyVersion: 2 };

    expect(() => decryptCredential(envelope, masterKey, wrongContext)).toThrow(
      /AAD mismatch: keyVersion does not match/
    );
  });

  it('supports base64url encoded 32-byte master key format', () => {
    const rawKey = crypto.randomBytes(32);
    const base64urlKey = rawKey.toString('base64url');

    const envelope = encryptCredential(secretPayload, base64urlKey, context);
    const decrypted = decryptCredential(envelope, base64urlKey, context);
    expect(decrypted.toString('utf8')).toBe(secretPayload);
  });

  it('rejects invalid key length', () => {
    const invalidKey = crypto.randomBytes(16); // 128-bit instead of 256-bit
    expect(() => normalizeKey(invalidKey)).toThrow(CredentialEncryptionError);
  });
});
