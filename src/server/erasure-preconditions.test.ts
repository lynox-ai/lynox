import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import { handleRunBackfillMetadata, type InboxApiDeps } from '../integrations/inbox/api.js';
import type { Engine } from '../core/engine.js';
import { GoogleAuth } from '../integrations/google/google-auth.js';
import { scopeToDir } from '../core/scope-resolver.js';
import type { SecretVault } from '../core/secret-vault.js';
import type { BackfillMetadataReport } from '../integrations/inbox/backfill-metadata.js';

// A mail account is added through the real MailContext; only the wire is faked.
function makeFakeImapClient(): unknown {
  return {
    usable: true,
    connect: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    on: vi.fn(),
    getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
    search: vi.fn().mockResolvedValue([]),
    fetch: vi.fn().mockImplementation(() => (async function* () {})()),
    fetchOne: vi.fn().mockResolvedValue(false),
    downloadMany: vi.fn().mockResolvedValue({}),
  };
}
vi.mock('imapflow', () => {
  function ImapFlow(): unknown { return makeFakeImapClient(); }
  return { ImapFlow, AuthenticationFailure: class extends Error {} };
});
// The claim's control-plane call, held open by the test so it can be overtaken by an erasure.
const cpFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../core/connector-egress.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/connector-egress.js')>()),
  cpFetch: cpFetchMock,
}));
vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn().mockImplementation(() => ({ sendMail: vi.fn(), close: vi.fn(), verify: vi.fn() })) },
}));

/**
 * `DELETE /api/data` refuses — 409 with a `code`, nothing erased — while something in this
 * process still holds user data and would write it back after the erasure, or hand it to
 * a model: a connected mail account, a Google grant or a sign-in in flight, the inbox
 * classifier at work, a backup. And the routes that would create such a writer refuse
 * while an erasure runs.
 *
 * Its own boot, because the inbox flag and a Google client pair change the conditions of
 * every other erasure test; `erasure-covers-export.test.ts` keeps the plain boot.
 */
