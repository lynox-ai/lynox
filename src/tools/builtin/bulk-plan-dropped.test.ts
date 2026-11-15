import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bulkPlanTool } from './bulk.js';
import { EngineDb } from '../../core/engine-db.js';
import { BulkLedger, BULK_HALT_REASONS, BULK_MAX_PREVIEWED_RUNS } from '../../core/bulk-ledger.js';
import { OWNER_PRINCIPAL } from '../../core/request-principal.js';
import { setTenantWorkspace, clearTenantWorkspace } from '../../core/workspace.js';
import type { IAgent } from '../../types/index.js';

/**
 * A planning over the cap of unapproved runs drops the oldest, and nothing keeps them. Its answer
 * names each run it dropped — id, system and when it was planned, as bulk_status shows a run — so
 * the planner can tell the user which plan is gone. A planning that drops nothing says nothing.
 */

const HOST = 'shop.example.com';

let dir: string;
let ws: string;
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

const planWorkspace = (): Promise<string> =>
  bulkPlanTool.handler({ target_system: 'workspace', source_file: 'plan.json' }, agent());
const planExternal = (): Promise<string> =>
  bulkPlanTool.handler({ target_system: 'http', target_host: HOST, source_file: 'src.json' }, agent());
const planList = (): Promise<string> => bulkPlanTool.handler({
  target_system: 'http', target_host: HOST,
  source_list: { path: '/wp-json/wc/v3/products', filters: { category: 12 }, after: { status: 'draft' } },
} as Parameters<typeof bulkPlanTool.handler>[0], agent());

