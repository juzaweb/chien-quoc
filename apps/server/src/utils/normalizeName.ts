/**
 * Case- and diacritic-insensitive comparison key ("Đại Việt" → "dai viet").
 *
 * Lives in its own module so both the auth service and the schema migration can
 * use it without importing each other (which would create a cycle).
 *
 * Needed because SQLite's `lower()` only folds ASCII characters, which would
 * let "đại việt" and "Đại Việt" register as two distinct lords.
 */
export function normalizeForComparison(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
