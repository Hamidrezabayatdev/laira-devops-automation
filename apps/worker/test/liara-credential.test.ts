import { describe, it, expect } from 'vitest';
import {
  parseLiaraDecryptedCredential,
  LiaraDecryptedCredentialSchema,
} from '../src/handlers/liara-credential.js';

describe('Liara Credential Parsing & Redaction Helper', () => {
  it('parses legacy bare string API token', () => {
    const raw = '  token-legacy-secret-12345  ';
    const result = parseLiaraDecryptedCredential(raw);

    expect(result.apiKey).toBe('token-legacy-secret-12345');
    expect(result.teamId).toBeUndefined();
    expect(result.sensitiveTokens).toEqual(['token-legacy-secret-12345']);
  });

  it('parses strict JSON credential with apiKey and teamId', () => {
    const jsonStr = JSON.stringify({
      apiKey: 'secret-api-key-abc',
      teamId: 'team-engineering-01',
    });
    const result = parseLiaraDecryptedCredential(jsonStr);

    expect(result.apiKey).toBe('secret-api-key-abc');
    expect(result.teamId).toBe('team-engineering-01');
    expect(result.sensitiveTokens).toContain(jsonStr);
    expect(result.sensitiveTokens).toContain('secret-api-key-abc');
  });

  it('parses strict JSON credential with only apiKey (teamId optional)', () => {
    const jsonStr = JSON.stringify({
      apiKey: 'secret-api-key-only',
    });
    const result = parseLiaraDecryptedCredential(jsonStr);

    expect(result.apiKey).toBe('secret-api-key-only');
    expect(result.teamId).toBeUndefined();
    expect(result.sensitiveTokens).toContain(jsonStr);
    expect(result.sensitiveTokens).toContain('secret-api-key-only');
  });

  it('rejects malformed JSON starting with {', () => {
    expect(() => parseLiaraDecryptedCredential('{ bad json')).toThrow();
  });

  it('rejects JSON with extra unrecognized properties (strict schema)', () => {
    const jsonStr = JSON.stringify({
      apiKey: 'key-123',
      extraProperty: 'forbidden',
    });
    expect(() => parseLiaraDecryptedCredential(jsonStr)).toThrow();
  });

  it('rejects JSON with empty apiKey', () => {
    const jsonStr = JSON.stringify({
      apiKey: '',
    });
    expect(() => parseLiaraDecryptedCredential(jsonStr)).toThrow();
  });

  it('rejects empty bare string', () => {
    expect(() => parseLiaraDecryptedCredential('')).toThrow();
    expect(() => parseLiaraDecryptedCredential('   ')).toThrow();
  });
});
