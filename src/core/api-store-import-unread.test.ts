import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The engine's normal start (engine.db): the profile files are imported into connections once,
// then read from there. A file the import could not read at all (no permission, a link to
// nothing) was skipped silently, and with nothing to import the next start had a profile saved
// meanwhile in connections, so the import was marked done without the files ever being read.
// While connections holds no api row yet, such a file now holds every name as on the boot without
// engine.db, the import stays open until every file is read or the unread one is deleted, and a
// profile saved meanwhile does not end it. An install whose rows were there before ends the
// import as before.
// Every start goes through the same three calls as the engine's boot.

vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn().mockResolvedValue([{ address: '1.2.3.4', family: 4 }]) },
}));

// `api_setup` resolves the flat-JSON directory as `<lynox dir>/apis`.
let lynoxDir = '';
vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  getLynoxDir: () => lynoxDir,
}));

import { ApiStore, purgeRecordedTokens, type ApiProfile } from './api-store.js';
import { tokenFingerprint } from './oauth-refresh-failure.js';
import type { SecretStoreLike } from '../types/index.js';
import { ConnectionStore } from './connection-store.js';
import { EngineDb } from './engine-db.js';
import { apiSetupTool } from '../tools/builtin/api-setup.js';
import type { RequestPrincipal } from './request-principal.js';

const IS_ROOT = process.getuid?.() === 0;

const dirs: string[] = [];
const engines: EngineDb[] = [];
let cs: ConnectionStore;

beforeEach(() => {
  lynoxDir = mkdtempSync(join(tmpdir(), 'lynox-import-unread-'));
  dirs.push(lynoxDir);
  const engine = new EngineDb(join(lynoxDir, 'engine.db'), '');
  engines.push(engine);
  cs = new ConnectionStore(engine);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const e of engines.splice(0)) e.close();
  for (const d of dirs.splice(0)) {
    try { chmodSync(join(d, 'apis', 'shop.json'), 0o600); } catch { /* not there, or a link */ }
    rmSync(d, { recursive: true, force: true });
  }
});

const ackFor = (...hosts: string[]) => ({ accepted: true as const, hosts, accepted_at: '2026-10-18T00:00:00.000Z' });
const bearer = (id: string, key: string): ApiProfile => ({
  id, name: id, base_url: `https://${id}.example/v1`, description: id, auth: { type: 'bearer', vault_keys: [key] }, custom_endpoint_ack: ackFor(`${id}.example`),
});
/** A profile without any vault name: public API, no credentials. */
const open = (id: string): ApiProfile => ({
  id, name: id, base_url: `https://${id}.example/v1`, description: id, auth: { type: 'none' }, custom_endpoint_ack: ackFor(`${id}.example`),
});

const apisDir = (): string => {
  const d = join(lynoxDir, 'apis');
  mkdirSync(d, { recursive: true });
  return d;
};
const put = (dir: string, p: ApiProfile): void => writeFileSync(join(dir, `${p.id}.json`), JSON.stringify(p));
/** A start on engine.db, in the engine's order: import, load from connections, then wire the store. */
const start = (dir: string): ApiStore => {
  const store = new ApiStore();
  store.importFromDirectoryIfNeeded(dir, cs);
  store.loadFromConnections(cs);
  store.setConnectionStore(cs);
  return store;
};
const imported = (dir: string): boolean => existsSync(join(dir, '.imported-to-connections'));
const rowIds = (): string[] => cs.getByKind('api').map((r) => r.id).sort();

const OWNER: RequestPrincipal = { kind: 'owner' } as RequestPrincipal;
const del = (store: ApiStore, id: string): Promise<string> =>
  apiSetupTool.handler({ action: 'delete', id } as never, {
    principal: OWNER,
    sessionCounters: { httpRequests: 0 },
    secretStore: null,
    promptUser: () => Promise.resolve('Allow'),
    getAvailableTools: () => [{ definition: { name: 'api_setup' } }],
    toolContext: { apiStore: store, secretReleases: null, mandateEnds: null, userConfig: {}, tools: [], allowedWildcards: [], hourlyRateLimit: Infinity, dailyRateLimit: Infinity },
  } as never) as Promise<string>;

