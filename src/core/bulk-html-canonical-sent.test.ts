import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { BulkLedger, BULK_HALT_REASONS, type BeforeImage } from './bulk-ledger.js';
import { OWNER_PRINCIPAL } from './request-principal.js';
import { mintBulkContract } from './bulk-external.js';
import { parseListSource } from './bulk-list.js';
import { judgeTemplate, normalizeJudgeRule } from './bulk-judge-rule.js';
import { checkMarkup, droppedTagsOf } from './bulk-html.js';
import { rawHtmlField, runBulkEffect, type TargetWriter } from './bulk-apply.js';
import type { CapabilityContract } from '../types/capability-contract.js';

// The belt of 1130: an HTML field is stored, and so sent, in the canonical bytes the markup check
// reads, never the planner's or the verdict's raw bytes; the send refuses raw bytes it finds.

const HOST = 'shop.example.com';
const LIST = `https://${HOST}/wp-json/wc/v3/products`;
const readContract: CapabilityContract = {
  version: 1, origin: 'reviewed', grantedTools: ['http_request'], httpMethods: ['GET'],
  hostPatterns: [HOST], pathPatterns: ['/wp-json/wc/v3/products'], paramConstraints: {},
};
const rule = normalizeJudgeRule({ rule: 'Rewrite the description.', schema: { description: { type: 'string', maxLength: 2000 } } }, { idField: 'id' });

