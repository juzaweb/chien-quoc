/**
 * SQLite DDL mirroring `prisma/schema.prisma`.
 *
 * The server creates the database file and its tables on boot when they are
 * missing, so a fresh clone (or a deleted `database/` folder) works without
 * requiring the Prisma CLI. Every statement is idempotent.
 *
 * Table and column names are snake_case, matching each model's `@@map` and each
 * field's `@map` in `prisma/schema.prisma`. Index names follow Prisma's
 * generated convention over the mapped names (`<table>_<column>_key` for a
 * unique constraint, `<table>_<columns>_idx` for `@@index`), so `prisma db push`
 * and this boot DDL describe the same database.
 */
export const DATABASE_TABLE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "display_name_key" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`,

  `CREATE TABLE IF NOT EXISTS "players" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#3b82f6',
    "wood" REAL NOT NULL DEFAULT 300,
    "food" REAL NOT NULL DEFAULT 300,
    "gold" REAL NOT NULL DEFAULT 150,
    "stone" REAL NOT NULL DEFAULT 100,
    "population" INTEGER NOT NULL DEFAULT 0,
    "population_cap" INTEGER NOT NULL DEFAULT 10,
    "is_online" BOOLEAN NOT NULL DEFAULT true,
    "last_saved_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`,

  `CREATE TABLE IF NOT EXISTS "buildings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "owner_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "grid_x" INTEGER NOT NULL,
    "grid_y" INTEGER NOT NULL,
    "size_x" INTEGER NOT NULL,
    "size_y" INTEGER NOT NULL,
    "hp" REAL NOT NULL,
    "max_hp" REAL NOT NULL,
    "is_constructed" BOOLEAN NOT NULL DEFAULT true,
    "construction_progress" REAL NOT NULL DEFAULT 100,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "buildings_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "players" ("id") ON DELETE CASCADE ON UPDATE CASCADE
  );`,

  `CREATE TABLE IF NOT EXISTS "units" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "owner_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "x" REAL NOT NULL,
    "y" REAL NOT NULL,
    "speed" REAL NOT NULL,
    "hp" REAL NOT NULL,
    "max_hp" REAL NOT NULL,
    "action_state" TEXT NOT NULL DEFAULT 'IDLE',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "units_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "players" ("id") ON DELETE CASCADE ON UPDATE CASCADE
  );`,

  `CREATE TABLE IF NOT EXISTS "world_resource_nodes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "grid_x" INTEGER NOT NULL,
    "grid_y" INTEGER NOT NULL,
    "remaining_amount" REAL NOT NULL,
    "max_amount" REAL NOT NULL,
    "updated_at" DATETIME NOT NULL
  );`
];

export const DATABASE_INDEX_STATEMENTS: readonly string[] = [
  `CREATE UNIQUE INDEX IF NOT EXISTS "users_username_key" ON "users"("username");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "users_display_name_key_key" ON "users"("display_name_key");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "players_name_key" ON "players"("name");`,
  `CREATE INDEX IF NOT EXISTS "buildings_owner_id_idx" ON "buildings"("owner_id");`,
  `CREATE INDEX IF NOT EXISTS "units_owner_id_idx" ON "units"("owner_id");`,
  `CREATE INDEX IF NOT EXISTS "world_resource_nodes_grid_x_grid_y_idx" ON "world_resource_nodes"("grid_x", "grid_y");`
];
