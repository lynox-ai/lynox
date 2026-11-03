import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { BulkLedger, BULK_HALT_REASONS, classifyChange, sameValue } from './bulk-ledger.js';
import { OWNER_PRINCIPAL } from './request-principal.js';
import { externalWriter, mintBulkContract, type ExternalClient, type ExternalImage, type ExternalRead } from './bulk-external.js';
import { parseListSource } from './bulk-list.js';
import { markupAddedByHost } from './bulk-html.js';
import { runBulkEffect, type TargetWriter } from './bulk-apply.js';
import { BULK_NOTICES, type BulkNotices } from './bulk-notices.js';
import type { BeforeImage } from './bulk-ledger.js';
import type { CapabilityContract } from '../types/capability-contract.js';

// The read-back after a write and the undo of a description (PRD shopify-preset §21.2 items 2, 6
// and 7). Until descriptions are written on Shopify (item 1), the ledger's side runs here on a
// WooCommerce list run, whose `description` is an HTML field of its list form too; the writer's
// side runs on a stub host.

const HOST = 'shop.example.com';
const LIST = `https://${HOST}/wp-json/wc/v3/products`;
const readContract: CapabilityContract = {
  version: 1, origin: 'reviewed', grantedTools: ['http_request'], httpMethods: ['GET'],
  hostPatterns: [HOST], pathPatterns: ['/wp-json/wc/v3/products'], paramConstraints: {},
};
const added = (sent: string, back: string, startDomains: string[] = []): boolean =>
  !markupAddedByHost({ sent, back, storeHost: HOST, startDomains }).ok;

let dir: string;
let engineDb: EngineDb;
let ledger: BulkLedger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lynox-bulk-shop-markup-'));
  engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  ledger = new BulkLedger(engineDb, null);
});
afterEach(() => {
  engineDb.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A confirmed probe for the list's verb, so a run writes wide (as `bulk-external-apply.test.ts`). */
function seedProbe(): void {
  const runId = 'fixture-probe';
  const db = engineDb.getDb();
  db.prepare(`INSERT OR IGNORE INTO bulk_runs (id, rule_hash, target_system, undo, phase, targets_total, targets_applied)
    VALUES (?, 'fixture', ?, 'restorable', 'done', 1, 1)`).run(runId, `http:${HOST}`);
  db.prepare(`INSERT OR IGNORE INTO bulk_targets (run_id, seq, target_key, change, applied_at, result)
    VALUES (?, 0, ?, 'update', '2026-09-30T00:00:00.000Z', ?)`).run(runId, engineDb.enc(`${LIST}/900`), engineDb.enc('written'));
  db.prepare('INSERT OR REPLACE INTO bulk_host_probes (host, method, kind, run_id, confirmed_at) VALUES (?, ?, ?, ?, ?)')
    .run(HOST, 'PUT', '/wp-json/wc/v3/products/', runId, '2026-09-30T00:00:00.000Z');
}

/** A WooCommerce list run over the products `befores` holds, each planned to `after`, read and approved. */
function approvedRun(after: Record<string, unknown>, befores: Record<string, unknown>[]): string {
  const source = parseListSource(HOST, { path: '/wp-json/wc/v3/products', after }, 'PUT', () => null);
  const out = ledger.recordExternalListPlan({ createdBy: 't', principal: OWNER_PRINCIPAL, host: HOST, source, readContract });
  if (!out.ok) throw new Error(out.reason);
  const id = out.status.id;
  if (!ledger.resumePreview(id, Date.now(), { listChecksum: ledger.listStartChecksum(id)! }).ok) throw new Error('list not started');
  ledger.recordListPage(id, { page: 1, items: befores.map((_, i) => ({ key: `${LIST}/${String(i + 1)}`, id: String(i + 1) })), bytes: 1 });
  ledger.finishList(id, (keys) => mintBulkContract(HOST, keys, 'PUT'));
  if (!ledger.resumePreview(id).ok) throw new Error('reads not started');
  for (const [i, seq] of ledger.listUnread(id).entries()) {
    if (!ledger.recordRead(id, seq, { before: befores[i]! })) throw new Error('read not recorded');
  }
  if (!ledger.finishPreview(id)) throw new Error('preview not finished');
  seedProbe();
  approve(id);
  return id;
}

function approve(id: string): void {
  const approved = ledger.approve(id, { checksum: ledger.computeChecksum(id)!, unmeasuredConfirmed: true });
  if (!approved.ok) throw new Error(approved.reason);
}

/** A host of products by key: it keeps what is written, then `kept` may change it. */
function stubWriter(store: Map<string, Record<string, unknown>>, kept: (sent: Record<string, unknown>) => Record<string, unknown> = (v) => v): TargetWriter & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    readsBack: true,
    async read(key, fields) {
      const v = store.get(key);
      if (!v || fields === null) return 'foreign';
      return { absent: false, value: Object.fromEntries(fields.map((f) => [f, v[f] ?? null])) };
    },
    async write(key, after: BeforeImage) {
      const value = after.value as Record<string, unknown>;
      sent.push(key);
      store.set(key, { ...store.get(key), ...kept(value) });
      const back = Object.fromEntries(Object.keys(value).map((f) => [f, store.get(key)![f] ?? null]));
      // The writer's own check stands in for `externalRunWriter`'s on the Shopify form.
      const marked = Object.keys(value).some((f) => typeof value[f] === 'string' && typeof back[f] === 'string'
        && added(value[f] as string, back[f] as string));
      return { result: 'written', actual: { value: back, estimated: false }, ...(marked ? { hostAddedMarkup: true as const } : {}) };
    },
  };
}

