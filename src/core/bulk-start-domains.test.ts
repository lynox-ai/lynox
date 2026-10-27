import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { BulkLedger, BULK_HALT_REASONS, BULK_START_DOMAINS_MAX, normalizeStartDomains, type ListPageItem } from './bulk-ledger.js';
import { OWNER_PRINCIPAL } from './request-principal.js';
import { mintBulkContract } from './bulk-external.js';
import { parseListSource } from './bulk-list.js';
import { judgeTemplate, normalizeJudgeRule } from './bulk-judge-rule.js';
import type { CapabilityContract } from '../types/capability-contract.js';

// The link domains the owner allows a judged run's verdicts to add (PRD shopify-preset §20.2
// item 5, S20-4): set on the owner's start only, replaceable until a target is read, frozen
// after, and bound by the approval checksum where set.

const HOST = 'shop.example.com';
const LIST = `https://${HOST}/wp-json/wc/v3/products`;
const readContract: CapabilityContract = {
  version: 1, origin: 'reviewed', grantedTools: ['http_request'], httpMethods: ['GET'],
  hostPatterns: [HOST], pathPatterns: ['/wp-json/wc/v3/products'], paramConstraints: {},
};
const rule = normalizeJudgeRule({ rule: 'Mark the draft.', schema: { status: { type: 'string', enum: ['draft', 'publish'] } } }, { idField: 'id' });
const item = (id: number): ListPageItem => ({ key: `${LIST}/${String(id)}`, id: String(id) });

let dir: string;
let engineDb: EngineDb;
let ledger: BulkLedger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lynox-bulk-domains-'));
  engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  ledger = new BulkLedger(engineDb);
});
afterEach(() => {
  engineDb.close();
  rmSync(dir, { recursive: true, force: true });
});

function plan(judged: boolean): string {
  const after = judged ? judgeTemplate(rule) : { status: 'draft' };
  const source = parseListSource(HOST, { path: '/wp-json/wc/v3/products', after }, 'PUT', () => null);
  const out = ledger.recordExternalListPlan({ createdBy: 't', principal: OWNER_PRINCIPAL, host: HOST, source, readContract, ...(judged ? { judge: rule } : {}) });
  if (!out.ok) throw new Error(out.reason);
  return out.status.id;
}

/** A judged list run whose list is read, waiting for the start that begins the judge. */
function listed(): string {
  const id = plan(true);
  if (!ledger.resumePreview(id, Date.now(), { listChecksum: ledger.listStartChecksum(id)! }).ok) throw new Error('list start');
  ledger.recordListPage(id, { page: 1, items: [item(1), item(2)], bytes: 1 });
  ledger.finishList(id, (keys) => mintBulkContract(HOST, keys, 'PUT'));
  return id;
}

function startJudge(id: string, costCapUsd = 2): ReturnType<BulkLedger['resumePreview']> {
  return ledger.resumePreview(id, Date.now(), { judgeRuleHash: ledger.getJudgeRuleForOwner(id)!.hash, costCapUsd });
}

describe('normalizeStartDomains', () => {
  it('takes host names, lowercased, in Punycode, without duplicates and sorted', () => {
    expect(normalizeStartDomains(['Shop.Example.CH', 'b.example', 'shop.example.ch', 'bücher.ch'])).toEqual(['b.example', 'shop.example.ch', 'xn--bcher-kva.ch']);
    expect(normalizeStartDomains([])).toEqual([]);
  });

  it('refuses anything that is not a bare host name', () => {
    for (const bad of ['*.example.ch', 'example.ch/x', 'example.ch:8443', 'user@example.ch', 'localhost', '127.0.0.1', 'exa mple.ch', '-x.ch', 'example.ch.', '', 'a\\b.ch', 'x.ch?y']) {
      expect(normalizeStartDomains([bad]), bad).toBeNull();
    }
    expect(normalizeStartDomains('example.ch')).toBeNull();
    expect(normalizeStartDomains([42])).toBeNull();
  });

  it('takes at most the cap', () => {
    const many = Array.from({ length: BULK_START_DOMAINS_MAX + 1 }, (_, i) => `d${String(i)}.example`);
    expect(normalizeStartDomains(many.slice(0, BULK_START_DOMAINS_MAX))).toHaveLength(BULK_START_DOMAINS_MAX);
    expect(normalizeStartDomains(many)).toBeNull();
  });
});