describe('a profile file the import cannot read holds every name, and the import waits', () => {
  it('a link to nothing: nothing is imported, no sentinel, and every name is held', () => {
    const dir = apisDir();
    symlinkSync(join(dir, 'gone.json'), join(dir, 'shop.json'));
    put(dir, bearer('good', 'GOOD_KEY'));
    const store = start(dir);
    expect(rowIds()).toEqual([]);
    expect(imported(dir)).toBe(false);
    expect(store.unreadableHolds('ANY_NAME_AT_ALL')).toBe(true);
  });

  it('a link to itself: the same', () => {
    const dir = apisDir();
    symlinkSync(join(dir, 'shop.json'), join(dir, 'shop.json'));
    put(dir, bearer('good', 'GOOD_KEY'));
    const store = start(dir);
    expect(rowIds()).toEqual([]);
    expect(imported(dir)).toBe(false);
    expect(store.unreadableHolds('ANY_NAME_AT_ALL')).toBe(true);
  });

  it.skipIf(IS_ROOT)('a file without read permission: the same', () => {
    const dir = apisDir();
    put(dir, bearer('shop', 'SHOP_KEY'));
    chmodSync(join(dir, 'shop.json'), 0o000);
    put(dir, bearer('good', 'GOOD_KEY'));
    const store = start(dir);
    expect(rowIds()).toEqual([]);
    expect(imported(dir)).toBe(false);
    expect(store.unreadableHolds('ANY_NAME_AT_ALL')).toBe(true);
  });

  it('a profile with a name of its own is refused while the file is unread', () => {
    const dir = apisDir();
    symlinkSync(join(dir, 'gone.json'), join(dir, 'shop.json'));
    const store = start(dir);
    const saved = store.save(bearer('rep', 'REP_KEY'), dir);
    expect(saved.ok).toBe(false);
    expect(saved.ok ? '' : saved.reason).toContain('delete "shop" with api_setup delete');
    expect(rowIds()).toEqual([]);
  });

  it('control: a directory with a profile file\'s name is no profile and does not stop the import', () => {
    const dir = apisDir();
    mkdirSync(join(dir, 'z.json'));
    put(dir, bearer('good', 'GOOD_KEY'));
    const store = start(dir);
    expect(rowIds()).toEqual(['good']);
    expect(imported(dir)).toBe(true);
    expect(store.get('good')).toBeDefined();
    expect(store.unreadableHolds('ANY_NAME_AT_ALL')).toBe(false);
  });

});

// A file the import read but cannot take as a profile (not JSON, a required field missing, an id
// that is not valid) was skipped for good, and the rest imported: the import runs once, so its
// profile was gone without a word anywhere but the log. Such a file now holds the import as an
// unread one does, and the owner is told where a missing profile shows: `api_setup list` names
// the file and what to do, and so does the API page (`GET /api/api-profiles`).
const list = (store: ApiStore): Promise<string> =>
  apiSetupTool.handler({ action: 'list' } as never, {
    principal: OWNER,
    toolContext: { apiStore: store, secretReleases: null, mandateEnds: null, userConfig: {}, tools: [], allowedWildcards: [], hourlyRateLimit: Infinity, dailyRateLimit: Infinity },
  } as never) as Promise<string>;
const NOTICE = 'The API profiles saved before the move to engine.db are not imported yet: the import waits on one file in the API profile directory, listed below. Until each is repaired or deleted, none of those profiles are available. Tell the owner: repair the file, or delete it (api_setup delete with the id given, or by hand where none is given). The import runs at the next start.';