const run = (id: string, w: TargetWriter, effect: 'bulk_apply' | 'bulk_undo' = 'bulk_apply', notices?: BulkNotices) =>
  runBulkEffect(id, effect, { ledger, trailFor: () => null, writerFor: () => w, notices });
const SCRIPT = '<script>steal()</script>';

describe('markupAddedByHost: what the host kept against what was sent', () => {
  it('names an element, an attribute or a link domain the run never sent', () => {
    expect(added('<p>Neu</p>', `<p>Neu</p>${SCRIPT}`)).toBe(true);
    expect(added('<p>Neu</p>', '<p onclick="x()">Neu</p>')).toBe(true);
    expect(added('<p>Neu</p>', '<p>Neu <a href="https://evil.example/">x</a></p>')).toBe(true);
    expect(added('<p>Neu</p>', '<p>Neu</p><!-- wp:html -->')).toBe(true);
  });

  it('passes formatting, an allowlisted addition, a removal and markup that was sent', () => {
    expect(added('<P>Neu<br/></P>', '<p>Neu<br></p>')).toBe(false);
    expect(added('Neu', '<p>Neu</p>')).toBe(false);
    expect(added(`<p>Neu</p>${SCRIPT}`, '<p>Neu</p>')).toBe(false);
    expect(added(`<p>Neu</p>${SCRIPT}`, `<p>Neu</p>\n${SCRIPT}`)).toBe(false);
    expect(added('<p>Neu</p>', '<p>Neu <a href="/de/produkt">x</a></p>')).toBe(false);
  });

  it('names a tag or attribute value the host left open at the end, which no tree shows', () => {
    expect(added('<p>Neu</p>', '<p>Neu</p><img src=x onerror=alert(1) ')).toBe(true);
    expect(added('<p>Neu</p>', '<p title="x')).toBe(true);
    // A value sent open (an undo's before-image) and kept so is not the host's doing…
    expect(added('<p>Neu</p><b title="x', '<p>Neu</p><b title="x')).toBe(false);
    // …but what the host writes into that open end is, though both trees read the same.
    expect(added('<p>Neu</p><b title="x', '<p>Neu</p><b title="x" onerror="alert(1)')).toBe(true);
    expect(added('<p>Neu</p><img src=x ', '<p>Neu</p><img src=x onerror=alert(1) ')).toBe(true);
  });

  it('counts a second copy of a script the run sent once', () => {
    expect(added(`<p>Neu</p>${SCRIPT}`, `<p>Neu</p>${SCRIPT}${SCRIPT}`)).toBe(true);
  });

  it('does not refuse a hidden character the host added: that is no markup', () => {
    expect(added('<p>Neu</p>', '<p>Ne​u</p>')).toBe(false);
  });
});

