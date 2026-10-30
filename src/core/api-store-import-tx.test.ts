import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The import of the flat-file profiles writes every profile in one transaction. When that failed,
// it returned with nothing to say the import was still open: a profile saved before the next start
// made that start take the import as done, and none of the files was ever imported. Now the import
// is held open as when it waits on a file: the marker is written, the profiles it read wait, and a
// save is asked against them; without the marker every save is refused.
// Every start goes through the same three calls as the engine's boot.

import { ApiStore, type ApiProfile } from './api-store.js';
import { ConnectionStore } from './connection-store.js';
import { EngineDb } from './engine-db.js';

const dirs: string[] = [];
const engines: EngineDb[] = [];
let cs: ConnectionStore;
let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lynox-import-tx-'));
  dirs.push(root);
  const engine = new EngineDb(join(root, 'engine.db'), '');
  engines.push(engine);
  cs = new ConnectionStore(engine);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const e of engines.splice(0)) e.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ackFor = (...hosts: string[]) => ({ accepted: true as const, hosts, accepted_at: '2026-10-18T00:00:00.000Z' });
const open = (id: string): ApiProfile => ({
  id, name: id, base_url: `https://${id}.example/v1`, description: id, auth: { type: 'none' }, custom_endpoint_ack: ackFor(`${id}.example`),
});

const apisDir = (): string => {
  const d = join(root, 'apis');
  mkdirSync(d, { recursive: true });
  return d;
};
const put = (dir: string, p: ApiProfile): void => writeFileSync(join(dir, `${p.id}.json`), JSON.stringify(p));
/** The connections store, except that the import's one transaction throws, as on a locked database. */
const failingOnce = (): ConnectionStore => new Proxy(cs, {
  get(target, prop, receiver) {
    if (prop === 'upsertMany') return () => { throw new Error('database is locked'); };
    const v: unknown = Reflect.get(target, prop, receiver);
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
  },
});
/** A start on engine.db, in the engine's order: import, load from connections, then wire the store. */
const start = (dir: string, importStore: ConnectionStore = cs): ApiStore => {
  const store = new ApiStore();
  store.importFromDirectoryIfNeeded(dir, importStore);
  store.loadFromConnections(cs);
  store.setConnectionStore(cs);
  return store;
};
const marker = (dir: string): string => join(dir, '.import-pending');
const imported = (dir: string): boolean => existsSync(join(dir, '.imported-to-connections'));
const rowIds = (): string[] => cs.getByKind('api').map((r) => r.id).sort();
const reason = (r: { ok: boolean; reason?: string }): string => (r.ok ? '' : r.reason ?? '');
const blockMarker = (dir: string): void => symlinkSync(join(dir, 'no-such-dir', 'x'), marker(dir));

describe('when the import transaction fails, the import stays open', () => {
  it('a profile saved before the next start does not end it: the next start imports every file', () => {
    const dir = apisDir();
    put(dir, open('good'));
    put(dir, open('other'));
    const store = start(dir, failingOnce());
    expect(rowIds()).toEqual([]);
    expect(imported(dir)).toBe(false);
    expect(existsSync(marker(dir)), 'the failed import left nothing to say it is open').toBe(true);

    expect(store.save(open('rep'), dir).ok).toBe(true);
    start(dir);
    expect(rowIds()).toEqual(['good', 'other', 'rep']);
    expect(imported(dir)).toBe(true);
    expect(existsSync(marker(dir))).toBe(false);
  });

  it('a save under the id of a profile it read is refused, and says the import runs at the next start', () => {
    const dir = apisDir();
    put(dir, { ...open('good'), description: 'from the file' });
    const store = start(dir, failingOnce());
    const saved = store.save(open('good'), dir);
    expect(saved.ok).toBe(false);
    expect(reason(saved)).toContain('file "good.json"');
    expect(reason(saved)).toContain('let the import run first: it runs at the next start.');
    expect(reason(saved), 'no file waits to be repaired here').not.toContain('repaired or deleted');

    const next = start(dir);
    expect(next.get('good')?.description).toBe('from the file');
  });

  it('with its marker unwritable as well, every save is refused, and the reason does not speak of a file', () => {
    const dir = apisDir();
    put(dir, open('good'));
    blockMarker(dir);
    const store = start(dir, failingOnce());
    expect(store.saveRefusal(open('rep'))).toContain('did not finish');
    const saved = store.save(open('rep'), dir);
    expect(saved.ok).toBe(false);
    expect(reason(saved)).toContain('did not finish');
    expect(reason(saved)).toContain('apis/');
    expect(reason(saved)).not.toContain('waits on a file');
    expect(rowIds()).toEqual([]);
    rmSync(marker(dir));
    start(dir);
    expect(rowIds()).toEqual(['good']);
  });

  it('nothing is listed as a file the import waits on', () => {
    const dir = apisDir();
    put(dir, open('good'));
    expect(start(dir, failingOnce()).importWaitsOn()).toEqual([]);
  });
});