/** Whether the answer names `id` as dropped and the run is gone from the ledger. */
function namedAsDropped(answer: string, id: string): boolean {
  const gone = ledger.listRuns(50).every((r) => r.id !== id);
  return gone && new RegExp(`discarded [^\\n]*run ${id} \\(`).test(answer);
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-bulk-dropped-')));
  ws = join(dir, 'workspace');
  mkdirSync(ws);
  setTenantWorkspace(ws);
  writeFileSync(join(ws, 'plan.json'), JSON.stringify([{ target: 'page.md', after: 'y' }]));
  writeFileSync(join(ws, 'src.json'), JSON.stringify([{ target: `https://${HOST}/products/1`, after: { price: '1' } }]));
  engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  ledger = new BulkLedger(engineDb, null);
});
afterEach(() => {
  clearTenantWorkspace();
  engineDb.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('a planning that drops unapproved runs over the cap', () => {
  it('names the run it dropped, with its system, size and time in UTC, and says the plan is gone', async () => {
    const first = await planWorkspace();
    const firstId = runIdOf(first);
    const createdAt = ledger.getStatus(firstId)!.createdAt;
    for (let i = 1; i < BULK_MAX_PREVIEWED_RUNS; i++) await planWorkspace();
    const answer = await planWorkspace();
    expect(namedAsDropped(answer, firstId)).toBe(true);
    expect(answer).toContain(
      `To keep at most ${String(BULK_MAX_PREVIEWED_RUNS)} unapproved plans, recording this one discarded an older unapproved plan: ` +
      `run ${firstId} (workspace, 1 target, created ${createdAt.slice(0, 16)} UTC). Nothing of a discarded plan is kept: tell the user which plans are gone, ` +
      'described by system, size and date rather than by run id, and offer to plan again any that is still wanted and was not replaced.',
    );
    // Only the run dropped is named as one: the new run is the one the status line reports.
    expect(answer.match(/run [0-9a-f-]{36} \(workspace, 1 target, created /g)).toHaveLength(1);
  });

  it('says nothing of dropping while the plans fit under the cap', async () => {
    for (let i = 0; i < BULK_MAX_PREVIEWED_RUNS; i++) {
      const answer = await planWorkspace();
      expect(answer).not.toContain('discarded');
      expect(answer).not.toContain('Nothing of a discarded plan is kept');
    }
    expect(ledger.listRuns(50)).toHaveLength(BULK_MAX_PREVIEWED_RUNS);
  });

  it('names every run one planning dropped, oldest first', async () => {
    // One unapproved run more than the cap already waits (planned while the cap was higher): the
    // next planning drops two. Inserted newest first, so rowid order cannot stand in for time.
    const insert = engineDb.getDb().prepare(
      "INSERT INTO bulk_runs (id, created_at, rule_hash, target_system, undo, phase, targets_total) VALUES (?, ?, 'h', 'workspace', 'restorable', 'previewed', ?)",
    );
    for (let i = BULK_MAX_PREVIEWED_RUNS; i >= 0; i--) insert.run(`old-${String(i).padStart(2, '0')}`, `2000-01-01 00:${String(i).padStart(2, '0')}:30`, 12 - i);
    const answer = await planWorkspace();
    expect(answer).toContain('discarded 2 older unapproved plans: run old-00 (workspace, 12 targets, created 2000-01-01 00:00 UTC); ' +
      'run old-01 (workspace, 11 targets, created 2000-01-01 00:01 UTC).');
    expect(namedAsDropped(answer, 'old-01')).toBe(true);
    expect(ledger.listRuns(50)).toHaveLength(BULK_MAX_PREVIEWED_RUNS);
  });

  it('says of a dropped run already replaced by a started one that it was replaced', async () => {
    engineDb.getDb().prepare(
      `INSERT INTO bulk_runs (id, created_at, rule_hash, target_system, undo, phase, halt_reason)
       VALUES ('replaced-run', '2000-01-01 00:00:00', 'h', 'data_store', 'restorable', 'aborted', ?)`,
    ).run(BULK_HALT_REASONS.superseded);
    for (let i = 1; i < BULK_MAX_PREVIEWED_RUNS; i++) await planWorkspace();
    const answer = await planWorkspace();
    expect(answer).toContain('discarded an older unapproved plan: run replaced-run (data_store, 0 targets, created 2000-01-01 00:00 UTC, already replaced by a run the user started).');
    expect(namedAsDropped(answer, 'replaced-run')).toBe(true);
  });

  it('names it from an external plan', async () => {
    const firstId = runIdOf(await planExternal());
    for (let i = 1; i < BULK_MAX_PREVIEWED_RUNS; i++) expect(await planExternal()).not.toContain('discarded');
    const answer = await planExternal();
    expect(answer).toContain('External dry run recorded');
    expect(namedAsDropped(answer, firstId)).toBe(true);
    expect(answer).toContain(`run ${firstId} (http:${HOST}, 1 target, created `);
  });

  it('names it from a list plan, whose size is not known before its list is read', async () => {
    const firstId = runIdOf(await planList());
    for (let i = 1; i < BULK_MAX_PREVIEWED_RUNS; i++) expect(await planList()).not.toContain('discarded');
    const answer = await planList();
    expect(answer).toContain('List dry run recorded');
    expect(namedAsDropped(answer, firstId)).toBe(true);
    expect(answer).toContain(`run ${firstId} (http:${HOST}, its list not read yet, created `);
  });

  it('gives a list plan read in part the targets read so far, and says its list was not read to the end', async () => {
    // A local planning does not wait for a list being read, and may drop it part read.
    engineDb.getDb().prepare(
      `INSERT INTO bulk_runs (id, created_at, rule_hash, target_system, undo, phase, targets_total, list_state, list_page)
       VALUES ('part-read', '2000-01-01 00:00:00', 'h', 'http:${HOST}', 'restorable', 'planned', 5, 'pending', 1)`,
    ).run();
    for (let i = 1; i < BULK_MAX_PREVIEWED_RUNS; i++) await planWorkspace();
    const answer = await planWorkspace();
    expect(answer).toContain(`run part-read (http:${HOST}, 5 targets read so far, its list not read to the end, created 2000-01-01 00:00 UTC).`);
    expect(namedAsDropped(answer, 'part-read')).toBe(true);
  });
});
