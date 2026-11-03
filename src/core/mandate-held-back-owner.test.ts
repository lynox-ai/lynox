import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// A profile the boot held back is stored, and it is the owner's: a mandate session may neither
// save over it nor delete it. The author check reads the stored
// profile, registered or held back; it runs before anything else a save or a delete does, so a
// refused call leaves the stored record and the vault as they were. Through both real loaders and
// `api_setup`.

vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn().mockResolvedValue([{ address: '1.2.3.4', family: 4 }]) },
}));

// `api_setup` resolves the flat-JSON directory as `<lynox dir>/apis`.
let lynoxDir = '';
vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  getLynoxDir: () => lynoxDir,
}));

import { ApiStore, type ApiProfile } from './api-store.js';
import { EngineDb } from './engine-db.js';
import { ConnectionStore } from './connection-store.js';
import { tokenFingerprint } from './oauth-refresh-failure.js';
import { setPinnedTransportForTests } from './network-guard.js';
import { apiSetupTool } from '../tools/builtin/api-setup.js';
import type { RequestPrincipal } from './request-principal.js';
import { testAuditLog } from '../../tests/helpers/audit-log.js';

// Values assembled at runtime: no literal here has the shape of a credential.
const value = (...parts: string[]): string => parts.join('-');

let sent = 0;
let restoreTransport: (() => void) | undefined;
const dirs: string[] = [];
const engines: EngineDb[] = [];
const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

beforeEach(() => {
  sent = 0;
  lynoxDir = tmp('lynox-mandate-hb-home-');
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  restoreTransport = setPinnedTransportForTests(async () => {
    sent += 1;
    return new Response('ok', { status: 200 });
  });
});

