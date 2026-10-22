import { pgSchema } from 'drizzle-orm/pg-core';

/**
 * Explicit database schemas:
 * - app: Core application domain state, identity, workspaces, runs, outbox.
 * - pgboss: Dedicated schema for background queue coordination via pg-boss.
 * - checkpoints: Reserved schema for future LangGraph.js execution state.
 */
export const appSchema = pgSchema('app');
export const pgbossSchema = pgSchema('pgboss');
export const checkpointsSchema = pgSchema('checkpoints');
