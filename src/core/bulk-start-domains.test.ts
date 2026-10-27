import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { BulkLedger, BULK_HALT_REASONS, BULK_START_DOMAINS_MAX, normalizeStartDomains, type ListPageItem } from './bulk-ledger.js';
import { OWNER_PRINCIPAL } from './request-principal.js';
import { PUBLIC_SECOND_LEVEL_LABELS, SHARED_PLATFORM_DOMAINS } from './public-suffix.js';
import { mintBulkContract } from './bulk-external.js';
import { parseListSource } from './bulk-list.js';
import { judgeTemplate, normalizeJudgeRule } from './bulk-judge-rule.js';
import type { CapabilityContract } from '../types/capability-contract.js';

// The link domains the owner allows a judged run's verdicts to add (PRD shopify-preset §20.2
// item 5, S20-4): given with the start that begins the judge and written in its transaction,
// frozen from then on, and bound by the approval checksum where set.

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

function startJudge(id: string, costCapUsd = 2, startDomains?: unknown): ReturnType<BulkLedger['resumePreview']> {
  return ledger.resumePreview(id, Date.now(), { judgeRuleHash: ledger.getJudgeRuleForOwner(id)!.hash, costCapUsd, ...(startDomains !== undefined ? { startDomains } : {}) });
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

  it('takes at most the cap, counted as stored', () => {
    const many = Array.from({ length: BULK_START_DOMAINS_MAX + 1 }, (_, i) => `d${String(i)}.example`);
    expect(normalizeStartDomains(many.slice(0, BULK_START_DOMAINS_MAX))).toHaveLength(BULK_START_DOMAINS_MAX);
    expect(normalizeStartDomains(many)).toBeNull();
    // A duplicate does not count twice, as the start form counts it.
    expect(normalizeStartDomains([...many.slice(0, BULK_START_DOMAINS_MAX), 'D0.example'])).toHaveLength(BULK_START_DOMAINS_MAX);
  });

  it('refuses a shared suffix on its own, and takes a name under one', () => {
    for (const shared of ['myshopify.com', 'co.uk', 'github.io', 'com.au', 'MyShopify.com', 'blogspot.com', 'workers.dev', 'eu.org', 'sites.google.com']) {
      expect(normalizeStartDomains([shared]), shared).toBeNull();
    }
    expect(normalizeStartDomains(['meinshop.myshopify.com', 'example.co.uk', 'me.github.io', 'example.com'])).toEqual(['example.co.uk', 'example.com', 'me.github.io', 'meinshop.myshopify.com']);
  });

  it('refuses a host that grows past 253 characters in Punycode', () => {
    const label = `${'ü'.repeat(3)}${'a'.repeat(40)}`;
    const raw = `${Array(5).fill(label).join('.')}.ch`;
    expect(raw.length).toBeLessThanOrEqual(253);
    expect(new URL(`https://${raw}/`).hostname.length).toBeGreaterThan(253);
    expect(normalizeStartDomains([raw])).toBeNull();
    expect(normalizeStartDomains([`${label}.ch`])).toHaveLength(1);
  });

  it('keeps the start form\'s copies of the shared suffixes equal to the engine\'s', () => {
    const ui = readFileSync(join(__dirname, '..', '..', 'packages', 'web-ui', 'src', 'lib', 'components', 'bulk-start-domains.ts'), 'utf8');
    const listOf = (name: string): string[] => {
      const m = new RegExp(`const ${name}: readonly string\\[\\] = \\[([^\\]]*)\\]`).exec(ui);
      if (!m) throw new Error(`${name} not found in the start form`);
      return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
    };
    expect(listOf('PUBLIC_SECOND_LEVEL_LABELS')).toEqual([...PUBLIC_SECOND_LEVEL_LABELS]);
    expect(listOf('SHARED_PLATFORM_DOMAINS')).toEqual([...SHARED_PLATFORM_DOMAINS]);
  });
});