describe('the external writer\'s read-back check', () => {
  const client = { track: () => () => null } as unknown as ExternalClient;
  const io = (back: ExternalImage | 'fail') => ({
    read: async (): Promise<ExternalRead> => (back === 'fail' ? { kind: 'error' } as unknown as ExternalRead : { kind: 'ok', value: back } as ExternalRead),
    write: async (): Promise<ExternalRead> => ({ kind: 'ok', value: {} } as ExternalRead),
  });
  const check = (sent: ExternalImage, back: ExternalImage): 'added' | 'rewritten' | 'kept' => {
    const s = sent['description'];
    const b = back['description'];
    if (typeof s !== 'string' || typeof b !== 'string') return 'kept';
    return added(s, b) ? 'added' : s === b ? 'kept' : 'rewritten';
  };

  it('reports the target written with what the host kept, and the mark', async () => {
    const w = externalWriter(client, { io: io({ description: `<p>Neu</p>${SCRIPT}` }), readBack: check });
    expect(await w.write('k', { absent: false, value: { description: '<p>Neu</p>' } })).toEqual({
      result: 'written', actual: { value: { description: `<p>Neu</p>${SCRIPT}` }, estimated: false }, hostAddedMarkup: true,
    });
  });

  it('reports a read-back that only reformats as rewritten, never marked, and nothing without a check', async () => {
    const reformatted = externalWriter(client, { io: io({ description: '<p>Neu</p>\n' }), readBack: check });
    expect(await reformatted.write('k', { absent: false, value: { description: '<p>Neu</p>' } }))
      .toEqual({ result: 'written', actual: { value: { description: '<p>Neu</p>\n' }, estimated: false }, hostRewrote: true });
    const unchecked = externalWriter(client, { io: io({ description: `<p>Neu</p>${SCRIPT}` }) });
    expect(await unchecked.write('k', { absent: false, value: { description: '<p>Neu</p>' } })).not.toHaveProperty('hostAddedMarkup');
  });

  it('keeps what was sent, estimated and unmarked, when the read-back fails', async () => {
    const w = externalWriter(client, { io: io('fail'), readBack: () => 'added' });
    expect(await w.write('k', { absent: false, value: { description: '<p>Neu</p>' } }))
      .toEqual({ result: 'written', actual: { value: { description: '<p>Neu</p>' }, estimated: true } });
  });
});

