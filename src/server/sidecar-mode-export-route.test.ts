import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { MigrationImporter } from '../core/migration-import.js';
import { deriveSigningKey, signHandshake, type MigrationManifest } from '../core/migration-crypto.js';
import { TARGET_BODY_CAPS } from '../core/migration-target-reply.js';

// A target that sends slowly is given up on after this long here (30 s in production).
vi.mock('../core/migration-target-reply.js', async (original) => ({
  ...(await original<typeof import('../core/migration-target-reply.js')>()),
  TARGET_BODY_TIMEOUT_MS: 1500,
  TARGET_REQUEST_TIMEOUTS_MS: { handshake: 300, manifest: 400, chunk: 500, restore: 3000 },
  // The whole transfer's deadline (from the bundle's size in production), set per test here.
  transferDeadlineMs: () => transferDeadline.ms,
}));
const transferDeadline = vi.hoisted(() => ({ ms: 60_000 }));
import { resetShellIsolationForTest, setShellIsolationForTest, type ShellIsolation } from '../core/shell-isolation.js';
import { _resetWorkspaceAccess } from '../core/workspace-access.js';

/**
 * The target of the export: a real importer in a temp dir, answering the four calls the route
 * makes. The route reaches the network only through `network-guard.js` (imported lazily there),
 * so stubbing that module is the seam: the route, the exporter and the transfer run for real.
 */
