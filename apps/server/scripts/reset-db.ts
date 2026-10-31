/**
 * Drops every table so `DatabaseService.initialize()` recreates the schema from
 * scratch on the next boot. Used instead of deleting `dev.db`, which another
 * process on this machine keeps open.
 */
import { prisma } from '../src/services/DatabaseService.js';

// Physical snake_case names, as declared by `@@map` in `prisma/schema.prisma`.
const tables = ['buildings', 'units', 'players', 'world_resource_nodes', 'users'];

for (const table of tables) {
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${table}";`);
  console.log(`dropped ${table}`);
}

await prisma.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE);');
const left = await prisma.$queryRawUnsafe(
  `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;`
);
console.log('remaining tables:', left);
await prisma.$disconnect();