describe('Art. 17 erasure refuses while a writer is live (real engine)', () => {
  // Built at RUNTIME: a key-shaped literal in a fixture is what the commit-time secret
  // scan looks for, and this repo is public.
  const SECRET = `t-${randomBytes(12).toString('hex')}`;
  let api: LynoxHTTPApi;
  let baseUrl: string;
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = [
    'LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY', 'LYNOX_BILLING_TIER',
    'LYNOX_MANAGED_MODE', 'LYNOX_FEATURE_UNIFIED_INBOX', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'LYNOX_NETWORK_POLICY',
  ];

  const engineOf = (): Engine => (api as unknown as { engine: Engine }).engine;
  const vaultOf = (): SecretVault => {
    const v = (api as unknown as { engine: { secretVault: SecretVault | null } }).engine.secretVault;
    if (v === null) throw new Error('fixture: the engine opened no vault');
    return v;
  };
  const internals = (): { erasureInProgress: boolean; erasureGeneration: number } =>
    api as unknown as { erasureInProgress: boolean; erasureGeneration: number };
  const google = (): NonNullable<ReturnType<Engine['getGoogleAuth']>> => {
    const g = engineOf().getGoogleAuth();
    if (g === null) throw new Error('fixture: no Google auth — the client pair did not reach the engine');
    return g;
  };
  const mail = (): NonNullable<ReturnType<Engine['getMailContext']>> => {
    const m = engineOf().getMailContext();
    if (m === null) throw new Error('fixture: no mail context');
    return m;
  };

  const auth = { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' };
  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${baseUrl}${path}`, { method, headers: auth, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { parsed = { text }; }
    return { status: res.status, body: parsed };
  }
  const erase = (): ReturnType<typeof call> => call('DELETE', '/api/data', { confirm: 'DELETE_ALL_DATA' });

  // What "nothing was erased" is measured against: the FIRST destructive step (flat-file
  // memory), a vault row, the flag and the erasure counter. The marker sits in the scope
  // that step empties — the memory's CURRENT scope, which is a context, not `global`; a
  // marker anywhere else survives that step and proves nothing about its position.
  const MARK_DIR = (): string => {
    const m = engineOf().getMemory();
    if (m === null) throw new Error('fixture: no flat-file memory');
    return join(dir, 'memory', scopeToDir(m.currentScope()));
  };
  const MARK_PATH = (): string => join(MARK_DIR(), 'knowledge.txt');
  let memMark = '';
  function seedNothingErased(): number {
    memMark = `ZZMARK-${randomBytes(4).toString('hex')}`;
    mkdirSync(MARK_DIR(), { recursive: true });
    writeFileSync(MARK_PATH(), memMark);
    vaultOf().set('ZZ_SEED', memMark);
    return internals().erasureGeneration;
  }
  function expectNothingErased(genBefore: number): void {
    expect(readFileSync(MARK_PATH(), 'utf8')).toBe(memMark);
    expect(vaultOf().get('ZZ_SEED')).toBe(memMark);
    expect(internals().erasureInProgress).toBe(false);
    expect(internals().erasureGeneration).toBe(genBefore);
  }
  async function expectRefused(code: string): Promise<void> {
    const gen = seedNothingErased();
    const res = await erase();
    expect(res.status).toBe(409);
    expect(res.body['code']).toBe(code);
    expect(String(res.body['error'])).toContain('Nothing was erased.');
    expectNothingErased(gen);
  }

  const ACCOUNT = { id: 'zz-acc', displayName: 'ZZ', address: 'zz@example.org', type: 'personal' };
  const tokens = (): Parameters<ReturnType<typeof google>['setTokens']>[0] => ({
    access_token: `a-${randomBytes(8).toString('hex')}`,
    refresh_token: `r-${randomBytes(8).toString('hex')}`,
    expires_at: Date.now() + 3_600_000,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-erasure-pre-'));
    for (const k of ENV) saved[k] = process.env[k];
    process.env['LYNOX_DATA_DIR'] = dir;
    process.env['LYNOX_HTTP_SECRET'] = SECRET;
    process.env['LYNOX_ALLOW_PLAIN_HTTP'] = 'true';
    process.env['LYNOX_VAULT_KEY'] = `v-${randomBytes(12).toString('hex')}`;
    process.env['LYNOX_FEATURE_UNIFIED_INBOX'] = '1';
    process.env['GOOGLE_CLIENT_ID'] = `${randomBytes(6).toString('hex')}.apps.example`;
    process.env['GOOGLE_CLIENT_SECRET'] = `s-${randomBytes(12).toString('hex')}`;
    // Nothing leaves the box: `revoke` is refused by the policy and drops the grant locally.
    process.env['LYNOX_NETWORK_POLICY'] = 'deny-all';
    delete process.env['LYNOX_BILLING_TIER'];
    delete process.env['LYNOX_MANAGED_MODE'];
    reloadConfig();
    api = new LynoxHTTPApi();
    await api.init();
    await api.start(0);
    const addr = (api as unknown as { server: Server | null }).server?.address();
    if (addr === null || addr === undefined || typeof addr === 'string') throw new Error('no port');
    baseUrl = `http://127.0.0.1:${String(addr.port)}`;
  }, 120_000);

  afterAll(async () => {
    try {
      await api?.shutdown();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
      reloadConfig();
    }
  });

  it('refuses while a mail account is connected, and the account route refuses while an erasure runs', async () => {
    // While the flag is up, the add route refuses after its connection test — the last
    // await before the write — so nothing reaches the registry or the vault.
    internals().erasureInProgress = true;
    try {
      const skip = await call('POST', '/api/mail/accounts', { ...accountBody(), skipTest: true });
      expect(skip.status).toBe(409);
      expect(skip.body['code']).toBe('erasure_in_progress');
    } finally {
      internals().erasureInProgress = false;
    }
    // An erasure that starts DURING the connection test: the check has to sit after it.
    const ctx = mail();
    const realTest = ctx.testAccount.bind(ctx);
    ctx.testAccount = async () => {
      internals().erasureInProgress = true;
      return { ok: true } as Awaited<ReturnType<typeof realTest>>;
    };
    try {
      const during = await call('POST', '/api/mail/accounts', accountBody());
      expect(during.status).toBe(409);
      expect(during.body['code']).toBe('erasure_in_progress');
    } finally {
      ctx.testAccount = realTest;
      internals().erasureInProgress = false;
    }
    expect(ctx.registry.list()).toEqual([]);

    const added = await call('POST', '/api/mail/accounts', { ...accountBody(), skipTest: true });
    expect(added.status).toBe(200);
    expect(ctx.registry.list()).toEqual([ACCOUNT.id]);
    await expectRefused('mail_accounts_registered');

    expect((await call('DELETE', `/api/mail/accounts/${ACCOUNT.id}`)).status).toBe(200);
    expect(ctx.registry.list()).toEqual([]);
  }, 60_000);

  it('refuses while Google is connected or a sign-in is pending, and the Google routes refuse while an erasure runs', async () => {
    internals().erasureInProgress = true;
    try {
      const start = await call('POST', '/api/google/auth', {});
      expect(start.status).toBe(409);
      expect(start.body['code']).toBe('erasure_in_progress');
      // No state cookie and no code: refused for the erasure, not for the missing cookie.
      const cb = await fetch(`${baseUrl}/api/google/callback?code=x&state=y`, { headers: { Authorization: `Bearer ${SECRET}` } });
      expect(cb.status).toBe(409);
    } finally {
      internals().erasureInProgress = false;
    }

    // A device flow whose start returns while an erasure has begun: the poll that would
    // write the grant is never started.
    const waitForAuth = vi.fn(async () => {});
    const startSpy = vi.spyOn(google(), 'startDeviceFlow').mockImplementation(async () => {
      internals().erasureInProgress = true;
      return { verificationUrl: 'https://example.test/d', userCode: 'uc', waitForAuth };
    });
    try {
      const late = await call('POST', '/api/google/auth', {});
      expect(late.status).toBe(409);
      expect(late.body['code']).toBe('erasure_in_progress');
      expect(waitForAuth).not.toHaveBeenCalled();
    } finally {
      startSpy.mockRestore();
      internals().erasureInProgress = false;
    }

    // A managed claim still out at the control plane is a pending grant, and when its
    // answer arrives during an erasure the tokens are not written.
    const MANAGED = ['LYNOX_MANAGED_CONTROL_PLANE_URL', 'LYNOX_MANAGED_INSTANCE_ID'] as const;
    for (const k of MANAGED) saved[k] ??= process.env[k];
    process.env['LYNOX_MANAGED_CONTROL_PLANE_URL'] = 'https://cp.example.test';
    process.env['LYNOX_MANAGED_INSTANCE_ID'] = 'zz-inst';
    let answer!: (r: Response) => void;
    cpFetchMock.mockImplementationOnce(() => new Promise<Response>((r) => { answer = r; }));
    try {
      const claim = call('POST', '/api/google/claim-managed', { claim_nonce: 'zz' });
      while (cpFetchMock.mock.calls.length === 0) await new Promise((r) => setTimeout(r, 10));
      expect(google().grantPending).toBe(true);
      internals().erasureInProgress = true;
      answer(new Response(JSON.stringify(tokens()), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      const res = await claim;
      expect(res.status).toBe(409);
      expect(res.body['code']).toBe('erasure_in_progress');
      expect(google().isAuthenticated()).toBe(false);
      expect(google().grantPending).toBe(false);
    } finally {
      internals().erasureInProgress = false;
      for (const k of MANAGED) delete process.env[k];
    }

    // A claim that arrives while an erasure runs never reaches the control plane.
    process.env['LYNOX_MANAGED_CONTROL_PLANE_URL'] = 'https://cp.example.test';
    process.env['LYNOX_MANAGED_INSTANCE_ID'] = 'zz-inst';
    const callsBefore = cpFetchMock.mock.calls.length;
    internals().erasureInProgress = true;
    try {
      const early = await call('POST', '/api/google/claim-managed', { claim_nonce: 'zz' });
      expect(early.status).toBe(409);
      expect(early.body['code']).toBe('erasure_in_progress');
      expect(cpFetchMock.mock.calls.length).toBe(callsBefore);
    } finally {
      internals().erasureInProgress = false;
      for (const k of MANAGED) delete process.env[k];
    }

    // The mail context keeps the instance it was built with; after a reload that is no
    // longer the engine's, and a grant it still holds is what a refresh writes back.
    const ctx = mail() as unknown as { googleAuth: GoogleAuth | null };
    const bootInstance = ctx.googleAuth;
    const store = new Map<string, string>();
    const older = new GoogleAuth({
      clientId: 'older', clientSecret: 's',
      vault: { get: (k: string) => store.get(k) ?? null, set: (k: string, v: string) => { store.set(k, v); }, delete: (k: string) => store.delete(k) } as unknown as SecretVault,
    });
    await older.setTokens(tokens());
    ctx.googleAuth = older;
    try {
      await expectRefused('google_connected');
    } finally {
      ctx.googleAuth = bootInstance;
    }

    let release!: () => void;
    const pending = google().whileGranting(() => new Promise<void>((r) => { release = r; }));
    try {
      await expectRefused('google_grant_pending');
    } finally {
      release();
      await pending;
    }

    await google().setTokens(tokens());
    expect(google().isAuthenticated()).toBe(true);
    await expectRefused('google_connected');
    expect((await call('POST', '/api/google/revoke')).status).toBe(200);
    expect(google().isAuthenticated()).toBe(false);
  }, 60_000);

  it('refuses while the inbox classifies, reads in an account, or backfills', async () => {
    const rt = engineOf().getInboxRuntime();
    if (rt === null) throw new Error('fixture: the inbox runtime did not boot under LYNOX_FEATURE_UNIFIED_INBOX=1');

    const realQueue = rt.queue;
    rt.queue = { depth: 1 } as unknown as typeof rt.queue;
    try {
      await expectRefused('inbox_queue_busy');
    } finally {
      rt.queue = realQueue;
    }

    // A provider switch rebuilding the runtime re-classifies on the way.
    const eng = engineOf() as unknown as { _inboxRebootstrapInflight: Promise<void> | null };
    eng._inboxRebootstrapInflight = new Promise<void>(() => {});
    try {
      await expectRefused('inbox_queue_busy');
    } finally {
      eng._inboxRebootstrapInflight = null;
    }

    rt.coldStartTracker.start('zz-cold');
    try {
      await expectRefused('inbox_cold_start_running');
    } finally {
      rt.coldStartTracker.fail('zz-cold', 'fixture');
    }

    let finish!: () => void;
    const deps = {
      providerResolver: () => ({}),
      backfillMetadataRunner: () => new Promise<BackfillMetadataReport>((r) => { finish = () => { r({} as BackfillMetadataReport); }; }),
    } as unknown as InboxApiDeps;
    const backfill = handleRunBackfillMetadata(deps, { accountId: 'zz' });
    try {
      await expectRefused('inbox_backfill_running');
    } finally {
      finish();
      await backfill;
    }
  }, 60_000);

  it('refuses while an API connection completes its sign-in, and that callback refuses during an erasure', async () => {
    const counter = api as unknown as { profileGrantsPending: number };
    counter.profileGrantsPending++;
    try {
      await expectRefused('api_grant_pending');
    } finally {
      counter.profileGrantsPending--;
    }

    // The callback counts itself for the whole request: observed from inside it.
    let seen: number | undefined;
    const spy = vi.spyOn(LynoxHTTPApi as unknown as { _readProfileOAuthCookie: () => string | null }, '_readProfileOAuthCookie')
      .mockImplementation(() => { seen = counter.profileGrantsPending; return null; });
    try {
      await fetch(`${baseUrl}/api/oauth/callback?code=x&state=y`, { headers: { Authorization: `Bearer ${SECRET}` } });
      expect(seen).toBe(1);
      expect(counter.profileGrantsPending).toBe(0);
    } finally {
      spy.mockRestore();
    }

    internals().erasureInProgress = true;
    try {
      const during = await fetch(`${baseUrl}/api/oauth/callback?code=x&state=y`, { headers: { Authorization: `Bearer ${SECRET}` } });
      expect(during.status).toBe(409);
    } finally {
      internals().erasureInProgress = false;
    }
  }, 60_000);

  it('refuses a backup or a restore requested while an erasure runs', async () => {
    const bm = engineOf().getBackupManager();
    if (bm === null) throw new Error('fixture: no backup manager');
    const made = await bm.createBackup();
    expect(made.success).toBe(true);
    const id = made.path.split('/').pop()!;
    const countBefore = bm.listBackups().length;
    internals().erasureInProgress = true;
    try {
      const backup = await call('POST', '/api/backups');
      expect(backup.status).toBe(409);
      expect(backup.body['code']).toBe('erasure_in_progress');
      expect(bm.listBackups().length).toBe(countBefore);
      const restore = await call('POST', `/api/backups/${id}/restore`);
      expect(restore.status).toBe(409);
      expect(restore.body['code']).toBe('erasure_in_progress');
    } finally {
      internals().erasureInProgress = false;
    }
  }, 60_000);

  it('refuses while a backup runs', async () => {
    const bm = engineOf().getBackupManager();
    if (bm === null) throw new Error('fixture: no backup manager');
    const counter = bm as unknown as { _running: number };
    counter._running++;
    try {
      await expectRefused('backup_running');
    } finally {
      counter._running--;
    }
  }, 60_000);

  it('erases once every writer is disconnected', async () => {
    expect(mail().registry.list()).toEqual([]);
    expect(google().isAuthenticated()).toBe(false);
    expect(mail().googleAuth?.isAuthenticated() ?? false).toBe(false);
    expect(vaultOf().has('GOOGLE_OAUTH_TOKENS')).toBe(false);

    // A service account counts as authenticated and holds no user grant; it writes nothing
    // to the vault and cannot be disconnected, so it must not refuse the erasure.
    const sa = vi.spyOn(google(), 'isAuthenticated').mockReturnValue(true);
    seedNothingErased();
    const res = await erase();
    sa.mockRestore();
    expect(res.body['failed'] ?? []).toEqual([]);
    expect(res.status).toBe(200);
    expect(res.body['message']).toBe('All user data has been permanently deleted');
    expect(existsSync(MARK_PATH())).toBe(false);
    expect(vaultOf().get('ZZ_SEED')).toBeNull();
  }, 60_000);

  function accountBody(): Record<string, unknown> {
    return {
      id: ACCOUNT.id, displayName: ACCOUNT.displayName, address: ACCOUNT.address, preset: 'fastmail', type: ACCOUNT.type,
      credentials: { user: ACCOUNT.address, pass: `p-${randomBytes(6).toString('hex')}` },
    };
  }
});
