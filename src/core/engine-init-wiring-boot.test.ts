import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import type { GDriveBackupUploader, UploadResult } from './backup-upload-gdrive.js';
import type { LynoxConfig } from '../types/index.js';
import { SubjectStore } from './subject-store.js';
import type { ExtractionResult } from './entity-extractor.js';

// Gate 3 (below) stores one memory through the real KnowledgeLayer; extraction is mocked so no
// LLM is needed and the minted subject is deterministic. Hoisted by vitest — inert for gates 1/2.
const extractorMock = vi.hoisted(() => ({ extraction: { entities: [], relations: [] } as ExtractionResult }));
vi.mock('./entity-extractor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./entity-extractor.js')>();
  return { ...actual, extractEntities: vi.fn(async () => extractorMock.extraction) };
});

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
 * Both shipped as declared survivors on the premise that reaching `init()` needs the heavy
 * mock chain `engine-propagate-provider.test.ts` builds. That premise looked at the wrong
 * precedent: `engine-startup-reap-boot.test.ts` and `engine-verb-backfill-boot.test.ts` boot
 * a real Engine against a tmp data dir and call `init()` directly. This test is that same
 * shape.
 */
describe('Engine boot — the two init() gates are actually wired', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  const ENV_KEYS = [
    'LYNOX_DATA_DIR', 'LYNOX_SUBJECT_GRAPH_ENABLED',
    'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
    'LYNOX_MANAGED_INSTANCE_ID', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE',
    // `ensureVaultKey()` WRITES this into `process.env` on the first boot and then returns early
    // forever, so without clearing it the first test's key is inherited by every later boot —
    // whose own `vault.key` file is never created and whose referenced path is then deleted by
    // `afterEach`. No assertion depended on it, but it is exactly the uncontrolled cross-case
    // state the comment below argues against for the other seven.
    'LYNOX_VAULT_KEY',
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

  // ─── Gate 2: the Drive-upload gates — tier at boot, consent at upload ───────────────────

  /**
   * The user config `loadConfig()` will read: `getUserConfigDir()` honours `LYNOX_DATA_DIR`, which
   * `freshDataDir` has already pointed at the tmp dir. Written BEFORE `boot()`, because `boot()`
   * calls `reloadConfig()` and the Engine constructor reads the config once.
   */
  function writeUserConfig(dir: string, config: Record<string, unknown>): void {
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2));
  }

  /** A stub with `upload`'s real signature, recording each call. */
  function spyUploader(): { calls: string[]; uploader: GDriveBackupUploader } {
    const calls: string[] = [];
    const stub = {
      upload: async (backupDir: string): Promise<UploadResult> => {
        calls.push(backupDir);
        return { success: true, folderId: 'stub', filesUploaded: 1 };
      },
    };
    return { calls, uploader: stub as unknown as GDriveBackupUploader };
  }

  /** Enough of a data dir for `createBackup()` to have something to copy. */
  function seedBackupSource(dir: string): void {
    mkdirSync(join(dir, 'memory', '_global'), { recursive: true });
    writeFileSync(join(dir, 'memory', '_global', 'facts.txt'), 'a fact');
  }

  it('wires the Drive uploader on self-host — the TIER condition, asked at boot', async () => {
    freshDataDir('drive-selfhost');
    setEnv('GOOGLE_CLIENT_ID', 'test-client-id');
    setEnv('GOOGLE_CLIENT_SECRET', 'test-client-secret');
    // No provisioning marker → self-host, the one tier that keeps Drive. Note there is no opt-in
    // here and the uploader is attached anyway: consent is not a wiring condition any more, it is
    // asked at the upload. The two cases below prove that it is asked at all.
    const engine = await boot();

    expect(engine.getBackupManager()).not.toBeNull();
    expect(engine.getBackupManager()!.getGDriveUploader()).not.toBeNull();
  });

  it('refuses the Drive uploader on a CP-provisioned instance', async () => {
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
    //
    // No opt-in is written, and none is needed: tier is now the ONLY wiring condition, so a null
    // uploader here has exactly one possible cause. That is what the previous version of this
    // test could not claim — it passed with the consent read structurally broken, because either
    // condition explained the observation.
    freshDataDir('drive-provisioned');
    setEnv('GOOGLE_CLIENT_ID', 'test-client-id');
    setEnv('GOOGLE_CLIENT_SECRET', 'test-client-secret');
    setEnv('LYNOX_MANAGED_INSTANCE_ID', 'inst-test-0001');
    const engine = await boot();

    expect(engine.getBackupManager()).not.toBeNull();
    expect(engine.getBackupManager()!.getGDriveUploader()).toBeNull();
  });

  it('REVOKING the opt-in stops uploads in the running process, without a restart', async () => {
    // The test the whole gate exists for, and the one a boot-time-only check cannot pass. Two
    // backups through the SAME engine, with the setting flipped in between — so the assertion is
    // about the decision being current, not about it having been made once.
    //
    // Before this, the opt-in was read in `init()` only: turning it off left the uploader
    // attached and backups going out until the process restarted. Fail-open, and the same class
    // `_reconcileBugsink` exists to close for the privacy toggle.
    const dir = freshDataDir('drive-revoke');
    seedBackupSource(dir);
    setEnv('GOOGLE_CLIENT_ID', 'test-client-id');
    setEnv('GOOGLE_CLIENT_SECRET', 'test-client-secret');
    writeUserConfig(dir, { backup_gdrive: true });
    const engine = await boot();

    const manager = engine.getBackupManager();
    expect(manager).not.toBeNull();
    const { calls, uploader } = spyUploader();
    manager!.setGDriveUploader(uploader);

    // FIXTURE GUARD, and it is the one the previous version of these tests was missing: the
    // opt-in has to have REACHED the engine's config. Writing it to disk does not establish that
    // it arrived, and without this a passing test below could be explained by either condition.
    expect(engine.getUserConfig().backup_gdrive, 'the opt-in must have reached userConfig').toBe(true);

    const first = await manager!.createBackup();
    expect(first.success).toBe(true);
    // FIXTURE GUARD: the upload also needs an encrypted archive, so if this were false the
    // assertion below would pass for the wrong reason.
    expect(first.manifest.encrypted, 'the boot must have produced a vault key').toBe(true);
    expect(calls).toEqual([first.path]);

    // Now revoke it the way the product does: write the config, clear the cache, reload.
    writeUserConfig(dir, { backup_gdrive: false });
    reloadConfig();
    await engine.reloadUserConfig();
    expect(engine.getUserConfig().backup_gdrive, 'the revocation must have reached userConfig').toBe(false);

    const second = await manager!.createBackup();
    expect(second.success).toBe(true);
    expect(second.manifest.encrypted).toBe(true);   // still encrypted — only consent changed
    expect(second.path).not.toBe(first.path);       // a second, real archive
    // WITNESS 1: the local backup still happened.
    expect(existsSync(join(second.path, 'manifest.json'))).toBe(true);
    // WITNESS 2: and nothing went out for it.
    expect(calls).toEqual([first.path]);
  });
});

