import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface MigrateOptions {
  migrationsDir?: string;
}

export async function runMigrations(
  poolOrClient: pg.Pool | pg.PoolClient,
  options?: MigrateOptions
): Promise<string[]> {
  let migrationsDir = options?.migrationsDir;
  if (!migrationsDir) {
    const candidate1 = path.resolve(__dirname, '../migrations');
    const candidate2 = path.resolve(__dirname, '../../migrations');
    if (fs.existsSync(candidate1)) {
      migrationsDir = candidate1;
    } else if (fs.existsSync(candidate2)) {
      migrationsDir = candidate2;
    } else {
      migrationsDir = candidate1;
    }
  }

  const client = 'connect' in poolOrClient ? await poolOrClient.connect() : poolOrClient;

  try {
    // Acquire session advisory lock to serialize concurrent migration runs safely
    await client.query('SELECT pg_advisory_lock(987654321)');

    // Ensure migration tracking table exists in app schema (after creating app schema)
    await client.query(`CREATE SCHEMA IF NOT EXISTS app;`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS app._migrations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    if (!fs.existsSync(migrationsDir)) {
      throw new Error(`Migrations directory not found: ${migrationsDir}`);
    }

    const files = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    const appliedMigrations: string[] = [];

    for (const file of files) {
      const existing = await client.query(
        `SELECT name FROM app._migrations WHERE name = $1`,
        [file]
      );

      if (existing.rows.length === 0) {
        const sqlPath = path.join(migrationsDir, file);
        const sql = fs.readFileSync(sqlPath, 'utf8');

        // Apply migration within transaction
        try {
          await client.query('BEGIN');
          await client.query(sql);
          await client.query(
            `INSERT INTO app._migrations (name) VALUES ($1)`,
            [file]
          );
          await client.query('COMMIT');
          appliedMigrations.push(file);
        } catch (err) {
          await client.query('ROLLBACK');
          throw new Error(`Failed to apply migration ${file}: ${(err as Error).message}`);
        }
      }
    }

    return appliedMigrations;
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock(987654321)');
    } catch {
      // Ignore unlock failure
    }
    if ('release' in client && typeof (client as pg.PoolClient).release === 'function' && 'connect' in poolOrClient) {
      (client as pg.PoolClient).release();
    }
  }
}
