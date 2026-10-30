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
 * A rule text over the limit is refused when the run is planned, and the refusal names the
 * counted length: the model shortens by that number instead of an estimate of its own.
 */

let dir: string;
let engineDb: EngineDb;
let ledger: BulkLedger;

function agent(): IAgent {
  return { toolContext: { bulkLedger: ledger }, currentThreadId: 'thread-1', principal: OWNER_PRINCIPAL } as unknown as IAgent;
}

const plan = (rule: string): Promise<string> => bulkPlanTool.handler({
  target_system: 'http', target_host: 'shop.example.com',
  source_list: { path: '/wp-json/wc/v3/products' },
  judge: { rule, schema: { description: { type: 'string', maxLength: 2000 } } },
} as unknown as Parameters<typeof bulkPlanTool.handler>[0], agent());

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-bulk-rule-length-')));
  engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  ledger = new BulkLedger(engineDb, null);
});
afterEach(() => {
  engineDb.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('bulk_plan and the length of a rule text', () => {
  it('refuses 4001 characters with the counted length and the limit, and records no run', async () => {
    const out = await plan('x'.repeat(4_001));
    expect(out).toContain('judge.rule has 4001 characters; it may have at most 4000. Shorten it by at least 1.');
    expect(ledger.listRuns(10)).toHaveLength(0);
  });

  it('plans 4000 characters (the control)', async () => {
    expect(await plan('x'.repeat(4_000))).toMatch(/Bulk run [0-9a-f-]{36}/);
    expect(ledger.listRuns(10)).toHaveLength(1);
  });
});
