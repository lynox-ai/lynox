import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The import that waits on a file writes `.import-pending`, and that marker is what tells the next
// start that the rows saved meanwhile do not end the import. Writing it could fail without a word:
// a profile saved afterwards made the next start take the import as done, and the profiles in the
// files it waited on never arrived. Now a save is refused while the marker is missing, so
// connections holds no api row and the next start runs the import again.
// Every start goes through the same three calls as the engine's boot.

import { ApiStore, type ApiProfile } from './api-store.js';
import { ConnectionStore } from './connection-store.js';
import { EngineDb } from './engine-db.js';

const IS_ROOT = process.getuid?.() === 0;

const dirs: string[] = [];
const engines: EngineDb[] = [];
let cs: ConnectionStore;
let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lynox-import-marker-'));
  dirs.push(root);
  const engine = new EngineDb(join(root, 'engine.db'), '');
  engines.push(engine);
  cs = new ConnectionStore(engine);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const e of engines.splice(0)) e.close();
  for (const d of dirs.splice(0)) {
    try { chmodSync(join(d, 'apis'), 0o700); } catch { /* not there */ }
    rmSync(d, { recursive: true, force: true });
  }
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
/** A file the import waits on: not valid JSON. */
const waitOn = (dir: string): void => writeFileSync(join(dir, 'broken.json'), '{');
/** A start on engine.db, in the engine's order: import, load from connections, then wire the store. */
const start = (dir: string): ApiStore => {
  const store = new ApiStore();
  store.importFromDirectoryIfNeeded(dir, cs);
  store.loadFromConnections(cs);
  store.setConnectionStore(cs);
  return store;
};
const marker = (dir: string): string => join(dir, '.import-pending');
const imported = (dir: string): boolean => existsSync(join(dir, '.imported-to-connections'));
const rowIds = (): string[] => cs.getByKind('api').map((r) => r.id).sort();
const reason = (r: { ok: boolean; reason?: string }): string => (r.ok ? '' : r.reason ?? '');
/**
 * The marker cannot be written, as root as well: a link at its name to a directory that does not
 * exist. Writing through it fails, and `existsSync` follows it and finds nothing, as it finds no
 * marker. Removing the link is the repair.
 */
const blockMarker = (dir: string): void => symlinkSync(join(dir, 'no-such-dir', 'x'), marker(dir));
const unblockMarker = (dir: string): void => rmSync(marker(dir));
/** Counts the store's writes of its sentinel and marker, writing them as before. */
const watchWrites = () => {
  const proto = ApiStore.prototype as unknown as { _writeImportSentinel: (p: string) => boolean };
  return vi.spyOn(proto, '_writeImportSentinel');
};