describe('a write the host kept with markup it was not sent (§21.2 item 6)', () => {
  it('records the target written with its actual and its mark, then halts before the next one', async () => {
    const id = approvedRun({ description: '<p>Neu</p>' }, [{ description: '<p>Alt</p>' }, { description: '<p>Alt 2</p>' }]);
    const store = new Map<string, Record<string, unknown>>([[`${LIST}/1`, { description: '<p>Alt</p>' }], [`${LIST}/2`, { description: '<p>Alt 2</p>' }]]);
    const w = stubWriter(store, (v) => ({ ...v, description: `${String(v['description'])}${SCRIPT}` }));
    const out = await run(id, w);
    expect(out.status).toBe('halted');
    expect(ledger.getStatus(id)).toMatchObject({ applied: 1, haltReason: BULK_HALT_REASONS.markupAddedByShop });
    expect(w.sent).toEqual([`${LIST}/1`]);
    const [first, second] = ledger.getPreview(id);
    expect(first).toMatchObject({ written: true, shopAddedMarkup: true });
    expect(second!.written).toBe(false);
    expect(second).not.toHaveProperty('shopAddedMarkup');
    const row = engineDb.getDb().prepare('SELECT after_actual FROM bulk_targets WHERE run_id = ? AND seq = ?').get(id, first!.seq) as { after_actual: string };
    expect(JSON.parse(engineDb.dec(row.after_actual))).toEqual({ value: { description: `<p>Neu</p>${SCRIPT}` }, estimated: false });
  });

  it('says the halt in the instance\'s notice language', async () => {
    const id = approvedRun({ description: '<p>Neu</p>' }, [{ description: '<p>Alt</p>' }]);
    const store = new Map([[`${LIST}/1`, { description: '<p>Alt</p>' } as Record<string, unknown>]]);
    const out = await run(id, stubWriter(store, (v) => ({ ...v, description: `${String(v['description'])}${SCRIPT}` })), 'bulk_apply', BULK_NOTICES.de);
    expect(out.summary.startsWith(BULK_NOTICES.de.halted('apply', BULK_HALT_REASONS.markupAddedByShop))).toBe(true);
  });

  it('keeps the mark when another halt overwrites the reason', async () => {
    const id = approvedRun({ description: '<p>Neu</p>' }, [{ description: '<p>Alt</p>' }]);
    const store = new Map([[`${LIST}/1`, { description: '<p>Alt</p>' } as Record<string, unknown>]]);
    await run(id, stubWriter(store, (v) => ({ ...v, description: `${String(v['description'])}${SCRIPT}` })));
    ledger.halt(id, BULK_HALT_REASONS.unavailable);
    expect(ledger.getPreview(id)[0]).toMatchObject({ shopAddedMarkup: true });
  });

  it('does not halt on a read-back with only a paragraph added, or only reformatted', async () => {
    const id = approvedRun({ description: 'Neu' }, [{ description: '<p>Alt</p>' }, { description: '<p>Alt 2</p>' }]);
    const store = new Map<string, Record<string, unknown>>([[`${LIST}/1`, { description: '<p>Alt</p>' }], [`${LIST}/2`, { description: '<p>Alt 2</p>' }]]);
    const out = await run(id, stubWriter(store, (v) => ({ ...v, description: `<p>${String(v['description'])}</p>\n` })));
    expect(out.status).toBe('done');
    expect(ledger.getStatus(id)).toMatchObject({ applied: 2, haltReason: null });
    expect(ledger.getPreview(id).some((t) => t.shopAddedMarkup === true)).toBe(false);
  });
});

