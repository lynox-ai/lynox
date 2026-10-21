import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The source guard of PRD-SOURCE-CONNECTION R8-3: the erasure record is written only by the
 * `api_setup` delete, which asked the person. It counts HOW `erasure` reaches `ApiStore.remove`,
 * not where the literal sits: every call of a `.remove(` with a third argument must pass an object
 * literal naming its record kind, so a wrapper that hands its own caller's options on, or a
 * computed value, fails here as surely as a second caller of `erasure`.
 */

const SRC = join(import.meta.dirname, '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

/** The top-level arguments of every call of `name(` in `text`, as source strings. */
export function callsOf(text: string, name: string): string[][] {
  const calls: string[][] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(`${name}(`, from);
    if (at < 0) return calls;
    let depth = 0;
    let arg = '';
    const args: string[] = [];
    let i = at + name.length;
    for (; i < text.length; i++) {
      const c = text[i]!;
      if ('([{'.includes(c)) { depth++; if (depth === 1) continue; }
      if (')]}'.includes(c)) { depth--; if (depth === 0) break; }
      if (c === ',' && depth === 1) { args.push(arg.trim()); arg = ''; continue; }
      arg += c;
    }
    if (arg.trim() !== '') args.push(arg.trim());
    calls.push(args);
    from = i;
  }
}

const files = sourceFiles(SRC).map((path) => ({ path: relative(SRC, path), text: readFileSync(path, 'utf8') }));

describe('only the api_setup delete writes an erasure record', () => {
  it('every .remove( with a third argument passes a literal record kind, and `erasure` only from api_setup, once', () => {
    const found: string[] = [];
    for (const { path, text } of files) {
      for (const args of callsOf(text, '.remove')) {
        if (args.length < 3) continue;
        found.push(`${path}: ${args[2]}`);
      }
    }
    expect(found.sort()).toEqual([
      "server/http-api.ts: { record: 'closing' }",
      "tools/builtin/api-setup.ts: { record: 'erasure' }",
    ]);
  });

  it('the store writes a record only through remove, and the record only inside the delete\'s transaction', () => {
    const callers = (name: string): string[] => files.filter(({ text }) => callsOf(text, name).length > 0).map(({ path }) => path).sort();
    // The definition counts as a call site of its own name; each has exactly one other.
    expect(callers('_removeStored')).toEqual(['core/api-store.ts']);
    expect(callsOf(files.find((f) => f.path === 'core/api-store.ts')!.text, 'this._removeStored')).toEqual([['id', 'apisDir', 'options?.record']]);
    expect(callers('removeApiWithRecord')).toEqual(['core/api-store.ts', 'core/connection-store.ts']);
    expect(callers('writeConnectionRecord')).toEqual(['core/connection-erasure.ts', 'core/connection-store.ts']);
    expect(callsOf(files.find((f) => f.path === 'core/connection-store.ts')!.text, 'writeConnectionRecord').length).toBe(1);
  });

  it('the parser sees a pass-through and a computed kind (positive control)', () => {
    const passThrough = callsOf('store.remove(id, dir, opts); other.remove(a, b, { record: kind });', '.remove');
    expect(passThrough.map((a) => a[2])).toEqual(['opts', '{ record: kind }']);
  });
});
