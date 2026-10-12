import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { BulkLedger, BULK_HALT_REASONS, type ListPageItem } from './bulk-ledger.js';
import { OWNER_PRINCIPAL } from './request-principal.js';
import { mintBulkContract } from './bulk-external.js';
import { parseListSource, type BulkListSource } from './bulk-list.js';
import { BULK_MAX_TARGETS } from './bulk-plan.js';
import type { CapabilityContract } from '../types/capability-contract.js';

const HOST = 'shop.example.com';
const LIST = `https://${HOST}/wp-json/wc/v3/products`;
const source: BulkListSource = parseListSource(HOST, { path: '/wp-json/wc/v3/products', filters: { category: '12' }, after: { status: 'draft' } }, 'PUT', () => null);
const readContract: CapabilityContract = {
  version: 1, origin: 'reviewed', grantedTools: ['http_request'], httpMethods: ['GET'],
  hostPatterns: [HOST], pathPatterns: ['/wp-json/wc/v3/products'], paramConstraints: {},
};
const mint = (keys: readonly string[]): CapabilityContract => mintBulkContract(HOST, keys, 'PUT');
const item = (id: number): ListPageItem => ({ key: `${LIST}/${String(id)}`, id: String(id) });

let dir: string;
let engineDb: EngineDb;
let ledger: BulkLedger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lynox-bulk-list-'));
  engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  ledger = new BulkLedger(engineDb);
});
afterEach(() => {
  engineDb.close();
  rmSync(dir, { recursive: true, force: true });
});

function plan(s: BulkListSource = source): string {
  const out = ledger.recordExternalListPlan({ createdBy: 't', principal: OWNER_PRINCIPAL, host: HOST, source: s, readContract });
  if (!out.ok) throw new Error(out.reason);
  return out.status.id;
}

function start(runId: string): void {
  const res = ledger.resumePreview(runId, Date.now(), { listChecksum: ledger.listStartChecksum(runId)! });
  if (!res.ok) throw new Error(res.reason);
}

describe('recordExternalListPlan', () => {
  it('records the run halted before its first request, with no target and its read contract', () => {
    const id = plan();
    const s = ledger.getStatus(id)!;
    expect(s.phase).toBe('planned');
    expect(s.haltReason).toBe(BULK_HALT_REASONS.awaitingStart);
    expect(s.total).toBe(0);
    expect(s.list).toEqual({
      state: 'pending', path: '/wp-json/wc/v3/products', filters: { category: '12' }, idField: 'id',
      method: 'PUT', after: { status: 'draft' }, pagesRead: 0,
    });
    expect(JSON.parse(ledger.getListRun(id)!.contractJson!)).toEqual(readContract);
  });

  it('holds no reading slot until it is started, and then holds it', () => {
    const first = plan();
    const second = plan();
    start(first);
    const third = ledger.recordExternalListPlan({ createdBy: 't', principal: OWNER_PRINCIPAL, host: HOST, source, readContract });
    expect(third).toEqual({ ok: false, reason: 'external_in_progress' });
    expect(ledger.resumePreview(second, Date.now(), { listChecksum: ledger.listStartChecksum(second)! }))
      .toEqual({ ok: false, reason: 'external_in_progress' });
  });

  it('keeps a run without a list source as it was', () => {
    const out = ledger.recordExternalPlan({
      createdBy: 't', principal: OWNER_PRINCIPAL, host: HOST, targets: [{ key: `${LIST}/1`, after: { status: 'draft' } }], contract: mint([`${LIST}/1`]),
    });
    if (!out.ok) throw new Error(out.reason);
    expect(out.status.list).toBeNull();
    expect(ledger.listStartChecksum(out.status.id)).toBeNull();
    expect(ledger.resumePreview(out.status.id).ok).toBe(true);
  });
});

