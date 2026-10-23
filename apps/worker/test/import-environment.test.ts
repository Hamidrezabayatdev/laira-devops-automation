import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  readSelectedEnvironment,
  executeImportEnvironmentCommand,
  MAX_ENV_FILE_BYTES,
} from '../src/cli/import-environment.js';
import type { OperatorCliDependencies } from '../src/cli/types.js';

describe('Operator Local Environment Import CLI & Vault Integration', () => {
  let tmpDir: string;
  const masterKey = crypto.randomBytes(32).toString('base64url');
  const demoOperatorId = '152868728';

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laira-env-test-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createMockFetch(userData = { id: 152868728, login: 'demo-operator', name: 'Demo Operator' }) {
    return vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(userData), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
  }

  function createMockPool() {
    const userStore = new Map<string, any>();
    const workspaceStore = new Map<string, any>();
    const connectionStore = new Map<string, any>();
    const credentialStore = new Map<string, any>();
    const queries: { sql: string; values?: any[] }[] = [];

    const client = {
      query: async (rawSql: string, values?: any[]) => {
        const sql = rawSql.replace(/\s+/g, ' ').trim();
        queries.push({ sql, values });

        if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) {
          return { rows: [] };
        }

        if (sql.includes('pg_advisory_xact_lock')) {
          return { rows: [] };
        }

        // Users lookup / upsert
        if (sql.includes('FROM app.users WHERE id = $1')) {
          const [id] = values || [];
          const u = userStore.get(id);
          return { rows: u ? [u] : [] };
        }

        if (sql.includes('INSERT INTO app.users')) {
          const [id, name, email, image] = values || [];
          const row = { id, name, email, image, created_at: new Date(), updated_at: new Date() };
          userStore.set(id, row);
          return { rows: [row] };
        }

        // Workspaces lookup / upsert
        if (sql.includes('FROM app.workspaces WHERE github_user_id = $1')) {
          const [ghId] = values || [];
          const found = Array.from(workspaceStore.values()).find((w) => w.github_user_id === ghId);
          return { rows: found ? [found] : [] };
        }

        if (sql.includes('INSERT INTO app.workspaces')) {
          const [id, name, slug, ownerId, ghId] = values || [];
          const row = {
            id,
            name,
            slug,
            owner_user_id: ownerId,
            github_user_id: ghId,
            created_at: new Date(),
            updated_at: new Date(),
          };
          workspaceStore.set(id, row);
          return { rows: [row] };
        }

        // Check connection uniqueness by workspace and name
        if (sql.includes('SELECT id FROM app.connections WHERE workspace_id = $1 AND name = $2')) {
          const [wsId, name] = values || [];
          const found = Array.from(connectionStore.values()).find(
            (c) => c.workspace_id === wsId && c.name === name
          );
          return { rows: found ? [{ id: found.id }] : [] };
        }

        // Connections lookup
        if (sql.includes('SELECT * FROM app.connections WHERE id = $1 AND workspace_id = $2')) {
          const [connId, wsId] = values || [];
          const found = connectionStore.get(`${wsId}:${connId}`);
          return { rows: found ? [found] : [] };
        }

        // Insert connection
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

        // Insert credential version
        if (sql.includes('INSERT INTO app.connection_credential_versions')) {
          const [id, wsId, connId, ver, alg, ciphertext, iv, tag, keyVer] = values || [];
          const row = {
            id,
            workspace_id: wsId,
            connection_id: connId,
            version: ver,
            algorithm: alg,
            ciphertext,
            iv,
            tag,
            key_version: keyVer,
            created_at: new Date(),
          };
          credentialStore.set(`${wsId}:${connId}:${ver}`, row);
          return { rows: [row] };
        }

        // Update active version
        if (sql.includes('UPDATE app.connections') && sql.includes('SET active_version = $1')) {
          const [ver, connId, wsId] = values || [];
          const found = connectionStore.get(`${wsId}:${connId}`);
          if (found) {
            found.active_version = ver;
          }
          return { rows: [] };
        }

        return { rows: [] };
      },
      release: () => {},
    };

    const pool = {
      connect: async () => client,
      query: client.query,
      end: async () => {},
      connectionStore,
      credentialStore,
      queries,
    };

    return { pool, client, connectionStore, credentialStore, queries };
  }

  describe('1. Pure Helper: readSelectedEnvironment', () => {
    it('reads and parses valid env file picking strictly allowlisted keys (no auto-all)', async () => {
      const filePath = path.join(tmpDir, 'valid.env');
      fs.writeFileSync(
        filePath,
        `
# Application environment configuration
DATABASE_URL=postgres://app:pwd@localhost:5432/app_db
PORT=8080
UNWANTED_SECRET=should-never-be-imported
ANOTHER_KEY=ignore-me
        `.trim(),
        'utf8'
      );

      const result = await readSelectedEnvironment(filePath, 'PORT,DATABASE_URL');

      expect(result).toEqual({
        PORT: '8080',
        DATABASE_URL: 'postgres://app:pwd@localhost:5432/app_db',
      });
      // Guarantees unwanted keys in the file are NEVER included
      expect(result).not.toHaveProperty('UNWANTED_SECRET');
      expect(result).not.toHaveProperty('ANOTHER_KEY');
    });

    it('accepts allowlisted keys as array as well as comma-separated string', async () => {
      const filePath = path.join(tmpDir, 'array_keys.env');
      fs.writeFileSync(filePath, 'FOO=bar\nBAZ=qux\n', 'utf8');

      const result = await readSelectedEnvironment(filePath, ['FOO', 'BAZ']);
      expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
    });

    it('rejects with static error when allowlisted key is missing from env file', async () => {
      const filePath = path.join(tmpDir, 'missing.env');
      fs.writeFileSync(filePath, 'PORT=3000\n', 'utf8');

      await expect(
        readSelectedEnvironment(filePath, 'PORT,MISSING_DATABASE_URL')
      ).rejects.toThrow('Missing allowlisted environment variable in file');
    });

    it('rejects empty allowlist with static error', async () => {
      const filePath = path.join(tmpDir, 'any.env');
      fs.writeFileSync(filePath, 'FOO=bar\n', 'utf8');

      await expect(readSelectedEnvironment(filePath, '')).rejects.toThrow(
        'No environment variable keys specified in allowlist'
      );
      await expect(readSelectedEnvironment(filePath, ' ,  , ')).rejects.toThrow(
        'No environment variable keys specified in allowlist'
      );
      await expect(readSelectedEnvironment(filePath, [])).rejects.toThrow(
        'No environment variable keys specified in allowlist'
      );
    });

    it('refuses symlink via O_NOFOLLOW with static error (no path/contents leaked)', async () => {
      const targetPath = path.join(tmpDir, 'real_target.env');
      const symlinkPath = path.join(tmpDir, 'symlink_trap.env');
      fs.writeFileSync(targetPath, 'API_KEY=secret_val\n', 'utf8');

      try {
        fs.symlinkSync(targetPath, symlinkPath);
      } catch {
        // Skip if environment doesn't allow symlink creation
        return;
      }

      try {
        await readSelectedEnvironment(symlinkPath, 'API_KEY');
        expect.unreachable('Should have rejected symlink');
      } catch (err: any) {
        expect(err.message).toBe('Failed to read environment file: symlinks are not permitted');
        expect(err.message).not.toContain(symlinkPath);
        expect(err.message).not.toContain(targetPath);
        expect(err.message).not.toContain('secret_val');
      }
    });

    it('refuses directory / non-regular files with static error', async () => {
      await expect(
        readSelectedEnvironment(tmpDir, 'ANY_KEY')
      ).rejects.toThrow('Failed to read environment file: not a regular file');
    });

    it('rejects files exceeding 64 KiB bound with static error', async () => {
      const filePath = path.join(tmpDir, 'oversized.env');
      const oversizedContent = 'VAR=' + 'a'.repeat(MAX_ENV_FILE_BYTES + 10) + '\n';
      fs.writeFileSync(filePath, oversizedContent, 'utf8');

      await expect(
        readSelectedEnvironment(filePath, 'VAR')
      ).rejects.toThrow('Failed to read environment file: file exceeds maximum size of 64 KiB');
    });

    it('rejects reserved injection keys (NODE_OPTIONS, LD_PRELOAD, LD_LIBRARY_PATH) via vault validation', async () => {
      const filePath = path.join(tmpDir, 'reserved.env');
      fs.writeFileSync(filePath, 'NODE_OPTIONS=--inspect=0.0.0.0:9229\nPORT=3000\n', 'utf8');

      await expect(
        readSelectedEnvironment(filePath, 'PORT,NODE_OPTIONS')
      ).rejects.toThrow('Runtime environment variable key is reserved');
    });

    it('guarantees static errors that never leak file paths or raw file contents', async () => {
      const superSecretContent = 'RAW_SECRET_PASSWORD_DO_NOT_LEAK_12345';
      const filePath = path.join(tmpDir, 'secret.env');
      fs.writeFileSync(filePath, `invalid-key=${superSecretContent}\n`, 'utf8');

      try {
        await readSelectedEnvironment(filePath, 'invalid-key');
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.message).not.toContain(filePath);
        expect(err.message).not.toContain(superSecretContent);
        expect(err.message).not.toContain('invalid-key');
      }
    });
  });

  describe('2. CLI Command: executeImportEnvironmentCommand', () => {
    it('executes full operator import flow and outputs reference JSON without values or path', async () => {
      const filePath = path.join(tmpDir, 'prod.env');
      fs.writeFileSync(
        filePath,
        'DATABASE_URL=postgres://app:pwd@db:5432/main\nAPP_KEY=secret_app_key_xyz\nPORT=4000\n',
        'utf8'
      );

      const { pool, connectionStore, credentialStore } = createMockPool();
      const stdoutLogs: string[] = [];
      const deps: OperatorCliDependencies = {
        pool: pool as any,
        env: {
          GH_TOKEN: 'demo_token_123',
          DEMO_OWNER_GITHUB_ID: demoOperatorId,
          ENCRYPTION_MASTER_KEY: masterKey,
        },
        fetchFn: createMockFetch(),
        stdout: (msg) => stdoutLogs.push(msg),
      };

      const result = await executeImportEnvironmentCommand(
        {
          name: 'production-env',
          file: filePath,
          keys: 'PORT,DATABASE_URL,APP_KEY',
        },
        deps
      );

      // Verify returned reference
      expect(result.connectionId).toMatch(/^conn_/);
      expect(result.credentialVersion).toBe(1);
      expect(result.keys).toEqual(['APP_KEY', 'DATABASE_URL', 'PORT']);

      // Never returns secret values or file path in result
      expect((result as any).values).toBeUndefined();
      expect((result as any).file).toBeUndefined();
      expect((result as any).DATABASE_URL).toBeUndefined();

      // Verify stdout output
      expect(stdoutLogs.length).toBe(1);
      const outputJson = JSON.parse(stdoutLogs[0]);
      expect(outputJson.connectionId).toBe(result.connectionId);
      expect(outputJson.credentialVersion).toBe(1);
      expect(outputJson.keys).toEqual(['APP_KEY', 'DATABASE_URL', 'PORT']);

      // Verify stdout NEVER contains secret values or file path
      const rawStdout = stdoutLogs[0];
      expect(rawStdout).not.toContain('secret_app_key_xyz');
      expect(rawStdout).not.toContain('postgres://app:pwd');
      expect(rawStdout).not.toContain(filePath);
      expect(rawStdout).not.toContain(masterKey);

      // Verify database stored records
      expect(connectionStore.size).toBe(1);
      expect(credentialStore.size).toBe(1);
      const storedConn = Array.from(connectionStore.values())[0];
      expect(storedConn.name).toBe('production-env');
      expect(storedConn.provider).toBe('deployment_env');
      expect(storedConn.status).toBe('active');
    });

    it('rejects if connection name is missing', async () => {
      const deps: OperatorCliDependencies = {
        env: { ENCRYPTION_MASTER_KEY: masterKey },
      };

      await expect(
        executeImportEnvironmentCommand(
          {
            name: '',
            file: path.join(tmpDir, 'any.env'),
            keys: 'PORT',
          },
          deps
        )
      ).rejects.toThrow('Connection name is required');
    });

    it('rejects if file path is missing', async () => {
      const deps: OperatorCliDependencies = {
        env: { ENCRYPTION_MASTER_KEY: masterKey },
      };

      await expect(
        executeImportEnvironmentCommand(
          {
            name: 'valid-name',
            file: '',
            keys: 'PORT',
          },
          deps
        )
      ).rejects.toThrow('Environment file path is required');
    });

    it('rejects if keys allowlist is missing', async () => {
      const deps: OperatorCliDependencies = {
        env: { ENCRYPTION_MASTER_KEY: masterKey },
      };

      await expect(
        executeImportEnvironmentCommand(
          {
            name: 'valid-name',
            file: path.join(tmpDir, 'any.env'),
            keys: '',
          },
          deps
        )
      ).rejects.toThrow('Environment keys allowlist is required');
    });

    it('rejects if ENCRYPTION_MASTER_KEY is missing from environment', async () => {
      const filePath = path.join(tmpDir, 'valid_no_key.env');
      fs.writeFileSync(filePath, 'PORT=8080\n', 'utf8');

      const deps: OperatorCliDependencies = {
        env: {
          GH_TOKEN: 'demo_token_123',
          DEMO_OWNER_GITHUB_ID: demoOperatorId,
        },
        fetchFn: createMockFetch(),
      };

      await expect(
        executeImportEnvironmentCommand(
          {
            name: 'env-no-master-key',
            file: filePath,
            keys: 'PORT',
          },
          deps
        )
      ).rejects.toThrow('ENCRYPTION_MASTER_KEY environment variable is required');
    });

    it('fails closed when operator authentication fails BEFORE reading file', async () => {
      const nonExistentFile = path.join(tmpDir, 'does_not_exist.env');

      const deps: OperatorCliDependencies = {
        env: {
          ENCRYPTION_MASTER_KEY: masterKey,
          GH_TOKEN: '',
          GITHUB_TOKEN: '',
        },
        execFn: () => {
          throw new Error('No gh binary');
        },
      };

      // Fails with auth error, NOT 'file not found', proving auth runs BEFORE file read
      await expect(
        executeImportEnvironmentCommand(
          {
            name: 'auth-fail-env',
            file: nonExistentFile,
            keys: 'PORT',
          },
          deps
        )
      ).rejects.toThrow('GitHub authentication failed: no token available');
    });

    it('refuses overwrite on existing connection with same name in workspace', async () => {
      const filePath = path.join(tmpDir, 'dup.env');
      fs.writeFileSync(filePath, 'PORT=8080\n', 'utf8');

      const { pool } = createMockPool();
      const deps: OperatorCliDependencies = {
        pool: pool as any,
        env: {
          GH_TOKEN: 'demo_token_123',
          DEMO_OWNER_GITHUB_ID: demoOperatorId,
          ENCRYPTION_MASTER_KEY: masterKey,
        },
        fetchFn: createMockFetch(),
        stdout: () => {},
      };

      // First import succeeds
      await executeImportEnvironmentCommand(
        {
          name: 'same-name-env',
          file: filePath,
          keys: 'PORT',
        },
        deps
      );

      // Second import must refuse overwrite
      await expect(
        executeImportEnvironmentCommand(
          {
            name: 'same-name-env',
            file: filePath,
            keys: 'PORT',
          },
          deps
        )
      ).rejects.toThrow('Connection with this name already exists in workspace. Refusing to overwrite.');
    });
  });
});
