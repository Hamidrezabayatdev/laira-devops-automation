-- Incremental migration: Add default UUID generation for Auth.js users.id
ALTER TABLE app.users ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