describe('the undo of a description (§21.2 items 2 and 7)', () => {
  /** A run that wrote product 1, its read-back marked; and product 2, kept as sent. */
  async function markedRun(): Promise<{ id: string; store: Map<string, Record<string, unknown>> }> {
    const id = approvedRun({ description: '<p>Neu</p>' }, [{ description: '<p>Alt</p>' }, { description: '<p>Alt 2</p>' }]);
    const store = new Map<string, Record<string, unknown>>([[`${LIST}/1`, { description: '<p>Alt</p>' }], [`${LIST}/2`, { description: '<p>Alt 2</p>' }]]);
    let first = true;
    const w = stubWriter(store, (v) => {
      const plus = first ? SCRIPT : '';
      first = false;
      return { ...v, description: `${String(v['description'])}${plus}` };
    });
    await run(id, w);
    // The owner looked and writes on: product 2 is kept as sent.
    expect(ledger.resume(id, { checksum: ledger.computeChecksum(id)! })).toMatchObject({ ok: true });
    await run(id, w);
    expect(ledger.getStatus(id)).toMatchObject({ applied: 2 });
    return { id, store };
  }

  const planned = (sourceId: string): string => {
    const undo = ledger.planUndo(sourceId);
    if (!undo.ok) throw new Error(undo.reason);
    return undo.status.id;
  };
  const byKey = (id: string, key: string) => ledger.getPreview(id).find((t) => t.key === key)!;

  it('writes back the before-image of the marked product itself: that is the owner\'s state', async () => {
    const { id, store } = await markedRun();
    const undo = planned(id);
    expect(byKey(undo, `${LIST}/1`).change).toBe('update');
    approve(undo);
    expect((await run(undo, stubWriter(store), 'bulk_undo')).status).toBe('done');
    expect(store.get(`${LIST}/1`)!['description']).toBe('<p>Alt</p>');
  });

  it('refuses, in an undo of that undo, the value the store kept with the markup — and only that target', async () => {
    const { id, store } = await markedRun();
    const undo = planned(id);
    approve(undo);
    await run(undo, stubWriter(store), 'bulk_undo');
    const redo = planned(undo);
    expect(byKey(redo, `${LIST}/1`)).toMatchObject({ change: 'invalid', error: 'shop_added_markup' });
    expect(byKey(redo, `${LIST}/2`).change).toBe('update');
  });

  it('reads the mark down the whole chain, not only on the run it undoes', async () => {
    const { id, store } = await markedRun();
    const u1 = planned(id);
    approve(u1);
    await run(u1, stubWriter(store), 'bulk_undo');
    // The undo of the undo refuses product 1; the test plants it as planned anyway, as a ledger
    // from before this check would hold it, so that the marked value is written once by an undo
    // whose own read-back cannot be marked: it sent that markup itself.
    const u2 = planned(u1);
    engineDb.getDb().prepare(
      `UPDATE bulk_targets SET change = 'update', undo = 'restorable', error = NULL, before = ?, after_planned = ? WHERE run_id = ? AND seq = ?`,
    ).run(
      engineDb.enc(JSON.stringify({ absent: false, value: { description: '<p>Alt</p>' } })),
      engineDb.enc(JSON.stringify({ description: `<p>Neu</p>${SCRIPT}` })),
      u2, byKey(u2, `${LIST}/1`).seq,
    );
    approve(u2);
    // The store reformats what u2 sends: the copy u4 would restore is not byte-equal to the mark.
    await run(u2, stubWriter(store, (v) => ({ ...v, description: String(v['description']).replace('<p>', '<P>') })), 'bulk_undo');
    // u2 sent the markup itself, so its own read-back is not marked; u3 restores u1's actual
    // (the clean text) and u4 would restore u2's — the marked value again, two undos down.
    const u3 = planned(u2);
    approve(u3);
    await run(u3, stubWriter(store), 'bulk_undo');
    const u4 = planned(u3);
    expect(byKey(u4, `${LIST}/1`)).toMatchObject({ change: 'invalid', error: 'shop_added_markup' });
  });

  it('restores a before-image that held the very markup the store added back: that was the owner\'s', async () => {
    // The plan took the script out; the store put the same script back after the write.
    const id = approvedRun({ description: '<p>Neu</p>' }, [{ description: `<p>Neu</p>${SCRIPT}` }]);
    const store = new Map([[`${LIST}/1`, { description: `<p>Neu</p>${SCRIPT}` } as Record<string, unknown>]]);
    await run(id, stubWriter(store, (v) => ({ ...v, description: `${String(v['description'])}${SCRIPT}` })));
    expect(ledger.getPreview(id)[0]).toMatchObject({ shopAddedMarkup: true });
    const undo = planned(id);
    expect(byKey(undo, `${LIST}/1`).change).not.toBe('invalid');
  });

  it('counts a chain it cannot walk to its end as marked: a cycle, and a broken link', async () => {
    const { id, store } = await markedRun();
    const u1 = planned(id);
    approve(u1);
    await run(u1, stubWriter(store), 'bulk_undo');
    const db = engineDb.getDb();
    // A cycle: the source points back at its own undo, so the walk never reaches the start.
    db.prepare('UPDATE bulk_runs SET source_run_id = ? WHERE id = ?').run(u1, id);
    // Each target of the source points at the undo's target that took it back.
    db.prepare('UPDATE bulk_targets SET source_seq = (SELECT u.seq FROM bulk_targets u WHERE u.run_id = ? AND u.source_seq = bulk_targets.seq) WHERE run_id = ?').run(u1, id);
    expect(byKey(planned(u1), `${LIST}/2`)).toMatchObject({ change: 'invalid', error: 'shop_added_markup' });
  });

  it('counts a broken link up the chain as marked', async () => {
    const { id, store } = await markedRun();
    const u1 = planned(id);
    approve(u1);
    await run(u1, stubWriter(store), 'bulk_undo');
    engineDb.getDb().prepare('UPDATE bulk_targets SET source_seq = 999 WHERE run_id = ?').run(u1);
    expect(byKey(planned(u1), `${LIST}/2`)).toMatchObject({ change: 'invalid', error: 'shop_added_markup' });
  });

  it('lists what an undo restores, the HTML fields resolved from the run its family started from', async () => {
    const id = approvedRun({ description: '<p>Neu</p>' }, [{ description: `<p>Alt</p>${SCRIPT}` }]);
    const store = new Map([[`${LIST}/1`, { description: `<p>Alt</p>${SCRIPT}` } as Record<string, unknown>]]);
    await run(id, stubWriter(store));
    const undo = planned(id);
    expect(byKey(undo, `${LIST}/1`).markupChanges).toEqual([{
      field: 'description',
      added: [{ kind: 'element', namespace: 'html', element: 'script', attributes: [], text: 'steal()', inTemplate: false }],
      removed: [],
    }]);
    expect(ledger.htmlFieldsOf(undo)).toEqual(['description', 'short_description']);
  });
});