const target: {
  importer: MigrationImporter | null; manifest: MigrationManifest | null;
  /** The health body the target answers (absent: 404). */
  health?: unknown; healthCalls: number;
  /** Answer the handshake with `acceptsPlainStores: true` whatever the importer says. */
  claimsPlain?: boolean;
  /** Answer the handshake completion with 500. */
  failCompletion?: boolean;
  /** Refuse the manifest with this `error` (any JSON value). */
  manifestError?: unknown;
  /** The status of that refusal (default 422). */
  manifestStatus?: number | undefined;
  /** Refuse the manifest with this raw body. */
  manifestRaw?: string | undefined;
  /** Refuse the chunk at this index with this `error`. */
  chunkError?: { at: number; error: string } | undefined;
  /** Refuse the restore with this `error`. */
  restoreError?: string | undefined;
  /** Refuse the restore with this status and `error`. */
  restoreStatus?: { status: number; error: string } | undefined;
  /** Fail this request as a refused connection would. */
  unreachable?: 'handshake' | 'manifest' | 'chunk' | undefined;
  /** Answer the handshake with a server key that does not parse. */
  badKey?: boolean;
  /** Answer the handshake with a signature that does not check. */
  badSignature?: boolean;
  /** Answer the handshake with a valid, signed key on another curve. */
  otherCurve?: boolean;
  /** Fail the restore request with the network guard's own refusal. */
  guardBlocksRestore?: boolean;
  /** The text of that refusal, when not the default one. */
  guardText?: string | undefined;
  /** Answer this step with a body of `bytes` bytes: the handshake, its refusal, or the restore's report. */
  large?: { at: 'handshake' | 'handshake-refusal' | 'restore'; bytes: number } | undefined;
  /** Answer the handshake with this raw body and 200. */
  handshakeRaw?: string | undefined;
  /** Answer this step with a body that starts and never ends. */
  slow?: 'handshake' | 'handshake-refusal' | 'manifest' | 'restore' | undefined;
  /** Answer each part and the restore after this long (each inside its own deadline). */
  lagMs?: number | undefined;
  /** Parts answered after their lag. */
  partsAnswered: number;
  /** The last part's answer: its body ends after this long (inside the body's own deadline). */
  lastPartBodyLagMs?: number | undefined;
  /** Answer the restore with this raw body and 200. */
  restoreRaw?: string | undefined;
  /** Answer this step with a refusal whose body breaks off mid-way. */
  broken?: 'handshake-refusal' | 'manifest' | undefined;
  /** Refuse the handshake with 400 and this body. */
  handshakeRefusal?: { error: string; code?: string } | undefined;
  /** Never start answering this request (until it is aborted). */
  silent?: 'handshake' | 'completion' | 'manifest' | 'chunk' | 'restore' | undefined;
  /** Every answer the target gave with 200 to a manifest or a chunk, to see that the source read it. */
  okBodies: Response[];
  /** Answer the restore with this `verification`. */
  restoreReport?: unknown;
  /**
   * How the target answers `POST /api/migration/abort`: with its importer (`real`), with this status
   * and body, or not at all (absent: 404, as an older target without the route).
   */
  abort?: 'real' | { status: number; body: unknown } | undefined;
  /** The session ids every abort the source sent named. */
  abortCalls: unknown[];
  /** Answer the handshake without its session id, as an older target. */
  noSessionId?: boolean;
} = { importer: null, manifest: null, healthCalls: 0, okBodies: [], abortCalls: [], partsAnswered: 0 };
/** A body that sends its first bytes and then breaks off. */
const brokenOff = (status: number): Response => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{"error":"x')); c.error(new Error('other side closed')); } }), { status });
/** A body that sends its first bytes and never ends. */
const endless = (status: number): Response => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{"a')); } }), { status });
/** A JSON body of exactly `bytes` bytes, `fields` and a filler. */
const sized = (fields: Record<string, unknown>, bytes: number): string => {
  const bare = JSON.stringify({ ...fields, pad: '' });
  return JSON.stringify({ ...fields, pad: 'x'.repeat(bytes - Buffer.byteLength(bare)) });
};
/** Every transfer key the route derives, to see whether it is zeroized. */
const derivedKeys: Buffer[] = [];
const TOKEN = 'e'.repeat(64);
const IS_ROOT = process.getuid?.() === 0;

vi.mock('../core/network-guard.js', async (original) => {
  const real = await original<typeof import('../core/network-guard.js')>();
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  return {
    ...real,
    assertPublicUrl: vi.fn(async () => undefined),
    fetchPinned: vi.fn(async (url: string, init: RequestInit = {}) => {
      const imp = target.importer!;
      const path = new URL(url).pathname;
      const body = typeof init.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
      const method = init.method ?? 'GET';
      const step = path === '/api/migration/handshake' ? (method === 'GET' ? 'handshake' : 'completion') : path.split('/').pop();
      if (target.unreachable !== undefined && target.unreachable === step) {
        throw Object.assign(new Error('connect ECONNREFUSED 203.0.113.7:443'), { code: 'ECONNREFUSED' });
      }
      if (target.otherCurve && step === 'handshake') {
        const p = target.importer!.startHandshake(TOKEN);
        const foreign = generateKeyPairSync('ec', { namedCurve: 'secp256k1' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
        return json({ ...p, serverPubKey: foreign, signature: signHandshake(foreign, deriveSigningKey(TOKEN)) });
      }
      if (target.guardBlocksRestore && step === 'restore') throw new Error(target.guardText ?? 'Blocked: the redirect points to a private address');
      if (target.badSignature && step === 'handshake') {
        const p = target.importer!.startHandshake(TOKEN);
        return json({ ...p, signature: '00'.repeat(32) });
      }
      if (target.badKey && step === 'handshake') {
        // A key that does not parse, signed with the token as a real target would: it passes the check.
        const p = target.importer!.startHandshake(TOKEN);
        const key = deriveSigningKey(TOKEN);
        return json({ ...p, serverPubKey: 'not-a-key', signature: signHandshake('not-a-key', key) });
      }
      if (target.silent !== undefined && target.silent === step) {
        return new Promise<Response>((_resolve, reject) => { init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
      }
      if (target.lagMs !== undefined && (path === '/api/migration/chunk' || path === '/api/migration/restore')) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, target.lagMs);
          init.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
        });
        if (path === '/api/migration/chunk') target.partsAnswered++;
      }
      try {
        if (path === '/api/health') { target.healthCalls++; return target.health === undefined ? json({ error: 'none' }, 404) : json(target.health); }
        if (path === '/api/migration/handshake' && (init.method ?? 'GET') === 'GET' && target.broken === 'handshake-refusal') return brokenOff(503);
        if (path === '/api/migration/manifest' && target.broken === 'manifest') return brokenOff(422);
        if (path === '/api/migration/handshake' && (init.method ?? 'GET') === 'GET' && target.handshakeRefusal) return json(target.handshakeRefusal, 400);
        if (path === '/api/migration/handshake' && (init.method ?? 'GET') === 'GET' && target.slow === 'handshake') return endless(200);
        if (path === '/api/migration/handshake' && (init.method ?? 'GET') === 'GET' && target.slow === 'handshake-refusal') return endless(503);
        if (path === '/api/migration/manifest' && target.slow === 'manifest') return endless(422);
        if (path === '/api/migration/restore' && target.slow === 'restore') return endless(200);
        if (path === '/api/migration/restore' && target.restoreRaw !== undefined) return new Response(target.restoreRaw, { status: 200 });
        if (path === '/api/migration/handshake' && (init.method ?? 'GET') === 'GET' && target.handshakeRaw !== undefined) return new Response(target.handshakeRaw, { status: 200 });
        if (path === '/api/migration/handshake' && (init.method ?? 'GET') === 'GET' && target.large?.at === 'handshake') return new Response(sized({ ...imp.startHandshake(TOKEN) }, target.large.bytes), { status: 200 });
        if (path === '/api/migration/handshake' && (init.method ?? 'GET') === 'GET' && target.large?.at === 'handshake-refusal') return new Response('x'.repeat(target.large.bytes), { status: 503 });
        if (path === '/api/migration/handshake' && (init.method ?? 'GET') === 'GET') {
          const { sessionId, ...older } = imp.startHandshake(TOKEN);
          return json({ ...older, ...(target.noSessionId ? {} : { sessionId }), ...(target.claimsPlain ? { acceptsPlainStores: true } : {}) });
        }
        if (path === '/api/migration/abort' && target.abort !== undefined) {
          const named = (body as { sessionId?: unknown } | undefined)?.sessionId;
          target.abortCalls.push(named);
          if (target.abort !== 'real') return json(target.abort.body, target.abort.status);
          const outcome = imp.abortBeforeManifest(typeof named === 'string' ? named : '');
          return outcome === 'in-transfer' ? json({ error: 'in transfer', code: 'migration_in_transfer' }, 409) : json({ aborted: outcome === 'aborted' });
        }
        if (path === '/api/migration/handshake') {
          if (target.failCompletion) return json({ error: 'completion refused' }, 500);
          imp.completeHandshake((body as { clientPubKey: string }).clientPubKey); return json({ ready: true });
        }
        if (path === '/api/migration/manifest' && target.manifestRaw !== undefined) return new Response(target.manifestRaw, { status: 422 });
        if (path === '/api/migration/manifest' && target.manifestError !== undefined) return json({ error: target.manifestError }, target.manifestStatus ?? 422);
        if (path === '/api/migration/manifest') { target.manifest = body as MigrationManifest; imp.setManifest(target.manifest); const r = json({ accepted: true }); target.okBodies.push(r); return r; }
        if (path === '/api/migration/chunk' && target.chunkError && (body as { seq: number }).seq === target.chunkError.at) return json({ error: target.chunkError.error }, 422);
        if (path === '/api/migration/restore' && target.restoreError !== undefined) return json({ error: target.restoreError }, 500);
        if (path === '/api/migration/restore' && target.restoreStatus) return json({ error: target.restoreStatus.error }, target.restoreStatus.status);
        if (path === '/api/migration/chunk' && target.lastPartBodyLagMs !== undefined && (body as { seq: number }).seq === (target.manifest?.chunks.length ?? 0) - 1) {
          imp.receiveChunk(body as Parameters<MigrationImporter['receiveChunk']>[0]);
          const lag = target.lastPartBodyLagMs;
          return new Response(new ReadableStream<Uint8Array>({ start(c) { setTimeout(() => { c.enqueue(new TextEncoder().encode('{}')); c.close(); }, lag); } }), { status: 200 });
        }
        if (path === '/api/migration/chunk') { const r = json(imp.receiveChunk(body as Parameters<MigrationImporter['receiveChunk']>[0])); target.okBodies.push(r); return r; }
        // The target's restore is not under test: answered without writing.
        if (path === '/api/migration/restore' && target.large?.at === 'restore') return new Response(sized({ success: true, verification: {} }, target.large.bytes), { status: 200 });
        if (path === '/api/migration/restore' && target.restoreReport !== undefined) return json({ success: true, verification: target.restoreReport });
        if (path === '/api/migration/restore') return json({ success: true, verification: {} });
      } catch (err: unknown) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
      return json({ error: `unexpected ${path}` }, 404);
    }),
  };
});

vi.mock('../core/migration-crypto.js', async (original) => {
  const real = await original<typeof import('../core/migration-crypto.js')>();
  return { ...real, deriveTransferKey: vi.fn((...args: Parameters<typeof real.deriveTransferKey>) => { const k = real.deriveTransferKey(...args); derivedKeys.push(k); return k; }) };
});

const { LynoxHTTPApi } = await import('./http-api.js');
const { reloadConfig } = await import('../core/config.js');

/**
 * Walker 2 through its route (PRD D7): `POST /api/migration/export` in shell sidecar mode, the
 * tier unset. The workspace is left out of what reaches the target, the rest goes, and the
 * route's result says so. A pool directory at `chmod 000` is in the workspace: wired to a walk,
 * the export would end in an error event instead.
 */
describe('the migration export route in sidecar mode (real engine)', () => {
  const SECRET = `t-${randomBytes(12).toString('hex')}`;
  const sidecar = { kind: 'sidecar', socket: '/run/lynox/shell.sock', root: {} } as unknown as ShellIsolation;
  let api: InstanceType<typeof LynoxHTTPApi>;
  let baseUrl: string;
  let dir: string;
  let dst: string;
  let locked: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE'];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-sidecar-export-'));
    dst = mkdtempSync(join(tmpdir(), 'lynox-sidecar-export-dst-'));
    for (const k of ENV) saved[k] = process.env[k];
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
    mkdirSync(join(dir, 'apis'), { recursive: true });
    writeFileSync(join(dir, 'apis', 'shop.json'), '{"id":"shop"}');
    locked = join(dir, 'workspace', 'pool-7');
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(dir, 'workspace', 'mine.txt'), 'ZZ-mine');
    chmodSync(locked, 0o000);
    _resetWorkspaceAccess();
  }, 120_000);

  afterEach(() => {
    resetShellIsolationForTest();
    target.importer?.cleanup();
    target.importer = null;
    target.manifest = null;
    target.health = undefined;
    target.healthCalls = 0;
    target.claimsPlain = false;
    target.failCompletion = false;
    target.manifestError = undefined;
    target.manifestRaw = undefined;
    target.chunkError = undefined;
    target.restoreError = undefined;
    target.large = undefined;
    target.handshakeRaw = undefined;
    target.restoreReport = undefined;
    target.slow = undefined;
    target.lagMs = undefined;
    target.partsAnswered = 0;
    target.lastPartBodyLagMs = undefined;
    transferDeadline.ms = 60_000;
    target.restoreRaw = undefined;
    target.silent = undefined;
    target.okBodies = [];
    target.handshakeRefusal = undefined;
    target.broken = undefined;
    target.restoreStatus = undefined;
    target.unreachable = undefined;
    target.badKey = false;
    target.badSignature = false;
    target.otherCurve = false;
    target.guardBlocksRestore = false;
    target.guardText = undefined;
    target.abort = undefined;
    target.abortCalls = [];
    target.manifestStatus = undefined;
    target.noSessionId = false;
    derivedKeys.length = 0;
  });

  afterAll(async () => {
    try {
      await api?.shutdown();
    } finally {
      chmodSync(locked, 0o700);
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
      rmSync(dst, { recursive: true, force: true });
      reloadConfig();
    }
  });

  /** Runs the export and returns the SSE events by name. */
  async function exportTo(opts: { acceptPlainStores?: boolean; sameTarget?: boolean } = {}): Promise<Map<string, unknown>> {
    // `sameTarget`: the importer of the attempt before, with whatever session it still holds.
    if (opts.sameTarget !== true || target.importer === null) {
      target.importer = new MigrationImporter({ lynoxDir: dst, vaultKey: 'a-dst-vault-key-for-the-route-test', acceptPlainStores: opts.acceptPlainStores === true });
    }
    const res = await fetch(`${baseUrl}/api/migration/export`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUrl: 'https://target.example', migrationToken: TOKEN }),
    });
    expect(res.status).toBe(200);
    const events = new Map<string, unknown>();
    for (const block of (await res.text()).split('\n\n')) {
      const name = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (name !== undefined && data !== undefined) events.set(name, JSON.parse(data));
    }
    return events;
  }

  it('leaves the workspace out of what reaches the target, carries the rest, and says so', async () => {
    setShellIsolationForTest(sidecar);
    const events = await exportTo();
    expect(events.get('error')).toBeUndefined();
    expect(events.get('done')).toMatchObject({ success: true, workspace: 'omitted-sidecar' });
    const names = target.manifest!.chunks.map(c => c.name);
    expect(names).toContain('apis');
    expect(names.filter(n => n.split(':')[0] === 'workspace')).toEqual([]);
  });

  // As root a `chmod 000` directory closes nothing, so there is no failure to show.
  it.skipIf(IS_ROOT)('control: in local mode the same route walks the tree and fails on the closed directory', async () => {
    const events = await exportTo();
    expect(events.get('done')).toBeUndefined();
    expect((events.get('error') as { message: string }).message).toMatch(/EACCES|permission/i);
  });

  const HEALTH = { migration: { import_limit_mb: 100_000, baseline_mb: 1, k: 1.5, rest_factor: 1 } };
  const typeOf = (store: string): string | undefined => target.manifest?.chunks.find(c => c.name === store || c.name === `${store}:part0`)?.type;

  it('sends the stores as plaintext to a destination that takes them and publishes its numbers', async () => {
    setShellIsolationForTest(sidecar);
    target.health = HEALTH;
    const events = await exportTo({ acceptPlainStores: true });
    expect(events.get('error')).toBeUndefined();
    expect(typeOf('engine.db')).toBe('sqlite_db_plain');
    expect((events.get('done') as { plain: { stores: Array<{ store: string; path: string }> } }).plain.stores.find(s => s.store === 'engine.db')?.path).toBe('plain');
  });

  it('sends the stores raw, as today, when the destination does not say it takes plaintext, without asking its health', async () => {
    setShellIsolationForTest(sidecar);
    target.health = HEALTH;
    const events = await exportTo();
    expect(events.get('error')).toBeUndefined();
    expect(typeOf('engine.db')).toBe('sqlite_db');
    expect(target.healthCalls).toBe(0);
    expect((events.get('done') as { plain?: unknown }).plain).toBeUndefined();
  });

  it('sends the stores raw when the destination takes plaintext but its health body has no usable numbers', async () => {
    setShellIsolationForTest(sidecar);
    target.health = { migration: { ...HEALTH.migration, k: 0 } };
    const events = await exportTo({ acceptPlainStores: true });
    expect(events.get('error')).toBeUndefined();
    expect(target.healthCalls).toBe(1);
    expect(typeOf('engine.db')).toBe('sqlite_db');
  });

  it('shows a destination\'s refusal as its own text', async () => {
    setShellIsolationForTest(sidecar);
    // The handshake says yes, the importer does not take plaintext: it refuses the manifest.
    target.claimsPlain = true;
    target.health = HEALTH;
    const events = await exportTo();
    expect((events.get('error') as { message: string }).message)
      .toBe('The target instance refused the migration. It says: "The manifest carries a store as plaintext, which the target instance does not take yet; the source has to send it raw.". You can start the migration again in 30 minutes at the latest.');
  });

  it('shows at most 500 characters of a destination\'s text, and marks the cut', async () => {
    setShellIsolationForTest(sidecar);
    target.manifestError = 'x'.repeat(499) + 'yz';
    expect(((await exportTo()).get('error') as { message: string }).message).toBe(`The target instance refused the migration. It says: "${'x'.repeat(499)}y…". You can start the migration again in 30 minutes at the latest.`);
    target.manifestError = 'x'.repeat(500);
    expect(((await exportTo()).get('error') as { message: string }).message).toBe(`The target instance refused the migration. It says: "${'x'.repeat(500)}". You can start the migration again in 30 minutes at the latest.`);
  });

  it('keeps the raw answer in quotes after the step\'s own sentence when the destination gives no usable error text', async () => {
    setShellIsolationForTest(sidecar);
    for (const error of ['', 42, null]) {
      target.manifestError = error;
      expect(((await exportTo()).get('error') as { message: string }).message).toBe(`The target instance refused the migration. It says: ${JSON.stringify(JSON.stringify({ error }))}. You can start the migration again in 30 minutes at the latest.`);
    }
    target.manifestError = undefined;
    target.manifestRaw = 'bad gateway';
    expect(((await exportTo()).get('error') as { message: string }).message).toBe('The target instance refused the migration. It says: "bad gateway". You can start the migration again in 30 minutes at the latest.');
    // No words left to quote, in the error text or the raw answer: said as such, never as empty quotes.
    target.manifestRaw = undefined;
    for (const error of ['\n\t ', '\u202e']) {
      target.manifestError = error;
      expect(((await exportTo()).get('error') as { message: string }).message).toBe('The target instance refused the migration. The target instance gave no readable reason. You can start the migration again in 30 minutes at the latest.');
    }
    target.manifestError = undefined;
    for (const raw of ['', ' \u200b ']) {
      target.manifestRaw = raw;
      expect(((await exportTo()).get('error') as { message: string }).message).toBe('The target instance refused the migration. The target instance gave no readable reason. You can start the migration again in 30 minutes at the latest.');
    }
  });

  it('reads each answer of the destination up to its cap and names the step when one is larger', async () => {
    setShellIsolationForTest(sidecar);
    const message = async (): Promise<string | undefined> => ((await exportTo()).get('error') as { message: string } | undefined)?.message;
    // The handshake's key material: at the cap it is read and the migration goes on, one byte over it is not read.
    target.large = { at: 'handshake', bytes: TARGET_BODY_CAPS.handshake };
    expect(await message()).toBeUndefined();
    target.large = { at: 'handshake', bytes: TARGET_BODY_CAPS.handshake + 1 };
    expect(await message()).toBe('lynox could not set up the connection to the target instance: its answer is over 64 KiB, so lynox did not read it. Nothing was transferred. You can start the migration again in 30 minutes at the latest.');
    // The handshake's refusal.
    target.large = { at: 'handshake-refusal', bytes: TARGET_BODY_CAPS.handshake + 1 };
    expect(await message()).toBe('lynox could not set up the connection to the target instance: its answer is over 64 KiB, so lynox did not read it. Nothing was transferred. You can start the migration again in 30 minutes at the latest.');
    target.large = { at: 'handshake-refusal', bytes: 600 };
    expect(await message()).toBe(`The target instance did not accept the migration. It says: "${'x'.repeat(500)}…". Nothing was transferred.`);
    // A refusal of the manifest (the same reader serves the chunks and the restore).
    target.large = undefined;
    target.manifestRaw = 'x'.repeat(TARGET_BODY_CAPS.refusal + 1);
    expect(await message()).toBe('The target instance refused the migration. Its answer is over 64 KiB, so lynox did not read it. You can start the migration again in 30 minutes at the latest.');
    target.manifestRaw = 'x'.repeat(TARGET_BODY_CAPS.refusal);
    expect(await message()).toBe(`The target instance refused the migration. It says: "${'x'.repeat(500)}…". You can start the migration again in 30 minutes at the latest.`);
    // The restore's report.
    target.manifestRaw = undefined;
    target.large = { at: 'restore', bytes: TARGET_BODY_CAPS.restore };
    expect(await message()).toBeUndefined();
    target.large = { at: 'restore', bytes: TARGET_BODY_CAPS.restore + 1 };
    expect(await message()).toBe('The target instance\'s report on restoring the data could not be read: its answer is over 8 MiB. Check on the target instance whether your data arrived before you migrate again.');
  });

  it('fails on an answer that is not JSON without quoting it, and says what the user can know', async () => {
    setShellIsolationForTest(sidecar);
    const message = async (): Promise<string | undefined> => ((await exportTo()).get('error') as { message: string } | undefined)?.message;
    target.handshakeRaw = 'not json \u202E at all';
    expect(await message()).toBe('lynox could not set up the connection to the target instance: its answer is not in the expected format. Nothing was transferred. You can start the migration again in 30 minutes at the latest.');
    target.handshakeRaw = undefined;
    target.restoreRaw = 'not json';
    expect(await message()).toBe('The target instance\'s report on restoring the data could not be read: its answer is not in the expected format. Check on the target instance whether your data arrived before you migrate again.');
  });

  it('says that the target still holds an earlier attempt, by its code or by an older target\'s text', async () => {
    setShellIsolationForTest(sidecar);
    const message = async (): Promise<string | undefined> => ((await exportTo()).get('error') as { message: string } | undefined)?.message;
    const told = 'The target instance is still holding an earlier migration attempt, so it did not accept a new one. Nothing was transferred. You can start the migration again in 30 minutes at the latest.';
    // The importer's own refusal text, pinned: the older targets in the fleet send it without a code.
    const imp = new MigrationImporter({ lynoxDir: dst, vaultKey: 'a-dst-vault-key-for-the-route-test' });
    imp.startHandshake(TOKEN);
    expect(() => imp.startHandshake(TOKEN)).toThrow(/^Migration session already active/);
    imp.cleanup();
    target.handshakeRefusal = { error: 'Migration session already active. Finalize or cleanup first.' };
    expect(await message()).toBe(told);
    target.handshakeRefusal = { error: 'something else', code: 'migration_session_active' };
    expect(await message()).toBe(told);
    // Control: another refusal is shown as the target's text.
    target.handshakeRefusal = { error: 'Invalid migration token' };
    expect(await message()).toBe('The target instance did not accept the migration. It says: "Invalid migration token". Nothing was transferred.');
    // A refusal without any words of its own.
    for (const error of ['', '\n\t ', '\u202e']) {
      target.handshakeRefusal = { error };
      expect(await message()).toBe('The target instance did not accept the migration. The target instance gave no readable reason. Nothing was transferred.');
    }
  });

  it('ends the target\'s session when it stops before the manifest, so the next attempt goes through at once', async () => {
    setShellIsolationForTest(sidecar);
    target.abort = 'real';
    target.failCompletion = true;
    const first = await exportTo();
    expect((first.get('error') as { message: string }).message).toBe('lynox could not finish setting up the connection to the target instance. Nothing was transferred. You can start the migration again now.');
    expect(target.abortCalls).toHaveLength(1);
    expect(target.abortCalls[0]).toMatch(/^[0-9a-f]{32}$/);
    // The same target, at once: its session is gone, so the handshake is not turned away.
    target.failCompletion = false;
    const second = await exportTo({ sameTarget: true });
    expect(second.get('error')).toBeUndefined();
    expect(second.get('done')).toMatchObject({ success: true });
  });

  it('after a refused manifest, lets the target\'s words stand alone once it ended the session', async () => {
    setShellIsolationForTest(sidecar);
    const message = async (): Promise<string | undefined> => ((await exportTo()).get('error') as { message: string } | undefined)?.message;
    target.manifestError = 'The bundle names a store this instance does not know';
    target.abort = 'real';
    expect(await message()).toBe('The target instance refused the migration. It says: "The bundle names a store this instance does not know".');
    // Not confirmed: the session may still be held, so the 30 minutes stay.
    target.abort = { status: 200, body: { aborted: false } };
    expect(await message()).toBe('The target instance refused the migration. It says: "The bundle names a store this instance does not know". You can start the migration again in 30 minutes at the latest.');
    expect(target.abortCalls).toHaveLength(2);
    // The target failing or busy is no refusal of the manifest: once the session ended, start again now.
    target.abort = 'real';
    for (const status of [503, 429]) {
      target.manifestStatus = status;
      expect(await message()).toBe('The target instance refused the migration. It says: "The bundle names a store this instance does not know". You can start the migration again now.');
    }
  });

  it('keeps the 30 minutes where the target did not confirm that it ended the session', async () => {
    setShellIsolationForTest(sidecar);
    const message = async (): Promise<string | undefined> => ((await exportTo()).get('error') as { message: string } | undefined)?.message;
    const later = 'lynox could not finish setting up the connection to the target instance. Nothing was transferred. You can start the migration again in 30 minutes at the latest.';
    target.failCompletion = true;
    // An older target: no route (404), or no session id in its handshake, so no abort is sent.
    expect(await message()).toBe(later);
    target.abort = 'real';
    target.noSessionId = true;
    expect(await message()).toBe(later);
    expect(target.abortCalls).toEqual([]);
    target.noSessionId = false;
    // The target answers, but does not say it ended the session.
    for (const abort of [{ status: 200, body: { aborted: false } }, { status: 200, body: { aborted: 'true' } }, { status: 409, body: { error: 'in transfer' } }, { status: 500, body: { aborted: true } }]) {
      target.abort = abort;
      expect(await message()).toBe(later);
    }
    expect(target.abortCalls).toHaveLength(4);
  });

  it('sends no abort once the target took the manifest, nor after a refused handshake or a signature that does not check', async () => {
    setShellIsolationForTest(sidecar);
    target.abort = 'real';
    target.chunkError = { at: 0, error: 'chunk refused' };
    const after = (await exportTo()).get('error') as { message: string };
    expect(after.message).toMatch(/You can start the migration again in 30 minutes at the latest\.$/);
    target.chunkError = undefined;
    // A target whose signature does not check is not asked anything further.
    target.badSignature = true;
    expect(((await exportTo()).get('error') as { message: string }).message).toMatch(/^lynox could not confirm that it is talking to the target instance/);
    target.badSignature = false;
    target.handshakeRefusal = { error: 'Migration session already active. Finalize or cleanup first.' };
    const refused = (await exportTo()).get('error') as { message: string };
    expect(refused.message).toMatch(/still holding an earlier migration attempt/);
    expect(target.abortCalls).toEqual([]);
  });

  it('gives up on a target that does not start answering, per step, with what the user can know', async () => {
    setShellIsolationForTest(sidecar);
    const message = async (): Promise<string | undefined> => ((await exportTo()).get('error') as { message: string } | undefined)?.message;
    target.silent = 'handshake';
    expect(await message()).toBe('lynox could not set up the connection to the target instance: it did not answer within 0.3 seconds. Nothing was transferred. You can start the migration again in 30 minutes at the latest.');
    target.silent = 'completion';
    expect(await message()).toBe('lynox could not set up the connection to the target instance: it did not answer within 0.3 seconds. Nothing was transferred. You can start the migration again in 30 minutes at the latest.');
    target.silent = 'manifest';
    expect(await message()).toBe('The target instance did not answer within 0.4 seconds. lynox stopped before sending your data. You can start the migration again in 30 minutes at the latest.');
    target.silent = 'chunk';
    expect(await message()).toBe('The target instance did not answer within 0.5 seconds while receiving part 1 of the data. lynox stopped; the target instance has not restored anything. You can start the migration again in 30 minutes at the latest.');
    target.silent = 'restore';
    expect(await message()).toBe('The target instance\'s report on restoring the data could not be read: it did not answer within 3 seconds. Check on the target instance whether your data arrived before you migrate again.');
  });

  it('reads the target\'s answers to the manifest and every chunk to their end', async () => {
    setShellIsolationForTest(sidecar);
    const events = await exportTo();
    expect(events.get('error')).toBeUndefined();
    expect(target.okBodies.length).toBeGreaterThan(1);
    expect(target.okBodies.every((r) => r.bodyUsed)).toBe(true);
  });

  it('fails the handshake on an answer without its fields, and passes a nested restore report on cut, not as an error', async () => {
    setShellIsolationForTest(sidecar);
    const message = async (): Promise<string | undefined> => ((await exportTo()).get('error') as { message: string } | undefined)?.message;
    for (const raw of ['null', '{}', '{"serverPubKey":1,"signature":"s","challengeNonce":"n"}']) {
      target.handshakeRaw = raw;
      expect(await message()).toBe('lynox could not set up the connection to the target instance: its answer is not in the expected format. Nothing was transferred. You can start the migration again in 30 minutes at the latest.');
    }
    target.handshakeRaw = undefined;
    target.restoreRaw = JSON.stringify({ success: true, verification: { secretsImported: 1 } }).replace('{"secretsImported":1}', '['.repeat(200_000) + ']'.repeat(200_000));
    const events = await exportTo();
    expect(events.get('error')).toBeUndefined();
    expect(events.get('done')).toMatchObject({ success: true });
  });

  it('passes the network guard\'s refusal of the restore request on with the retry sentence, and asks to check the target for anything else', async () => {
    setShellIsolationForTest(sidecar);
    target.guardBlocksRestore = true;
    expect(((await exportTo()).get('error') as { message: string }).message).toBe('lynox did not send the request to restore the data: the redirect points to a private address. The target instance has not restored anything. You can start the migration again in 30 minutes at the latest.');
    // One without any words of its own.
    target.guardText = '';
    expect(((await exportTo()).get('error') as { message: string }).message).toBe('The request to restore the data ended unexpectedly. Check on the target instance whether your data arrived before you migrate again.');
  });

  it('words a connection that cannot be made per step, never with the transport\'s own text', async () => {
    setShellIsolationForTest(sidecar);
    const message = async (): Promise<string | undefined> => ((await exportTo()).get('error') as { message: string } | undefined)?.message;
    target.unreachable = 'handshake';
    expect(await message()).toBe('lynox could not set up the connection to the target instance: it could not be reached. Nothing was transferred. You can start the migration again in 30 minutes at the latest.');
    target.unreachable = 'manifest';
    expect(await message()).toBe('lynox could not reach the target instance. lynox stopped before sending your data. You can start the migration again in 30 minutes at the latest.');
    target.unreachable = 'chunk';
    expect(await message()).toBe('lynox lost the connection to the target instance while sending part 1 of the data. lynox stopped; the target instance has not restored anything. You can start the migration again in 30 minutes at the latest.');
  });

  it('treats a server key that does not parse, or is on another curve, as an answer in the wrong format', async () => {
    setShellIsolationForTest(sidecar);
    target.otherCurve = true;
    expect(((await exportTo()).get('error') as { message: string }).message).toBe('lynox could not set up the connection to the target instance: its answer is not in the expected format. Nothing was transferred. You can start the migration again in 30 minutes at the latest.');
    target.otherCurve = false;
    target.badKey = true;
    expect(((await exportTo()).get('error') as { message: string }).message).toBe('lynox could not set up the connection to the target instance: its answer is not in the expected format. Nothing was transferred. You can start the migration again in 30 minutes at the latest.');
  });

  it('says nothing was transferred for a stop without words before the handshake', async () => {
    setShellIsolationForTest(sidecar);
    const proto = (await import('../core/migration-export.js')).MigrationExporter.prototype as unknown as { preview: () => unknown };
    const spy = vi.spyOn(proto, 'preview').mockImplementation(() => { throw new Error(''); });
    try {
      expect(((await exportTo()).get('error') as { message: string }).message).toBe('The migration stopped for a reason lynox could not read. Nothing was transferred.');
    } finally { spy.mockRestore(); }
  });

  it('adds no retry sentence where the same attempt would fail again', async () => {
    setShellIsolationForTest(sidecar);
    // The source's own bound: the bundle does not fit one migration.
    const proto = (await import('../core/migration-export.js')).MigrationExporter.prototype as unknown as { export: (...a: unknown[]) => unknown };
    const spy = vi.spyOn(proto, 'export').mockImplementation(() => { throw new Error('This instance\'s data does not fit one migration: it is 600 MiB. None of your data was sent, and the data on this instance is unchanged. A migration cannot move only part of it; write to support@lynox.ai with this message and we will look at it with you.'); });
    try {
      expect(((await exportTo()).get('error') as { message: string }).message).toBe('This instance\'s data does not fit one migration: it is 600 MiB. None of your data was sent, and the data on this instance is unchanged. A migration cannot move only part of it; write to support@lynox.ai with this message and we will look at it with you.');
    } finally { spy.mockRestore(); }
    // A handshake whose signature does not check.
    target.badSignature = true;
    expect(((await exportTo()).get('error') as { message: string }).message).toBe('lynox could not confirm that it is talking to the target instance, so it did not set up the connection. Nothing was transferred. If this happens again, write to support@lynox.ai.');
  });

  it('adds the retry sentence to a stop after the handshake that did not word one', async () => {
    setShellIsolationForTest(sidecar);
    // The export refuses on the source after the handshake (here: a collector fails).
    const proto = (await import('../core/migration-export.js')).MigrationExporter.prototype as unknown as { collectConfig: () => unknown };
    const spy = vi.spyOn(proto, 'collectConfig').mockImplementation(() => { throw new Error('config unreadable'); });
    try {
      expect(((await exportTo()).get('error') as { message: string }).message).toBe('config unreadable. You can start the migration again in 30 minutes at the latest.');
      // A stop without any words of its own still says what the user can do.
      spy.mockImplementation(() => { throw new Error(''); });
      expect(((await exportTo()).get('error') as { message: string }).message).toBe('The migration stopped for a reason lynox could not read. You can start the migration again in 30 minutes at the latest.');
      // Any text reaching the user is cleaned, also one that did not come from the target.
      spy.mockImplementation(() => { throw new Error('config\u202e unreadable\n'); });
      expect(((await exportTo()).get('error') as { message: string }).message).toBe('config unreadable. You can start the migration again in 30 minutes at the latest.');
    } finally { spy.mockRestore(); }
  });

  it('says that the connection broke when a refusal breaks off mid-way, never the transport\'s own words', async () => {
    setShellIsolationForTest(sidecar);
    const message = async (): Promise<string | undefined> => ((await exportTo()).get('error') as { message: string } | undefined)?.message;
    target.broken = 'handshake-refusal';
    expect(await message()).toBe('lynox could not set up the connection to the target instance: the connection broke before its answer was complete. Nothing was transferred. You can start the migration again in 30 minutes at the latest.');
    target.broken = 'manifest';
    expect(await message()).toBe('The target instance refused the migration. The connection broke before its answer was complete. You can start the migration again in 30 minutes at the latest.');
  });

  it('stops a target that answers every step just inside its deadline once the whole transfer runs out of time', { timeout: 30_000 }, async () => {
    setShellIsolationForTest(sidecar);
    const message = async (): Promise<string | undefined> => ((await exportTo()).get('error') as { message: string } | undefined)?.message;
    // Each part answered after 300 ms, inside its 500 ms; the whole transfer may take 700 ms.
    target.lagMs = 300;
    transferDeadline.ms = 700;
    expect(await message()).toBe('The migration took longer than 0.7 seconds, so lynox stopped it. The target instance has not restored anything. You can start the migration again in 30 minutes at the latest.');
    // Stopped while a part was still waiting, not after all of them: at most two of the six answered.
    expect(target.manifest?.chunks.length).toBe(6);
    expect(target.partsAnswered).toBeLessThanOrEqual(2);
    // Out of time while the restore was asked for: the data has gone out, so check the target.
    // (The restore does not answer; the whole transfer's 1.5 s end before its own 3 s.)
    target.lagMs = undefined;
    target.silent = 'restore';
    transferDeadline.ms = 1500;
    expect(await message()).toBe('The migration took longer than 1.5 seconds, so lynox stopped waiting for the target instance to restore the data. Check on the target instance whether your data arrived before you migrate again.');
    target.silent = undefined;
    // Out of time before the restore was asked for (the last part's answer took the rest): nothing
    // was restored, so the user can try again.
    transferDeadline.ms = 300;
    target.lastPartBodyLagMs = 600;
    expect(await message()).toBe('The migration took longer than 0.3 seconds, so lynox stopped it. The target instance has not restored anything. You can start the migration again in 30 minutes at the latest.');
    target.lastPartBodyLagMs = undefined;
    // Control: the same lag with time enough completes.
    target.lagMs = 300;
    transferDeadline.ms = 60_000;
    const done = await exportTo();
    expect(done.get('error')).toBeUndefined();
    expect(done.get('done')).toBeDefined();
  });

  it('gives up on an answer that does not arrive in full in time, per step', { timeout: 30_000 }, async () => {
    setShellIsolationForTest(sidecar);
    const message = async (): Promise<string | undefined> => ((await exportTo()).get('error') as { message: string } | undefined)?.message;
    target.slow = 'handshake';
    expect(await message()).toBe('lynox could not set up the connection to the target instance: it did not finish its answer within 1.5 seconds. Nothing was transferred. You can start the migration again in 30 minutes at the latest.');
    target.slow = 'handshake-refusal';
    expect(await message()).toBe('lynox could not set up the connection to the target instance: it did not finish its answer within 1.5 seconds. Nothing was transferred. You can start the migration again in 30 minutes at the latest.');
    target.slow = 'manifest';
    expect(await message()).toBe('The target instance refused the migration. It did not finish its answer within 1.5 seconds. You can start the migration again in 30 minutes at the latest.');
    target.slow = 'restore';
    expect(await message()).toBe('The target instance\'s report on restoring the data could not be read: it did not finish its answer within 1.5 seconds. Check on the target instance whether your data arrived before you migrate again.');
  });

  it('passes the target\'s restore report on with its strings cleaned', async () => {
    setShellIsolationForTest(sidecar);
    target.restoreReport = { databasesRestored: ['engine.db'], portableDirSkipped: ['workspace/a\u202Eb\nc'], secretsImported: 2 };
    const events = await exportTo();
    expect(events.get('error')).toBeUndefined();
    expect((events.get('done') as { verification: unknown }).verification).toEqual({ databasesRestored: ['engine.db'], portableDirSkipped: ['workspace/ab c'], secretsImported: 2 });
  });

  it('names what the user can do next with the error: start again now, later, or check the target first', async () => {
    setShellIsolationForTest(sidecar);
    const retry = async (): Promise<unknown> => ((await exportTo()).get('error') as { retry?: unknown } | undefined)?.retry;
    // Refused before the target holds a session: nothing to wait for.
    target.handshakeRefusal = { error: 'Invalid migration token' };
    expect(await retry()).toBe('now');
    target.handshakeRefusal = undefined;
    // A session may still be held and the target did not end it: wait.
    target.manifestError = 'no';
    expect(await retry()).toBe('later');
    // The target ended it: start again now.
    target.abort = 'real';
    expect(await retry()).toBe('now');
    target.manifestError = undefined;
    target.abort = undefined;
    // The restore may have run in part: check the target first.
    target.restoreError = 'restore refused';
    expect(await retry()).toBe('check');
    target.restoreError = undefined;
    // A sentence that sends the user to support still leaves the target's session held: wait.
    target.badSignature = true;
    expect(await retry()).toBe('later');
    target.badSignature = undefined;
  });

  it('keeps the target\'s words in quotes, so they cannot pose as lynox\'s own sentence', async () => {
    setShellIsolationForTest(sidecar);
    const message = async (): Promise<string | undefined> => ((await exportTo()).get('error') as { message: string } | undefined)?.message;
    const AGAIN = 'You can start the migration again in 30 minutes at the latest.';
    const NOW = 'You can start the migration again now.';
    // Words carrying a quote and lynox's own sentences, in both forms.
    const posing = `Say "ok". ${AGAIN} ${NOW}`;
    const quoted = '"Say \\"ok\\". You can start the migration again in 30 minutes at the latest. You can start the migration again now."';
    // Refused manifest, session ended: the words stand alone, untouched inside their quotes.
    target.manifestError = posing;
    target.abort = 'real';
    expect(await message()).toBe(`The target instance refused the migration. It says: ${quoted}.`);
    // Not confirmed: lynox's own 30 minutes follow the words, once.
    target.abort = { status: 200, body: { aborted: false } };
    expect(await message()).toBe(`The target instance refused the migration. It says: ${quoted}. ${AGAIN}`);
    // The target busy, session ended: lynox's sentence becomes "now", the quoted copy stays as it was.
    target.abort = 'real';
    target.manifestStatus = 503;
    expect(await message()).toBe(`The target instance refused the migration. It says: ${quoted}. ${NOW}`);
    target.manifestError = undefined;
    target.manifestStatus = undefined;
    // After the manifest no session can be ended: the target's "now" does not replace lynox's 30 minutes.
    target.chunkError = { at: 0, error: posing };
    expect(await message()).toBe(`The target instance refused part 1 of 6 of the data. It says: ${quoted}. ${AGAIN}`);
    target.chunkError = undefined;
  });

  it('shows the destination\'s words without control or bidi characters', async () => {
    setShellIsolationForTest(sidecar);
    target.manifestError = 'refused\u202E gnp.exe\nnext\u2066line\u0007';
    expect(((await exportTo()).get('error') as { message: string }).message).toBe('The target instance refused the migration. It says: "refused gnp.exe nextline". You can start the migration again in 30 minutes at the latest.');
    target.manifestError = undefined;
    target.manifestRaw = 'bad\r\ngateway\u202D';
    expect(((await exportTo()).get('error') as { message: string }).message).toBe('The target instance refused the migration. It says: "bad  gateway". You can start the migration again in 30 minutes at the latest.');
  });

  it('says which part of the data the destination refused, counted from 1 out of all parts, and that it could not restore', async () => {
    setShellIsolationForTest(sidecar);
    target.chunkError = { at: 0, error: 'chunk refused' };
    expect(((await exportTo()).get('error') as { message: string }).message).toBe('The target instance refused part 1 of 6 of the data. It says: "chunk refused". You can start the migration again in 30 minutes at the latest.');
    target.chunkError = { at: 2, error: 'chunk refused' };
    expect(((await exportTo()).get('error') as { message: string }).message).toBe('The target instance refused part 3 of 6 of the data. It says: "chunk refused". You can start the migration again in 30 minutes at the latest.');
    target.chunkError = undefined;
    target.restoreError = 'restore refused';
    expect(((await exportTo()).get('error') as { message: string }).message).toBe('The target instance could not restore the data. It says: "restore refused". Check on the target instance whether your data arrived before you migrate again.');
    // Words that would grow in quotes (lone surrogates) and carry lynox's own sentence: they are
    // dropped, so lynox's closing sentence still ends the message and no retry is offered.
    target.restoreError = `Check on the target instance. ${'\ud800'.repeat(600)}`;
    expect(((await exportTo()).get('error') as { message: string }).message).toBe('The target instance could not restore the data. It says: "Check on the target instance.". Check on the target instance whether your data arrived before you migrate again.');
    target.chunkError = { at: 0, error: `support@lynox.ai ${'\ud800'.repeat(600)}` };
    target.restoreError = undefined;
    expect(((await exportTo()).get('error') as { message: string }).message).toBe('The target instance refused part 1 of 6 of the data. It says: "support@lynox.ai". You can start the migration again in 30 minutes at the latest.');
    target.chunkError = undefined;
    // A refusal before the restore started (here: a missing chunk, 400) keeps the retry sentence.
    target.restoreError = undefined;
    target.restoreStatus = { status: 400, error: 'Cannot restore — not all chunks received.' };
    expect(((await exportTo()).get('error') as { message: string }).message).toBe('The target instance could not restore the data. It says: "Cannot restore — not all chunks received.". You can start the migration again in 30 minutes at the latest.');
  });

  it('zeroizes the transfer key when the handshake completion fails', async () => {
    setShellIsolationForTest(sidecar);
    target.failCompletion = true;
    const events = await exportTo();
    expect((events.get('error') as { message: string }).message).toMatch(/lynox could not finish setting up the connection to the target instance/);
    expect(derivedKeys).toHaveLength(1);
    expect(derivedKeys[0]!.every(b => b === 0)).toBe(true);
  });

  it('zeroizes the transfer key when the export refuses', async () => {
    const { MigrationExporter } = await import('../core/migration-export.js');
    let key: Buffer | undefined;
    const spy = vi.spyOn(MigrationExporter.prototype, 'export').mockImplementation((transferKey: Buffer) => {
      key = transferKey;
      expect(transferKey.some(b => b !== 0)).toBe(true);
      throw new Error('This instance\'s data does not fit one migration');
    });
    try {
      const events = await exportTo();
      expect((events.get('error') as { message: string }).message).toMatch(/does not fit one migration/);
      expect(key).toBeDefined();
      expect(key!.every(b => b === 0)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
