import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * An engine that started without engine.db keeps its API profiles in the flat files of `apis/`,
 * which the next boot with engine.db does not read: a change made there was lost and a deleted
 * profile came back, without a word. Such an engine now refuses a person's change with a plain
 * reason before anything is asked, written or sent, and still stores what the engine
 * records by itself. The texts are written out here, not read from the module.
 */

let mockLynoxDir: string;
vi.mock('../../core/config.js', () => ({
  getLynoxDir: () => mockLynoxDir,
}));

import { apiSetupTool } from './api-setup.js';
import { ApiStore, SaveRefused } from '../../core/api-store.js';
import type { ApiProfile } from '../../core/api-store.js';
import { OWNER_PRINCIPAL } from '../../core/request-principal.js';
import { bindingsAsMigrated } from '../../../tests/helpers/vault-bindings.js';
import { testAuditLog } from '../../../tests/helpers/audit-log.js';

const SAVE = "This engine is running without engine.db, which it could not open when it was started, so lynox does not add or change API connections now: the change would be lost once the engine opens engine.db again. Nothing was saved, and nothing is saved later on its own; once someone has restarted the engine, the connection has to be added or changed again. This does not end on its own: it lasts until someone restarts the engine and the engine can open all its files again; the log the engine writes at start says why it could not. Do not retry and do not offer to do it later on your own: nothing will remind you after the restart. Tell the user it did not happen; after the restart they can ask again. Do not ask whether to try again later either; if they want that, they ask after the restart.";
const REMOVE = "This engine is running without engine.db, which it could not open when it was started, so lynox does not remove API connections now: a removed connection would come back once the engine opens engine.db again. Nothing was removed, and nothing is removed later on its own; once someone has restarted the engine, the connection has to be removed again. This does not end on its own: it lasts until someone restarts the engine and the engine can open all its files again; the log the engine writes at start says why it could not. Do not retry and do not offer to do it later on your own: nothing will remind you after the restart. Tell the user it did not happen; after the restart they can ask again. Do not ask whether to try again later either; if they want that, they ask after the restart.";
const RENEW = "This engine is running without engine.db, which it could not open when it was started, so lynox does not renew an API connection's access now: the renewed access would be lost once the engine opens engine.db again. Nothing was sent to the provider. This does not end on its own: it lasts until someone restarts the engine and the engine can open all its files again; the log the engine writes at start says why it could not. Do not retry and do not offer to do it later on your own: nothing will remind you after the restart. Tell the user it did not happen; after the restart they can ask again. Do not ask whether to try again later either; if they want that, they ask after the restart.";
const CONNECT = "This engine is running without engine.db, which it could not open when it was started, so lynox does not connect API accounts now: the connection would be lost once the engine opens engine.db again. Nothing was sent to the provider, and nothing is connected later on its own; once someone has restarted the engine, the account has to be connected again. This does not end on its own: it lasts until someone restarts the engine and the engine can open all its files again; the log the engine writes at start says why it could not. Do not retry and do not offer to do it later on your own: nothing will remind you after the restart. Tell the user it did not happen; after the restart they can ask again. Do not ask whether to try again later either; if they want that, they ask after the restart.";

const PROFILE: ApiProfile = {
  id: 'shop-api',
  name: 'Shop API',
  base_url: 'https://api.example.com/v1',
  description: 'A test API.',
  auth: { type: 'bearer' },
  endpoints: [{ method: 'GET', path: '/items', description: 'List items' }],
  guidelines: ['Page with ?page='],
  avoid: ['No POST to /items'],
};

/** A new API on a host no stored profile uses, so only the engine-less refusal stands in its way. */
const NEW_PROFILE: ApiProfile = { ...PROFILE, id: 'new-api', base_url: 'https://other.example.com/v1' };

const OAUTH_PROFILE: ApiProfile = {
  id: 'books-api',
  name: 'Books API',
  base_url: 'https://books.example.com/api',
  description: 'An OAuth test API.',
  auth: {
    type: 'oauth2',
    oauth: {
      authorize_url: 'https://books.example.com/oauth/authorize',
      token_url: 'https://books.example.com/oauth/token',
      client_id_key: 'BOOKS_CLIENT_ID',
      client_secret_key: 'BOOKS_CLIENT_SECRET',
    },
  },
} as ApiProfile;

function agentFor(store: ApiStore): never {
  return {
    principal: OWNER_PRINCIPAL,
    sessionCounters: { httpRequests: 0 },
    secretStore: undefined,
    promptUser: vi.fn(async () => 'Yes'),
    toolContext: {
      auditLog: testAuditLog().log,
      apiStore: store,
      vaultNameBindings: bindingsAsMigrated(store),
      dataStore: null, taskManager: null, knowledgeLayer: null, runHistory: null,
      userConfig: {}, tools: [], streamHandler: null, networkPolicy: undefined, allowedHosts: undefined,
      allowedWildcards: [], rateLimitProvider: null, hourlyRateLimit: Infinity, dailyRateLimit: Infinity,
      isolationEnvOverride: undefined, isolationMinimalEnv: false,
    },
  } as never;
}

