import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { BulkLedger, BULK_HALT_REASONS, type ListPageItem } from './bulk-ledger.js';
import { OWNER_PRINCIPAL } from './request-principal.js';
import { mintBulkContract } from './bulk-external.js';
import { parseListSource } from './bulk-list.js';
import { judgeTemplate, normalizeJudgeRule } from './bulk-judge-rule.js';
import type { CapabilityContract } from '../types/capability-contract.js';

// A judged run the owner replaces by starting another one in its place keeps the id of that run,
// so its page can link the run that took its place (U-342). Only the run that ended so carries it.

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
  dir = mkdtempSync(join(tmpdir(), 'lynox-bulk-superseded-by-'));
  engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  ledger = new BulkLedger(engineDb, null);
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

function startJudge(id: string, supersedes?: string): ReturnType<BulkLedger['resumePreview']> {
  return ledger.resumePreview(id, Date.now(), { judgeRuleHash: ledger.getJudgeRuleForOwner(id)!.hash, costCapUsd: 2, ...(supersedes !== undefined ? { supersedes } : {}) });
}

describe('a judged run another one replaced', () => {
  it('keeps the id of the run that took its place, and no other run carries one', () => {
    const first = listed();
    expect(startJudge(first).ok).toBe(true);
    ledger.haltPreview(first, BULK_HALT_REASONS.timeBudget);
    const bystander = listed();
    const second = listed();
    expect(startJudge(second, first).ok).toBe(true);
    const ended = ledger.getStatus(first)!;
    expect(ended.phase).toBe('aborted');
    expect(ended.haltReason).toBe(BULK_HALT_REASONS.superseded);
    expect(ended.supersededBy).toBe(second);
    expect(ledger.getStatus(second)!.supersededBy).toBeNull();
    expect(ledger.getStatus(bystander)!.supersededBy).toBeNull();
    // The list carries it as the run's page does.
    expect(ledger.listRuns(10).find((r) => r.id === first)!.supersededBy).toBe(second);
  });

  it('records nothing when the start does not name the run it would replace', () => {
    const first = listed();
    expect(startJudge(first).ok).toBe(true);
    ledger.haltPreview(first, BULK_HALT_REASONS.timeBudget);
    const second = listed();
    expect(startJudge(second)).toMatchObject({ ok: false, reason: 'supersede_required' });
    expect(ledger.getStatus(first)!.phase).toBe('planned');
    expect(ledger.getStatus(first)!.supersededBy).toBeNull();
  });
});
