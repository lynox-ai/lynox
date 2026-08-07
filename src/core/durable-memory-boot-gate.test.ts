import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import type { LynoxConfig } from '../types/index.js';

/**
 * The durable-memory tool swap, proven at BOOT on a real {@link Engine.init}.
 *
 * H9 says the swap is total: durable ON registers `remember`/`recall`/`memory_block_edit` and
 * the six legacy `memory_*` tools are absent; durable OFF is the exact mirror. What makes that
 * worth a boot test rather than a unit test is the failure it exists to catch — the swap
 * happening only HALFWAY. The registration gate and the store wiring are two different lines in
 * two different init phases, and when they disagree the tenant gets six durable tools over a
 * null store (each answering "Durable memory is not enabled for this agent") AND no legacy
 * tools, because the else-branch never ran. No memory at all, and the boot is green: /api/health
 * OK, one line on stderr. Since pro migration 0048 flipped the CP default ON, that is the path
 * every newly provisioned tenant takes, which is why it is tested here and not carried as a
 * dormant edge case.
 *
 * The flag is set through `LYNOX_DURABLE_MEMORY_ENABLED` rather than a stubbed config, because
 * that env var IS how the control plane flips it per tenant — the test walks the production
 * path, so it also fails if the env bridge stops reaching `userConfig`.
 *
 * This REPLACES a source-text parity test that compared the two `if (…)` conditions as strings.
 * That test was worthless and measurably so: inverting BOTH gates to `&& this.engineDb === null`
 * — durable tools only when engine.db is MISSING, the precise bug inside out — left all three of
 * its assertions green. It could only see that two lines matched, never what they did. The
 * conditions are now deliberately DIFFERENT (one creates the store, the other asks whether it
 * exists), so string parity is not only unenforceable, it is the wrong property.
 */
describe('Engine boot — the durable-memory tool swap is total in both directions', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  afterEach(async () => {
    for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
    engines.length = 0;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const k of Object.keys(savedEnv)) delete savedEnv[k];
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  const DURABLE = ['remember', 'recall', 'memory_block_edit'] as const;
  const LEGACY = ['memory_store', 'memory_recall', 'memory_delete', 'memory_update', 'memory_list', 'memory_promote'] as const;

  function setEnv(key: string, value: string): void {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    process.env[key] = value;
  }

  /** Boot a real Engine in a throwaway data dir. `breakEngineDb` puts a DIRECTORY where
   *  engine.db belongs, which SQLite cannot open — the engine catches that and leaves the
   *  field null, so it is the honest way to reach the null-engineDb branch without stubbing
   *  the very wiring under test. */
  async function boot(durable: boolean, breakEngineDb = false): Promise<Engine> {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-dk-boot-'));
    dirs.push(dir);
    if (breakEngineDb) mkdirSync(join(dir, 'engine.db'));
    setEnv('LYNOX_DATA_DIR', dir);
    setEnv('LYNOX_DURABLE_MEMORY_ENABLED', durable ? 'true' : 'false');
    // `loadConfig()` memoises per PROCESS — correct in production, where each tenant is its own
    // process, and a trap here, where three boots share one. Without this the second and third
    // cases silently re-use the FIRST case's flag: the durable-OFF case booted with the flag
    // still on and failed on the legacy tools, which is how this line came to exist.
    reloadConfig();

    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();
    return engine;
  }

  const names = (e: Engine): string[] => e.getRegistry().getEntries().map(t => t.definition.name);

  it('durable ON with a healthy engine.db registers the durable tools and NO legacy ones', async () => {
    const engine = await boot(true);
    const registered = names(engine);

    // The store actually got built — otherwise the assertions below would pass for the WRONG
    // reason (a boot that fell back to legacy would also satisfy "no durable tools"), and so
    // would a broken env bridge that never turned the flag on at all.
    expect(engine.getKnowledgeStore(), 'durable ON + healthy engine.db must wire the store').not.toBeNull();
    for (const t of DURABLE) expect(registered, `durable tool ${t}`).toContain(t);
    for (const t of LEGACY) expect(registered, `legacy tool ${t} must be absent when durable is on`).not.toContain(t);
  });

  it('durable ON but engine.db unopenable falls back to the LEGACY tools — never to neither', async () => {
    const engine = await boot(true, true);
    const registered = names(engine);

    // The premise: this really is the broken-engine.db path, not a healthy boot that happened
    // to land on legacy for some other reason. Without this the test would still pass if
    // `breakEngineDb` silently stopped working.
    expect(engine.getEngineDb(), 'the directory-instead-of-file trick must actually break engine.db').toBeNull();
    expect(engine.getKnowledgeStore()).toBeNull();

    // This is the assertion the whole file exists for. The bug was not "the wrong set" — it was
    // NEITHER set, so asserting the legacy tools are PRESENT is what separates a working
    // fallback from the silent no-memory state.
    for (const t of LEGACY) expect(registered, `legacy tool ${t} must be present when the store is missing`).toContain(t);
    for (const t of DURABLE) expect(registered, `durable tool ${t} must NOT be registered over a null store`).not.toContain(t);
  });

  it('durable OFF registers the legacy tools and NO durable ones', async () => {
    const engine = await boot(false);
    const registered = names(engine);

    for (const t of LEGACY) expect(registered, `legacy tool ${t}`).toContain(t);
    for (const t of DURABLE) expect(registered, `durable tool ${t} must be absent when the flag is off`).not.toContain(t);
  });
});