describe('htmlFieldsOf: fail-closed on the product form (sec-core F6)', () => {
  it('holds descriptionHtml for a Shopify product run without a list form, and nothing for an ordinary one', () => {
    const db = engineDb.getDb();
    const insert = db.prepare(`INSERT INTO bulk_runs (id, rule_hash, target_system, undo, phase, targets_total, kind, contract_json)
      VALUES (?, 'r', ?, 'restorable', 'previewed', 0, 'apply', ?)`);
    insert.run('store-run', 'http:acme.myshopify.com', JSON.stringify({ ...readContract, httpMethods: [], hostPatterns: ['acme.myshopify.com'] }));
    insert.run('plain-run', `http:${HOST}`, JSON.stringify({ ...readContract, httpMethods: ['PUT'] }));
    expect(ledger.htmlFieldsOf('store-run')).toEqual(['descriptionHtml']);
    expect(ledger.htmlFieldsOf('plain-run')).toEqual([]);
  });
});

describe('sameValue: a run\'s HTML fields under the normalised comparison (§21.2 item 5)', () => {
  it('takes a reformatted HTML field as the same, and one changed character, element or attribute as not', () => {
    const html = ['description'];
    expect(sameValue({ description: '<P>Neu<br/></P>', name: 'a' }, { description: '<p>Neu<br></p>', name: 'a' }, html)).toBe(true);
    expect(sameValue({ description: '<p>Neu</p>' }, { description: '<p>Neu!</p>' }, html)).toBe(false);
    expect(sameValue({ description: '<p>Neu</p>' }, { description: '<p>Neu</p><p></p>' }, html)).toBe(false);
    expect(sameValue({ description: '<p>Neu</p>' }, { description: '<p class="x">Neu</p>' }, html)).toBe(false);
  });

  it('compares a field open at its end byte for byte: the page closes what the parser drops', () => {
    const html = ['description'];
    expect(sameValue({ description: '<p>a</p>' }, { description: '<p>a</p><img src=x onerror=y' }, html)).toBe(false);
    expect(sameValue({ description: '<p>a</p><img src=x onerror=y' }, { description: '<p>a</p>' }, html)).toBe(false);
    // An element left open at the end that takes in what follows (a `strong`, reopened around the
    // theme's markup) drops nothing, and the parser closes it: the same tree as the closed value.
    // Byte for byte, in both directions.
    expect(sameValue({ description: '<p><strong>a</p>' }, { description: '<p><strong>a</strong></p>' }, html)).toBe(false);
    expect(sameValue({ description: '<p><strong>a</strong></p>' }, { description: '<p><strong>a</p>' }, html)).toBe(false);
    // The same value open at its end is equal to itself, byte for byte.
    expect(sameValue({ description: '<p>a' }, { description: '<p>a' }, html)).toBe(true);
  });

  it('compares a field byte for byte when the sides differ in what the parser drops', () => {
    const html = ['description'];
    expect(sameValue({ description: '<p>a</p>' }, { description: '<body onload=alert(1)><p>a</p>' }, html)).toBe(false);
    expect(sameValue({ description: '<p>a</p>' }, { description: '<p>a</p></div>' }, html)).toBe(false);
    // Text on both sides of the dropped tag: the parser joins it into one text node over the tag.
    expect(sameValue({ description: '<p>ab</p>' }, { description: '<p>a</div>b</p>' }, html)).toBe(false);
    expect(sameValue({ description: '<p>ab</p>' }, { description: '<p>a<body onload=alert(1)>b</p>' }, html)).toBe(false);
    // A dropped stretch on either side, the rest only reformatted: byte for byte, so not equal —
    // the tree does not say where it sits, and the page closes the container there.
    expect(sameValue({ description: '<P>a</P></div>' }, { description: '<p>a</p></div>' }, html)).toBe(false);
    expect(sameValue({ description: '<p>a</p></div>' }, { description: '<P>a</P></div>' }, html)).toBe(false);
    expect(sameValue({ description: '<p>a</p></div><p>b</p>' }, { description: '<p>a</p><p>b</p></div>' }, html)).toBe(false);
    // The same bytes stay equal.
    expect(sameValue({ description: '<p>a</p></div>' }, { description: '<p>a</p></div>' }, html)).toBe(true);
  });

  it('keeps every other field byte for byte, and a field one side lacks as a difference', () => {
    expect(sameValue({ description: '<p>a</p>', name: '<b>x</b>' }, { description: '<p>a</p>', name: '<B>x</B>' }, ['description'])).toBe(false);
    expect(sameValue({ description: '<p>a</p>' }, { description: '<p>a</p>', name: null }, ['description'])).toBe(false);
    expect(sameValue({ description: null }, { description: '' }, ['description'])).toBe(false);
    // Without HTML fields, the comparison is today's.
    expect(sameValue({ description: '<P>a</P>' }, { description: '<p>a</p>' })).toBe(false);
    expect(classifyChange({ absent: false, value: { description: '<P>a</P>' } }, { description: '<p>a</p>' }, ['description'])).toBe('unchanged');
    expect(classifyChange({ absent: false, value: { description: '<P>a</P>' } }, { description: '<p>a</p>' })).toBe('update');
  });
});

