import {
  text,
  timestamp,
  integer,
  jsonb,
  unique,
  foreignKey,
  index,
} from 'drizzle-orm/pg-core';
import { appSchema } from './reserved.js';
import { workspaces } from './workspaces.js';
import { projects } from './projects.js';

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_input'
  | 'waiting_approval'
  | 'waiting_external'
  | 'verifying'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'outcome_unknown';

export interface RunErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}

export const runs = appSchema.table(
  'runs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id'),
    type: text('type').notNull(),
    status: text('status').$type<RunStatus>().notNull().default('queued'),
    input: jsonb('input').$type<Record<string, unknown>>().notNull().default({}),
    output: jsonb('output').$type<Record<string, unknown>>(),
    error: jsonb('error').$type<RunErrorPayload>(),
    claimedBy: text('claimed_by'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    unique('runs_ws_id_unique').on(table.workspaceId, table.id),
    // SQL-authoritative composite foreign key:
    // Migration 0002 enforces `FOREIGN KEY (workspace_id, project_id) REFERENCES app.projects(workspace_id, id) ON DELETE SET NULL (project_id)`.
    // Drizzle ORM 0.45 lacks support for PostgreSQL 15+ column-subset `ON DELETE SET NULL (columns)`.
    // Calling `.onDelete('set null')` in Drizzle would incorrectly imply nulling both columns, violating NOT NULL on workspace_id.
    // The migration SQL is the authoritative definition for the (project_id)-scoped SET NULL rule.
    foreignKey({
      columns: [table.workspaceId, table.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
      name: 'runs_workspace_project_fkey',
    }),
  ]
);

export const runEvents = appSchema.table(
  'run_events',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('run_events_run_seq_unique').on(table.runId, table.seq),
    index('run_events_ws_run_seq_idx').on(table.workspaceId, table.runId, table.seq),
  ]
);
