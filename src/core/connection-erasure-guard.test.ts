import { describe, it, expect } from 'vitest';
import { ERASURE_SWEEP_INTERVAL_MS, providerErasureEnabled } from './connection-erasure.js';
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

/**
 * Call shapes `callsOf('.remove')` cannot read: a space before the parenthesis, a computed name,
 * call/apply/bind, destructuring the method off the store, an optional call, or the method
 * assigned to a name.
 */
const HIDDEN = /\.remove\s+\(|\[['"]remove['"]\]|\.remove\.(call|apply|bind)\b|\{[^}\n]*\bremove\b[^}\n]*\}\s*=|\.remove\s*\?\.\s*\(|=\s*[\w$.]+\.remove\b(?!\s*\()/;

/** Whether a `.remove(` call in `text` spreads its arguments, which the scan cannot count. */
function spreadsIntoRemove(text: string): boolean {
  return callsOf(text, '.remove').some((args) => args.some((a) => a.startsWith('...')));
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
      "tools/builtin/api-setup.ts: { record: 'closing' }",
      "tools/builtin/api-setup.ts: { record: 'erasure' }",
    ]);
  });

  it('the store writes a record only through remove, and the record only inside the delete\'s transaction', () => {
    const callers = (name: string): string[] => files.filter(({ text }) => callsOf(text, name).length > 0).map(({ path }) => path).sort();
    // The definition counts as a call site of its own name; each has exactly one other.
    expect(callers('_removeStored')).toEqual(['core/api-store.ts']);
    expect(callsOf(files.find((f) => f.path === 'core/api-store.ts')!.text, 'this._removeStored')).toEqual([['id', 'apisDir', 'options?.record']]);
    expect(callers('removeApiWithRecord')).toEqual(['core/api-store.ts', 'core/connection-store.ts']);
    expect(callers('writeConnectionRecord')).toEqual(['core/api-store.ts', 'core/connection-erasure.ts', 'core/connection-store.ts']);
    expect(callsOf(files.find((f) => f.path === 'core/connection-store.ts')!.text, 'writeConnectionRecord').length).toBe(1);
  });

  it('a provider\'s record has one writer, reached from the one revocation verdict; the kind is decided in one place, and a cancel writes no record', () => {
    const callers = (name: string): string[] => files.filter(({ text }) => callsOf(text, name).length > 0).map(({ path }) => path).sort();
    const textOf = (path: string): string => files.find((f) => f.path === path)!.text;
    // The one writer of a record that is no delete: inside `markRevokedWithRecord`, once.
    expect(callsOf(textOf('core/api-store.ts'), 'writeConnectionRecord')).toEqual([['conn.recordDb()', 'id', "'erasure'", 'revokedAt', '{ revokedGrant, stamped }']]);
    // Reached only from fetch_token's grant-revoked branch: the definition, and one call.
    expect(callers('markRevokedWithRecord')).toEqual(['core/api-store.ts', 'tools/builtin/api-setup.ts']);
    expect(callsOf(textOf('core/api-store.ts'), 'markRevokedWithRecord')).toHaveLength(1);
    expect(callsOf(textOf('tools/builtin/api-setup.ts'), 'markRevokedWithRecord')).toEqual([['input.id', 'presentedFp', 'new Date()', 'stampApplies', 'apisDir']]);
    // The cause is set in one module (and named by the migration's CHECK), nowhere else.
    expect(files.filter(({ text }) => text.includes("'provider_revoked'")).map(({ path }) => path).sort()).toEqual(['core/connection-erasure.ts', 'core/engine-db.ts']);
    // The cancel ends a held record and writes none; it is called from the save, the delete and its module.
    expect(callers('cancelHeldProviderRecords')).toEqual(['core/api-store.ts', 'core/connection-erasure.ts', 'core/connection-store.ts']);
    expect(callers('recordDb')).toEqual(['core/api-store.ts', 'core/connection-store.ts']);
  });

  it('no call reaches remove in a shape the scan above cannot read, and the store writes a record from one place', () => {
    expect(files.filter(({ text }) => HIDDEN.test(text)).map(({ path }) => path)).toEqual([]);
    // A spread hands on arguments the scan cannot count.
    expect(files.filter(({ text }) => spreadsIntoRemove(text)).map(({ path }) => path)).toEqual([]);
    // The fourth argument writes the audit row of each provider erasure the delete supersedes.
    expect(callsOf(files.find((f) => f.path === 'core/api-store.ts')!.text, 'removeApiWithRecord')).toEqual([['id', 'record', 'new Date()', expect.stringContaining("auditProviderCancels(this.auditLog, conn.recordDb(), OWNER_PRINCIPAL, ids, 'owner_delete')")]]);
  });

  it('the hidden-shape scan sees each shape it forbids (positive control)', () => {
    for (const shape of ['s.remove (a, b, c)', "s['remove'](a)", 's.remove.call(s, a)', 'const { remove } = store', 's.remove?.(id, undefined, opts)', 'const r = s.remove;', 'const r = this.store.remove']) expect(HIDDEN.test(shape), shape).toBe(true);
    for (const shape of ['s.remove(a, b, c)', 'const n = s.removeAll(a);', 'x = s.remove(a)']) expect(HIDDEN.test(shape), shape).toBe(false);
    expect(callsOf('s.remove(...args);', '.remove')).toEqual([['...args']]);
    expect(spreadsIntoRemove('s.remove(...args);')).toBe(true);
    expect(spreadsIntoRemove('s.remove(id, dir, { record: \'closing\' });')).toBe(false);
  });

  it('the parser sees a pass-through and a computed kind (positive control)', () => {
    const passThrough = callsOf('store.remove(id, dir, opts); other.remove(a, b, { record: kind });', '.remove');
    expect(passThrough.map((a) => a[2])).toEqual(['opts', '{ record: kind }']);
  });
});

describe('the promises the owner\'s notice of a provider\'s erasure rests on', () => {
  it('a provider\'s refusal writes no erasure by default', () => {
    expect(providerErasureEnabled(), 'providerErasureEnabled() is off by default; turning it on is a reviewed change that comes with the owner\'s notice').toBe(false);
  });

  it('the engine sweeps at most every 15 minutes, with the interval the notice is written for', () => {
    expect(ERASURE_SWEEP_INTERVAL_MS, 'the notice promises erasure once a running run ends; review its text before sweeping less often').toBeLessThanOrEqual(15 * 60_000);
    const engine = readFileSync(join(SRC, 'core/engine.ts'), 'utf8');
    expect(callsOf(engine, 'setInterval').filter((args) => args[0]?.includes('sweepConnectionErasures'))).toEqual([['() => this.sweepConnectionErasures()', 'ERASURE_SWEEP_INTERVAL_MS']]);
  });
});
