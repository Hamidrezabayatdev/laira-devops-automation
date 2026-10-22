#!/usr/bin/env node
import pg from 'pg';
import { runMigrations } from '../migrator.js';

async function main() {
  const connectionString = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;
  if (!connectionString) {
    console.error('Error: DATABASE_URL or TEST_DATABASE_URL environment variable is required.');
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString });

  try {
    console.log('Running database migrations...');
    const applied = await runMigrations(pool);
    if (applied.length === 0) {
      console.log('Database schema is already up to date. No new migrations applied.');
    } else {
      console.log(`Successfully applied ${applied.length} migration(s):`);
      for (const m of applied) {
        console.log(`  - ${m}`);
      }
    }
    await pool.end();
    process.exit(0);
  } catch {
    console.error('Migration failed: database operation encountered an unrecoverable error');
    try {
      await pool.end();
    } catch {
      // Ignore pool close error
    }
    process.exit(1);
  }
}

main();