describe('the start of a list read', () => {
  it('needs the checksum of the list the owner was shown', () => {
    const id = plan();
    expect(ledger.resumePreview(id)).toEqual({ ok: false, reason: 'checksum' });
    expect(ledger.resumePreview(id, Date.now(), { listChecksum: 'x'.repeat(64) })).toEqual({ ok: false, reason: 'checksum' });
    expect(ledger.getStatus(id)!.haltReason).toBe(BULK_HALT_REASONS.awaitingStart);
    start(id);
    expect(ledger.getStatus(id)!.haltReason).toBeNull();
  });

  it('binds the checksum to the list source: a source changed after it was shown is refused', () => {
    const id = plan();
    const shown = ledger.listStartChecksum(id)!;
    const other = { ...source, filters: { category: '13' } };
    engineDb.getDb().prepare('UPDATE bulk_runs SET list_source = ? WHERE id = ?').run(engineDb.enc(JSON.stringify(other)), id);
    expect(ledger.resumePreview(id, Date.now(), { listChecksum: shown })).toEqual({ ok: false, reason: 'checksum' });
  });

  it('binds the checksum to the read contract too', () => {
    const id = plan();
    const shown = ledger.listStartChecksum(id)!;
    engineDb.getDb().prepare('UPDATE bulk_runs SET contract_json = ? WHERE id = ?')
      .run(JSON.stringify({ ...readContract, pathPatterns: ['/wp-json/wc/v3/orders'] }), id);
    expect(ledger.resumePreview(id, Date.now(), { listChecksum: shown })).toEqual({ ok: false, reason: 'checksum' });
  });
});

describe('takeListCall', () => {
  it('counts requests up to the cap, and none once the run has stopped reading', () => {
    const id = plan();
    expect(ledger.takeListCall(id, 5)).toBe(false); // not started
    start(id);
    expect(ledger.takeListCall(id, 2)).toBe(true);
    expect(ledger.takeListCall(id, 2)).toBe(true);
    expect(ledger.takeListCall(id, 2)).toBe(false);
    expect(ledger.getListRun(id)!.calls).toBe(2);
  });
});

describe('recordListPage', () => {
  it('records a page as the one after the last, and refuses any other', () => {
    const id = plan();
    start(id);
    expect(ledger.recordListPage(id, { page: 2, items: [item(1)], bytes: 10 })).toEqual({ ok: false, reason: 'moved' });
    expect(ledger.recordListPage(id, { page: 1, items: [item(1), item(2)], bytes: 10 })).toEqual({ ok: true, added: 2, total: 2 });
    expect(ledger.recordListPage(id, { page: 1, items: [item(3)], bytes: 10 })).toEqual({ ok: false, reason: 'moved' });
    const run = ledger.getListRun(id)!;
    expect(run.page).toBe(1);
    expect(run.bytes).toBe(10);
  });

  it('refuses a page while the run is not reading its list', () => {
    const id = plan();
    expect(ledger.recordListPage(id, { page: 1, items: [item(1)], bytes: 1 })).toEqual({ ok: false, reason: 'moved' });
    start(id);
    ledger.haltPreview(id, BULK_HALT_REASONS.listUnreadable);
    expect(ledger.recordListPage(id, { page: 1, items: [item(1)], bytes: 1 })).toEqual({ ok: false, reason: 'moved' });
  });

  it('passes over a key seen on an earlier page — the list moved under the read', () => {
    const id = plan();
    start(id);
    ledger.recordListPage(id, { page: 1, items: [item(1), item(2)], bytes: 1 });
    expect(ledger.recordListPage(id, { page: 2, items: [item(2), item(3), item(3)], bytes: 1 })).toEqual({ ok: true, added: 1, total: 3 });
  });

  it('records an element without a usable id under an engine-made key, with its fixed reason', () => {
    const id = plan();
    start(id);
    ledger.recordListPage(id, { page: 1, items: [item(1), { invalid: 'list_item_bad_id' }, { invalid: 'list_item_no_id' }], bytes: 1 });
    expect(ledger.getStatus(id)!.invalidReasons).toEqual({ list_item_bad_id: 1, list_item_no_id: 1 });
    const keys = ledger.getPreview(id).map((t) => t.key);
    expect(keys).toEqual([`${LIST}/1`, '#1.1', '#1.2']);
  });

  it('refuses a page that would pass the target cap, and records none of it', () => {
    const id = plan();
    start(id);
    const many = Array.from({ length: BULK_MAX_TARGETS + 1 }, (_, i) => item(i));
    expect(ledger.recordListPage(id, { page: 1, items: many, bytes: 1 })).toEqual({ ok: false, reason: 'too_large' });
    expect(ledger.getStatus(id)!.total).toBe(0);
    expect(ledger.recordListPage(id, { page: 1, items: many.slice(0, BULK_MAX_TARGETS), bytes: 1 }).ok).toBe(true);
  });

  it('refuses a page whose after-states would pass the run\'s byte cap', () => {
    const big = { ...source, after: { description: 'x'.repeat(1024 * 1024 - 32) } };
    const id = plan(big);
    start(id);
    const items = Array.from({ length: 33 }, (_, i) => item(i));
    expect(ledger.recordListPage(id, { page: 1, items, bytes: 1 })).toEqual({ ok: false, reason: 'too_large' });
    expect(ledger.recordListPage(id, { page: 1, items: items.slice(0, 31), bytes: 1 }).ok).toBe(true);
  });
});