afterEach(() => {
  restoreTransport?.();
  restoreTransport = undefined;
  vi.restoreAllMocks();
  for (const e of engines.splice(0)) { try { e.close(); } catch { /* ignore */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ackFor = (...hosts: string[]) => ({ accepted: true as const, hosts, accepted_at: '2026-10-18T00:00:00.000Z' });
const MANDATE: RequestPrincipal = { kind: 'mandate', email: 'setup@example.org', mandateId: 'M-1' } as RequestPrincipal;
const MANDATE_TAG = 'mandate:setup@example.org';

/** The owner's oauth2 profile `crm` on `crm.example`. */
const crm = (): ApiProfile => ({
  id: 'crm', name: 'crm', base_url: 'https://crm.example/v1', description: 'crm',
  auth: { type: 'oauth2', oauth: { token_url: 'https://crm.example/oauth/token', grant_type: 'refresh_token', client_id_key: 'CRM_CID', client_secret_key: 'CRM_CSECRET' } },
  custom_endpoint_ack: ackFor('crm.example'),
});
/**
 * `reader`, oauth2 on its own host, reading the refresh slot `crm` derives: the boot holds it
 * back. Its exchange wrote its own access token.
 */
const reader = (over: Partial<ApiProfile> = {}): ApiProfile => ({
  id: 'reader', name: 'reader', base_url: 'https://reader.example/v1', description: 'reader',
  auth: { type: 'oauth2', vault_keys: ['CRM_CID', 'CRM_CSECRET'], oauth: { token_url: 'https://crm.example/oauth/token', grant_type: 'refresh_token', client_id_key: 'CRM_CID', client_secret_key: 'CRM_CSECRET', refresh_token_key: 'CRM_REFRESH_TOKEN' } },
  custom_endpoint_ack: ackFor('reader.example'),
  oauth_grant: { written: [{ name: 'READER_ACCESS_TOKEN', fp: tokenFingerprint(value('reader', 'access')) }] },
  endpoints: [{ method: 'GET', path: '/items', description: 'List items' }],
  guidelines: ['Page with cursor'],
  avoid: ['Do not poll'],
  ...over,
});
const VAULT = { READER_ACCESS_TOKEN: value('reader', 'access'), CRM_REFRESH_TOKEN: value('crm', 'refresh') };

interface Booted { store: ApiStore; stored: () => string | undefined }
type Loader = (profiles: readonly ApiProfile[]) => Booted;

/** Files `<id>.json` in `<lynox dir>/apis`, the directory `api_setup` saves to and deletes from. */
const fromDirectory: Loader = (profiles) => {
  const dir = join(lynoxDir, 'apis');
  mkdirSync(dir, { recursive: true });
  for (const p of profiles) writeFileSync(join(dir, `${p.id}.json`), JSON.stringify(p));
  const store = new ApiStore();
  store.loadFromDirectory(dir);
  const file = join(dir, 'reader.json');
  return { store, stored: () => (existsSync(file) ? readFileSync(file, 'utf8') : undefined) };
};
/** Rows of engine.db `connections`, the store wired to them. */
const fromConnections: Loader = (profiles) => {
  const engine = new EngineDb(join(tmp('lynox-mandate-hb-db-'), 'engine.db'), '');
  engines.push(engine);
  const cs = new ConnectionStore(engine);
  for (const p of profiles) {
    const { id, name, ...rest } = p;
    cs.upsert({ id, kind: 'api', name, subjectId: null, direction: 'outbound', configJson: JSON.stringify(rest), vaultKeys: [], status: 'active' });
  }
  const store = new ApiStore();
  store.setConnectionStore(cs);
  store.loadFromConnections(cs);
  return { store, stored: () => { const row = cs.get('reader'); return row ? JSON.stringify(row) : undefined; } };
};
const loaders = [['loadFromDirectory', fromDirectory], ['loadFromConnections', fromConnections]] as const;

/** A vault over a plain map. */
function vaultOf(entries: Record<string, string>) {
  const map: Record<string, string> = { ...entries };
  return {
    resolve: (name: string): string | null => map[name] ?? null,
    resolveSecretRefs: (input: unknown): unknown => input,
    set: (name: string, v: string): void => { map[name] = v; },
    deleteSecret: (name: string): boolean => delete map[name],
    listNames: (): string[] => Object.keys(map),
    snapshot: (): Record<string, string> => ({ ...map }),
  };
}

function call(store: ApiStore, vault: ReturnType<typeof vaultOf>, input: Record<string, unknown>, asked: () => Promise<string>): Promise<string> {
  const agent = {
    principal: MANDATE,
    sessionCounters: { httpRequests: 0 },
    secretStore: vault,
    promptUser: asked,
    getAvailableTools: () => [{ definition: { name: 'http_request' } }, { definition: { name: 'api_setup' } }],
    toolContext: { auditLog: testAuditLog().log, apiStore: store, secretReleases: null, mandateEnds: null, userConfig: {}, tools: [], allowedWildcards: [], hourlyRateLimit: Infinity, dailyRateLimit: Infinity },
  } as never;
  return apiSetupTool.handler(input as never, agent) as Promise<string>;
}

const REFUSED = 'Error: API profile "reader" was not set up in this session\'s name, so this session may not change or delete it. Nothing was changed. Ask the owner to make the change.';
/**
 * The mandate's edit: its own sign-in instead of the owner's refresh slot, on another base. A save
 * that gets past the author check goes through, and since it ends the reading it empties the token
 * slot `reader` holds first: the vault and the stored record both change (the control below).
 */
const moved = (): ApiProfile => reader({
  base_url: 'https://elsewhere.example/v1',
  custom_endpoint_ack: ackFor('elsewhere.example'),
  auth: { type: 'oauth2', vault_keys: ['READER_CID', 'READER_CSECRET'], oauth: { token_url: 'https://elsewhere.example/oauth/token', grant_type: 'refresh_token', client_id_key: 'READER_CID', client_secret_key: 'READER_CSECRET' } },
});

describe.each(loaders)('a profile of the owner the boot held back, through %s', (_loader, boot) => {
  const setup = () => {
    const booted = boot([crm(), reader()]);
    expect(booted.store.get('reader')).toBeUndefined();
    expect(booted.store.storedProfile('reader')).toBeDefined();
    return { ...booted, before: booted.stored(), vault: vaultOf(VAULT), asked: vi.fn(async () => 'Allow') };
  };

  it.each(['create', 'update'] as const)('a mandate\'s %s over it is refused, and the stored record and the vault stay as they were', async (action) => {
    const { store, stored, before, vault, asked } = setup();
    expect(await call(store, vault, { action, profile: moved() }, asked)).toBe(REFUSED);
    expect(asked).not.toHaveBeenCalled();
    expect(stored()).toBe(before);
    expect(store.storedProfile('reader')?.created_by).toBeUndefined();
    expect(vault.snapshot()).toEqual(VAULT);
    expect(sent).toBe(0);
  });

  it('a mandate\'s delete of it is refused, unasked, and the stored record and the vault stay as they were', async () => {
    const { store, stored, before, vault, asked } = setup();
    expect(await call(store, vault, { action: 'delete', id: 'reader' }, asked)).toBe(REFUSED);
    expect(asked).not.toHaveBeenCalled();
    expect(stored()).toBe(before);
    expect(store.storedProfile('reader')).toBeDefined();
    expect(vault.snapshot()).toEqual(VAULT);
  });
});

describe.each(loaders)('control: a profile of the mandate the boot held back, through %s', (_loader, boot) => {
  const setup = () => {
    const booted = boot([crm(), reader({ created_by: MANDATE_TAG })]);
    expect(booted.store.get('reader')).toBeUndefined();
    expect(booted.store.storedProfile('reader')).toBeDefined();
    return { ...booted, before: booted.stored(), vault: vaultOf(VAULT), asked: vi.fn(async () => 'Allow') };
  };

  // The same payload the refused tests send: past the author check it is saved, and the vault and
  // the stored record change, so their equality asserts above carry weight.
  it.each(['create', 'update'] as const)('the mandate\'s %s over it goes through and empties what it held', async (action) => {
    const { store, stored, before, vault, asked } = setup();
    expect(await call(store, vault, { action, profile: moved() }, asked)).toContain('Profile saved and activated immediately');
    expect(store.get('reader')?.base_url).toBe('https://elsewhere.example/v1');
    expect(stored()).not.toBe(before);
    expect(vault.snapshot()).toEqual({ CRM_REFRESH_TOKEN: VAULT.CRM_REFRESH_TOKEN });
  });

  it('the mandate deletes it, asked', async () => {
    const { store, stored, vault, asked } = setup();
    expect(await call(store, vault, { action: 'delete', id: 'reader' }, asked)).toMatch(/^Deleted API profile "reader"\./);
    expect(asked).toHaveBeenCalledOnce();
    expect(stored()).toBeUndefined();
  });
});
