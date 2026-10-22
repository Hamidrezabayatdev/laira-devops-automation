import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

const { Pool } = pg;

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseConfig {
  connectionString?: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

let globalPool: pg.Pool | null = null;
let globalDb: Database | null = null;

export function getDatabasePool(config?: DatabaseConfig): pg.Pool {
  if (globalPool) {
    return globalPool;
  }

  const connectionString =
    config?.connectionString ||
    process.env.DATABASE_URL ||
    process.env.TEST_DATABASE_URL;

  if (!connectionString) {
    throw new Error(
      'DATABASE_URL or TEST_DATABASE_URL environment variable is required to connect to database'
    );
  }

  globalPool = new Pool({
    connectionString,
    max: config?.max ?? 20,
    idleTimeoutMillis: config?.idleTimeoutMillis ?? 30000,
    connectionTimeoutMillis: config?.connectionTimeoutMillis ?? 5000,
  });

  return globalPool;
}

export function createDatabaseClient(pool: pg.Pool): Database {
  return drizzle(pool, { schema });
}

export function getDatabase(config?: DatabaseConfig): { db: Database; pool: pg.Pool } {
  if (globalDb && globalPool) {
    return { db: globalDb, pool: globalPool };
  }

  const pool = getDatabasePool(config);
  const db = createDatabaseClient(pool);
  globalDb = db;

  return { db, pool };
}

export async function closeDatabase(): Promise<void> {
  if (globalPool) {
    await globalPool.end();
    globalPool = null;
    globalDb = null;
  }
}
