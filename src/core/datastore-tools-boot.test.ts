import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import { DataStore, CRM_OVERLAP_NAMES } from './data-store.js';
import { DATASTORE_PROMPT_SUFFIX } from './prompts.js';
import type { LynoxConfig, IAgent } from '../types/index.js';
import type { Session } from './session.js';

/**
 * A FRESH instance must be able to create its first table.
 *
 * Until this test existed it could not: the six data-store tools were registered only when
 * `listCollections()` was non-empty at boot, and on an instance with neither a table of its own
 * nor a CRM record that count is always zero — the boot drops the CRM's own EMPTY collections
 * just before the check and the CRM recreates them only later in boot. So `data_store_create`,
 * the tool that makes the first table, was offered only once a table already existed. The base
 * prompt names `data_store_insert` and `data_store_query` as routes all the same, so a model on a
 * new instance that followed it would get "Tool not found".
 *
 * A real Engine against a tmp data dir, `init()` called directly — the shape of
 * `google-visibility-boot.test.ts`. A unit test that handed the registry a DataStore itself
 * would not see the boot order, and the boot order is the defect.
 */

const DATA_STORE_TOOLS = [
  'data_store_create', 'data_store_insert', 'data_store_query',
  'data_store_list', 'data_store_delete', 'data_store_drop',
] as const;

type ToolLike = { definition: { name: string }; handler: (input: unknown, agent: IAgent) => Promise<string> };
type AgentLike = IAgent & { systemPrompt: string; getAvailableTools(): ToolLike[] };

function agentOf(session: Session): AgentLike {
  const agent = (session as unknown as { agent: AgentLike | null }).agent;
  if (!agent || typeof agent.getAvailableTools !== 'function') {
    throw new Error('no agent on the session — the probe broke, this is not a pass');
  }
  return agent;
}