describe('the same refusals while the import waits on a file keep their words', () => {
  it('the id refusal names the files to repair, and the marker refusal the file it waits on', () => {
    const dir = apisDir();
    writeFileSync(join(dir, 'broken.json'), '{');
    put(dir, open('good'));
    const store = start(dir);
    expect(reason(store.save(open('good'), dir))).toContain('once every file api_setup list names is repaired or deleted.');

    const blocked = join(root, 'apis2');
    mkdirSync(blocked);
    writeFileSync(join(blocked, 'broken.json'), '{');
    blockMarker(blocked);
    const r = reason(start(blocked).save(open('rep'), blocked));
    expect(r).toContain('waits on a file');
    expect(r).not.toContain('did not finish');
  });
});

describe('control: an import whose transaction succeeds', () => {
  it('writes no marker, holds nothing, and a save goes through', () => {
    const dir = apisDir();
    put(dir, open('good'));
    const store = start(dir);
    expect(imported(dir)).toBe(true);
    expect(existsSync(marker(dir))).toBe(false);
    expect(store.saveRefusal(open('good'))).toBeNull();
    expect(store.save(open('rep'), dir).ok).toBe(true);
    expect(rowIds()).toEqual(['good', 'rep']);
  });
});

// A name is bound into the `name` column as it is, and SQLite binds only text, numbers, bigints,
// buffers and null. A file named `true` passed every check before the transaction and then failed
// it at every start: the import stayed open for good, no profile of it arrived, and nothing told
// the owner which file it was.
describe('a file whose name cannot be stored', () => {
  const failedTransaction = (): boolean =>
    vi.mocked(process.stderr.write).mock.calls.some(([s]) => String(s).includes('Import transaction failed'));

  it.each([
    ['true', true],
    ['an array', ['a']],
    ['an object', { a: 1 }],
  ])('a name that is %s waits as a file that is no profile, and once it is gone the others are imported', (_what, name) => {
    const dir = apisDir();
    put(dir, open('good'));
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ ...open('bad'), name }));

    const first = start(dir);
    expect(first.importWaitsOn()).toEqual([{ file: 'bad.json', reason: 'not_a_profile', deleteId: 'bad' }]);
    expect(failedTransaction()).toBe(false);
    expect(rowIds()).toEqual([]);

    rmSync(join(dir, 'bad.json'));
    const second = start(dir);
    expect(second.importWaitsOn()).toEqual([]);
    expect(rowIds()).toEqual(['good']);
    expect(imported(dir)).toBe(true);
  });

  it('control: a name that is a number is still imported, as before', () => {
    const dir = apisDir();
    writeFileSync(join(dir, 'num.json'), JSON.stringify({ ...open('num'), name: 2024 }));
    const store = start(dir);
    expect(store.importWaitsOn()).toEqual([]);
    expect(rowIds()).toEqual(['num']);
    expect(cs.getByKind('api')[0]?.name).toBe('2024.0'); // a double, stored as text, as before
  });

  it('a save of such a profile is refused and says what the name has to be', () => {
    const store = start(apisDir());
    const r = store.save({ ...open('bad'), name: true } as unknown as ApiProfile, apisDir());
    expect(r.ok).toBe(false);
    expect(reason(r)).toContain('a name that is text or a number');
    expect(rowIds()).toEqual([]);
  });
});