describe('a written description the store kept otherwise than sent (§21.2 item 6: counted, not halted)', () => {
  it('counts the target on the run and names it on its row, and writes on to the next', async () => {
    const id = approvedRun({ description: 'Neu' }, [{ description: '<p>Alt</p>' }, { description: '<p>Alt 2</p>' }]);
    const store = new Map<string, Record<string, unknown>>([[`${LIST}/1`, { description: '<p>Alt</p>' }], [`${LIST}/2`, { description: '<p>Alt 2</p>' }]]);
    const base = stubWriter(store, (v) => ({ ...v, description: `<p>${String(v['description'])}</p>` }));
    // The first write comes back rewritten, the second as sent.
    let n = 0;
    const w: TargetWriter = {
      ...base,
      async write(key, after, sent, refused) {
        const out = await base.write(key, after, sent, refused);
        n += 1;
        return n === 1 && typeof out !== 'string' ? { ...out, hostRewrote: true as const } : out;
      },
    };
    const out = await run(id, w);
    expect(out.status).toBe('done');
    expect(ledger.getStatus(id)).toMatchObject({ applied: 2, hostRewrote: 1, shopAddedMarkup: 0 });
    const rows = ledger.getPreview(id);
    expect(rows[0]).toMatchObject({ hostRewrote: true });
    expect(rows[1]).not.toHaveProperty('hostRewrote');
  });
});

describe('a WooCommerce description keeps today\'s comparison (§21.4, N5)', () => {
  it('compares nothing as HTML on a WooCommerce list run, although its list form names the field HTML', () => {
    const id = approvedRun({ description: 'Neu' }, [{ description: '<P>Alt</P>' }]);
    expect(ledger.htmlFieldsOf(id)).toContain('description');
    expect(ledger.comparedAsHtml(id)).toEqual([]);
  });

  it('resumes a WooCommerce target the store reformatted as a conflict, as before', async () => {
    const id = approvedRun({ description: '<p>Neu</p>' }, [{ description: '<p>Alt</p>' }]);
    // A dead loop's write, kept reformatted: not the planned bytes, so not found as planned.
    const store = new Map<string, Record<string, unknown>>([[`${LIST}/1`, { description: '<P>Neu</P>' }]]);
    const w = stubWriter(store);
    await run(id, w);
    expect(w.sent).toEqual([]);
    expect(ledger.getStatus(id)).toMatchObject({ applied: 0, conflicts: 1 });
  });
});