let dir: string;
let engineDb: EngineDb;
let ledger: BulkLedger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lynox-bulk-canonical-'));
  engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  ledger = new BulkLedger(engineDb, null);
});
afterEach(() => {
  engineDb.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A WooCommerce list run with product 1 listed and its reads started; `judged` plans a judge. */
function listed(after: Record<string, unknown>, judged = false): { id: string; seq: number } {
  const source = parseListSource(HOST, { path: '/wp-json/wc/v3/products', after: judged ? judgeTemplate(rule) : after }, 'PUT', () => null);
  const out = ledger.recordExternalListPlan({ createdBy: 't', principal: OWNER_PRINCIPAL, host: HOST, source, readContract, ...(judged ? { judge: rule } : {}) });
  if (!out.ok) throw new Error(out.reason);
  const id = out.status.id;
  if (!ledger.resumePreview(id, Date.now(), { listChecksum: ledger.listStartChecksum(id)! }).ok) throw new Error('list start');
  ledger.recordListPage(id, { page: 1, items: [{ key: `${LIST}/1`, id: '1' }], bytes: 1 });
  ledger.finishList(id, (keys) => mintBulkContract(HOST, keys, 'PUT'));
  const reads = judged
    ? ledger.resumePreview(id, Date.now(), { judgeRuleHash: ledger.getJudgeRuleForOwner(id)!.hash, costCapUsd: 2 })
    : ledger.resumePreview(id);
  if (!reads.ok) throw new Error('reads not started');
  const [seq] = ledger.listUnread(id);
  if (seq === undefined) throw new Error('no target');
  return { id, seq };
}

/** The after-state the ledger stored for a run's only target. */
function storedAfter(id: string): Record<string, unknown> {
  const row = engineDb.getDb().prepare('SELECT after_planned FROM bulk_targets WHERE run_id = ?').get(id) as { after_planned: string };
  return JSON.parse(engineDb.dec(row.after_planned)) as Record<string, unknown>;
}

describe('the ledger stores an HTML field in its canonical bytes (1130)', () => {
  it('stores a planned description canonical when the read records it', () => {
    const { id, seq } = listed({ description: '<p>a<br/>b &#8211; c</p>' });
    expect(ledger.recordRead(id, seq, { before: { description: '<p>x</p>' } })).toBe(true);
    expect(storedAfter(id)['description']).toBe('<p>a<br>b – c</p>');
  });

  it('stores a verdict\'s description canonical, so the stretch the check held never reaches the shop', () => {
    const { id, seq } = listed({}, true);
    const before = '<body class="z"><p>a</p>';
    expect(ledger.recordRead(id, seq, { before: { description: before } })).toBe(true);
    const verdict = '<p>neu<br/>Text</p><body class="z">';
    // The check holds the stretch the before-image carries, because what is sent is canonical.
    expect(checkMarkup({ before, after: verdict, storeHost: HOST, startDomains: [] }).ok).toBe(true);
    expect(ledger.claimJudge(id, seq, 'tok', Date.now(), 60_000)).toBe(true);
    expect(ledger.recordJudgement(id, seq, 'tok', { after: { description: verdict } })).toBe(true);
    const stored = storedAfter(id)['description'] as string;
    expect(stored).toBe('<p>neu<br>Text</p>');
    expect(droppedTagsOf(stored)).toEqual([]);
  });

  it('keeps a description equal to its before-image byte for byte, so an unchanged field is no write', () => {
    const raw = '<p>a<br/>b</p>';
    const { id, seq } = listed({ description: raw });
    expect(ledger.recordRead(id, seq, { before: { description: raw } })).toBe(true);
    expect(storedAfter(id)['description']).toBe(raw);
    expect(ledger.getPreview(id)[0]?.change).toBe('unchanged');
  });

  it('keeps a verdict equal to its before-image byte for byte', () => {
    const { id, seq } = listed({}, true);
    const raw = '<p>a<br/>b</p>';
    expect(ledger.recordRead(id, seq, { before: { description: raw } })).toBe(true);
    expect(ledger.claimJudge(id, seq, 'tok', Date.now(), 60_000)).toBe(true);
    expect(ledger.recordJudgement(id, seq, 'tok', { after: { description: raw } })).toBe(true);
    expect(storedAfter(id)['description']).toBe(raw);
  });

  it('stores a value whose canonical form is not stable raw, so the send refuses it', () => {
    // `<pre>` with a leading blank line loses one line per round trip: a canonical form that
    // changes again would show the shop something the check never read.
    const raw = '<pre>\n\nCode</pre>';
    const { id, seq } = listed({ description: raw });
    expect(ledger.recordRead(id, seq, { before: { description: '<p>x</p>' } })).toBe(true);
    expect(storedAfter(id)['description']).toBe(raw);
    expect(rawHtmlField({ after: { absent: false, value: storedAfter(id) }, expected: { absent: false, value: { description: '<p>x</p>' } } }, ['description'])).toBe('description');
  });

  it('CONTROL: leaves a field the list form does not name HTML as it is', () => {
    const { id, seq } = listed({ name: 'a<br/>b' });
    expect(ledger.recordRead(id, seq, { before: { name: 'x' } })).toBe(true);
    expect(storedAfter(id)['name']).toBe('a<br/>b');
  });
});

describe('rawHtmlField: the send takes only canonical bytes (1130)', () => {
  const img = (value: Record<string, unknown>): BeforeImage => ({ absent: false, value });
  it('names an HTML field in raw bytes that is not its before-image', () => {
    expect(rawHtmlField({ after: img({ description: '<p>a<br/>b</p>' }), expected: img({ description: '<p>x</p>' }) }, ['description'])).toBe('description');
  });
  it('passes canonical bytes, a field equal to its before-image, and a run with no HTML field', () => {
    expect(rawHtmlField({ after: img({ description: '<p>a<br>b</p>' }), expected: img({ description: '<p>x</p>' }) }, ['description'])).toBeNull();
    expect(rawHtmlField({ after: img({ description: '<p>a<br/>b</p>' }), expected: img({ description: '<p>a<br/>b</p>' }) }, ['description'])).toBeNull();
    expect(rawHtmlField({ after: img({ description: '<p>a<br/>b</p>' }), expected: img({ description: '<p>x</p>' }) }, [])).toBeNull();
  });
});

describe('a write sends what the ledger stored, and never raw HTML (1130)', () => {
  /** A one-target WooCommerce run, read and approved; `legacy` stores raw bytes as a row from before the belt would. */
  function approved(after: string, legacy: boolean, before = '<p>x</p>'): string {
    const { id, seq } = listed({ description: after });
    if (!ledger.recordRead(id, seq, { before: { description: before } })) throw new Error('read');
    if (legacy) {
      engineDb.getDb().prepare('UPDATE bulk_targets SET after_planned = ? WHERE run_id = ?').run(engineDb.enc(JSON.stringify({ description: after })), id);
    }
    if (!ledger.finishPreview(id)) throw new Error('preview not finished');
    const ok = ledger.approve(id, { checksum: ledger.computeChecksum(id)! });
    if (!ok.ok) throw new Error(ok.reason);
    return id;
  }

  function shop(before = '<p>x</p>'): { writer: TargetWriter; sent: unknown[] } {
    const sent: unknown[] = [];
    let held: Record<string, unknown> = { description: before };
    const writer: TargetWriter = {
      async read() { return { absent: false, value: held }; },
      async write(_key, after) {
        if (!after.absent) { sent.push(after.value); held = after.value as Record<string, unknown>; }
        return 'written';
      },
    };
    return { writer, sent };
  }

  it('sends the canonical bytes the check read', async () => {
    const runId = approved('<p>a<br/>b</p>', false);
    const s = shop();
    await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: () => s.writer });
    expect(s.sent).toEqual([{ description: '<p>a<br>b</p>' }]);
  });

  it('sends nothing for a row holding raw bytes, and halts the run', async () => {
    const runId = approved('<p>a<br/>b</p>', true);
    const s = shop();
    await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: () => s.writer });
    expect(s.sent).toEqual([]);
    expect(ledger.getStatus(runId)?.haltReason).toBe(BULK_HALT_REASONS.contract);
  });

  it('lets an undo send the store\'s own raw bytes back: it restores a before-image', async () => {
    const own = '<p>x<br/>y</p>';
    const runId = approved('<p>a<br/>b</p>', false, own);
    const s = shop(own);
    await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: () => s.writer });
    const undo = ledger.planUndo(runId);
    if (!undo.ok) throw new Error(undo.reason);
    expect(ledger.approve(undo.status.id, { checksum: ledger.computeChecksum(undo.status.id)! }).ok).toBe(true);
    const out = await runBulkEffect(undo.status.id, 'bulk_undo', { ledger, trailFor: () => null, writerFor: () => s.writer });
    expect(out.status).toBe('done');
    expect(s.sent).toEqual([{ description: '<p>a<br>b</p>' }, { description: own }]);
  });
});
