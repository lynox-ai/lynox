import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import type { LynoxConfig } from '../types/index.js';

/**
 * The BOOT-WIRING proof for the two gates in {@link Engine.init} that carry data-protection
 * behaviour: the merge-ledger retention sweep and the Drive-upload tier gate.
 *
 * Their DECISIONS are covered elsewhere — `pruneExpiredLedgers` and `driveBackupAllowed` each
 * have their own suite. What was not covered is that `init()` CALLS them: delete either line
 * and the whole suite stays green, while the behaviour disappears silently. Fall away the boot
 * sweep and ledgers holding email, phone, `vat_id` and domain grow forever on an instance that
 * received a restore and never merges. Fall away the Drive gate and CP-provisioned instances
 * upload those same backups to a third party again.
 *
 * Both shipped as declared survivors under `DEF-engine-init-wiring-untestable`, whose
 * verify-done is a CONJUNCTION — a test for only one gate lets the other keep vanishing
 * unnoticed — on the premise that reaching `init()` needs the heavy mock chain
 * `engine-propagate-provider.test.ts` builds. That premise looked at the wrong precedent:
 * `engine-startup-reap-boot.test.ts` and `engine-verb-backfill-boot.test.ts` boot a real
 * Engine against a tmp data dir and call `init()` directly. This test is that same shape.
 */
describe('Engine boot — the two init() gates are actually wired', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  const ENV_KEYS = [
    'LYNOX_DATA_DIR', 'LYNOX_SUBJECT_GRAPH_ENABLED',
    'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
    'LYNOX_MANAGED_INSTANCE_ID', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE',
  ] as const;
  const saved = new Map<string, string | undefined>();

  function setEnv(key: string, value: string | undefined): void {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  afterEach(async () => {
    for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
    engines.length = 0;
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    saved.clear();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    reloadConfig();
  });

  function freshDataDir(label: string): string {
    const dir = mkdtempSync(join(tmpdir(), `lynox-${label}-`));
    dirs.push(dir);
    // Every marker cleared by default: a leaked one from the ambient environment would make
    // the self-host case silently assert the managed path instead.
    for (const k of ENV_KEYS) setEnv(k, undefined);
    setEnv('LYNOX_DATA_DIR', dir);
    return dir;
  }

  async function boot(): Promise<Engine> {
    reloadConfig(); // loadConfig() caches, and an earlier boot in this file filled it
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();
    return engine;
  }

  // ─── Gate 1: the merge-ledger retention sweep ───────────────────────────────────────────

  /** A ledger file exactly as `runMerge` names and shapes it — `createdAt` is what ages it. */
  function seedLedger(sweepsDir: string, createdAt: string, suffix: string): string {
    const full = join(sweepsDir, `merge-${createdAt.replace(/[:.]/g, '-')}-${suffix}.json`);
    writeFileSync(full, JSON.stringify({
      version: 1, phase: 'merge', createdAt, applied: true,
      entry: { dupId: `s-${suffix}`, canonicalId: 's-canonical', dup: { name: 'Testfirma Nord' } },
      dataStore: [], threadAnchors: [],
    }, null, 2));
    return full;
  }

  it('sweeps a ledger a restore landed, without any merge ever running', async () => {
    const dir = freshDataDir('ledger-boot');
    const sweeps = join(dir, 'sweeps');
    mkdirSync(sweeps, { recursive: true });

    // The state a restored instance is actually in: ledgers this process never wrote, and no
    // merge on the way to sweep them.
    const now = Date.now();
    const expired = seedLedger(sweeps, new Date(now - 200 * 86_400_000).toISOString(), 'aged01');
    const fresh = seedLedger(sweeps, new Date(now - 1 * 86_400_000).toISOString(), 'fresh01');
    // Not a merge ledger. `sweeps/` is not exclusively ours, and a boot-time delete pass that
    // widened its filter would be a silent data-loss bug — the near-miss is the case that
    // matters. Aged deliberately: with a correct name filter it is never even parsed, but a
    // WIDENED filter would find it expired and delete it. That is what makes this bite.
    const foreign = join(sweeps, 'merge-plan-notes.json');
    writeFileSync(foreign, JSON.stringify({
      note: 'not a ledger', createdAt: new Date(now - 200 * 86_400_000).toISOString(),
    }));

    // The subject-graph flag gates the block this sweep lives in, and it is OFF in prod today.
    // Without it the block is skipped and every assertion below would pass vacuously.
    setEnv('LYNOX_SUBJECT_GRAPH_ENABLED', 'true');
    const engine = await boot();

    // FIXTURE GUARD: `_subjectStore` is assigned in the same `if` block, three lines above the
    // sweep. Null here means the block never ran and the assertions below prove nothing.
    expect(engine.getSubjectStore()).not.toBeNull();

    expect(existsSync(expired)).toBe(false);  // boot did the work no merge was coming to do
    expect(existsSync(fresh)).toBe(true);     // and only that work — never the newest
    expect(existsSync(foreign)).toBe(true);   // a file runMerge never wrote is not ours to delete
  });

  // ─── Gate 2: the Drive-upload tier gate ─────────────────────────────────────────────────

  it('wires the Drive uploader on self-host', async () => {
    freshDataDir('drive-selfhost');
    setEnv('GOOGLE_CLIENT_ID', 'test-client-id');
    setEnv('GOOGLE_CLIENT_SECRET', 'test-client-secret');
    // No provisioning marker set → self-host, the one tier that keeps Drive.
    const engine = await boot();

    // FIXTURE GUARD: without Google auth the gate is never reached and `null` below would mean
    // nothing. This asserts the test is exercising the branch it claims to.
    expect(engine.getGoogleAuth()).not.toBeNull();
    expect(engine.getBackupManager()).not.toBeNull();

    expect(engine.getBackupManager()!.getGDriveUploader()).not.toBeNull();
  });

  it('refuses the Drive uploader on a CP-provisioned instance', async () => {
    freshDataDir('drive-provisioned');
    setEnv('GOOGLE_CLIENT_ID', 'test-client-id');
    setEnv('GOOGLE_CLIENT_SECRET', 'test-client-secret');
    // Any ONE provisioning marker closes the gate — `driveBackupAllowed` delegates to
    // `isProvisionedInstance`, which fails closed on a partial env. The instance-id marker is
    // used here deliberately: `LYNOX_BILLING_TIER` additionally arms the managed usage hook
    // ~25 lines below, which demands a control-plane URL and secret and makes `init()` throw.
    // Coupling this wiring test to that hook would test the hook, not the wiring.
    //
    // Which TIERS count as provisioned — BYOK included, the case that matters most because a
    // gate written against `managed`/`managed_pro` would leave the cheapest tier open — is the
    // decision, and it is covered in `backup-drive-tier-boundary.test.ts`. This asserts only
    // that `init()` consults that decision at all.
    setEnv('LYNOX_MANAGED_INSTANCE_ID', 'inst-test-0001');
    const engine = await boot();

    expect(engine.getGoogleAuth()).not.toBeNull();     // fixture guard, as above
    expect(engine.getBackupManager()).not.toBeNull();

    expect(engine.getBackupManager()!.getGDriveUploader()).toBeNull();
  });
});