describe('Engine boot — a fresh instance can create its first table', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  const ENV_KEYS = ['LYNOX_DATA_DIR', 'LYNOX_VAULT_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
    'GOOGLE_SERVICE_ACCOUNT_KEY', 'LYNOX_MANAGED_INSTANCE_ID'] as const;
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
    reloadConfig();
  });

  function freshDataDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-dsboot-'));
    dirs.push(dir);
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

  it('registers all six on a fresh boot, with no table in the store', async () => {
    freshDataDir();
    const engine = await boot();
    const names = engine.getRegistry().getEntries().map(e => e.definition.name);
    for (const t of DATA_STORE_TOOLS) {
      expect(names, `${t} must be registered before any table exists`).toContain(t);
    }
    // The registry is not the only copy. `registerPipelineTools()` copies it into
    // the tool context during boot, and that copy is what workflow steps get
    // before any session exists — a scheduled run right after a restart. Read
    // before `createSession()`, which would refresh it and hide a late registration.
    const contextNames = engine.getToolContext().tools.map(e => e.definition.name);
    for (const t of DATA_STORE_TOOLS) {
      expect(contextNames, `${t} must be in the tool context that session-less workflow steps get`).toContain(t);
    }
  });

  it('hands all six to the first session\'s agent, with the prompt section that describes them', async () => {
    freshDataDir();
    const engine = await boot();
    const agent = agentOf(engine.createSession());
    const offered = agent.getAvailableTools().map(t => t.definition.name);
    for (const t of DATA_STORE_TOOLS) {
      expect(offered, `${t} must reach the model, not only the registry`).toContain(t);
    }
    expect(agent.systemPrompt).toContain(DATASTORE_PROMPT_SUFFIX);
  });

  it('lets ONE tool snapshot create a table and fill it — create, insert and query from the same list', async () => {
    // An agent keeps the tool list it was built with for the whole turn. So the core flow —
    // "make a table for these receipts and put them in" — works only if the SAME snapshot
    // already carries insert when create runs. Taken once, used for all three calls.
    freshDataDir();
    const engine = await boot();
    const agent = agentOf(engine.createSession());
    const snapshot = agent.getAvailableTools();
    const call = async (name: string, input: unknown): Promise<string> => {
      const tool = snapshot.find(t => t.definition.name === name);
      expect(tool, `${name} must be in the turn's tool list`).toBeDefined();
      return tool!.handler(input, agent);
    };

    await call('data_store_create', {
      name: 'belege',
      columns: [{ name: 'lieferant', type: 'string' }, { name: 'betrag', type: 'number' }],
    });
    const inserted = await call('data_store_insert', {
      collection: 'belege',
      records: [{ lieferant: 'Papeterie Nord', betrag: 42.5 }, { lieferant: 'Druckerei Süd', betrag: 17 }],
    });
    expect(inserted).not.toMatch(/not found|not available|error/i);

    const queried = await call('data_store_query', { collection: 'belege' });
    expect(queried).toContain('Papeterie Nord');
    expect(queried).toContain('Druckerei Süd');
  });

  it('keeps all six through the boot that drops the CRM\'s empty collections', async () => {
    // The drop-then-recreate cycle is what hid the tools: boot 1 lets the CRM create its
    // collections, EMPTY; boot 2 drops them before the old check ran. Both halves of that are
    // asserted — the empty collection after boot 1 and the drop in boot 2 — or a second boot
    // with nothing to drop would pass this for the wrong reason. If the drop is ever changed to
    // spare the CRM's own collections, this test goes red on purpose: it then checks nothing
    // that test 1 does not.
    freshDataDir();
    const first = await boot();
    const crmOwned = first.getDataStore()?.listCollections().filter(c => c.name === 'contacts') ?? [];
    expect(crmOwned, 'boot 1 must leave an empty CRM collection behind, or boot 2 drops nothing').toHaveLength(1);
    expect(crmOwned[0]?.recordCount).toBe(0);
    await first.shutdown();
    engines.splice(engines.indexOf(first), 1);

    const drop = vi.spyOn(DataStore.prototype, 'dropEmptyCrmOverlaps');
    try {
      const second = await boot();
      expect(drop, 'boot 2 must run the drop').toHaveBeenCalledTimes(1);
      expect(drop.mock.results[0]?.value, 'boot 2 must actually drop the CRM\'s empty collection').toContain('contacts');
      const names = second.getRegistry().getEntries().map(e => e.definition.name);
      for (const t of DATA_STORE_TOOLS) {
        expect(names, `${t} must survive the boot-time drop`).toContain(t);
      }
    } finally {
      drop.mockRestore();
    }
  });

  it('still registers all six on an instance that already has a table of its own', async () => {
    // The fix must not trade one case for the other. Every boot above sees an empty store at
    // the registration point, so a registration gated on an EMPTY store would pass them all.
    // An instance with its own table is the case that always worked; it has to keep working.
    freshDataDir();
    const first = await boot();
    const agent = agentOf(first.createSession());
    const create = agent.getAvailableTools().find(t => t.definition.name === 'data_store_create');
    expect(create, 'data_store_create must be offered on boot 1').toBeDefined();
    await create!.handler({ name: 'belege', columns: [{ name: 'betrag', type: 'number' }] }, agent);
    // With a record, so the table is the non-empty kind a real instance has — an empty one would
    // let a registration gated on "no table of its own holds data" pass this test.
    const insert = agent.getAvailableTools().find(t => t.definition.name === 'data_store_insert');
    expect(insert, 'data_store_insert must be offered on boot 1').toBeDefined();
    await insert!.handler({ collection: 'belege', records: [{ betrag: 42.5 }] }, agent);
    await first.shutdown();
    engines.splice(engines.indexOf(first), 1);

    const second = await boot();
    const own = second.getDataStore()?.listCollections().find(c => c.name === 'belege');
    expect(own?.recordCount, 'the table from boot 1, with its record, must survive boot 2, or this is a fresh-store test again')
      .toBeGreaterThan(0);
    const names = second.getRegistry().getEntries().map(e => e.definition.name);
    for (const t of DATA_STORE_TOOLS) {
      expect(names, `${t} must be registered on an instance with a table of its own`).toContain(t);
    }
  });

  it('still registers all six on an instance whose only data is a CRM record', async () => {
    // The other case that always worked: no table of its own, but a contact. A CRM collection
    // with a record survives the drop, so the old check saw a collection and registered. No other
    // test here boots with a CRM record, so a registration gated on "no CRM data" would pass them.
    freshDataDir();
    const first = await boot();
    const agent = agentOf(first.createSession());
    const save = agent.getAvailableTools().find(t => t.definition.name === 'contacts_save');
    expect(save, 'contacts_save must be offered on boot 1').toBeDefined();
    await save!.handler({ name: 'Ada Muster', email: 'ada@example.test' }, agent);
    await first.shutdown();
    engines.splice(engines.indexOf(first), 1);

    const second = await boot();
    const collections = second.getDataStore()?.listCollections() ?? [];
    expect(collections.find(c => c.name === 'contacts')?.recordCount,
      'the contact from boot 1 must survive boot 2, or this is a fresh-store test again').toBeGreaterThan(0);
    expect(collections.filter(c => !CRM_OVERLAP_NAMES.has(c.name)).map(c => c.name),
      'no table of its own — only the CRM record may make this instance non-empty').toEqual([]);
    const names = second.getRegistry().getEntries().map(e => e.definition.name);
    for (const t of DATA_STORE_TOOLS) {
      expect(names, `${t} must be registered on an instance with a CRM record`).toContain(t);
    }
  });

  it('keeps the deprecated Session.registerDataStoreTools() a no-op — same tools, same registry version', async () => {
    // It stays for library consumers, but it must do nothing. A registry change makes a
    // session rebuild its agent at the start of its next run (the version check in `run()`),
    // so a call that registered the six again would cost a rebuild and gain nothing.
    freshDataDir();
    const engine = await boot();
    const session = engine.createSession();
    const registry = engine.getRegistry();
    const version = registry.version;
    const names = registry.getEntries().map(e => e.definition.name);
    session.registerDataStoreTools();
    expect(registry.version, 'a second registration must not bump the registry version').toBe(version);
    expect(registry.getEntries().map(e => e.definition.name)).toEqual(names);
  });
});
