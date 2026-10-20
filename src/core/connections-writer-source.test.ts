import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Who writes `connections`, and with which kind. The table's id is one primary key across all
 * kinds, and `ConnectionStore.upsert` conflicts on the id alone. Two kinds write it: `api`
 * (`ApiStore`) and `google` (`Engine._onGoogleTokenChange`). A third writer or kind must not
 * arrive unseen, so this pins every `.upsert(` call in the engine source — whatever the receiver
 * is called, since a search by receiver name misses a call through a local alias — and the kind
 * each connections writer writes.
 */
const SRC = join(import.meta.dirname, '..');
const UPSERT = /\.upsert\s*\(/g;

// Every `.upsert(` call by file. The connections writers are api-store.ts and engine.ts;
// connection-store.ts calls its own upsert from `upsertMany`; the rest write other tables.
const KNOWN_CALLS: Record<string, number> = {
  // save, the import's store strip (rewrites a row it read, same id and kind), the import re-gate.
  'core/api-store.ts': 3,
  'core/connection-store.ts': 1,
  'core/engine.ts': 1,
  'core/run-history.ts': 2,
  'core/trigger-store.ts': 2,
  'core/verb-graph-backfill.ts': 4,
  // `upsertCopy` saves the copy through its own `upsert` (table workflows).
  'core/workflow-store.ts': 1,
};

const FIX = 'A new `.upsert(` call: if it writes `connections`, settle how its ids relate to the other kinds\' ids before adding it here with its kind; if it writes another table, add it to KNOWN_CALLS.';

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts') ? [path] : [];
  });
}

const read = (file: string): string => readFileSync(join(SRC, file), 'utf-8');

describe('connections writers', () => {
  it('every .upsert( call in the engine source is a known one', () => {
    const calls: Record<string, number> = {};
    for (const path of sources(SRC)) {
      const n = readFileSync(path, 'utf-8').match(UPSERT)?.length ?? 0;
      if (n > 0) calls[relative(SRC, path)] = n;
    }
    expect(calls, FIX).toEqual(KNOWN_CALLS);
  });

  it('api-store.ts writes connections only through profileToConnectionRow, and that writes kind api', () => {
    const text = read('core/api-store.ts');
    const args = [...text.matchAll(/\.upsert\s*\(\s*([A-Za-z_]+)/g)].map((m) => m[1]);
    expect(args, FIX).toEqual(['profileToConnectionRow', 'profileToConnectionRow', 'profileToConnectionRow']);
    // One of the two is the store's own write, behind the check for another kind's row; the
    // other is the static re-gate, which only rewrites rows it read as kind api.
    expect(text.match(/this\.connStore\??\.upsert\s*\(/g)?.length, FIX).toBe(1);
    const writeRow = text.slice(text.indexOf('private _writeRow('));
    expect(writeRow.slice(0, writeRow.indexOf('\n  }\n')), FIX).toMatch(/_otherKindAt\(profile\.id\)[\s\S]*throw[\s\S]*this\.connStore\.upsert\(/);
    const body = text.slice(text.indexOf('function profileToConnectionRow'));
    expect([...body.slice(0, body.indexOf('\n}\n')).matchAll(/\bkind:\s*'([a-z_]+)'/g)].map((m) => m[1]), FIX).toEqual(['api']);
  });

  it('engine.ts writes one connections row, of kind google', () => {
    const text = read('core/engine.ts');
    const at = text.search(UPSERT);
    expect([...text.slice(at, at + 200).matchAll(/\bkind:\s*'([a-z_]+)'/g)].map((m) => m[1]), FIX).toEqual(['google']);
  });

  it('positive control: the call pattern sees a call split across lines and under any receiver name', () => {
    expect('store\n      .upsert({ id })'.match(UPSERT)?.length).toBe(1);
    expect('this.connStore?.upsert(row)'.match(UPSERT)?.length).toBe(1);
    expect('upsert(row: ConnectionRow): void {'.match(UPSERT)).toBeNull();
  });
});
