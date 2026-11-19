/**
 * Compile weld for the data-dir inventory's export decision.
 *
 * A source file, not a test, for the reason `google-client-pair-welds.ts` gives: tsc does not
 * read `src/**` test files, so a `@ts-expect-error` there proves nothing. The check lives in an
 * exported, never-called function, and `export-tables.test.ts` imports it, so deleting this
 * file fails the test run.
 *
 * It dies to one mutation: making `DataDirEntry.export` optional. The fixture is otherwise a
 * complete entry, so no other error can satisfy the suppression.
 */
import type { DataDirEntry } from './data-dir-inventory.js';

export function inventoryExportWelds(): DataDirEntry[] {
  // @ts-expect-error — an entry without an export decision does not compile
  const withoutExport: DataDirEntry = { name: 'x', kind: 'file', secret: false, backup: false, migrate: false, why: 'x', erase: { by: 'remove' } };
  return [withoutExport];
}
