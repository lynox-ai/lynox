import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';
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
    // An ARCHIVED thread and a titled one with NO messages. Both were unseeded
    // until a refuter pointed out what that costs: the overview listing filters
    // `message_count > 0` and defaults `is_archived = 0`, so with neither seeded a
    // route that reads through that listing passes this file — which is how the
    // export came to omit a row class the erasure destroys.
    archived_thread: 'ZZMARKER-archived-thread-7f3a',
    empty_titled_thread: 'ZZMARKER-empty-titled-thread-7f3a',
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
    // The DK REVIEW QUEUE. The export emits it as `durable_knowledge.pending_entries`
    // and it was unseeded, so a regression sparing `status='pending_review'` rows —
    // or a queue that moves to its own file — left an un-erased personal-data row
    // sitting in export #2's own payload with every assertion green. A refuter
    // demonstrated exactly that.
    durable_pending: 'ZZMARKER-durable-pending-7f3a',
    // `config` is exported (redacted) and reset by the erasure. With nothing seeded
    // it was `{}` in both exports, so the reset was witnessed by nothing and
    // deleting it survived every test.
    config: 'ZZMARKER-config-7f3a',
  } as const;

  /** Which top-level export key each marker must appear in — the control is
   *  PER KEY, not a substring search over the whole dump.
   *
   *  ⚠ The whole-dump search was the flaw a refuter demonstrated: `MARK.contact`
   *  also appears in `deals` (as `contact_name`) and in `datastore` (the CRM is a
   *  view over two DataStore collections, which `listCollections` returns). Seeding
   *  only the deal and never calling `upsertContact` therefore satisfied the
   *  control while the `contacts` surface was never reached — so its absence from
   *  export #2 proved nothing about it. A control that cannot say WHICH key
   *  produced the hit is not a per-surface control. */
  const MARKER_HOME: Record<keyof typeof MARK, string> = {
    thread_title: 'threads',
    thread_message: 'threads',
    archived_thread: 'threads',
    empty_titled_thread: 'threads',
    memory: 'memory',
    knowledge_graph: 'knowledge_graph',
    durable_knowledge: 'durable_knowledge',
    durable_pending: 'durable_knowledge',
    memory_block: 'durable_knowledge',
    contact: 'contacts',
    deal: 'deals',
    datastore: 'datastore',
    secret_name: 'secrets',
    config: 'config',
  };

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
    for (const k of [
      'LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY',
      'LYNOX_DURABLE_MEMORY_ENABLED', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE',
      'LYNOX_SUBJECT_GRAPH_ENABLED',
    ]) {
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
    // `denyOnManagedInstance` 403s the erasure on any instance with a billing tier
    // set, so a stray env var makes this file fail for a reason that has nothing to
    // do with the property — and `readEnvAlias` falls back to `LYNOX_MANAGED_MODE`,
    // so deleting only the canonical name left half a guard.
    delete process.env['LYNOX_BILLING_TIER'];
    delete process.env['LYNOX_MANAGED_MODE'];
    // This one selects which DATABASE the export's entity list comes from:
    // flag-on, `KnowledgeLayer.listEntities` reads engine.db via the subject store,
    // while the erasure always deletes from agent-memory.db. The fixture's legacy
    // entity would then be missing from export #1 and the positive control would
    // fail on a correct erasure. `process.env` is per-fork and shared across test
    // files, and at least one other file leaves this set, so the configuration
    // under test has to be pinned rather than inherited.
    delete process.env['LYNOX_SUBJECT_GRAPH_ENABLED'];
    reloadConfig();
    api = new LynoxHTTPApi();
    await api.init();
    await api.start(0);
    baseUrl = `http://127.0.0.1:${portOf()}`;
  }, 120_000);

  afterAll(async () => {
    // `finally`, and the shutdown is optional-chained: if `beforeAll` throws before
    // the server exists — a full disk on `mkdtempSync` is the realistic one — then
    // `api` is undefined, `await api.shutdown()` throws out of the hook, and
    // `LYNOX_DATA_DIR` plus `LYNOX_DURABLE_MEMORY_ENABLED=true` leak into every
    // later file in this fork. A cleanup hook that can fail before it cleans up is
    // the one place where the recovery depends on the thing that broke.
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

  /** Writes one marker into every surface the export reads, through the real
   *  stores. Returns the markers it actually managed to write. */
  async function seedEverySurface(): Promise<void> {
    const e = engineOf();

    const ts = e.getThreadStore();
    if (ts === null) throw new Error('fixture: no thread store');
    ts.createThread('t-marked', { title: MARK.thread_title });
    ts.appendMessages('t-marked', [{ role: 'user', content: MARK.thread_message }], 0, { message_count: 1 });
    ts.createThread('t-archived', { title: MARK.archived_thread });
    ts.appendMessages('t-archived', [{ role: 'user', content: 'archived body' }], 0, { message_count: 1 });
    ts.updateThread('t-archived', { is_archived: true });
    // No `appendMessages` — the rollup counter stays 0, which is the state
    // `escalation.ts` leaves behind between its two transactions, and the state a
    // user leaves by opening a thread and typing nothing.
    ts.createThread('t-empty-titled', { title: MARK.empty_titled_thread });

    const mem = e.getMemory();
    if (mem === null) throw new Error('fixture: no memory');
    await mem.save('knowledge', MARK.memory);

    const kg = e.getKnowledgeLayer();
    if (kg === null) throw new Error('fixture: no knowledge layer');
    kg.getDb().createEntity({ canonicalName: MARK.knowledge_graph, entityType: 'person', scopeType: 'global', scopeId: '' });

    const ks = e.getKnowledgeStore();
    if (ks === null) throw new Error('fixture: no knowledge store — is LYNOX_DURABLE_MEMORY_ENABLED set?');
    ks.write({ text: MARK.durable_knowledge, sourceChannel: 'user', sourceUntrusted: false });
    // `sourceUntrusted` routes the write to `pending_review` — the queue half of
    // the substrate, which the export reads and nothing here used to seed. A queued
    // fact is stored personal data whether or not it was ever approved.
    ks.write({ text: MARK.durable_pending, sourceChannel: 'agent', sourceUntrusted: true });
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

    // The config file, through the same writer the erasure's reset uses. `language`
    // is a plain, non-secret field, so `redactConfigForResponse` leaves it in the
    // dump — a redacted field would have made this marker unobservable and the
    // surface uncheckable, which is what `config` already was.
    const { saveUserConfig } = await import('../core/config.js');
    saveUserConfig({ language: MARK.config } as unknown as Parameters<typeof saveUserConfig>[0]);
  }

  it('leaves not one seeded datum behind, and only then says so', async () => {
    await seedEverySurface();
    const e0 = engineOf();

    const beforeRes = await get('/api/export');
    expect(beforeRes.status).toBe(200);
    const before = await beforeRes.text();
    const beforeJson = JSON.parse(before) as Record<string, unknown>;

    // POSITIVE CONTROL, and the assertion this test would be worthless without:
    // a marker missing HERE means the fixture never reached that surface, in which
    // case its absence from the second export proves nothing at all.
    //
    // Checked inside its OWN key (`MARKER_HOME`) rather than anywhere in the dump.
    // The whole-dump version passed while a surface went unseeded: `MARK.contact`
    // also occurs in `deals` as `contact_name` and in `datastore`, because the CRM
    // is a view over two DataStore collections — so seeding only the deal satisfied
    // the control with `contacts` never written.
    const unseeded = Object.entries(MARK)
      .filter(([k, v]) => !JSON.stringify(beforeJson[MARKER_HOME[k as keyof typeof MARK]]).includes(v))
      .map(([k]) => `${k}→${MARKER_HOME[k as keyof typeof MARK]}`);
    expect(unseeded, 'the export must show every seeded surface, in its own key, before anything is erased').toEqual([]);

    const { status, body } = await erase();
    expect(status).toBe(200);
    expect(body['message']).toBe('All user data has been permanently deleted');

    // ⚠ BEFORE anything else reads the CRM, and the position is the assertion.
    // `roles.ts` admits `contacts_search` to the READ-ONLY tool surface with the
    // justification that `ensureSchema` is "a latch already closed during boot; the
    // CRM's DDL is therefore unreachable here". The erasure drops the collections
    // that memo describes, so a repair that only re-opened the latch would leave
    // the next `contacts_search` from a read-only spawned agent running
    // `CREATE TABLE`. `rebuildSchema` re-ensures in the same synchronous call, so
    // no other caller can observe it open.
    //
    // Asserted here rather than at the end of this test because the export below
    // performs a CRM read, which closes the latch by itself — further down, the
    // line is satisfied by a repair that did nothing.
    expect(e0.getCRM()!.initialized, 'the CRM schema latch must be closed again, before any reader').toBe(true);

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
      'knowledge_graph', 'memory', 'secrets', 'threads', 'threads_may_be_incomplete', 'version',
    ]);

    const survivors = Object.entries(MARK).filter(([, v]) => after.includes(v)).map(([k]) => k);
    expect(survivors, 'these surfaces still hold data the export returns').toEqual([]);

    // And at the SOURCE as well as in the answer.
    //
    // ⚠ What this half does and does not do, corrected twice after refuters
    // demonstrated the overclaim twice. It catches a dropped export key and an
    // accessor gone null. For the stores read through their own API below
    // (`listActive`, `getBlock`, `listNames`, `load`) it is NOT an independent
    // witness: those are the same methods the export route calls, so a listing that
    // stopped returning rows which are still on disk satisfies both halves at once.
    // The DataStore is the exception and deliberately so — it is read from the FILE
    // further down, because that is exactly the case a refuter demonstrated. For the
    // rest, the independent check is the re-seed at the end of this test.
    const e = engineOf();
    // Through the EXHAUSTIVE reader, not the overview listing: the listing caps at
    // 200 and filters `message_count > 0`, so it reports "no threads" for a table
    // that still holds the archived and the empty-titled one. A source check read
    // through a capped listing is the same instrument the defect came from.
    expect(e.getThreadStore()!.listThreadsForExport({ limit: 500 })).toEqual([]);
    // `save(ns, '')` leaves the namespace EMPTY, which `load` reports as either ''
    // or null depending on whether the file survives — the property is that the
    // text is gone, not which of the two empties it became.
    expect(await e.getMemory()!.load('knowledge') ?? '').toBe('');
    expect(e.getKnowledgeStore()!.listActive(500)).toEqual([]);
    // The review queue, which the export emits as `durable_knowledge.pending_entries`
    // and which nothing checked: a wipe that spared `status='pending_review'` left a
    // personal-data row in export #2's own payload with every other line green.
    expect(e.getKnowledgeStore()!.listPendingMasked(500)).toEqual([]);
    expect(e.getKnowledgeStore()!.getBlock('profile')?.content ?? '').not.toContain(MARK.memory_block);
    expect(e.getCRM()!.listContacts(undefined, 500)).toEqual([]);
    expect(e.getCRM()!.getAllDeals(undefined, 500)).toEqual([]);
    // ⚠ Read from the FILE, with our own connection, and this is not belt-and-
    // braces — it is the one assertion here that does not go through the same store
    // method the export route goes through.
    //
    // What the `listCollections()` version missed, measured end to end by a
    // refuter: an erasure that removes a collection's `ds_collections` META row and
    // leaves its `ds_<name>` data table on disk. Every check pointed the reassuring
    // way — `survivors` was empty (the dump no longer lists the collection),
    // "no collection holds rows" was empty (it iterates the same listing), and
    // `not.toContain('marked_rows')` was *satisfied by the defect*. The marker row
    // was still there after a 200 "All user data has been permanently deleted".
    //
    // `datastore.db` is also its own file, so `engineDb.deleteAllData()`'s
    // `sqlite_master` sweep — the thing that makes the DK coverage transitive — does
    // not reach it at all.
    const dsDb = new BetterSqlite3(join(dir, 'datastore.db'), { readonly: true });
    try {
      const tables = (dsDb.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ds_%' AND name != 'ds_collections'",
      ).all() as Array<{ name: string }>).map(t => t.name);
      const populated = tables.filter(t =>
        (dsDb.prepare(`SELECT COUNT(*) c FROM "${t}"`).get() as { c: number }).c > 0).map(t => t.name);
      expect(populated, 'a DataStore table still holds rows on disk').toEqual([]);
      // And the fixture's own table is gone as a TABLE, not merely absent from the
      // catalogue — the distinction the old assertion could not make.
      expect(tables, 'the seeded data table survived as a table').not.toContain('ds_marked_rows');
      // The INVERSE defect, which the assertion this replaced did cover: the table
      // dropped and the catalogue row left behind. That row carries the collection
      // name the user chose and its `schema_json` column names, and the export
      // substitutes `[]` for a collection whose table is missing — so without this
      // line the state is invisible to the whole file.
      const metaNames = (dsDb.prepare('SELECT name FROM ds_collections').all() as Array<{ name: string }>).map(r => r.name);
      expect(metaNames, 'a catalogue row outlived its table').not.toContain('marked_rows');
    } finally {
      dsDb.close();
    }
    expect(e.getSecretStore()!.listNames()).not.toContain(MARK.secret_name);

    // ⚠ The discriminator, and without it this test's central assertion has a
    // second explanation. "No marker survived" is satisfied just as well by a
    // surface that STOPPED BEING READ as by one that was emptied — and three of the
    // export's sections substitute an empty block on a caught error
    // (`knowledge_graph`, `durable_knowledge`, and `datastore` per collection), so
    // a store left unusable by the erasure yields 200, all keys present, no
    // markers: every check above points the reassuring way. Re-seeding and
    // re-exporting is what tells the two apart — a section that is still wired
    // shows the new datum, a silently-quiet one does not.
    const RESEED = 'ZZMARKER-after-erasure-7f3a';
    // `datastore` is in the re-seed list below, and its absence was the gap: the
    // comment above names it as one of the three sections that substitute an empty
    // block on a caught error, and then the loop did not check it.
    const ts2 = e.getThreadStore()!;
    ts2.createThread('t-reseed', { title: RESEED });
    ts2.appendMessages('t-reseed', [{ role: 'user', content: 'reseeded' }], 0, { message_count: 1 });
    await e.getMemory()!.save('knowledge', RESEED);
    e.getKnowledgeStore()!.write({ text: `${RESEED} is a durable fact`, sourceChannel: 'user', sourceUntrusted: false });
    e.getCRM()!.upsertContact({ name: RESEED, email: 'reseed@example.invalid' });
    e.getSecretStore()!.set('ZZMARKER_RESEED_7F3A', 'v');
    e.getKnowledgeLayer()!.getDb().createEntity({ canonicalName: RESEED, entityType: 'person', scopeType: 'global', scopeId: '' });
    const dsAfter = e.getDataStore()!;
    dsAfter.createCollection({ name: 'reseeded_rows', scope: { type: 'global', id: '' }, columns: [{ name: 'note', type: 'string' }] });
    dsAfter.insertRecords({ collection: 'reseeded_rows', records: [{ note: RESEED }] });

    const reRes = await get('/api/export');
    expect(reRes.status).toBe(200);
    const reText = await reRes.text();
    for (const section of ['threads', 'memory', 'durable_knowledge', 'contacts', 'knowledge_graph', 'datastore'] as const) {
      expect(
        (JSON.stringify((JSON.parse(reText) as Record<string, unknown>)[section])).includes(RESEED),
        `${section} stopped being read — an empty section is not an emptied store`,
      ).toBe(true);
    }
    expect(reText).toContain('ZZMARKER_RESEED_7F3A');
  }, 120_000);

  it('reads and erases ALL threads past the 200-row page, in both routes', async () => {
    const e = engineOf();
    const ts = e.getThreadStore()!;
    // Start from empty rather than from whatever the previous case left: the two
    // tests share one booted engine, so a count asserted against "250 seeded" is
    // only true if nothing else is in the table. Without this the case passes or
    // fails depending on test ORDER, which is the worst kind of green.
    const firstErase = await erase();
    expect(firstErase.status, 'the fixture reset must itself have succeeded').toBe(200);
    expect(ts.listThreadsForExport({ limit: 500 }), 'fixture guard').toEqual([]);
    // 600, and the number is load-bearing twice over. It is past the old
    // `listThreads` cap of 200, which is the defect: the export returned 200 of
    // these and the erasure deleted 200, both answering success. And it is past the
    // export route's own page size, which is what makes the route's WALK run at
    // all — at 250 the first page returned everything, the loop broke immediately,
    // and a reader that ignored its `after` cursor entirely passed this test. A
    // refuter's mutant proved it: the file was green with the keyset discarded.
    const SEEDED = 600;
    for (let i = 0; i < SEEDED; i++) {
      const id = `bulk-${String(i).padStart(4, '0')}`;
      ts.createThread(id, { title: `Bulk ${i}` });
      ts.appendMessages(id, [{ role: 'user', content: `m${i}` }], 0, { message_count: 1 });
    }

    const dumpRes = await get('/api/export');
    expect(dumpRes.status).toBe(200);
    const dump = await dumpRes.json() as { threads: Array<{ id: string }> };
    expect(dump.threads).toHaveLength(SEEDED);
    // Not just the count: a second page that repeated page one would also be 250.
    expect(new Set(dump.threads.map(t => t.id)).size, 'a second page that repeated the first would also be long enough').toBe(SEEDED);

    const { status, body } = await erase();
    expect(status).toBe(200);
    expect(body['deleted']).toBe(true);
    expect(ts.listThreadsForExport({ limit: 500 }), 'an erasure must leave zero threads').toEqual([]);
  }, 120_000);
});
