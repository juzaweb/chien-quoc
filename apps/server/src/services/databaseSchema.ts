/**
 * SQLite DDL mirroring `prisma/schema.prisma`.
 *
 * The server creates the database file and its tables on boot when they are
 * missing, so a fresh clone (or a deleted `database/` folder) works without
 * requiring the Prisma CLI. Every statement is idempotent.
 */
export const DATABASE_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS "Player" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#3b82f6',
    "wood" REAL NOT NULL DEFAULT 300,
    "food" REAL NOT NULL DEFAULT 300,
    "gold" REAL NOT NULL DEFAULT 150,
    "stone" REAL NOT NULL DEFAULT 100,
    "population" INTEGER NOT NULL DEFAULT 0,
    "populationCap" INTEGER NOT NULL DEFAULT 10,
    "isOnline" BOOLEAN NOT NULL DEFAULT true,
    "lastSavedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`,

  `CREATE TABLE IF NOT EXISTS "Building" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "gridX" INTEGER NOT NULL,
    "gridY" INTEGER NOT NULL,
    "sizeX" INTEGER NOT NULL,
    "sizeY" INTEGER NOT NULL,
    "hp" REAL NOT NULL,
    "maxHp" REAL NOT NULL,
    "isConstructed" BOOLEAN NOT NULL DEFAULT true,
    "constructionProgress" REAL NOT NULL DEFAULT 100,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Building_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Player" ("name") ON DELETE CASCADE ON UPDATE CASCADE
  );`,

  `CREATE TABLE IF NOT EXISTS "Unit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "x" REAL NOT NULL,
    "y" REAL NOT NULL,
    "speed" REAL NOT NULL,
    "hp" REAL NOT NULL,
    "maxHp" REAL NOT NULL,
    "actionState" TEXT NOT NULL DEFAULT 'IDLE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Unit_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Player" ("name") ON DELETE CASCADE ON UPDATE CASCADE
  );`,

  `CREATE TABLE IF NOT EXISTS "WorldResourceNode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "gridX" INTEGER NOT NULL,
    "gridY" INTEGER NOT NULL,
    "remainingAmount" REAL NOT NULL,
    "maxAmount" REAL NOT NULL,
    "updatedAt" DATETIME NOT NULL
  );`,

  `CREATE UNIQUE INDEX IF NOT EXISTS "Player_name_key" ON "Player"("name");`,
  `CREATE INDEX IF NOT EXISTS "Building_ownerId_idx" ON "Building"("ownerId");`,
  `CREATE INDEX IF NOT EXISTS "Unit_ownerId_idx" ON "Unit"("ownerId");`,
  `CREATE INDEX IF NOT EXISTS "WorldResourceNode_gridX_gridY_idx" ON "WorldResourceNode"("gridX", "gridY");`
];
