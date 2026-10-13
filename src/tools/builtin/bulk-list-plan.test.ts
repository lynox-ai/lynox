import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bulkPlanTool, bulkStatusTool } from './bulk.js';
import { EngineDb } from '../../core/engine-db.js';
import { BulkLedger, BULK_HALT_REASONS } from '../../core/bulk-ledger.js';
import { mintBulkContract, parseBulkContract } from '../../core/bulk-external.js';
import { OWNER_PRINCIPAL } from '../../core/request-principal.js';
import type { IAgent } from '../../types/index.js';

/**
 * `bulk_plan` with a list as its source (PRD bulk-loop §3.2): it records the list and its
 * read contract and sends nothing — the list is read only once the user starts the run.
 */

const HOST = 'shop.example.com';
const PATH = '/wp-json/wc/v3/products';

let dir: string;
let engineDb: EngineDb;
let ledger: BulkLedger;

function agent(): IAgent {
  return { toolContext: { bulkLedger: ledger }, currentThreadId: 'thread-1', principal: OWNER_PRINCIPAL } as unknown as IAgent;
}

function runIdOf(result: string): string {
  const m = /Bulk run ([0-9a-f-]{36})/.exec(result);
  if (!m) throw new Error(`no run id in: ${result}`);
  return m[1]!;
}

const plan = (extra: Record<string, unknown> = {}): Promise<string> => bulkPlanTool.handler({
  target_system: 'http', target_host: HOST,
  source_list: { path: PATH, filters: { category: 12 }, after: { status: 'draft' } },
  ...extra,
} as Parameters<typeof bulkPlanTool.handler>[0], agent());

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-bulk-list-plan-')));
  engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  ledger = new BulkLedger(engineDb);
});
afterEach(() => {
  engineDb.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('bulk_plan with source_list', () => {
  it('records the list under a contract that reads only the list, and waits for the user', async () => {
    const out = await plan({ write_method: 'PUT' });
    expect(out).toContain('List dry run recorded — nothing was sent, read or written.');
    expect(out).toContain('0 page(s) read');
    const id = runIdOf(out);
    const run = ledger.getListRun(id)!;
    expect(run).toMatchObject({ state: 'pending', page: 0, phase: 'planned', haltReason: BULK_HALT_REASONS.awaitingStart });
    expect(run.source).toEqual({ form: 'woocommerce', path: PATH, filters: { category: '12' }, idField: 'id', method: 'PUT', after: { status: 'draft' } });
    const contract = parseBulkContract(run.contractJson)!;
    expect(contract.httpMethods).toEqual(['GET']);
    expect(contract.pathPatterns).toEqual([PATH]);
    expect(ledger.getStatus(id)!.total).toBe(0);
  });

  it('writes with PATCH unless told otherwise', async () => {
    const id = runIdOf(await plan());
    expect(ledger.getListRun(id)!.source.method).toBe('PATCH');
  });

  it('is refused for any target system but http, without a host, and as atomic — recording nothing', async () => {
    expect(await plan({ target_system: 'workspace' })).toBe('Error: source_list needs target_system "http".');
    expect(await plan({ target_host: undefined })).toBe('Error: target_system "http" needs target_host: a plain host name such as api.example.com.');
    expect(await plan({ atomic: true })).toBe('Error: target_system "http" cannot be atomic: an external host has no rollback.');
    expect(ledger.listRuns()).toEqual([]);
  });

  it('passes the list check\'s refusal on, and records nothing', async () => {
    expect(await plan({ source_list: { path: PATH, filters: { orderby: 'price' }, after: { status: 'draft' } } }))
      .toBe('Error: source_list.filters may only use: category, tag, status, sku, type, stock_status.');
    expect(await plan({ source_list: { path: '/wp-json/wc/v3/products/7', after: { status: 'draft' } } }))
      .toBe('Error: source_list.path is not a list of the form woocommerce.');
    expect(ledger.listRuns()).toEqual([]);
  });

  it('is refused while another external dry run reads', async () => {
    const first = runIdOf(await plan());
    ledger.resumePreview(first, Date.now(), { listChecksum: ledger.listStartChecksum(first)! });
    expect(await plan()).toBe('Error: another external dry run is still reading its targets. Wait until bulk_status shows it previewed, then plan again.');
    expect(ledger.listRuns()).toHaveLength(1);
  });

  it('says, once the list is read, that the targets wait for the user\'s second start', async () => {
    const id = runIdOf(await plan());
    ledger.resumePreview(id, Date.now(), { listChecksum: ledger.listStartChecksum(id)! });
    ledger.recordListPage(id, { page: 1, items: [{ key: `https://${HOST}${PATH}/7` }], bytes: 20 });
    expect(ledger.finishList(id, (keys) => mintBulkContract(HOST, keys, 'PATCH'))).toBe('listed');
    expect(ledger.getStatus(id)!.haltReason).toBe(BULK_HALT_REASONS.listed);
    const status = await bulkStatusTool.handler({ run_id: id }, agent());
    expect(status).toContain('The list is read. Its targets are read only once the user starts the run again, outside this chat.');
    expect(status).not.toContain('Halted:');
    expect(status).not.toContain('not read to the end yet');
  });
});
