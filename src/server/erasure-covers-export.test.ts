import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import type { ThreadStore } from '../core/thread-store.js';
import type { KnowledgeStore } from '../core/knowledge-store.js';
import type { KnowledgeLayer } from '../core/knowledge-layer.js';
import type { DataStore } from '../core/data-store.js';
import type { SecretStore } from '../core/secret-store.js';
import type { CRM } from '../core/crm.js';
import type { FlatFileMemory } from '../core/memory.js';

/**
 * The property `GET /api/export` and `DELETE /api/data` owe each other:
 * **every store the export reads is emptied by the erasure.**
 *
 * ⚠ Why this file exists rather than another case in `http-api.test.ts`, and the
 * reason is not thoroughness — a mocked version of this test CANNOT measure the
 * property, and one was written and deleted before this one. Two of the stores are
 * erased TRANSITIVELY, by a path that never names them:
 *
 *   · the Durable Knowledge Substrate (`knowledge_entries`, `memory_blocks`) is
 *     cleared by `engineDb.deleteAllData()`, because `KnowledgeStore` shares the
 *     engine.db connection and that wipe enumerates tables from `sqlite_master`
 *   · CRM contacts and deals are cleared by `ds.dropCollection`, because the CRM
 *     is a view over two DataStore collections
 *
 * With mocks, both coverages are properties of the FIXTURE: wire the fakes
 * faithfully and it passes, wire them as independent objects — as the deleted
 * version did — and it reports a leftover that does not exist. Either way the
 * control is built from the test, so the day DK moves to its own database file the
 * mocked test stays green and a tenant's facts outlive their erasure request. Only
 * a real engine over real stores can see the difference, which is also why
 * "remove one delete path" is a mutation that belongs here.
 *
 * ONE boot for the whole file: a real `LynoxHTTPApi.init()` opens every store.
 */
