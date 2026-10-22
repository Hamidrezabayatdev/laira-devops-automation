import {
  text,
  timestamp,
  integer,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { appSchema } from './reserved.js';
import { workspaces } from './workspaces.js';

export type OutboxStatus = 'pending' | 'claimed' | 'dispatched' | 'failed';

export const outbox = appSchema.table(
  'outbox',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    topic: text('topic').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status').$type<OutboxStatus>().notNull().default('pending'),
    retryCount: integer('retry_count').notNull().default(0),
    lastError: text('last_error'),
    claimedBy: text('claimed_by'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  },
  (table) => [
    index('outbox_status_created_idx').on(table.status, table.createdAt),
  ]
);
