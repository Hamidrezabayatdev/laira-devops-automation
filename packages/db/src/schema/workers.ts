import {
  text,
  timestamp,
  integer,
  jsonb,
} from 'drizzle-orm/pg-core';
import { appSchema } from './reserved.js';

export type WorkerStatus = 'alive' | 'stopping' | 'stopped';

export const workerHeartbeats = appSchema.table('worker_heartbeats', {
  workerId: text('worker_id').primaryKey(),
  hostname: text('hostname').notNull(),
  pid: integer('pid').notNull(),
  status: text('status').$type<WorkerStatus>().notNull().default('alive'),
  lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
});