describe('setStartDomains', () => {
  it('stores the list at the start that begins the judge and shows it in the status', () => {
    const id = listed();
    expect(ledger.setStartDomains(id, ['example.ch'])).toEqual({ ok: true });
    expect(ledger.startDomainsOf(id)).toEqual(['example.ch']);
    expect(ledger.getStatus(id)!.startDomains).toEqual(['example.ch']);
  });

  it('is refused at the list read (D-8)', () => {
    const judged = plan(true);
    expect(ledger.setStartDomains(judged, ['example.ch'])).toEqual({ ok: false, reason: 'not_at_this_start' });
    expect(ledger.getStatus(judged)!.startDomains).toBeNull();
  });

  it('is refused on a listed run without a judge, and on a judged run without a list', () => {
    const plain = plan(false);
    ledger.resumePreview(plain, Date.now(), { listChecksum: ledger.listStartChecksum(plain)! });
    ledger.recordListPage(plain, { page: 1, items: [item(1)], bytes: 1 });
    ledger.finishList(plain, (keys) => mintBulkContract(HOST, keys, 'PUT'));
    expect(ledger.getStatus(plain)!.phase).toBe('planned');
    expect(ledger.setStartDomains(plain, ['example.ch'])).toEqual({ ok: false, reason: 'not_at_this_start' });
    const rows = ledger.recordDryRun({
      createdBy: 't', principal: OWNER_PRINCIPAL, targetSystem: 'data_store', scope: 'products', targetCollection: 'products',
      targets: [{ key: 'A', before: { absent: false, value: { sku: 'A', status: 'draft' } }, after: judgeTemplate(rule) }],
      judge: rule,
    }).id;
    expect(ledger.setStartDomains(rows, ['example.ch'])).toEqual({ ok: false, reason: 'not_at_this_start' });
  });

  it('can be given again after a start the ledger refused, while nothing is read', () => {
    const id = listed();
    expect(ledger.setStartDomains(id, ['a.example'])).toEqual({ ok: true });
    expect(ledger.resumePreview(id, Date.now(), { judgeRuleHash: ledger.getJudgeRuleForOwner(id)!.hash })).toEqual({ ok: false, reason: 'cost_cap' });
    expect(ledger.setStartDomains(id, ['b.example'])).toEqual({ ok: true });
    expect(ledger.startDomainsOf(id)).toEqual(['b.example']);
  });

  it('is frozen once the judge started: the same list passes, another is refused', () => {
    const id = listed();
    ledger.setStartDomains(id, ['a.example']);
    expect(startJudge(id).ok).toBe(true);
    ledger.haltPreview(id, BULK_HALT_REASONS.timeBudget);
    expect(ledger.setStartDomains(id, ['a.example'])).toEqual({ ok: true });
    expect(ledger.setStartDomains(id, ['b.example'])).toEqual({ ok: false, reason: 'start_domains_frozen' });
    expect(ledger.startDomainsOf(id)).toEqual(['a.example']);
  });

  it('is frozen once a target was read, even before the judge started', () => {
    const id = listed();
    // Test seam: a before-image recorded without a judge start.
    engineDb.getDb().prepare("UPDATE bulk_targets SET before = 'x' WHERE run_id = ? AND seq = 0").run(id);
    expect(ledger.setStartDomains(id, ['b.example'])).toEqual({ ok: false, reason: 'start_domains_frozen' });
  });

  it('refuses a list that is not one, and writes nothing', () => {
    const id = listed();
    expect(ledger.setStartDomains(id, ['*.example.ch'])).toEqual({ ok: false, reason: 'start_domains_invalid' });
    expect(ledger.getStatus(id)!.startDomains).toBeNull();
  });

  it('refuses outside planned', () => {
    expect(ledger.setStartDomains('nope', [])).toEqual({ ok: false, reason: 'not_found' });
    const id = listed();
    expect(startJudge(id).ok).toBe(true);
    // Running: halt_reason is null.
    expect(ledger.setStartDomains(id, [])).toEqual({ ok: false, reason: 'wrong_phase' });
  });
});

describe('the approval checksum and the start list', () => {
  it('binds the list where it is set, and is unchanged where it is not', () => {
    const id = listed();
    const without = ledger.computeChecksum(id);
    ledger.setStartDomains(id, ['a.example']);
    const withA = ledger.computeChecksum(id);
    expect(withA).not.toBe(without);
    ledger.setStartDomains(id, ['b.example']);
    expect(ledger.computeChecksum(id)).not.toBe(withA);
  });

  it('leaves a run without a list on the digest it had before the column existed', () => {
    // A judged list run before its list is read has no targets: its digest is the run's own
    // parts, written out here as they were before start lists existed.
    const id = plan(true);
    const r = engineDb.getDb().prepare('SELECT * FROM bulk_runs WHERE id = ?').get(id) as Record<string, string | number | null>;
    const parts = [
      'bulk-approval-v1', String(r['kind']), String(r['target_system']), String(r['target_collection'] ?? ''), String(r['atomic']),
      String(r['source_run_id'] ?? ''), String(r['rule_hash']), 'contract', String(r['contract_json']),
      'list', engineDb.dec(String(r['list_source'])), 'judge', String(r['judge_rule_hash']),
    ];
    expect(ledger.computeChecksum(id)).toBe(engineDb.keyedHash(parts));
  });
});
