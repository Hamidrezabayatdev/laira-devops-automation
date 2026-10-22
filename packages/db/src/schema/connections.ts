import { text, timestamp, integer, unique } from 'drizzle-orm/pg-core';
import { appSchema } from './reserved.js';
import { workspaces } from './workspaces.js';

export const connections = appSchema.table(
  'connections',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    provider: text('provider').notNull(),
    status: text('status').notNull().default('active'),
    activeVersion: integer('active_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('connections_ws_id_unique').on(table.workspaceId, table.id),
  ]
);

export const connectionCredentialVersions = appSchema.table(
  'connection_credential_versions',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    algorithm: text('algorithm').notNull().default('aes-256-gcm'),
    ciphertext: text('ciphertext').notNull(),
    iv: text('iv').notNull(),
    tag: text('tag').notNull(),
    keyVersion: integer('key_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('conn_cred_versions_ws_conn_ver_unique').on(
      table.workspaceId,
      table.connectionId,
      table.version
    ),
  ]
);
