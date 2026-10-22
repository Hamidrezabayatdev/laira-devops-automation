import { text, timestamp, unique } from 'drizzle-orm/pg-core';
import { appSchema } from './reserved.js';
import { workspaces } from './workspaces.js';

export const projects = appSchema.table(
  'projects',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('projects_ws_id_unique').on(table.workspaceId, table.id),
    unique('projects_ws_slug_unique').on(table.workspaceId, table.slug),
  ]
);