describe('a profile file the import read but cannot take holds the import, and the owner is told', () => {
  it('a file that does not parse: nothing is imported, and api_setup list names the file and the way out', async () => {
    const dir = apisDir();
    writeFileSync(join(dir, 'shop.json'), '{"id": "shop"');
    put(dir, bearer('good', 'GOOD_KEY'));
    const store = start(dir);
    expect(rowIds()).toEqual([]);
    expect(imported(dir)).toBe(false);
    expect(store.importWaitsOn()).toEqual([{ file: 'shop.json', reason: 'malformed', deleteId: 'shop' }]);
    const out = await list(store);
    expect(out).toContain('No API profiles registered.');
    expect(out).toContain(NOTICE);
    expect(out).toContain('- file "shop.json" is not valid JSON; delete id "shop"');
    // The names sit in a fence that says what they are; the notice is outside it.
    expect(out).toMatch(/<api_import_waiting>\nFile names from the API profile directory[^\n]*\n- file "shop\.json"/);
    expect(out.indexOf(NOTICE)).toBeLessThan(out.indexOf('<api_import_waiting>'));
  });

  it('repaired, the next start imports every file and the notice is gone', async () => {
    const dir = apisDir();
    writeFileSync(join(dir, 'shop.json'), '{"id": "shop"');
    put(dir, bearer('good', 'GOOD_KEY'));
    start(dir);
    put(dir, bearer('shop', 'SHOP_KEY'));
    const next = start(dir);
    expect(rowIds()).toEqual(['good', 'shop']);
    expect(imported(dir)).toBe(true);
    expect(existsSync(join(dir, '.import-pending'))).toBe(false);
    expect(next.importWaitsOn()).toEqual([]);
    const out = await list(next);
    expect(out).toContain('Registered APIs (2):');
    expect(out).not.toContain('not imported yet');
  });

  it('deleted with api_setup delete, it leaves the list at once, and the next start imports the rest', async () => {
    const dir = apisDir();
    writeFileSync(join(dir, 'shop.json'), JSON.stringify({ id: 'shop', name: 'shop' }));
    put(dir, bearer('good', 'GOOD_KEY'));
    const store = start(dir);
    expect(store.importWaitsOn().map((w) => w.reason)).toEqual(['not_a_profile']);
    expect(await del(store, 'shop')).toBe('Deleted API profile "shop".');
    expect(existsSync(join(dir, 'shop.json'))).toBe(false);
    expect(store.importWaitsOn()).toEqual([]);
    expect(await list(store)).not.toContain('not imported yet');
    start(dir);
    expect(rowIds()).toEqual(['good']);
    expect(imported(dir)).toBe(true);
  });

  it('a profile saved while it waits is listed beside the notice, and does not end the import', async () => {
    const dir = apisDir();
    writeFileSync(join(dir, 'shop.json'), JSON.stringify(bearer('Shop!', 'SHOP_KEY')));
    put(dir, bearer('good', 'GOOD_KEY'));
    const store = start(dir);
    expect(store.save(open('rep'), dir).ok).toBe(true);
    const out = await list(store);
    expect(out).toContain('Registered APIs (1):');
    expect(out).toContain('- file "shop.json" has an id that is not valid; delete id "shop"');
    const next = start(dir);
    expect(imported(dir)).toBe(false);
    expect(next.importWaitsOn().map((w) => w.file)).toEqual(['shop.json']);
  });

  it('it holds the names it carries, not every name', () => {
    const dir = apisDir();
    writeFileSync(join(dir, 'shop.json'), JSON.stringify(bearer('Shop!', 'SHOP_KEY')));
    const store = start(dir);
    expect(store.unreadableHolds('SHOP_KEY')).toBe(true);
    expect(store.unreadableHolds('ANY_NAME_AT_ALL')).toBe(false);
    const saved = store.save(bearer('rep', 'SHOP_KEY'), dir);
    expect(saved.ok ? '' : saved.reason).toContain('delete "shop" with api_setup delete');
  });

  it('a file whose name is no id is removed by hand, and the list says so', async () => {
    const dir = apisDir();
    writeFileSync(join(dir, 'my shop.json'), '[]');
    const store = start(dir);
    expect(store.importWaitsOn()).toEqual([{ file: 'my shop.json', reason: 'not_a_profile', deleteId: null }]);
    expect(await list(store)).toContain('- file "my shop.json" is no API profile that can be read (it needs an id, a name, a base_url and a description); its name is no id, so it is removed by hand');
  });

  it('a file holding JSON that is no object (null, a number, a list) waits as no profile, and the start goes on', () => {
    const dir = apisDir();
    writeFileSync(join(dir, 'a.json'), 'null');
    writeFileSync(join(dir, 'b.json'), '5');
    writeFileSync(join(dir, 'c.json'), '[]');
    const store = start(dir);
    expect(store.importWaitsOn().map((w) => [w.file, w.reason])).toEqual([['a.json', 'not_a_profile'], ['b.json', 'not_a_profile'], ['c.json', 'not_a_profile']]);
    expect(imported(dir)).toBe(false);
  });

  // What the import prints about a file that does not parse names the file and the fault, not the
  // parser's message, which quotes the text around the fault.
  it('the message about a file that does not parse quotes nothing of its content', () => {
    const dir = apisDir();
    const held = ['Zq', '7Lm', 'Wx3', 'Kp9', 'Rt2', 'Vn5'].join('');
    writeFileSync(join(dir, 'shop.json'), `{"id": "shop", "token": ${held}}`);
    const printed = vi.mocked(process.stderr.write);
    printed.mockClear();
    start(dir);
    const out = printed.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toContain('Import waits — shop.json is not valid JSON');
    expect(out).not.toContain(held.slice(0, 5));
    // The parser does quote it: the check above would see it.
    let parserSays = '';
    try { JSON.parse(`{"id": "shop", "token": ${held}}`); } catch (err) { parserSays = (err as Error).message; }
    expect(parserSays).toContain(held.slice(0, 5));
  });

  it('the boot without engine.db says the same of such a file, and quotes nothing of it either', () => {
    const dir = apisDir();
    const held = ['Zq', '7Lm', 'Wx3', 'Kp9', 'Rt2', 'Vn5'].join('');
    writeFileSync(join(dir, 'shop.json'), `{"id": "shop", "token": ${held}}`);
    const printed = vi.mocked(process.stderr.write);
    printed.mockClear();
    const store = new ApiStore();
    expect(store.loadFromDirectory(dir)).toBe(0);
    const out = printed.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toContain('Failed to load shop.json: not valid JSON');
    expect(out).not.toContain(held.slice(0, 5));
    // The file still holds what it names, as before.
    expect(store.unreadableHolds(held)).toBe(true);
    let parserSays = '';
    try { JSON.parse(`{"id": "shop", "token": ${held}}`); } catch (err) { parserSays = (err as Error).message; }
    expect(parserSays).toContain(held.slice(0, 5));
  });

  // A file's `id` that is not one may hold anything; the log names the file, never that value.
  it('an id that is not valid is not printed, on the import or on the boot without engine.db', () => {
    const held = ['Qm', '8Tz', 'Lk4', 'Hw6', 'Ys1'].join('');
    const dir = apisDir();
    writeFileSync(join(dir, 'shop.json'), JSON.stringify({ ...bearer('shop', 'SHOP_KEY'), id: held }));
    const printed = vi.mocked(process.stderr.write);
    const said = (): string => printed.mock.calls.map((c) => String(c[0])).join('');
    printed.mockClear();
    start(dir);
    expect(said()).toContain('Import waits — shop.json has an invalid id');
    expect(said()).not.toContain(held.slice(0, 5));
    printed.mockClear();
    new ApiStore().loadFromDirectory(dir);
    expect(said()).toContain('Skipping shop.json: its id is not valid');
    expect(said()).not.toContain(held.slice(0, 5));
  });

  it('control: a valid id is still named where the boot says a profile is v1', () => {
    const dir = apisDir();
    put(dir, bearer('shop', 'SHOP_KEY'));
    const printed = vi.mocked(process.stderr.write);
    printed.mockClear();
    new ApiStore().loadFromDirectory(dir);
    expect(printed.mock.calls.map((c) => String(c[0])).join('')).toContain('profile "shop" is v1');
  });

  it('a file the import could not read at all is listed too', async () => {
    const dir = apisDir();
    symlinkSync(join(dir, 'gone.json'), join(dir, 'shop.json'));
    const store = start(dir);
    expect(store.importWaitsOn()).toEqual([{ file: 'shop.json', reason: 'unread', deleteId: 'shop' }]);
    expect(await list(store)).toContain('- file "shop.json" could not be read; delete id "shop"');
  });

  it('control: an install whose rows were there before is not held by a broken file, and lists no notice', async () => {
    const dir = apisDir();
    cs.upsert({ id: 'old', kind: 'api', name: 'old', subjectId: null, direction: 'outbound', configJson: JSON.stringify({ base_url: 'https://old.example/v1', description: 'old', auth: { type: 'none' } }), vaultKeys: [], status: 'active' });
    writeFileSync(join(dir, 'shop.json'), '{"id": "shop"');
    const store = start(dir);
    expect(imported(dir)).toBe(true);
    expect(store.importWaitsOn()).toEqual([]);
    expect(await list(store)).not.toContain('not imported yet');
  });
});

