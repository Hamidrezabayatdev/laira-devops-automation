import { text, timestamp } from 'drizzle-orm/pg-core';
import { appSchema } from './reserved.js';
import { users } from './auth.js';

export const workspaces = appSchema.table('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  ownerUserId: text('owner_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  githubUserId: text('github_user_id').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
