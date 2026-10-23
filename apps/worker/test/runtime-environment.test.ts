import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import {
  importRuntimeEnvironment,
  resolveRuntimeEnvironment,
  validateRuntimeEnvironmentVariables,
  validateConnectionName,
  RESERVED_VARIABLE_KEYS,
  MAX_VARIABLES_COUNT,
  MAX_VARIABLES_TOTAL_BYTES,
  type RuntimeEnvironmentRef,
} from '../src/runtime-environment.js';
import { encryptCredential } from '@laira/security';

describe('Deployment Runtime Environment Secrets Module', () => {
  const masterKey = crypto.randomBytes(32);
  const workspaceId = 'ws_prod_app_01';

  describe('1. Exported Validators for CLI & Import', () => {
    it('validates connection name correctly', () => {
      expect(validateConnectionName('production-env')).toBe('production-env');
      expect(validateConnectionName('  staging_env.v2  ')).toBe('staging_env.v2');
      expect(validateConnectionName('App 1 Environment')).toBe('App 1 Environment');

      expect(() => validateConnectionName('')).toThrow('Connection name cannot be empty');
      expect(() => validateConnectionName('   ')).toThrow('Connection name cannot be empty');
      expect(() => validateConnectionName(123)).toThrow('Connection name must be a string');
      expect(() => validateConnectionName('a'.repeat(129))).toThrow('Connection name exceeds maximum length of 128 characters');
      expect(() => validateConnectionName('evil;drop table;')).toThrow('Connection name contains invalid characters');
    });

    it('validates compliant environment variables', () => {
      const vars = {
        NODE_ENV: 'production',
        PORT: '8080',
        DATABASE_URL: 'postgres://app:pwd@localhost:5432/db',
        API_KEY: 'secret-token-value',
      };
      const result = validateRuntimeEnvironmentVariables(vars);
      expect(result).toEqual(vars);
    });

    it('enforces descriptor safety and prevents getter execution', () => {
      let getterCalled = false;
      const objectWithGetter = {
        get TRAP_KEY() {
          getterCalled = true;
          throw new Error('Getter execution detected!');
        },
      };

      expect(() => validateRuntimeEnvironmentVariables(objectWithGetter)).toThrow(
        'Property accessors (getters/setters) are not permitted on runtime environment variables'
      );
      // Ensure the getter was NEVER invoked
      expect(getterCalled).toBe(false);

      const objectWithSetter = {};
      Object.defineProperty(objectWithSetter, 'VAR_SET', {
        set() {},
        enumerable: true,
        configurable: true,
      });
      expect(() => validateRuntimeEnvironmentVariables(objectWithSetter)).toThrow(
        'Property accessors (getters/setters) are not permitted on runtime environment variables'
      );

      const objectWithSymbol = {
        [Symbol('evil')]: 'val',
        VAR_A: 'val',
      };
      expect(() => validateRuntimeEnvironmentVariables(objectWithSymbol)).toThrow(
        'Symbol properties are not permitted on runtime environment variables'
      );

      const objectWithNonEnumerable = {};
      Object.defineProperty(objectWithNonEnumerable, 'HIDDEN', {
        value: 'hidden_val',
        enumerable: false,
        configurable: true,
      });
      expect(() => validateRuntimeEnvironmentVariables(objectWithNonEnumerable)).toThrow(
        'Non-enumerable properties are not permitted on runtime environment variables'
      );
    });

    it('rejects reserved injection keys: NODE_OPTIONS, LD_PRELOAD, LD_LIBRARY_PATH', () => {
      for (const reserved of RESERVED_VARIABLE_KEYS) {
        expect(() =>
          validateRuntimeEnvironmentVariables({
            [reserved]: '--inspect=0.0.0.0:9229',
          })
        ).toThrow('Runtime environment variable key is reserved');
      }
    });

    it('enforces key regex ^[A-Z][A-Z0-9_]{0,127}$', () => {
      // Valid keys
      expect(validateRuntimeEnvironmentVariables({ A: '1' })).toEqual({ A: '1' });
      expect(validateRuntimeEnvironmentVariables({ [ 'A'.repeat(128) ]: '1' }))
        .toHaveProperty('A'.repeat(128));

      // Invalid keys: lowercase, starting with number or underscore, illegal characters
      expect(() => validateRuntimeEnvironmentVariables({ lower_case: 'val' })).toThrow(
        'Runtime environment variable key violates required format'
      );
      expect(() => validateRuntimeEnvironmentVariables({ '1START_NUM': 'val' })).toThrow(
        'Runtime environment variable key violates required format'
      );
      expect(() => validateRuntimeEnvironmentVariables({ _START_UNDERSCORE: 'val' })).toThrow(
        'Runtime environment variable key violates required format'
      );
      expect(() => validateRuntimeEnvironmentVariables({ 'KE-Y': 'val' })).toThrow(
        'Runtime environment variable key violates required format'
      );
      expect(() => validateRuntimeEnvironmentVariables({ 'KEY.NAME': 'val' })).toThrow(
        'Runtime environment variable key violates required format'
      );
      expect(() => validateRuntimeEnvironmentVariables({ [ 'A'.repeat(129) ]: 'val' })).toThrow(
        'Runtime environment variable key violates required format'
      );
    });

    it('enforces non-string value rejection', () => {
      expect(() => validateRuntimeEnvironmentVariables({ KEY: 123 as any })).toThrow(
        'Runtime environment variable value must be a string'
      );
      expect(() => validateRuntimeEnvironmentVariables({ KEY: true as any })).toThrow(
        'Runtime environment variable value must be a string'
      );
      expect(() => validateRuntimeEnvironmentVariables({ KEY: null as any })).toThrow(
        'Runtime environment variable value must be a string'
      );
      expect(() => validateRuntimeEnvironmentVariables({ KEY: ['arr'] as any })).toThrow(
        'Runtime environment variable value must be a string'
      );
      expect(() => validateRuntimeEnvironmentVariables({ KEY: { obj: true } as any })).toThrow(
        'Runtime environment variable value must be a string'
      );
    });

    it('enforces count <= 40 and handles empty validation option', () => {
      // Rejects empty by default
      expect(() => validateRuntimeEnvironmentVariables({})).toThrow(
        'Runtime environment variables cannot be empty unless explicitly allowed'
      );

      // Allows empty when explicitly requested
      expect(validateRuntimeEnvironmentVariables({}, { allowEmpty: true })).toEqual({});

      // Exactly 40 keys is permitted
      const maxVars: Record<string, string> = {};
      for (let i = 0; i < MAX_VARIABLES_COUNT; i++) {
        maxVars[`VAR_${i}`] = `value_${i}`;
      }
      expect(Object.keys(validateRuntimeEnvironmentVariables(maxVars)).length).toBe(40);

      // 41 keys is rejected
      maxVars['VAR_EXTRA'] = 'overflow';
      expect(() => validateRuntimeEnvironmentVariables(maxVars)).toThrow(
        'Runtime environment variables count exceeds maximum limit of 40'
      );
    });

    it('enforces total byte limit <= 32 KiB (32768 bytes)', () => {
      const largeValue = 'x'.repeat(32000);
      expect(() =>
        validateRuntimeEnvironmentVariables({
          KEY: largeValue,
        })
      ).not.toThrow();

      const excessiveValue = 'x'.repeat(32769);
      expect(() =>
        validateRuntimeEnvironmentVariables({
          KEY: excessiveValue,
        })
      ).toThrow('Runtime environment total size exceeds maximum limit of 32768 bytes');
    });

    it('guarantees static errors that never leak secret values or malformed keys', () => {
      const superSecret = 'SUPER_SECRET_LEAKABLE_TOKEN_VALUE_XYZ';
      const malformedKey = 'bad_key_secret';

      try {
        validateRuntimeEnvironmentVariables({ [malformedKey]: superSecret });
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.message).not.toContain(superSecret);
        expect(err.message).not.toContain(malformedKey);
      }

      try {
        validateRuntimeEnvironmentVariables({ SECRET_KEY: 99999 as any });
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.message).not.toContain('SECRET_KEY');
        expect(err.message).not.toContain('99999');
      }
    });
  });

  describe('2. importRuntimeEnvironment', () => {
    function createMockPool() {
      const connectionStore = new Map<string, any>();
      const credentialStore = new Map<string, any>();
      const queries: { sql: string; values?: any[] }[] = [];

      const client = {
        query: async (rawSql: string, values?: any[]) => {
          const sql = rawSql.replace(/\s+/g, ' ').trim();
          queries.push({ sql, values });

          // Transaction statements
          if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) {
            return { rows: [] };
          }

          // Advisory transaction lock
          if (sql.includes('SELECT pg_advisory_xact_lock($1::bigint)')) {
            return { rows: [] };
          }

          // Check no-overwrite: app.connections by workspace_id and name
          if (sql.includes('SELECT id FROM app.connections WHERE workspace_id = $1 AND name = $2')) {
            const [wsId, name] = values || [];
            const found = Array.from(connectionStore.values()).find(
              (c) => c.workspace_id === wsId && c.name === name
            );
            return { rows: found ? [{ id: found.id }] : [] };
          }

          // SELECT * FROM app.connections (getConnection)
          if (sql.includes('SELECT * FROM app.connections WHERE id = $1 AND workspace_id = $2')) {
            const [connId, wsId] = values || [];
            const found = connectionStore.get(`${wsId}:${connId}`);
            return { rows: found ? [found] : [] };
          }

          // INSERT INTO app.connections
          if (sql.includes('INSERT INTO app.connections')) {
            const [id, wsId, name, provider] = values || [];
            const row = {
              id,
              workspace_id: wsId,
              name,
              provider,
              status: 'active',
              active_version: 1,
              created_at: new Date(),
              updated_at: new Date(),
            };
            connectionStore.set(`${wsId}:${id}`, row);
            return { rows: [row] };
          }

          // INSERT INTO app.connection_credential_versions
          if (sql.includes('INSERT INTO app.connection_credential_versions')) {
            const [id, wsId, connId, version, algorithm, ciphertext, iv, tag, keyVersion] = values || [];
            const row = {
              id,
              workspace_id: wsId,
              connection_id: connId,
              version,
              algorithm,
              ciphertext,
              iv,
              tag,
              key_version: keyVersion,
              created_at: new Date(),
            };
            credentialStore.set(`${wsId}:${connId}:${version}`, row);
            return { rows: [row] };
          }

          // UPDATE app.connections SET active_version = $1
          if (sql.includes('UPDATE app.connections') && sql.includes('SET active_version = $1')) {
            const [ver, connId, wsId] = values || [];
            const existing = connectionStore.get(`${wsId}:${connId}`);
            if (existing) {
              existing.active_version = ver;
            }
            return { rows: [] };
          }

          // SELECT * FROM app.connection_credential_versions
          if (sql.includes('SELECT id, workspace_id, connection_id, version, algorithm, ciphertext, iv, tag, key_version FROM app.connection_credential_versions')) {
            const [wsId, connId, version] = values || [];
            const found = credentialStore.get(`${wsId}:${connId}:${version}`);
            return { rows: found ? [found] : [] };
          }

          // Fallback
          return { rows: [] };
        },
        release: () => {},
      };

      const pool = {
        connect: async () => client,
        query: client.query,
        connectionStore,
        credentialStore,
        queries,
      };

      return { pool, client, connectionStore, credentialStore, queries };
    }

    it('imports runtime environment secrets atomically inside transaction with concurrency lock', async () => {
      const { pool, connectionStore, credentialStore, queries } = createMockPool();
      const variables = {
        DATABASE_URL: 'postgres://app:pwd@host:5432/app',
        JWT_SECRET: 'jwt-super-secret-32-chars-long!',
        APP_PORT: '3000',
      };

      const res = await importRuntimeEnvironment(
        pool as any,
        workspaceId,
        masterKey,
        variables,
        'prod-secrets'
      );

      expect(res.connectionId).toMatch(/^conn_/);
      expect(res.credentialVersion).toBe(1);
      // Keys must be returned sorted alphabetically
      expect(res.keys).toEqual(['APP_PORT', 'DATABASE_URL', 'JWT_SECRET']);

      // Never returns secret values in output reference
      expect((res as any).variables).toBeUndefined();
      expect((res as any).DATABASE_URL).toBeUndefined();

      // Transaction and advisory concurrency lock verification
      expect(queries.some((q) => q.sql === 'BEGIN')).toBe(true);
      expect(queries.some((q) => q.sql.includes('pg_advisory_xact_lock'))).toBe(true);
      expect(queries.some((q) => q.sql === 'COMMIT')).toBe(true);

      // Verify DB records
      const savedConn = connectionStore.get(`${workspaceId}:${res.connectionId}`);
      expect(savedConn).toBeDefined();
      expect(savedConn.provider).toBe('deployment_env');
      expect(savedConn.status).toBe('active');
      expect(savedConn.name).toBe('prod-secrets');

      const savedCred = credentialStore.get(`${workspaceId}:${res.connectionId}:1`);
      expect(savedCred).toBeDefined();
      expect(savedCred.algorithm).toBe('aes-256-gcm');
      expect(savedCred.ciphertext).toBeDefined();
      // Ciphertext does not expose plaintext
      expect(savedCred.ciphertext).not.toContain('jwt-super-secret');
    });

    it('refuses to overwrite existing connection with same name in workspace', async () => {
      const { pool } = createMockPool();

      await importRuntimeEnvironment(
        pool as any,
        workspaceId,
        masterKey,
        { KEY: 'val1' },
        'duplicate-name'
      );

      await expect(
        importRuntimeEnvironment(
          pool as any,
          workspaceId,
          masterKey,
          { KEY: 'val2' },
          'duplicate-name'
        )
      ).rejects.toThrow('Connection with this name already exists in workspace. Refusing to overwrite.');
    });

    it('rolls back transaction on encryption failure or database failure', async () => {
      const { pool, queries } = createMockPool();
      const invalidMasterKey = 'not-a-32-byte-key';

      await expect(
        importRuntimeEnvironment(
          pool as any,
          workspaceId,
          invalidMasterKey,
          { KEY: 'val' },
          'fail-tx'
        )
      ).rejects.toThrow();

      expect(queries.some((q) => q.sql === 'BEGIN')).toBe(true);
      expect(queries.some((q) => q.sql === 'ROLLBACK')).toBe(true);
    });

    it('wraps unknown raw database errors in a static AppError without leaking query or payload values', async () => {
      const failingClient = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql === 'BEGIN') return { rows: [] };
          if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
          if (sql.includes('SELECT id FROM app.connections')) return { rows: [] };
          // Simulate database driver error containing raw SQL or sensitive payload snippets
          throw new Error('Database error with internal details: insert into app.connections values (RAW_SECRET)');
        }),
        release: vi.fn(),
      };
      const failingPool = {
        connect: async () => failingClient,
      };

      try {
        await importRuntimeEnvironment(
          failingPool as any,
          workspaceId,
          masterKey,
          { SECRET: 'super_secret' },
          'failing-env'
        );
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.message).toBe('Failed to import runtime environment');
        expect(err.message).not.toContain('RAW_SECRET');
        expect(err.message).not.toContain('super_secret');
      }
    });
  });

  describe('3. resolveRuntimeEnvironment', () => {
    function setupStoredConnection(options: {
      provider?: string;
      status?: string;
      activeVersion?: number;
      credVersion?: number;
      algorithm?: string;
      keyVersion?: any;
      omitKeyVersion?: boolean;
      useKeyVersionAliasOnly?: boolean;
      payload?: string;
      tamperedAad?: boolean;
      dbErrorOnQuery?: boolean;
    } = {}) {
      const connId = `conn_test_${crypto.randomUUID().replace(/-/g, '')}`;
      const provider = options.provider ?? 'deployment_env';
      const status = options.status ?? 'active';
      const activeVersion = options.activeVersion ?? 1;
      const credVersion = options.credVersion ?? 1;
      const algorithm = options.algorithm ?? 'aes-256-gcm';
      const effectiveKeyVersion = options.keyVersion === undefined && !options.omitKeyVersion ? 1 : options.keyVersion;
      const payload = options.payload ?? JSON.stringify({
        variables: {
          PORT: '8080',
          DATABASE_URL: 'postgres://app:pwd@localhost:5432/db',
          API_KEY: 'top-secret',
        },
      });

      const effectiveWsId = options.tamperedAad ? 'ws_wrong_tenant' : workspaceId;
      const envelope = encryptCredential(
        payload,
        masterKey,
        {
          workspaceId: effectiveWsId,
          connectionId: connId,
          version: credVersion,
          keyVersion: 1,
        },
        1
      );

      const fakeClient = {
        query: async (rawSql: string, values?: any[]) => {
          const sql = rawSql.replace(/\s+/g, ' ').trim();

          if (options.dbErrorOnQuery) {
            throw new Error('Postgres connection reset with internal secret buffer 0xDEADBEEF');
          }

          if (sql.includes('FROM app.connections WHERE id = $1 AND workspace_id = $2')) {
            const [cId, wId] = values || [];
            if (cId === connId && wId === workspaceId) {
              return {
                rows: [
                  {
                    id: connId,
                    workspace_id: workspaceId,
                    name: 'test-env',
                    provider,
                    status,
                    active_version: activeVersion,
                  },
                ],
              };
            }
            return { rows: [] };
          }

          if (sql.includes('FROM app.connection_credential_versions WHERE workspace_id = $1 AND connection_id = $2 AND version = $3')) {
            const [wId, cId, ver] = values || [];
            if (wId === workspaceId && cId === connId && ver === credVersion) {
              const row: any = {
                id: `cred_${cId}_${ver}`,
                workspace_id: workspaceId,
                connection_id: connId,
                version: credVersion,
                algorithm,
                ciphertext: envelope.ciphertext,
                iv: envelope.iv,
                tag: envelope.tag,
              };

              if (options.useKeyVersionAliasOnly) {
                row.keyVersion = 1;
                // key_version column is deliberately missing in row
              } else if (!options.omitKeyVersion) {
                row.key_version = effectiveKeyVersion;
              }

              return { rows: [row] };
            }
            return { rows: [] };
          }

          return { rows: [] };
        },
        release: () => {},
      };

      const fakePool = {
        connect: async () => fakeClient,
        query: fakeClient.query,
      };

      const ref: RuntimeEnvironmentRef = {
        connectionId: connId,
        credentialVersion: credVersion,
      };

      return { fakePool, ref, connId };
    }

    it('resolves decrypted secrets returning Array<{key, value}> sorted by key', async () => {
      const { fakePool, ref } = setupStoredConnection();

      const result = await resolveRuntimeEnvironment(
        fakePool as any,
        workspaceId,
        masterKey,
        ref
      );

      expect(result).toEqual([
        { key: 'API_KEY', value: 'top-secret' },
        { key: 'DATABASE_URL', value: 'postgres://app:pwd@localhost:5432/db' },
        { key: 'PORT', value: '8080' },
      ]);
      expect(result[0].key).toBe('API_KEY');
      expect(result[1].key).toBe('DATABASE_URL');
      expect(result[2].key).toBe('PORT');
    });

    it('allows resolution for both active and configured_unverified status', async () => {
      const { fakePool, ref } = setupStoredConnection({ status: 'configured_unverified' });

      const result = await resolveRuntimeEnvironment(
        fakePool as any,
        workspaceId,
        masterKey,
        ref
      );
      expect(result.length).toBe(3);
    });

    it('rejects connection if provider is not deployment_env', async () => {
      const { fakePool, ref } = setupStoredConnection({ provider: 'liara' });

      await expect(
        resolveRuntimeEnvironment(fakePool as any, workspaceId, masterKey, ref)
      ).rejects.toThrow('Connection provider must be "deployment_env"');
    });

    it('rejects connection if status is not eligible (e.g. revoked or disabled)', async () => {
      const { fakePool, ref } = setupStoredConnection({ status: 'revoked' });

      await expect(
        resolveRuntimeEnvironment(fakePool as any, workspaceId, masterKey, ref)
      ).rejects.toThrow('Connection status is not eligible for resolution');
    });

    it('rejects if credentialVersion does not match active connection version (drift)', async () => {
      const { fakePool, ref } = setupStoredConnection({ activeVersion: 2, credVersion: 1 });

      await expect(
        resolveRuntimeEnvironment(fakePool as any, workspaceId, masterKey, ref)
      ).rejects.toThrow('Credential version does not match active connection version');
    });

    it('rejects unsupported encryption algorithm', async () => {
      const { fakePool, ref } = setupStoredConnection({ algorithm: 'chacha20-poly1305' });

      await expect(
        resolveRuntimeEnvironment(fakePool as any, workspaceId, masterKey, ref)
      ).rejects.toThrow('Unsupported encryption algorithm');
    });

    it('strictly requires cred.key_version === 1 numeric: rejects missing, null, alias, or non-1 key versions', async () => {
      // 1. Missing key_version (undefined)
      const { fakePool: missingPool, ref: missingRef } = setupStoredConnection({ omitKeyVersion: true });
      await expect(
        resolveRuntimeEnvironment(missingPool as any, workspaceId, masterKey, missingRef)
      ).rejects.toThrow('Unsupported key version');

      // 2. Null key_version
      const { fakePool: nullPool, ref: nullRef } = setupStoredConnection({ keyVersion: null });
      await expect(
        resolveRuntimeEnvironment(nullPool as any, workspaceId, masterKey, nullRef)
      ).rejects.toThrow('Unsupported key version');

      // 3. String '1' key_version (non-numeric)
      const { fakePool: strPool, ref: strRef } = setupStoredConnection({ keyVersion: '1' as any });
      await expect(
        resolveRuntimeEnvironment(strPool as any, workspaceId, masterKey, strRef)
      ).rejects.toThrow('Unsupported key version');

      // 4. Numeric key_version = 2
      const { fakePool: v2Pool, ref: v2Ref } = setupStoredConnection({ keyVersion: 2 });
      await expect(
        resolveRuntimeEnvironment(v2Pool as any, workspaceId, masterKey, v2Ref)
      ).rejects.toThrow('Unsupported key version');

      // 5. Using keyVersion camelCase alias only (must not fail-open)
      const { fakePool: aliasPool, ref: aliasRef } = setupStoredConnection({ useKeyVersionAliasOnly: true });
      await expect(
        resolveRuntimeEnvironment(aliasPool as any, workspaceId, masterKey, aliasRef)
      ).rejects.toThrow('Unsupported key version');
    });

    it('fails closed when cross-tenant / AAD tampering occurs without leaking data', async () => {
      const { fakePool, ref } = setupStoredConnection({ tamperedAad: true });

      await expect(
        resolveRuntimeEnvironment(fakePool as any, workspaceId, masterKey, ref)
      ).rejects.toThrow('Failed to decrypt runtime environment credentials');
    });

    it('enforces strict bounded schema on decrypted payload: rejects unexpected extra fields', async () => {
      const { fakePool, ref } = setupStoredConnection({
        payload: JSON.stringify({
          variables: { PORT: '3000' },
          maliciousInjection: 'extra-field',
        }),
      });

      await expect(
        resolveRuntimeEnvironment(fakePool as any, workspaceId, masterKey, ref)
      ).rejects.toThrow('Decrypted runtime environment payload contains unexpected properties');
    });

    it('enforces strict bounded schema: rejects decrypted payload containing reserved or illegal keys', async () => {
      const { fakePool, ref } = setupStoredConnection({
        payload: JSON.stringify({
          variables: { NODE_OPTIONS: '--inspect=0.0.0.0:9229' },
        }),
      });

      await expect(
        resolveRuntimeEnvironment(fakePool as any, workspaceId, masterKey, ref)
      ).rejects.toThrow('Decrypted runtime environment variables failed schema validation');
    });

    it('enforces static error messages on decryption/parsing failure: never leaks values or keys', async () => {
      const leakedSecret = 'SUPER_SECRET_PAYLOAD_TOKEN';
      const { fakePool, ref } = setupStoredConnection({
        payload: `{ "variables": { "INVALID_KEY_lowercase": "${leakedSecret}" } }`,
      });

      try {
        await resolveRuntimeEnvironment(fakePool as any, workspaceId, masterKey, ref);
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.message).not.toContain(leakedSecret);
        expect(err.message).not.toContain('INVALID_KEY_lowercase');
      }
    });

    it('wraps unknown raw database errors in resolve with a static error', async () => {
      const { fakePool, ref } = setupStoredConnection({ dbErrorOnQuery: true });

      try {
        await resolveRuntimeEnvironment(fakePool as any, workspaceId, masterKey, ref);
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.message).toBe('Failed to resolve runtime environment');
        expect(err.message).not.toContain('0xDEADBEEF');
      }
    });
  });
});