describe('the ways out', () => {
  it('the unread file is deleted with api_setup delete, and the next start imports the rest', async () => {
    const dir = apisDir();
    symlinkSync(join(dir, 'gone.json'), join(dir, 'shop.json'));
    put(dir, bearer('good', 'GOOD_KEY'));
    const store = start(dir);
    expect(await del(store, 'shop')).toBe('Deleted API profile "shop".');
    expect(() => lstatSync(join(dir, 'shop.json'))).toThrow();
    expect(store.unreadableHolds('ANY_NAME_AT_ALL')).toBe(false);

    const next = start(dir);
    expect(rowIds()).toEqual(['good']);
    expect(imported(dir)).toBe(true);
    expect(existsSync(join(dir, '.import-pending'))).toBe(false);
    expect(next.get('good')).toBeDefined();
  });

  it.skipIf(IS_ROOT)('the file is made readable, and the next start imports it and the rest', () => {
    const dir = apisDir();
    put(dir, bearer('shop', 'SHOP_KEY'));
    chmodSync(join(dir, 'shop.json'), 0o000);
    put(dir, bearer('good', 'GOOD_KEY'));
    start(dir);
    chmodSync(join(dir, 'shop.json'), 0o600);
    const next = start(dir);
    expect(rowIds()).toEqual(['good', 'shop']);
    expect(imported(dir)).toBe(true);
    expect(next.get('shop')).toBeDefined();
    expect(next.unreadableHolds('ANY_NAME_AT_ALL')).toBe(false);
  });

  it.skipIf(IS_ROOT)('a profile without names saved meanwhile does not end the import: after the repair, the old profiles are there', () => {
    const dir = apisDir();
    put(dir, bearer('shop', 'SHOP_KEY'));
    chmodSync(join(dir, 'shop.json'), 0o000);
    put(dir, bearer('good', 'GOOD_KEY'));
    const store = start(dir);
    expect(store.save(open('public'), dir).ok).toBe(true);
    expect(rowIds()).toEqual(['public']);

    // The next start, still unread: still waiting.
    start(dir);
    expect(imported(dir)).toBe(false);

    chmodSync(join(dir, 'shop.json'), 0o600);
    const next = start(dir);
    expect(rowIds()).toEqual(['good', 'public', 'shop']);
    expect(imported(dir)).toBe(true);
    expect(next.get('good')).toBeDefined();
    expect(next.get('shop')).toBeDefined();
    expect(next.get('public')).toBeDefined();
  });

  it('a row stored meanwhile keeps its id: the file under the same id is not imported over it', async () => {
    const dir = apisDir();
    symlinkSync(join(dir, 'gone.json'), join(dir, 'shop.json'));
    put(dir, { ...open('good'), description: 'old file' });
    const store = start(dir);
    // A save here is refused now (the import is about to write that id) ...
    expect(store.save({ ...open('good'), description: 'saved meanwhile' }, dir).ok).toBe(false);
    // ... so the row comes from a store that did not read the files, as one saved before that did.
    const elsewhere = new ApiStore();
    elsewhere.setConnectionStore(cs);
    expect(elsewhere.save({ ...open('good'), description: 'saved meanwhile' }, dir).ok).toBe(true);
    expect(await del(store, 'shop')).toBe('Deleted API profile "shop".');
    const next = start(dir);
    expect(rowIds()).toEqual(['good']);
    expect(next.get('good')?.description).toBe('saved meanwhile');
    expect(imported(dir)).toBe(true);
  });

  it('control: a delete removes only an unread FILE as a file; a row it could not read leaves the backup file of its id alone', () => {
    const dir = apisDir();
    put(dir, bearer('x', 'X_KEY'));
    writeFileSync(join(dir, '.imported-to-connections'), '');
    // A row that holds no profile: read from connections, not from a file.
    cs.upsert({ id: 'x', kind: 'api', name: 'x', subjectId: null, direction: null, configJson: '{"id":"x"', vaultKeys: [], status: 'active' });
    const store = start(dir);
    expect(store.unreadableSourceOf('x')).toBe('connection "x"');
    // The row goes another way before the delete.
    cs.remove('x', 'api');
    expect(store.remove('x', dir)).toBe(false);
    expect(existsSync(join(dir, 'x.json'))).toBe(true);
  });

  it('control: an install whose rows were there before any file went unread ends the import as before, and nothing is held or brought back', () => {
    const dir = apisDir();
    // The cutover happened, the sentinel did not land; one backup file is now a link to nothing,
    // and the profile of another backup file was deleted after the cutover.
    put(dir, bearer('live', 'LIVE_KEY'));
    put(dir, bearer('gone', 'GONE_KEY'));
    const seed = new ApiStore();
    seed.setConnectionStore(cs);
    expect(seed.save(bearer('live', 'LIVE_KEY'), dir).ok).toBe(true);
    symlinkSync(join(dir, 'nowhere.json'), join(dir, 'shop.json'));
    const store = start(dir);
    expect(store.get('live')).toBeDefined();
    expect(store.unreadableHolds('ANY_NAME_AT_ALL')).toBe(false);
    expect(imported(dir)).toBe(true);
    expect(existsSync(join(dir, '.import-pending'))).toBe(false);
    start(dir);
    expect(rowIds()).toEqual(['live']);
  });

  it('removing a row that shares its id with an unread file leaves the file holding every name', () => {
    const dir = apisDir();
    symlinkSync(join(dir, 'gone.json'), join(dir, 'aa.json'));
    const first = start(dir);
    // Saved while only aa.json was unread; then bb.json goes unread under the row's id.
    expect(first.save(open('bb'), dir).ok).toBe(true);
    rmSync(join(dir, 'aa.json'));
    symlinkSync(join(dir, 'gone.json'), join(dir, 'bb.json'));
    const store = start(dir);
    expect(store.unreadableHolds('ANY_NAME_AT_ALL')).toBe(true);
    expect(store.remove('bb', dir)).toBe(true);
    expect(rowIds()).toEqual([]);
    expect(store.unreadableHolds('ANY_NAME_AT_ALL')).toBe(true);
    expect(store.save(bearer('rep', 'REP_KEY'), dir).ok).toBe(false);
  });

  it('control: with every file read and a row already there, nothing is imported and the import is done', () => {
    const dir = apisDir();
    put(dir, bearer('good', 'GOOD_KEY'));
    const seed = new ApiStore();
    seed.setConnectionStore(cs);
    expect(seed.save(open('public'), dir).ok).toBe(true);
    start(dir);
    expect(rowIds()).toEqual(['public']);
    expect(imported(dir)).toBe(true);
  });
});

