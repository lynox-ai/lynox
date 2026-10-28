import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bulkPlanTool } from './bulk.js';
import { EngineDb } from '../../core/engine-db.js';
import { BulkLedger } from '../../core/bulk-ledger.js';
import { OWNER_PRINCIPAL } from '../../core/request-principal.js';
import type { IAgent } from '../../types/index.js';

/**
 * The link domains a judged run's verdicts may add are the owner's, given at the start (PRD
 * shopify-preset §20.2 item 5, S20-4). `bulk_plan` refuses a plan that names any, wherever in
 * its input, and records no run: an injected chat must not widen the domain rule.
 */

const HOST = 'shop.example.com';
const PATH = '/wp-json/wc/v3/products';
const judge = { rule: 'Rewrite the description.', schema: { description: { type: 'string', maxLength: 2000 } } };

let dir: string;
let engineDb: EngineDb;
let ledger: BulkLedger;

function agent(): IAgent {
  return { toolContext: { bulkLedger: ledger }, currentThreadId: 'thread-1', principal: OWNER_PRINCIPAL } as unknown as IAgent;
}

const plan = (input: Record<string, unknown>): Promise<string> =>
  bulkPlanTool.handler(input as Parameters<typeof bulkPlanTool.handler>[0], agent());

const base = (): Record<string, unknown> => ({
  target_system: 'http', target_host: HOST,
  source_list: { path: PATH },
  judge: { ...judge },
});

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-bulk-domains-plan-')));
  engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  ledger = new BulkLedger(engineDb, null);
});
afterEach(() => {
  engineDb.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('bulk_plan and a start list', () => {
  it('plans the same run without one (the control)', async () => {
    const out = await plan(base());
    expect(out).toMatch(/Bulk run [0-9a-f-]{36}/);
    expect(ledger.listRuns(10)).toHaveLength(1);
  });

  it.each([
    ['at the top', (i: Record<string, unknown>) => ({ ...i, start_domains: ['evil.example'] })],
    ['camel-cased', (i: Record<string, unknown>) => ({ ...i, startDomains: ['evil.example'] })],
    ['in the list source', (i: Record<string, unknown>) => ({ ...i, source_list: { ...(i['source_list'] as object), link_domains: ['evil.example'] } })],
    ['in the judge', (i: Record<string, unknown>) => ({ ...i, judge: { ...(i['judge'] as object), allowedDomains: ['evil.example'] } })],
  ])('refuses one %s and records no run', async (_where, withList) => {
    const out = await plan(withList(base()));
    expect(out).toContain('the link domains a run may add are the user\'s, set when they start the run');
    expect(out).not.toMatch(/Bulk run [0-9a-f-]{36}/);
    expect(ledger.listRuns(10)).toHaveLength(0);
  });
});
