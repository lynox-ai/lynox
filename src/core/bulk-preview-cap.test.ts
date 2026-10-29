import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { BulkLedger, BulkPreviewCapError, BULK_MAX_PREVIEWED_RUNS, type PlannedTarget } from './bulk-ledger.js';
import { mintBulkContract } from './bulk-external.js';
import { OWNER_PRINCIPAL, type RequestPrincipal } from './request-principal.js';
import { setTenantWorkspace, clearTenantWorkspace } from './workspace.js';
import { bulkPlanTool } from '../tools/builtin/bulk.js';
import type { IAgent } from '../types/index.js';

// 660b: the cap of unapproved runs. The owner's planning drops the oldest over it, whoever
// planned them. Anyone else's drops only its own, and is refused when those cannot make room:
// a preview cannot be discarded by hand, so dropping the owner's would leave the owner nothing
// to approve.

const HELPER: RequestPrincipal = { kind: 'mandate', email: 'helper@example.invalid', mandateId: 'grant-1' };
const OTHER: RequestPrincipal = { kind: 'mandate', email: 'other@example.invalid', mandateId: 'grant-2' };

let dir: string;
let engineDb: EngineDb;
let ledger: BulkLedger;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-bulk-cap-')));
  engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  ledger = new BulkLedger(engineDb, null);
});

afterEach(() => {
  engineDb.close();
  rmSync(dir, { recursive: true, force: true });
});

const local = (): PlannedTarget[] => [{ key: '/ws/a.md', before: { absent: false, value: 'old' }, after: 'new' }];
const plan = (principal: RequestPrincipal): string =>
  ledger.recordDryRun({ createdBy: 't', principal, targetSystem: 'workspace', scope: 'w', targets: local() }).id;
const runs = (): Array<{ id: string; principal: string; mandate_id: string | null }> =>
  engineDb.getDb().prepare(`SELECT id, principal, mandate_id FROM bulk_runs ORDER BY created_at, rowid`).all() as never;
const fill = (principal: RequestPrincipal, n: number): string[] => Array.from({ length: n }, () => plan(principal));

describe('the cap of unapproved runs', () => {
  it('a delegated session\'s planning drops only its own oldest run, never the owner\'s', () => {
    const owners = fill(OWNER_PRINCIPAL, 5);
    const helpers = fill(HELPER, BULK_MAX_PREVIEWED_RUNS - 5);
    const next = plan(HELPER);
    const ids = runs().map((r) => r.id);
    expect(ids).toHaveLength(BULK_MAX_PREVIEWED_RUNS);
    expect(owners.every((id) => ids.includes(id)), 'every run of the owner stays').toBe(true);
    expect(ids).not.toContain(helpers[0]);
    expect(ids).toContain(next);
  });

  it('refuses a delegated session\'s planning, and records nothing, when it has no run of its own to drop', () => {
    fill(OWNER_PRINCIPAL, BULK_MAX_PREVIEWED_RUNS);
    const before = runs();
    let thrown: unknown;
    try { plan(HELPER); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(BulkPreviewCapError);
    expect((thrown as BulkPreviewCapError).waiting).toBe(BULK_MAX_PREVIEWED_RUNS);
    expect(runs()).toEqual(before);
  });

  it('another grant\'s runs are not its own', () => {
    fill(OTHER, BULK_MAX_PREVIEWED_RUNS);
    expect(() => plan(HELPER)).toThrow(BulkPreviewCapError);
    expect(runs().every((r) => r.mandate_id === 'grant-2')).toBe(true);
  });

  it('a mandate whose principal names no grant finds its own runs too', () => {
    const noGrant: RequestPrincipal = { kind: 'mandate', email: 'helper@example.invalid' };
    fill(OWNER_PRINCIPAL, BULK_MAX_PREVIEWED_RUNS - 1);
    const mine = plan(noGrant);
    expect(runs().find((r) => r.id === mine)).toMatchObject({ mandate_id: null });
    const next = plan(noGrant);
    const ids = runs().map((r) => r.id);
    expect(ids).not.toContain(mine);
    expect(ids).toContain(next);
    expect(ids).toHaveLength(BULK_MAX_PREVIEWED_RUNS);
  });

  it('the owner\'s planning drops the oldest over the cap, whoever planned it', () => {
    const helpers = fill(HELPER, BULK_MAX_PREVIEWED_RUNS);
    const next = plan(OWNER_PRINCIPAL);
    const ids = runs().map((r) => r.id);
    expect(ids).toHaveLength(BULK_MAX_PREVIEWED_RUNS);
    expect(ids).not.toContain(helpers[0]);
    expect(ids).toContain(next);
  });

  it('holds for an external plan too, refused before anything is recorded', () => {
    fill(OWNER_PRINCIPAL, BULK_MAX_PREVIEWED_RUNS);
    const host = 'shop.example.com';
    const key = `https://${host}/p/1`;
    expect(() => ledger.recordExternalPlan({
      createdBy: 't', principal: HELPER, host, targets: [{ key, after: { price: '1' } }], contract: mintBulkContract(host, [key]),
    })).toThrow(BulkPreviewCapError);
    expect(runs()).toHaveLength(BULK_MAX_PREVIEWED_RUNS);
  });

  it('counts only the previews waiting for approval in its text, and has a sentence without a number when none does', () => {
    fill(OWNER_PRINCIPAL, BULK_MAX_PREVIEWED_RUNS);
    expect(() => plan(HELPER)).toThrow(/^10 previews are already waiting for approval\. A new one is possible only once the owner approves some\. Tell the user that in one sentence; do not try again in this run\.$/);
    // Runs still to be read count against the cap but do not wait on an approval.
    engineDb.getDb().prepare(`UPDATE bulk_runs SET phase = 'planned'`).run();
    expect(() => plan(HELPER)).toThrow(/^Too many bulk runs are being prepared on this instance right now\. A new one is possible only once the owner starts or approves waiting runs, or plans a new one\. Ask the owner\. Tell the user/);
    engineDb.getDb().prepare(`UPDATE bulk_runs SET phase = 'previewed' WHERE rowid IN (SELECT rowid FROM bulk_runs ORDER BY rowid LIMIT 3)`).run();
    expect(() => plan(HELPER)).toThrow(/^3 previews are already waiting/);
  });
});

describe('the planner is told by bulk_plan', () => {
  let ws: string;
  beforeEach(() => {
    ws = join(dir, 'workspace');
    mkdirSync(ws);
    setTenantWorkspace(ws);
  });
  afterEach(() => { clearTenantWorkspace(); });

  it('the refusal, and no run, none of the owner\'s ids', async () => {
    const owners = fill(OWNER_PRINCIPAL, BULK_MAX_PREVIEWED_RUNS);
    writeFileSync(join(ws, 'a.md'), 'old\n');
    writeFileSync(join(ws, 'src.json'), JSON.stringify([{ target: 'a.md', after: 'new\n' }]));
    const agent = { toolContext: { bulkLedger: ledger, dataStore: null }, currentThreadId: 'thread-1', principal: HELPER } as unknown as IAgent;
    const out = await bulkPlanTool.handler({ target_system: 'workspace', source_file: 'src.json' }, agent);
    expect(out).toBe('Error: 10 previews are already waiting for approval. A new one is possible only once the owner approves some. Tell the user that in one sentence; do not try again in this run.');
    for (const id of owners) expect(out).not.toContain(id);
    expect(runs()).toHaveLength(BULK_MAX_PREVIEWED_RUNS);
  });
});