// On the boot without engine.db a file whose id is not one is no profile: it holds what it names,
// as on the import, and its id goes nowhere further: not into the admission and its refusal
// texts, not into the held-back profiles, not into a duplicate check.
describe('a file whose id is not valid, on the boot without engine.db', () => {
  const held = ['Qm', '8Tz', 'Lk4', 'Hw6', 'Ys1'].join('');
  const said = (): string => vi.mocked(process.stderr.write).mock.calls.map((c) => String(c[0])).join('');
  const bad = (): ApiProfile => ({ ...bearer('shop', 'SHOP_KEY'), id: held });

  it('a copy of it under another file name: neither is registered, both hold their names, the id is not printed', () => {
    const dir = apisDir();
    writeFileSync(join(dir, 'shop.json'), JSON.stringify(bad()));
    writeFileSync(join(dir, 'shop.backup.json'), JSON.stringify(bad()));
    vi.mocked(process.stderr.write).mockClear();
    const store = new ApiStore();
    store.loadFromDirectory(dir);
    expect(store.getAll()).toEqual([]);
    expect(store.unreadableHolds('SHOP_KEY')).toBe(true);
    expect(said()).not.toContain(held.slice(0, 5));
  });

  it('a valid profile that names its derived slot is refused, and the refusal names the file, not its id', () => {
    const dir = apisDir();
    writeFileSync(join(dir, 'shop.json'), JSON.stringify({ ...bad(), auth: { type: 'oauth2', vault_keys: ['SHOP_CLIENT_ID'] } }));
    put(dir, bearer('good', `${held.toUpperCase()}_ACCESS_TOKEN`));
    vi.mocked(process.stderr.write).mockClear();
    const store = new ApiStore();
    store.loadFromDirectory(dir);
    expect(store.get('good')).toBeUndefined();
    expect(said()).toContain('file \"shop.json\"');
    expect(said()).not.toContain(held.slice(0, 5));
    // The slot does appear, upper-cased: it is the valid profile's own vault name, which its
    // refusal names. The invalid id itself does not.
    expect(said()).toContain(`${held.toUpperCase()}_ACCESS_TOKEN`);
  });

  it('it is no held-back profile: neither knownProfiles nor getAll carry its id', () => {
    const dir = apisDir();
    writeFileSync(join(dir, 'shop.json'), JSON.stringify(bad()));
    const store = new ApiStore();
    store.loadFromDirectory(dir);
    expect(store.knownProfiles().map((p) => p.id)).not.toContain(held);
    expect(store.getAll().map((p) => p.id)).not.toContain(held);
    expect(store.unreadableSourceOf('shop')).toBe('file "shop.json"');
  });

  // register() is the boot's entry; a caller that hands it an id that is not one is refused, and
  // its skip line does not print that value either.
  it('register refuses an id that is not valid without printing it', () => {
    vi.mocked(process.stderr.write).mockClear();
    expect(new ApiStore().register(bad())).toBe(false);
    expect(said()).toContain('Skipping profile with an id that is not valid: invalid id');
    expect(said()).not.toContain(held.slice(0, 5));
  });

  it('control: a valid profile beside it loads as usual', () => {
    const dir = apisDir();
    writeFileSync(join(dir, 'shop.json'), JSON.stringify(bad()));
    put(dir, bearer('good', 'GOOD_KEY'));
    const store = new ApiStore();
    expect(store.loadFromDirectory(dir)).toBe(1);
    expect(store.get('good')).toBeDefined();
  });
});

