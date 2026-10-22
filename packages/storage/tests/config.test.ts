import { describe, it, expect } from 'vitest';
import { StorageConfig } from '../src/config.ts';
import { StorageConfigError } from '../src/errors.ts';

describe('StorageConfig Security & Enforceability', () => {
  it('accepts valid production HTTPS configuration', () => {
    const config = new StorageConfig({
      endpoint: 'https://storage.iran.liara.ir',
      bucket: 'my-prod-bucket',
      region: 'iran',
      credentials: {
        accessKeyId: 'test-access-key-id',
        secretAccessKey: 'test-secret-access-key',
      },
    });

    expect(config.endpoint).toBe('https://storage.iran.liara.ir');
    expect(config.bucket).toBe('my-prod-bucket');
    expect(config.region).toBe('iran');
    expect(config.localDevelopment).toBe(false);
    expect(config.forcePathStyle).toBe(true);
  });

  it('rejects HTTP endpoint in production (when localDevelopment is false)', () => {
    expect(() => {
      new StorageConfig({
        endpoint: 'http://localhost:9000',
        bucket: 'my-prod-bucket',
        credentials: {
          accessKeyId: 'test-key',
          secretAccessKey: 'test-secret',
        },
        localDevelopment: false,
      });
    }).toThrow(StorageConfigError);
  });

  it('rejects non-localhost HTTP endpoint even when localDevelopment is true', () => {
    expect(() => {
      new StorageConfig({
        endpoint: 'http://storage.liara.ir',
        bucket: 'my-bucket',
        credentials: {
          accessKeyId: 'test-key',
          secretAccessKey: 'test-secret',
        },
        localDevelopment: true,
      });
    }).toThrow(StorageConfigError);
  });

  it('allows localhost HTTP endpoint when localDevelopment is explicitly true', () => {
    const config = new StorageConfig({
      endpoint: 'http://127.0.0.1:59000',
      bucket: 'local-test-bucket',
      credentials: {
        accessKeyId: 'minio-user',
        secretAccessKey: 'minio-password',
      },
      localDevelopment: true,
    });

    expect(config.endpoint).toBe('http://127.0.0.1:59000');
    expect(config.localDevelopment).toBe(true);
  });

  it('ensures credentials are NOT publicly enumerable or exposed via Object.keys()', () => {
    const config = new StorageConfig({
      endpoint: 'https://storage.iran.liara.ir',
      bucket: 'my-prod-bucket',
      credentials: {
        accessKeyId: 'my-super-secret-access-key',
        secretAccessKey: 'my-ultra-secret-key-12345',
      },
    });

    const keys = Object.keys(config);
    expect(keys).not.toContain('credentials');
    expect(keys).not.toContain('accessKeyId');
    expect(keys).not.toContain('secretAccessKey');

    // for..in loop must not iterate over credentials
    const iterated: string[] = [];
    for (const k in config) {
      iterated.push(k);
    }
    expect(iterated).not.toContain('credentials');
    expect(iterated).not.toContain('secretAccessKey');
  });

  it('redacts credentials in toJSON() serialization', () => {
    const config = new StorageConfig({
      endpoint: 'https://storage.iran.liara.ir',
      bucket: 'my-prod-bucket',
      credentials: {
        accessKeyId: 'real-access-key',
        secretAccessKey: 'real-secret-key-67890',
      },
    });

    const json = JSON.stringify(config);
    expect(json).not.toContain('real-secret-key-67890');
    expect(json).not.toContain('real-access-key');

    const parsed = JSON.parse(json);
    expect(parsed.credentials.accessKeyId).toBe('[REDACTED]');
    expect(parsed.credentials.secretAccessKey).toBe('[REDACTED]');
  });

  it('validates bucket name format according to S3 standards', () => {
    expect(() => {
      new StorageConfig({
        endpoint: 'https://storage.iran.liara.ir',
        bucket: 'INVALID_UPPERCASE_BUCKET',
        credentials: {
          accessKeyId: 'key',
          secretAccessKey: 'secret',
        },
      });
    }).toThrow(StorageConfigError);
  });
});
