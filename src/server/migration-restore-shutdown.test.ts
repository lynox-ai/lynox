import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type Anthropic from '@anthropic-ai/sdk';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import { EngineDb } from '../core/engine-db.js';
import { RESTORE_INBOX_BOUND_MS } from '../core/engine.js';
import { MigrationExporter } from '../core/migration-export.js';
import type { MigrationImporter } from '../core/migration-import.js';
import { MailStateDb } from '../integrations/mail/state.js';
import { bootstrapInbox, type InboxRuntime } from '../integrations/inbox/bootstrap.js';
import type { InboxQueuePayload } from '../integrations/inbox/runner.js';
import { generateEphemeralKeypair, serializePublicKey, deserializePublicKey, deriveTransferKey } from '../core/migration-crypto.js';

/**
 * The shutdown a migration restore runs before it replaces the databases. A backlog in the inbox
 * classifier queue would hold it for as long as classifying the backlog takes, and an inbox
 * rebootstrap had no bound at all: the instance answered 503 until someone restarted it. Measured
 * on a real engine boot, through the route.
 */
describe('the shutdown before a migration restore', () => {
  const SECRET = `t-${randomBytes(12).toString('hex')}`;
  const SRC_KEY = `s-${randomBytes(12).toString('hex')}`;
  let api: LynoxHTTPApi;
  let baseUrl: string;
  let dir: string;
  let src: string;
  let mail: MailStateDb | null = null;
  const saved: Record<string, string | undefined> = {};
  const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE'];

  type EngineInternals = { _inboxRuntime: InboxRuntime | null; _inboxRebootstrapInflight: Promise<void> | null };
  const engine = (): EngineInternals => (api as unknown as { engine: EngineInternals }).engine;

  /** A migration session holding the source's bundle, set up as the handshake/manifest/chunk routes do. */
  async function session(): Promise<MigrationImporter> {
    const importer = await (api as unknown as { _getOrCreateMigrationImporter: () => Promise<MigrationImporter | null> })._getOrCreateMigrationImporter();
    if (importer === null) throw new Error('fixture: no importer');
    const sh = importer.startHandshake('e'.repeat(64));
    const kp = generateEphemeralKeypair();
    const key = deriveTransferKey(kp.privateKey, deserializePublicKey(sh.serverPubKey), Buffer.from(sh.challengeNonce, 'hex'));
    importer.completeHandshake(serializePublicKey(kp.publicKey));
    const { manifest, chunks } = new MigrationExporter({ lynoxDir: src, vaultKey: SRC_KEY }).export(key);
    importer.setManifest(manifest);
    for (const c of chunks) importer.receiveChunk(c);
    return importer;
  }

  /**
   * A real inbox runtime with `jobs` mails in its queue, installed in the running engine. Each
   * classification takes 200 ms: classifying the backlog two at a time takes seconds. `hang`
   * makes it never answer within the test: the running jobs outlast the bound, as a call that
   * does not honour its timeout would.
   */
  async function inboxWithBacklog(jobs: number, classify: 'slow' | 'hang' = 'slow'): Promise<{ runtime: InboxRuntime; classifierCalls: () => number }> {
    mail = new MailStateDb({ path: ':memory:' });
    mail.upsertAccount({
      id: 'acct-1', displayName: 'Me', address: 'me@acme.example', preset: 'custom',
      imap: { host: 'i', port: 993, secure: true }, smtp: { host: 's', port: 465, secure: true },
      authType: 'imap', type: 'personal', isDefault: true,
    });
    const create = vi.fn(async () => {
      await new Promise((r) => { if (classify === 'slow') setTimeout(r, 200); });
      return { content: [{ type: 'text', text: JSON.stringify({ bucket: 'auto_handled', confidence: 0.9, one_line_why_de: 'Newsletter' }) }], usage: { input_tokens: 1, output_tokens: 1 } };
    });
    const runtime = bootstrapInbox({ mailStateDb: mail, anthropicClient: { messages: { create } } as unknown as Anthropic });
    for (let n = 1; n <= jobs; n++) {
      const payload: InboxQueuePayload = {
        accountId: 'acct-1',
        threadKey: `imap:t${String(n)}`,
        classifierInput: { accountAddress: 'me@acme.example', accountDisplayName: 'Me', subject: `S${String(n)}`, fromAddress: 'a@example.com', fromDisplayName: 'A', body: `B${String(n)}` },
        envelope: { fromAddress: 'a@example.com', subject: `S${String(n)}`, messageId: `<m${String(n)}@x>` },
      };
      expect(runtime.queue.enqueue(payload)).toBe(true);
    }
    for (let i = 0; i < 200 && runtime.queue.activeCount < 2; i++) await new Promise((r) => setImmediate(r));
    expect(runtime.queue.activeCount, 'fixture: two jobs running').toBe(2);
    engine()._inboxRuntime = runtime;
    return { runtime, classifierCalls: () => create.mock.calls.length };
  }

  const versions = (): string[] =>
    (mail!.getConnection().prepare('SELECT classifier_version FROM inbox_items').all() as Array<{ classifier_version: string }>).map((r) => r.classifier_version);

  beforeAll(() => {
    for (const k of ENV) saved[k] = process.env[k];
    src = mkdtempSync(join(tmpdir(), 'lynox-restore-sd-src-'));
    new EngineDb(join(src, 'engine.db'), SRC_KEY).close();
  });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-restore-sd-'));
    process.env['LYNOX_DATA_DIR'] = dir;
    process.env['LYNOX_HTTP_SECRET'] = SECRET;
    process.env['LYNOX_ALLOW_PLAIN_HTTP'] = 'true';
    process.env['LYNOX_VAULT_KEY'] = `v-${randomBytes(12).toString('hex')}`;
    delete process.env['LYNOX_BILLING_TIER'];
    delete process.env['LYNOX_MANAGED_MODE'];
    reloadConfig();
    api = new LynoxHTTPApi();
    await api.init();
    await api.start(0);
    const addr = (api as unknown as { server: Server | null }).server?.address();
    if (addr === null || addr === undefined || typeof addr === 'string') throw new Error('no port');
    baseUrl = `http://127.0.0.1:${String(addr.port)}`;
    // The route answers on a managed instance only and reads the tier per request.
    process.env['LYNOX_BILLING_TIER'] = 'starter';
  }, 120_000);

  afterEach(async () => {
    vi.useRealTimers();
    engine()._inboxRebootstrapInflight = null;
    engine()._inboxRuntime = null; // a hung runtime would hold the plain shutdown below
    await api?.shutdown().catch(() => undefined);
    await new Promise<void>((r) => { const s = (api as unknown as { server: Server | null }).server; if (s === null) r(); else s.close(() => r()); });
    try { mail?.close(); } catch { /* closed */ }
    mail = null;
    rmSync(dir, { recursive: true, force: true });
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(src, { recursive: true, force: true });
    reloadConfig();
  });

  it('a backlog of 100 waiting mails does not hold the restore: they are surfaced unclassified', async () => {
    const { classifierCalls } = await inboxWithBacklog(102);
    await session();

    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      const started = Date.now();
      const res = await fetch(`${baseUrl}/api/migration/restore`, { method: 'POST', headers: { Authorization: `Bearer ${SECRET}` } });
      const tookMs = Date.now() - started;
      expect(res.status).toBe(200);
      // Classifying the backlog two at a time would take over 10 s.
      expect(tookMs).toBeLessThan(5_000);
      expect(versions().filter((v) => v === 'restore-drain')).toHaveLength(100);
      expect(classifierCalls()).toBe(2);
      await new Promise((r) => setTimeout(r, 1100));
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      exit.mockRestore();
    }
  }, 120_000);

  it('an inbox shutdown that never settles ends the restore after the bound: no restore, a restart', async () => {
    await inboxWithBacklog(4, 'hang');
    const importer = await session();
    const restore = vi.spyOn(importer, 'restore');

    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let res: Response | undefined;
      void fetch(`${baseUrl}/api/migration/restore`, { method: 'POST', headers: { Authorization: `Bearer ${SECRET}` } }).then((r) => { res = r; });
      // Just short of the bound nothing has answered yet.
      for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
      await vi.advanceTimersByTimeAsync(RESTORE_INBOX_BOUND_MS - 1_000);
      for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
      expect(res, 'answered before the bound').toBeUndefined();
      await vi.advanceTimersByTimeAsync(1_000);
      for (let i = 0; i < 200 && res === undefined; i++) await new Promise((r) => setImmediate(r));
      expect(res?.status).toBe(500);
      expect(((await res!.json()) as { error?: string }).error).toMatch(/inbox shutdown did not settle within 60 s/);
      expect(restore).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
      exit.mockRestore();
    }
  }, 120_000);

  it('a rebootstrap that failed does not stop the restore', async () => {
    await session();
    const failed = Promise.reject(new Error('rebootstrap boom'));
    failed.catch(() => undefined);
    engine()._inboxRebootstrapInflight = failed;

    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      const res = await fetch(`${baseUrl}/api/migration/restore`, { method: 'POST', headers: { Authorization: `Bearer ${SECRET}` } });
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 1100));
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      exit.mockRestore();
    }
  }, 120_000);

  it('a shutdown other than the restore still classifies the backlog', async () => {
    const { classifierCalls } = await inboxWithBacklog(6);

    await api.shutdown();

    expect(classifierCalls()).toBe(6);
    expect(versions().filter((v) => v === 'restore-drain')).toEqual([]);
    expect(versions()).toHaveLength(6);
  }, 120_000);
});