// While the import waits on one file, the others it read are stored only once it runs. A save in
// between is asked against them as against a stored profile: it may not take the id the import
// will write (the import would pass that file over for good), nor a vault slot one of them uses.
describe('a profile the import read while it waits on another file is asked like a stored one', () => {
  /** A file the import waits on: not valid JSON, so it holds only the names of its stem. */
  const waitOn = (dir: string): void => writeFileSync(join(dir, 'broken.json'), '{');
  const reason = (r: { ok: boolean; reason?: string }): string => (r.ok ? '' : r.reason ?? '');

  it('a save under the id of a waiting profile is refused, and the import later writes the file', () => {
    const dir = apisDir();
    waitOn(dir);
    put(dir, { ...bearer('shop', 'SHOP_KEY'), description: 'from the file' });
    const store = start(dir);
    expect(rowIds()).toEqual([]);

    const saved = store.save(open('shop'), dir);
    expect(saved.ok, 'the save took the id the import is about to write').toBe(false);
    expect(reason(saved)).toContain('file "shop.json"');
    expect(rowIds()).toEqual([]);

    rmSync(join(dir, 'broken.json'));
    const next = start(dir);
    expect(rowIds()).toEqual(['shop']);
    expect(next.get('shop')?.description, 'the file was passed over').toBe('from the file');
  });

  it('a save on the vault slot of a waiting profile is refused', () => {
    const dir = apisDir();
    waitOn(dir);
    put(dir, bearer('foo_bar', 'FOO_KEY'));
    const store = start(dir);
    const saved = store.save(open('foo-bar'), dir);
    expect(saved.ok).toBe(false);
    expect(reason(saved)).toContain('vault slot');
    expect(reason(saved)).toContain('file "foo_bar.json"');
  });

  /** A waiting profile whose exchange wrote `WAIT_TOKEN`: a profile signing in with that name loses it. */
  const wrote = (): ApiProfile => ({ ...bearer('wait', 'WAIT_KEY'), oauth_grant: { written: [{ name: 'WAIT_TOKEN', fp: 'f' }] } } as ApiProfile);

  it('a save that signs in with a name a waiting profile wrote is refused', () => {
    const dir = apisDir();
    waitOn(dir);
    put(dir, wrote());
    const store = start(dir);
    const saved = store.save(bearer('rep', 'WAIT_TOKEN'), dir);
    expect(saved.ok).toBe(false);
    expect(reason(saved)).toContain('WAIT_TOKEN');
    expect(reason(saved)).toContain('file "wait.json"');
  });

  it('control: without a readable waiting profile the same saves go through', () => {
    const dir = apisDir();
    waitOn(dir);
    const store = start(dir);
    expect(store.save(open('shop'), dir).ok).toBe(true);
    expect(store.save(open('foo-bar'), dir).ok).toBe(true);
    expect(store.save(bearer('rep', 'WAIT_TOKEN'), dir).ok).toBe(true);
  });

  it('once the import has run, nothing waits: the profile is stored and asked as any other', () => {
    const dir = apisDir();
    waitOn(dir);
    put(dir, wrote());
    start(dir);
    rmSync(join(dir, 'broken.json'));
    const store = start(dir);
    expect(rowIds()).toEqual(['wait']);
    // Its own update goes through: the id is no longer one the import is about to write.
    expect(store.save({ ...wrote(), description: 'edited' }, dir).ok).toBe(true);
    // A rival is refused as by any stored profile, and named as one.
    const rival = store.save(bearer('rep', 'WAIT_TOKEN'), dir);
    expect(rival.ok).toBe(false);
    expect(reason(rival)).not.toContain('read but not written yet');
  });

  it('after the erasure forgets every profile, a waiting one holds nothing either', () => {
    const dir = apisDir();
    waitOn(dir);
    put(dir, bearer('shop', 'SHOP_KEY'));
    const store = start(dir);
    expect(store.save(open('shop'), dir).ok).toBe(false);
    // The erasure removes `apis/` itself; the store only forgets.
    rmSync(dir, { recursive: true, force: true });
    store.forgetAll();
    expect(store.save(open('shop'), apisDir()).ok, 'a forgotten waiting profile still held its id').toBe(true);
  });

  it('a waiting profile is neither listed nor named among the files the import waits on', () => {
    const dir = apisDir();
    waitOn(dir);
    put(dir, bearer('shop', 'SHOP_KEY'));
    const store = start(dir);
    expect(store.importWaitsOn().map((w) => w.file)).toEqual(['broken.json']);
    expect(store.getAll().map((p) => p.id)).toEqual([]);
    expect(store.knownProfiles().map((p) => p.id)).toEqual([]);
  });

  it('deleting another profile still removes a token its exchange wrote, though a waiting profile names it', () => {
    const dir = apisDir();
    waitOn(dir);
    put(dir, bearer('wait', 'SHARED_TOKEN'));
    const store = start(dir);
    const values: Record<string, string> = { SHARED_TOKEN: 'v-1' };
    const vault = {
      resolve: (n: string) => values[n] ?? null,
      deleteSecret: (n: string) => { const had = n in values; delete values[n]; return had; },
    } as unknown as SecretStoreLike;
    const gone: ApiProfile = { ...open('gone'), oauth_grant: { written: [{ name: 'SHARED_TOKEN', fp: tokenFingerprint('v-1') }] } } as ApiProfile;
    expect(purgeRecordedTokens(store, gone, vault).removed).toEqual(['SHARED_TOKEN']);
    expect(values['SHARED_TOKEN']).toBeUndefined();
  });
});