describe('the start list at the judge start', () => {
  it('is written with the start that begins the judge and shows in the status', () => {
    const id = listed();
    const out = startJudge(id, 2, ['Example.CH']);
    expect(out.ok).toBe(true);
    expect(ledger.startDomainsOf(id)).toEqual(['example.ch']);
    expect(ledger.getStatus(id)!.startDomains).toEqual(['example.ch']);
  });

  it('is refused at the list read (D-8), and the list read does not start', () => {
    const judged = plan(true);
    expect(ledger.resumePreview(judged, Date.now(), { listChecksum: ledger.listStartChecksum(judged)!, startDomains: ['example.ch'] }))
      .toEqual({ ok: false, reason: 'start_domains_not_here' });
    expect(ledger.getStatus(judged)!.startDomains).toBeNull();
    expect(ledger.getStatus(judged)!.haltReason).not.toBeNull();
    // A cost cap there is refused as such: the list's own reason does not hide it.
    expect(ledger.resumePreview(judged, Date.now(), { listChecksum: ledger.listStartChecksum(judged)!, costCapUsd: 2, startDomains: ['example.ch'] }))
      .toEqual({ ok: false, reason: 'not_at_this_start' });
  });

  it('is refused on a listed run without a judge, and on a judged run without a list', () => {
    const plain = plan(false);
    ledger.resumePreview(plain, Date.now(), { listChecksum: ledger.listStartChecksum(plain)! });
    ledger.recordListPage(plain, { page: 1, items: [item(1)], bytes: 1 });
    ledger.finishList(plain, (keys) => mintBulkContract(HOST, keys, 'PUT'));
    expect(ledger.getStatus(plain)!.phase).toBe('planned');
    expect(ledger.resumePreview(plain, Date.now(), { startDomains: ['example.ch'] })).toEqual({ ok: false, reason: 'start_domains_not_here' });
    const rows = ledger.recordDryRun({
      createdBy: 't', principal: OWNER_PRINCIPAL, targetSystem: 'data_store', scope: 'products', targetCollection: 'products',
      targets: [{ key: 'A', before: { absent: false, value: { sku: 'A', status: 'draft' } }, after: judgeTemplate(rule) }],
      judge: rule,
    }).id;
    expect(startJudge(rows, 2, ['example.ch'])).toEqual({ ok: false, reason: 'start_domains_not_here' });
  });

  it('leaves nothing behind when the start is refused: a later start without it runs without a list', () => {
    const id = listed();
    expect(ledger.resumePreview(id, Date.now(), { judgeRuleHash: ledger.getJudgeRuleForOwner(id)!.hash, startDomains: ['a.example'] }))
      .toEqual({ ok: false, reason: 'cost_cap' });
    expect(ledger.getStatus(id)!.startDomains).toBeNull();
    expect(startJudge(id).ok).toBe(true);
    expect(ledger.getStatus(id)!.startDomains).toBeNull();
  });

  it('takes an empty list as none', () => {
    const id = listed();
    expect(startJudge(id, 2, []).ok).toBe(true);
    expect(ledger.getStatus(id)!.startDomains).toBeNull();
  });

  it('is frozen once the judge started: the same list or none passes, another is refused', () => {
    const id = listed();
    expect(startJudge(id, 2, ['a.example']).ok).toBe(true);
    ledger.haltPreview(id, BULK_HALT_REASONS.timeBudget);
    expect(startJudge(id, 2, ['b.example'])).toEqual({ ok: false, reason: 'start_domains_frozen' });
    expect(ledger.getStatus(id)!.haltReason).toBe(BULK_HALT_REASONS.timeBudget);
    expect(startJudge(id, 2, ['a.example']).ok).toBe(true);
    ledger.haltPreview(id, BULK_HALT_REASONS.timeBudget);
    expect(startJudge(id).ok).toBe(true);
    expect(ledger.startDomainsOf(id)).toEqual(['a.example']);
  });

  it('is frozen once a target was read, even before the judge started', () => {
    const id = listed();
    // Test seam: a before-image recorded without a judge start.
    engineDb.getDb().prepare("UPDATE bulk_targets SET before = 'x' WHERE run_id = ? AND seq = 0").run(id);
    expect(startJudge(id, 2, ['b.example'])).toEqual({ ok: false, reason: 'start_domains_frozen' });
    expect(ledger.getStatus(id)!.startDomains).toBeNull();
  });

  it('refuses a frozen list before it ends another run', () => {
    const other = listed();
    expect(startJudge(other).ok).toBe(true);
    // Halted, it is still a started, unapproved judged run: the one a start must name to replace.
    ledger.haltPreview(other, BULK_HALT_REASONS.timeBudget);
    const id = listed();
    engineDb.getDb().prepare("UPDATE bulk_targets SET before = 'x' WHERE run_id = ? AND seq = 0").run(id);
    expect(ledger.resumePreview(id, Date.now(), { judgeRuleHash: ledger.getJudgeRuleForOwner(id)!.hash, costCapUsd: 2, supersedes: other, startDomains: ['b.example'] }))
      .toEqual({ ok: false, reason: 'start_domains_frozen' });
    expect(ledger.getStatus(other)!.phase).toBe('planned');
    // The same start without the list replaces it, so the refusal above was the list's.
    expect(ledger.resumePreview(id, Date.now(), { judgeRuleHash: ledger.getJudgeRuleForOwner(id)!.hash, costCapUsd: 2, supersedes: other }).ok).toBe(true);
    expect(ledger.getStatus(other)!.phase).toBe('aborted');
  });

  it('refuses a list that is not one, and starts nothing', () => {
    const id = listed();
    expect(startJudge(id, 2, ['*.example.ch'])).toEqual({ ok: false, reason: 'start_domains_invalid' });
    expect(ledger.getStatus(id)!.startDomains).toBeNull();
    expect(ledger.getStatus(id)!.haltReason).not.toBeNull();
  });
});

describe('the approval checksum and the start list', () => {
  it('binds the list where it is set, and is unchanged where it is not', () => {
    const id = listed();
    const without = ledger.computeChecksum(id);
    // Test seam: the column written as the judge start writes it.
    const put = (list: string[]): void => {
      engineDb.getDb().prepare('UPDATE bulk_runs SET start_domains = ? WHERE id = ?').run(engineDb.enc(JSON.stringify(list)), id);
    };
    put(['a.example']);
    const withA = ledger.computeChecksum(id);
    expect(withA).not.toBe(without);
    put(['b.example']);
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