/** What `apis/` holds, name → content. */
function filesOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir).sort()) out[f] = readFileSync(join(dir, f), 'utf8');
  return out;
}

/** A store as a boot without engine.db leaves it: profiles from the flat files, changes refused. */
function engineLessStore(apisDir: string, refuse = true): ApiStore {
  const store = new ApiStore();
  store.loadFromDirectory(apisDir);
  if (refuse) store.refuseChangesWithoutStore();
  return store;
}

/** An OAuth profile an earlier exchange connected: its grant is on record. */
const RENEWED_PROFILE: ApiProfile = {
  ...OAUTH_PROFILE, id: 'renewed-api', base_url: 'https://renewed.example.com/api',
  oauth_grant: { grant_id: 'g-1', connected_by: 'owner' },
} as ApiProfile;

let apisDir: string;

beforeEach(() => {
  mockLynoxDir = mkdtempSync(join(tmpdir(), 'lynox-engine-less-'));
  apisDir = join(mockLynoxDir, 'apis');
  mkdirSync(apisDir, { recursive: true });
  writeFileSync(join(apisDir, 'shop-api.json'), JSON.stringify(PROFILE, null, 2));
  writeFileSync(join(apisDir, 'books-api.json'), JSON.stringify(OAUTH_PROFILE, null, 2));
  writeFileSync(join(apisDir, 'renewed-api.json'), JSON.stringify(RENEWED_PROFILE, null, 2));
});

afterEach(() => {
  rmSync(mockLynoxDir, { recursive: true, force: true });
});

describe('ApiStore without engine.db', () => {
  it('refuses a save with the reason, and writes and registers nothing', () => {
    const store = engineLessStore(apisDir);
    const before = filesOf(apisDir);
    expect(store.save({ ...PROFILE, name: 'Changed' }, apisDir)).toEqual({ ok: false, reason: SAVE });
    expect(store.save({ ...PROFILE, id: 'new-api' }, apisDir)).toEqual({ ok: false, reason: SAVE });
    expect(store.saveRefusal({ ...PROFILE, id: 'new-api' })).toBe(SAVE);
    expect(filesOf(apisDir)).toEqual(before);
    expect(store.get('shop-api')?.name).toBe('Shop API');
    expect(store.get('new-api')).toBeUndefined();
  });

  it('refuses a remove with the reason, and the file and the profile stay', () => {
    const store = engineLessStore(apisDir);
    const before = filesOf(apisDir);
    expect(store.deleteRefusal(store.get('shop-api')!, null, 'owner')).toBe(REMOVE);
    expect(() => store.remove('shop-api', apisDir)).toThrow(new SaveRefused(REMOVE));
    expect(filesOf(apisDir)).toEqual(before);
    expect(store.get('shop-api')).toBeDefined();
  });

  it('names each refusal by its kind, and leaves the advice to the model out of an HTTP answer', () => {
    const store = engineLessStore(apisDir);
    const toModel = ' Do not retry and do not offer to do it later on your own: nothing will remind you after the restart. Tell the user it did not happen; after the restart they can ask again. Do not ask whether to try again later either; if they want that, they ask after the restart.';
    for (const [kind, text] of [['save', SAVE], ['remove', REMOVE], ['connect', CONNECT], ['renew', RENEW]] as const) {
      expect(text.endsWith(toModel)).toBe(true);
      expect(store.engineLessRefusal(kind, 'model')).toBe(text);
      expect(store.engineLessRefusal(kind, 'client')).toBe(text.slice(0, -toModel.length));
    }
  });

  it('refuses the records the engine writes by itself too, a provider\'s revocation among them', () => {
    const store = engineLessStore(apisDir);
    const before = filesOf(apisDir);
    expect(() => store.markRevokedWithRecord('books-api', 'fp-1', new Date('2026-11-06T00:00:00Z'), false, apisDir)).toThrow(new SaveRefused(SAVE));
    expect(filesOf(apisDir)).toEqual(before);
    expect(store.get('books-api')?.oauth_grant).toBeUndefined();
  });

  it('control: a store never told keeps the flat-file fallback on the same files', () => {
    const store = engineLessStore(apisDir, false);
    expect(store.engineLessRefusal('save', 'model')).toBeNull();
    expect(store.engineLessRefusal('save', 'client')).toBeNull();
    expect(store.save({ ...PROFILE, name: 'Changed' }, apisDir)).toEqual({ ok: true, isNew: false });
    expect((JSON.parse(readFileSync(join(apisDir, 'shop-api.json'), 'utf8')) as ApiProfile).name).toBe('Changed');
    expect(store.remove('shop-api', apisDir)).toBe(true);
    expect(readdirSync(apisDir)).toEqual(['books-api.json', 'renewed-api.json']);
  });
});