describe('Art. 17 erasure covers every surface the Art. 15 export reads (real engine)', () => {
  // Built at RUNTIME, never written as a literal: a key-SHAPED string in a fixture
  // is what the commit-time secret scan looks for, and this repo is public.
  const SECRET = `t-${randomBytes(12).toString('hex')}`;
  let api: LynoxHTTPApi;
  let baseUrl: string;
  let dir: string;
  const saved: Record<string, string | undefined> = {};

  /** Each marker is the seeded datum itself, so its ABSENCE from the second export
   *  is the property — not a stand-in for it. Distinctive enough that a substring
   *  search over the whole dump cannot match anything the engine wrote itself. */
  const MARK = {
    thread_title: 'ZZMARKER-thread-title-7f3a',
    thread_message: 'ZZMARKER-thread-message-7f3a',
    memory: 'ZZMARKER-flatfile-memory-7f3a',
    knowledge_graph: 'ZZMARKER-kg-entity-7f3a',
    durable_knowledge: 'ZZMARKER-durable-fact-7f3a',
    memory_block: 'ZZMARKER-memory-block-7f3a',
    contact: 'ZZMARKER-contact-7f3a',
    deal: 'ZZMARKER-deal-7f3a',
    datastore: 'ZZMARKER-datastore-cell-7f3a',
    // Secret NAMES are exported, values never are — so the marker has to live in
    // the name or this surface cannot be checked at all.
    secret_name: 'ZZMARKER_SECRET_NAME_7F3A',
  } as const;

  function engineOf(): {
    getThreadStore: () => ThreadStore | null;
    getMemory: () => FlatFileMemory | null;
    getKnowledgeLayer: () => KnowledgeLayer | null;
    getKnowledgeStore: () => KnowledgeStore | null;
    getCRM: () => CRM | null;
    getDataStore: () => DataStore | null;
    getSecretStore: () => SecretStore | null;
  } {
    return (api as unknown as { engine: ReturnType<typeof engineOf> }).engine;
  }

  function portOf(): number {
    const srv = (api as unknown as { server: Server | null }).server;
    const addr = srv?.address();
    if (addr === null || addr === undefined || typeof addr === 'string') throw new Error('no port');
    return addr.port;
  }

  async function get(path: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${SECRET}` } });
  }

  async function erase(): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${baseUrl}/api/data`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'DELETE_ALL_DATA' }),
    });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-erasure-'));
    for (const k of ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY', 'LYNOX_DURABLE_MEMORY_ENABLED', 'LYNOX_BILLING_TIER']) {
      saved[k] = process.env[k];
    }
    process.env['LYNOX_DATA_DIR'] = dir;
    process.env['LYNOX_HTTP_SECRET'] = SECRET;
    process.env['LYNOX_ALLOW_PLAIN_HTTP'] = 'true';
    process.env['LYNOX_VAULT_KEY'] = `v-${randomBytes(12).toString('hex')}`;
    // The substrate the whole DK half of this test is about. Off by default, so
    // without this `getKnowledgeStore()` is null and `durable_knowledge` would be
    // empty for a reason that has nothing to do with erasure.
    process.env['LYNOX_DURABLE_MEMORY_ENABLED'] = 'true';
    // `denyOnManagedInstance` 403s the erasure on any instance with a billing
    // tier set, and a stray env var from the shell would turn this file green
    // without the route ever running.
    delete process.env['LYNOX_BILLING_TIER'];
    reloadConfig();
    api = new LynoxHTTPApi();
    await api.init();
    await api.start(0);
    baseUrl = `http://127.0.0.1:${portOf()}`;
  }, 120_000);

  afterAll(async () => {
    await api.shutdown();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
    reloadConfig();
  });

  /** Writes one marker into every surface the export reads, through the real
   *  stores. Returns the markers it actually managed to write. */
  async function seedEverySurface(): Promise<void> {
    const e = engineOf();

    const ts = e.getThreadStore();
    if (ts === null) throw new Error('fixture: no thread store');
    ts.createThread('t-marked', { title: MARK.thread_title });
    ts.appendMessages('t-marked', [{ role: 'user', content: MARK.thread_message }], 0, { message_count: 1 });

    const mem = e.getMemory();
    if (mem === null) throw new Error('fixture: no memory');
    await mem.save('knowledge', MARK.memory);

    const kg = e.getKnowledgeLayer();
    if (kg === null) throw new Error('fixture: no knowledge layer');
    kg.getDb().createEntity({ canonicalName: MARK.knowledge_graph, entityType: 'person', scopeType: 'global', scopeId: '' });

    const ks = e.getKnowledgeStore();
    if (ks === null) throw new Error('fixture: no knowledge store — is LYNOX_DURABLE_MEMORY_ENABLED set?');
    ks.write({ text: MARK.durable_knowledge, sourceChannel: 'user', sourceUntrusted: false });
    ks.setBlockContent('profile', MARK.memory_block);

    const crm = e.getCRM();
    if (crm === null) throw new Error('fixture: no CRM');
    crm.upsertContact({ name: MARK.contact, email: 'marked@example.invalid' });
    crm.upsertDeal({ title: MARK.deal, contact_name: MARK.contact, stage: 'lead' });

    const ds = e.getDataStore();
    if (ds === null) throw new Error('fixture: no data store');
    ds.createCollection({
      name: 'marked_rows',
      scope: { type: 'global', id: '' },
      columns: [{ name: 'note', type: 'string' }],
    });
    ds.insertRecords({ collection: 'marked_rows', records: [{ note: MARK.datastore }] });

    const ss = e.getSecretStore();
    if (ss === null) throw new Error('fixture: no secret store');
    ss.set(MARK.secret_name, 'the-value-which-is-never-exported');
  }

  it('leaves not one seeded datum behind, and only then says so', async () => {
    await seedEverySurface();

    const beforeRes = await get('/api/export');
    expect(beforeRes.status).toBe(200);
    const before = await beforeRes.text();

    // POSITIVE CONTROL, and the assertion this test would be worthless without:
    // a marker missing HERE means the fixture never reached that surface, in which
    // case its absence from the second export proves nothing at all. Named
    // individually so a failure says WHICH surface went unseeded.
    const unseeded = Object.entries(MARK).filter(([, v]) => !before.includes(v)).map(([k]) => k);
    expect(unseeded, 'the export must show every seeded surface before anything is erased').toEqual([]);

    const { status, body } = await erase();
    expect(status).toBe(200);
    expect(body['message']).toBe('All user data has been permanently deleted');

    // ⚠ The STATUS first, and this file's own near-miss is the reason the line is
    // here. The second export used to 500 — the erasure drops the CRM's two
    // collections and `CRM.ensureSchema` had memoised that they exist, so every
    // later CRM read threw `Collection "contacts" not found`. A 500 body contains
    // no markers, so the survivor check below PASSED on an error page: a route
    // that had stopped answering at all read as a clean erasure. A "no marker
    // found" result points in the reassuring direction whatever the reason, so it
    // is only worth having once the response is known to be the dump.
    const afterRes = await get('/api/export');
    expect(afterRes.status, 'the export must still ANSWER after an erasure').toBe(200);
    const after = await afterRes.text();
    // And it must still be the dump, not any 200 — every surface present, so a key
    // that quietly stopped being exported cannot pass as an emptied one.
    const afterJson = JSON.parse(after) as Record<string, unknown>;
    expect(Object.keys(afterJson).sort()).toEqual([
      'config', 'contacts', 'datastore', 'deals', 'durable_knowledge', 'exported_at',
      'knowledge_graph', 'memory', 'secrets', 'threads', 'version',
    ]);

    const survivors = Object.entries(MARK).filter(([, v]) => after.includes(v)).map(([k]) => k);
    expect(survivors, 'these surfaces still hold data the export returns').toEqual([]);

    // And at the SOURCE, not only in the answer. A surface that stopped being READ
    // — an accessor gone null, a key dropped from the dump — would satisfy the line
    // above while the rows sit untouched on disk. This is the half that tells the
    // two apart.
    const e = engineOf();
    expect(e.getThreadStore()!.listThreads({ limit: 200, includeArchived: true })).toEqual([]);
    // `save(ns, '')` leaves the namespace EMPTY, which `load` reports as either ''
    // or null depending on whether the file survives — the property is that the
    // text is gone, not which of the two empties it became.
    expect(await e.getMemory()!.load('knowledge') ?? '').toBe('');
    expect(e.getKnowledgeStore()!.listActive(500)).toEqual([]);
    expect(e.getKnowledgeStore()!.getBlock('profile')?.content ?? '').not.toContain(MARK.memory_block);
    expect(e.getCRM()!.listContacts(undefined, 500)).toEqual([]);
    expect(e.getCRM()!.getAllDeals(undefined, 500)).toEqual([]);
    // Not "no collections": the export above runs a CRM read, which legitimately
    // re-creates the two EMPTY CRM tables (that is what the invalidated schema
    // cache is for). The property is that nothing holds a record — a collection
    // with a schema and no rows discloses nothing.
    expect(e.getDataStore()!.listCollections().filter(c => c.recordCount > 0)).toEqual([]);
    expect(e.getDataStore()!.listCollections().map(c => c.name)).not.toContain('marked_rows');
    expect(e.getSecretStore()!.listNames()).not.toContain(MARK.secret_name);
  }, 120_000);

  it('reads and erases ALL threads past the 200-row page, in both routes', async () => {
    const e = engineOf();
    const ts = e.getThreadStore()!;
    // Start from empty rather than from whatever the previous case left: the two
    // tests share one booted engine, so a count asserted against "250 seeded" is
    // only true if nothing else is in the table. Without this the case passes or
    // fails depending on test ORDER, which is the worst kind of green.
    await erase();
    expect(ts.listThreads({ limit: 200, includeArchived: true }), 'fixture guard').toEqual([]);
    // 250: both routes used to take a single `listThreads({ limit: 200 })`, so the
    // export returned 200 of these and the erasure deleted 200 of them — and
    // answered success. The number is deliberately just past one page; nothing is
    // learned from 10 000 that is not already visible at 250.
    for (let i = 0; i < 250; i++) {
      ts.createThread(`bulk-${String(i).padStart(4, '0')}`, { title: `Bulk ${i}` });
      ts.appendMessages(`bulk-${String(i).padStart(4, '0')}`, [{ role: 'user', content: `m${i}` }], 0, { message_count: 1 });
    }

    const dumpRes = await get('/api/export');
    expect(dumpRes.status).toBe(200);
    const dump = await dumpRes.json() as { threads: Array<{ id: string }> };
    expect(dump.threads).toHaveLength(250);
    // Not just the count: a second page that repeated page one would also be 250.
    expect(new Set(dump.threads.map(t => t.id)).size).toBe(250);

    const { status, body } = await erase();
    expect(status).toBe(200);
    expect(body['deleted']).toBe(true);
    expect(ts.listThreads({ limit: 200, includeArchived: true }), 'an erasure must leave zero threads').toEqual([]);
  }, 120_000);
});