// ─── Gate 3: the orphan-subject reap is wired through init() ───────────────────
//
// The reap needs the record store, which `_initCoreTools()` hands the KnowledgeLayer via
// `setRecordStore` — AFTER `_initKnowledge()`. The older bridge attach in
// `_initKnowledge()` was guarded on a DataStore that does not exist yet at that point, so it
// never fired in production; a reap riding on it would be permanently fail-closed while every
// unit test (which wires the store by hand) stays green. This boots the real Engine and asks
// the only question that proves the wiring: does an erase remove the subject it minted?
describe('Engine boot — the orphan-subject reap is reachable after init()', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  const saved = new Map<string, string | undefined>();
  function setEnv(key: string, value: string | undefined): void {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  afterEach(async () => {
    for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
    engines.length = 0;
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    saved.clear();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    extractorMock.extraction = { entities: [], relations: [] };
    reloadConfig();
  });

  it('an erase through the booted KnowledgeLayer reaps the subject the erased memory minted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-reap-boot-'));
    dirs.push(dir);
    for (const k of ['LYNOX_DATA_DIR', 'LYNOX_SUBJECT_GRAPH_ENABLED', 'LYNOX_KG_EXTRACTOR', 'LYNOX_EMBEDDING_PROVIDER', 'LYNOX_MANAGED_INSTANCE_ID', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE'] as const) setEnv(k, undefined);
    setEnv('LYNOX_DATA_DIR', dir);
    setEnv('LYNOX_SUBJECT_GRAPH_ENABLED', 'true');
    // The V2 extractor needs a live LLM client; V1 is the path the file-level mock replaces.
    setEnv('LYNOX_KG_EXTRACTOR', 'v1');
    // The default ONNX provider fetches a ~450 MB model from the Hugging Face hub on first use,
    // and CI starts with an empty model cache — so this test was timing a download, not a boot
    // (4.5–10.2 s against the 10 s limit). The wiring under test does not depend on which
    // embedder the layer holds; `local` is the built-in network-free one.
    setEnv('LYNOX_EMBEDDING_PROVIDER', 'local');
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();

    const layer = engine.getKnowledgeLayer();
    const engineDb = engine.getEngineDb();
    expect(layer, 'the boot must bring up the KnowledgeLayer — a null here is not a skip').not.toBeNull();
    expect(engine.getDataStore(), 'the boot must bring up the DataStore').not.toBeNull();
    expect(engineDb).not.toBeNull();

    extractorMock.extraction = { entities: [{ name: 'Boot Orphan AG', type: 'organization', confidence: 0.9 }], relations: [] };
    await layer!.store('Boot Orphan AG exists only to be erased.', 'knowledge', { type: 'context', id: 'boot' });
    const subjects = new SubjectStore(engineDb!);
    const id = subjects.findCanonical('Boot Orphan AG', 'organization')?.id;
    expect(id, 'extraction through the real layer must have minted the subject').toBeTruthy();

    expect(await layer!.eraseByPattern('exists only to be erased')).toBe(1);
    // Delete the `setRecordStore` line in _initCoreTools and this is the assertion that fails:
    // the oracle is null, the reap skips fail-closed, and the plaintext name survives.
    expect(subjects.getSubject(id!)).toBeNull();
  });
});