describe('api_setup without engine.db', () => {
  it.each([
    ['create', { action: 'create', profile: NEW_PROFILE }, SAVE],
    ['update', { action: 'update', profile: { ...PROFILE, name: 'Changed' } }, SAVE],
    ['refine', { action: 'refine', id: 'shop-api', refine: { addNotes: ['x'] } }, SAVE],
    ['refine of an id that does not exist', { action: 'refine', id: 'no-such-api', refine: { addNotes: ['x'] } }, SAVE],
    ['adopt_connection', { action: 'adopt_connection', id: 'books-api' }, SAVE],
    ['delete', { action: 'delete', id: 'shop-api' }, REMOVE],
    ['delete of an id that does not exist', { action: 'delete', id: 'no-such-api' }, REMOVE],
    ['connect', { action: 'connect', id: 'books-api' }, CONNECT],
    ['a first fetch_token', { action: 'fetch_token', id: 'books-api' }, RENEW],
    ['fetch_token into a name of its choosing', { action: 'fetch_token', id: 'renewed-api', output_secret_name: 'COPY_TOKEN' }, RENEW],
  ])('%s answers with the reason and changes nothing, without asking', async (_label, input, text) => {
    const store = engineLessStore(apisDir);
    const agent = agentFor(store);
    const before = filesOf(apisDir);
    const profilesBefore = JSON.stringify(store.getAll());
    const result = await apiSetupTool.handler(input as never, agent);
    expect(result).toBe(`Error: ${text}`);
    expect(filesOf(apisDir)).toEqual(before);
    expect(JSON.stringify(store.getAll())).toBe(profilesBefore);
    expect((agent as unknown as { promptUser: ReturnType<typeof vi.fn> }).promptUser).not.toHaveBeenCalled();
  });

  it.each([
    ['a refresh-token grant', { ...OAUTH_PROFILE, id: 'refresh-api', base_url: 'https://refresh.example.com/api', auth: { ...OAUTH_PROFILE.auth, oauth: { ...(OAUTH_PROFILE.auth as { oauth: object }).oauth, grant_type: 'refresh_token' } } }],
    ['a grant on record', RENEWED_PROFILE],
  ])('refuses fetch_token on a connection already on record too (%s), before anything is sent', async (_label, profile) => {
    writeFileSync(join(apisDir, `${(profile as ApiProfile).id}.json`), JSON.stringify(profile, null, 2));
    const store = engineLessStore(apisDir);
    const before = filesOf(apisDir);
    const result = await apiSetupTool.handler({ action: 'fetch_token', id: (profile as ApiProfile).id } as never, agentFor(store));
    expect(result).toBe(`Error: ${RENEW}`);
    expect(filesOf(apisDir)).toEqual(before);
  });

  // The way a person meets the renewal sentence: the access token of a connected account has
  // expired, the renewal before the request is refused (silently, into the log), the request comes
  // back 401, and the reminder the engine appends to that 401 sends the model to fetch_token. The
  // reminder is the one the request tool appends (`oauth401Reminder`, pinned byte for byte in
  // http.test.ts); the call it names, run as written, answers with the renewal sentence.
  it('a 401 on a connected account sends the model to fetch_token, which answers with the renewal sentence', async () => {
    const connected = { ...OAUTH_PROFILE, id: 'refresh-api', base_url: 'https://refresh.example.com/api', auth: { ...OAUTH_PROFILE.auth, oauth: { ...(OAUTH_PROFILE.auth as { oauth: object }).oauth, grant_type: 'refresh_token', token_expires_at: Date.now() - 3_600_000 } } } as ApiProfile;
    writeFileSync(join(apisDir, 'refresh-api.json'), JSON.stringify(connected, null, 2));
    const store = engineLessStore(apisDir);
    const { oauth401Reminder, oauthFetchTokenWouldSwapDelegatedAccess } = await import('./http.js');
    const profile = store.get('refresh-api')!;
    const reminder = oauth401Reminder(profile as never, oauthFetchTokenWouldSwapDelegatedAccess(profile, true));
    const named = /api_setup\(\{ action: "(fetch_token)", id: "([a-z0-9_-]+)" \}\)/.exec(reminder);
    expect(named, 'the 401 reminder names no fetch_token call').not.toBeNull();
    const before = filesOf(apisDir);
    const result = await apiSetupTool.handler({ action: named![1], id: named![2] } as never, agentFor(store));
    expect(result).toBe(`Error: ${RENEW}`);
    expect(filesOf(apisDir)).toEqual(before);
  });

  it('answers fetch_token on a profile that is not oauth2 with what is wrong with it, not with engine.db', async () => {
    const store = engineLessStore(apisDir);
    const result = await apiSetupTool.handler({ action: 'fetch_token', id: 'shop-api' } as never, agentFor(store));
    expect(result).toContain('not "oauth2"');
  });

  it('control: the same create goes through on a store that was not told', async () => {
    const store = engineLessStore(apisDir, false);
    const result = await apiSetupTool.handler({ action: 'create', profile: NEW_PROFILE } as never, agentFor(store));
    expect(result).not.toContain('engine.db');
    expect(store.get('new-api')).toBeDefined();
  });
});