describe('a save while the import waits and its marker could not be written', () => {
  it('is refused with the reason, and the import runs once the file is repaired', () => {
    const dir = apisDir();
    waitOn(dir);
    put(dir, open('good'));
    blockMarker(dir);
    const store = start(dir);
    expect(rowIds()).toEqual([]);
    expect(store.importWaitsOn().map((w) => w.file)).toEqual(['broken.json']);

    const saved = store.save(open('rep'), dir);
    expect(saved.ok, 'a save went through while nothing said the import is open').toBe(false);
    expect(reason(saved)).toContain('could not be written');
    expect(store.saveRefusal(open('rep'))).toBe(reason(saved));
    expect(rowIds()).toEqual([]);

    rmSync(join(dir, 'broken.json'));
    unblockMarker(dir);
    const next = start(dir);
    expect(rowIds()).toEqual(['good']);
    expect(imported(dir)).toBe(true);
    expect(next.importWaitsOn()).toEqual([]);
  });

  it.skipIf(IS_ROOT)('the same when apis/ is not writable', () => {
    const dir = apisDir();
    waitOn(dir);
    put(dir, open('good'));
    chmodSync(dir, 0o500);
    const store = start(dir);
    expect(existsSync(marker(dir))).toBe(false);
    expect(store.save(open('rep'), dir).ok).toBe(false);
    expect(rowIds()).toEqual([]);
    chmodSync(dir, 0o700);
    rmSync(join(dir, 'broken.json'));
    start(dir);
    expect(rowIds()).toEqual(['good']);
  });

  it('once the marker can be written, the save writes it and goes through, and the import stays open', () => {
    const dir = apisDir();
    waitOn(dir);
    put(dir, open('good'));
    blockMarker(dir);
    const store = start(dir);
    expect(store.save(open('rep'), dir).ok).toBe(false);

    unblockMarker(dir);
    expect(store.save(open('rep'), dir).ok).toBe(true);
    expect(lstatSync(marker(dir)).isFile()).toBe(true);
    expect(rowIds()).toEqual(['rep']);
    // Written once, the marker is not written again by the next save.
    const writes = watchWrites();
    expect(store.save(open('rep2'), dir).ok).toBe(true);
    expect(writes).not.toHaveBeenCalled();
    writes.mockRestore();

    // The row saved meanwhile does not end the import: the file is imported once it is repaired.
    const waiting = start(dir);
    expect(imported(dir)).toBe(false);
    expect(waiting.importWaitsOn().map((w) => w.file)).toEqual(['broken.json']);
    rmSync(join(dir, 'broken.json'));
    start(dir);
    expect(rowIds()).toEqual(['good', 'rep', 'rep2']);
    expect(imported(dir)).toBe(true);
  });

  it('once the marker can be written, saveRefusal answers as the save does', () => {
    const dir = apisDir();
    waitOn(dir);
    blockMarker(dir);
    const store = start(dir);
    expect(store.saveRefusal(open('rep'))).not.toBeNull();
    unblockMarker(dir);
    expect(store.saveRefusal(open('rep'))).toBeNull();
    expect(store.save(open('rep'), dir).ok).toBe(true);
  });

  it('the reason names apis/ and no other path, and says what to do', () => {
    const dir = apisDir();
    waitOn(dir);
    blockMarker(dir);
    const r = reason(start(dir).save(open('rep'), dir));
    expect(r).toContain('apis/');
    expect(r).not.toContain(root);
    expect(r).not.toContain('.import-pending');
    expect(r).toMatch(/writable/);
  });

  it('a profile loaded at the boot is not refused, where a save on the same store is', () => {
    const dir = apisDir();
    waitOn(dir);
    blockMarker(dir);
    const store = start(dir);
    expect(store.register(open('loaded'), 'load')).toBe(true);
    expect(store.save(open('saved'), dir).ok).toBe(false);
  });

  it('after the erasure forgets every profile, the save is no longer refused', () => {
    const dir = apisDir();
    waitOn(dir);
    blockMarker(dir);
    const store = start(dir);
    expect(store.save(open('rep'), dir).ok).toBe(false);
    // The erasure removes `apis/` itself, so no marker could be written there now.
    rmSync(dir, { recursive: true, force: true });
    store.forgetAll();
    expect(store.save(open('rep')).ok).toBe(true);
  });
});

describe('control: with a marker written, nothing is refused', () => {
  it('a save while the import waits goes through, and does not end the import', () => {
    const dir = apisDir();
    waitOn(dir);
    put(dir, open('good'));
    const store = start(dir);
    expect(lstatSync(marker(dir)).isFile()).toBe(true);
    const writes = watchWrites();
    expect(store.saveRefusal(open('rep'))).toBeNull();
    expect(store.save(open('rep'), dir).ok).toBe(true);
    expect(writes, 'a save with the marker written went after it again').not.toHaveBeenCalled();
    writes.mockRestore();
    start(dir);
    expect(imported(dir)).toBe(false);
  });

  it('a save after an import that ran goes through', () => {
    const dir = apisDir();
    put(dir, open('good'));
    const store = start(dir);
    expect(imported(dir)).toBe(true);
    const writes = watchWrites();
    expect(store.save(open('rep'), dir).ok).toBe(true);
    expect(writes).not.toHaveBeenCalled();
    expect(rowIds()).toEqual(['good', 'rep']);
  });

  it('a marker that stands from an earlier start but cannot be rewritten refuses nothing', () => {
    const dir = apisDir();
    waitOn(dir);
    start(dir);
    expect(existsSync(marker(dir))).toBe(true);
    const failing = vi.spyOn(ApiStore.prototype as unknown as { _writeImportSentinel: (p: string) => boolean }, '_writeImportSentinel').mockReturnValue(false);
    const store = start(dir);
    expect(failing).toHaveBeenCalled();
    expect(store.save(open('rep'), dir).ok).toBe(true);
  });
});