describe('finishList', () => {
  it('writes the contract over the keys, rewrites the rule and halts for the owner', () => {
    const id = plan();
    start(id);
    const ruleBefore = engineDb.getDb().prepare('SELECT rule_hash FROM bulk_runs WHERE id = ?').get(id) as { rule_hash: string };
    ledger.recordListPage(id, { page: 1, items: [item(2), { invalid: 'list_item_no_id' }, item(1)], bytes: 1 });
    let minted: readonly string[] = [];
    expect(ledger.finishList(id, (keys) => { minted = keys; return mint(keys); })).toBe('listed');
    expect([...minted].sort()).toEqual([`${LIST}/1`, `${LIST}/2`]);
    const run = ledger.getListRun(id)!;
    expect(run.state).toBe('done');
    expect(run.haltReason).toBe(BULK_HALT_REASONS.listed);
    expect(JSON.parse(run.contractJson!)).toEqual(mint(minted));
    const ruleAfter = engineDb.getDb().prepare('SELECT rule_hash FROM bulk_runs WHERE id = ?').get(id) as { rule_hash: string };
    expect(ruleAfter.rule_hash).not.toBe(ruleBefore.rule_hash);
    expect(ledger.listStartChecksum(id)).toBeNull();
  });

  it('ends a list with no usable target as planned, with nothing to read', () => {
    const id = plan();
    start(id);
    ledger.recordListPage(id, { page: 1, items: [{ invalid: 'list_item_no_id' }], bytes: 1 });
    expect(ledger.finishList(id, mint)).toBe('empty');
    const s = ledger.getStatus(id)!;
    expect(s.phase).toBe('previewed');
    expect(s.undo).toBe('none');
    expect(s.haltReason).toBeNull();
  });

  it('closes nothing that is not reading its list', () => {
    const id = plan();
    expect(ledger.finishList(id, mint)).toBe('moved');
    start(id);
    ledger.finishList(id, mint);
    expect(ledger.finishList(id, mint)).toBe('moved');
  });

  it('lets the owner start the per-target reads without a list checksum once the list stands', () => {
    const id = plan();
    start(id);
    ledger.recordListPage(id, { page: 1, items: [item(1)], bytes: 1 });
    ledger.finishList(id, mint);
    expect(ledger.resumePreview(id).ok).toBe(true);
  });
});

describe('a list still being read', () => {
  it('is never previewed, though it has no unread target', () => {
    const id = plan();
    start(id);
    expect(ledger.finishPreview(id)).toBe(false);
    expect(ledger.getStatus(id)!.phase).toBe('planned');
  });

  // Two rules keep a list that is still being read from approval: `finishPreview` never moves
  // it on, and `approve` refuses it. The second stands behind the first; this asserts what
  // both together guarantee, by forcing the phase the first one keeps it out of.
  it('is never approved, even in a phase it should not reach', () => {
    const id = plan();
    start(id);
    engineDb.getDb().prepare(`UPDATE bulk_runs SET phase = 'previewed' WHERE id = ?`).run(id);
    expect(ledger.approve(id, { checksum: ledger.computeChecksum(id)! })).toEqual({ ok: false, reason: 'wrong_phase' });
  });
});

describe('the approval checksum of a list run', () => {
  it('binds the list source', () => {
    const id = plan();
    start(id);
    ledger.recordListPage(id, { page: 1, items: [item(1)], bytes: 1 });
    ledger.finishList(id, mint);
    const before = ledger.computeChecksum(id);
    engineDb.getDb().prepare('UPDATE bulk_runs SET list_source = ? WHERE id = ?')
      .run(engineDb.enc(JSON.stringify({ ...source, filters: { category: '13' } })), id);
    expect(ledger.computeChecksum(id)).not.toBe(before);
  });
});
