import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdsDataStore } from '../../core/ads-data-store.js';
import { runBlueprint } from '../../core/ads-blueprint-engine.js';
import { createAdsEmitCsvTool, renderEmitReport } from './ads-emit-csv.js';
import { runEmit } from '../../core/ads-emit-engine.js';
import type { IAgent } from '../../types/index.js';

const ACCOUNT = '123-456-7890';
const CUSTOMER = 'acme-shop';
const fakeAgent = {} as unknown as IAgent;

describe('ads_emit_csv tool', () => {
  let tempDir: string;
  let workspaceDir: string;
  let store: AdsDataStore;
  let tool: ReturnType<typeof createAdsEmitCsvTool>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-emit-tool-'));
    workspaceDir = await mkdtemp(join(tmpdir(), 'lynox-emit-tool-ws-'));
    store = new AdsDataStore(join(tempDir, 'ads-optimizer.db'));
    tool = createAdsEmitCsvTool(store);
  });

  afterEach(async () => {
    store.close();
    await rm(tempDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it('returns error string for unknown account', async () => {
    const out = await tool.handler({ ads_account_id: 'nope' }, fakeAgent);
    expect(out).toMatch(/^ads_emit_csv failed/);
  });

  it('writes per-campaign CSVs and produces success-shaped markdown', async () => {
    seedFullScenario(store);
    runBlueprint(store, ACCOUNT);

    const out = await tool.handler({ ads_account_id: ACCOUNT, workspace_dir: workspaceDir }, fakeAgent);
    expect(out).toMatch(/^# Emit Report/);
    expect(out).toMatch(/Emit erfolgreich/);
    expect(out).toMatch(/Editor-CSV-Pack — Direkt herunterladen/);
    expect(out).toMatch(/\/api\/files\/download\?path=/);

    // CSV files exist
    const runDir = join(workspaceDir, 'ads', ACCOUNT, 'blueprints');
    const blueprintRunDirs = await readdir(runDir);
    expect(blueprintRunDirs.length).toBe(1);
    const files = await readdir(join(runDir, blueprintRunDirs[0]!));
    expect(files.some(f => f.endsWith('.csv'))).toBe(true);
  });

  it('reports HARD validator errors in the markdown table', async () => {
    seedCustomerAndAccount(store);
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);
    // Synthetic broken RSA blueprint entity (too few headlines).
    store.insertBlueprintEntity({
      runId: r.run_id, adsAccountId: ACCOUNT, entityType: 'rsa_ad',
      kind: 'NEW', externalId: 'rsa1',
      payload: { headlines: ['only one'], descriptions: ['one'] },
      confidence: 1, rationale: '',
    });

    const out = await tool.handler({ ads_account_id: ACCOUNT, workspace_dir: workspaceDir }, fakeAgent);
    expect(out).toMatch(/Pre-Emit-Validators/);
    expect(out).toMatch(/Errors/);
    expect(out).toMatch(/HARD-Checks/);
  });
});

describe('renderEmitReport', () => {
  let tempDir: string;
  let workspaceDir: string;
  let store: AdsDataStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-emit-render-'));
    workspaceDir = await mkdtemp(join(tmpdir(), 'lynox-emit-render-ws-'));
    store = new AdsDataStore(join(tempDir, 'ads-optimizer.db'));
  });

  afterEach(async () => {
    store.close();
    await rm(tempDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it('shows No-Op banner when result is idempotent', () => {
    seedFullScenario(store);
    runBlueprint(store, ACCOUNT);
    const first = runEmit(store, ACCOUNT, { workspaceDir });

    // Manually mark the previous-run hash to match this run, simulating a
    // no-change re-emit scenario.
    type RawDb = { db?: { prepare(sql: string): { run(...args: unknown[]): unknown } } };
    const raw = store as unknown as RawDb;
    raw.db?.prepare('UPDATE ads_audit_runs SET previous_run_id = ? WHERE run_id = ?')
      .run(first.run.run_id, first.run.run_id); // self-loop just for stamp test
    raw.db?.prepare('UPDATE ads_audit_runs SET emitted_csv_hash = ? WHERE run_id = ?')
      .run(first.hash, first.run.run_id);

    const same = runEmit(store, ACCOUNT, { workspaceDir });
    expect(same.idempotent).toBe(true);
    const md = renderEmitReport(same);
    expect(md).toMatch(/No-Op/);
  });
});

// ── Fixtures ──────────────────────────────────────────────────────────

function seedCustomerAndAccount(store: AdsDataStore): void {
  store.upsertCustomerProfile({
    customerId: CUSTOMER, clientName: 'Acme Shop',
    languages: ['DE'], pmaxOwnedHeadTerms: ['drills'], primaryGoal: 'roas',
  });
  store.upsertAdsAccount({ adsAccountId: ACCOUNT, customerId: CUSTOMER, accountLabel: 'Main' });
}

function seedFullScenario(store: AdsDataStore): void {
  seedCustomerAndAccount(store);
  const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
  store.completeAuditRun(r.run_id);
  store.insertCampaignsBatch({
    runId: r.run_id, adsAccountId: ACCOUNT,
    rows: [{ campaignId: 'c1', campaignName: 'DE-Search-Brand', status: 'ENABLED' }],
  });
  store.insertAdGroupsBatch({
    runId: r.run_id, adsAccountId: ACCOUNT,
    rows: [{ adGroupId: 'ag1', adGroupName: 'AG-Brand', campaignName: 'DE-Search-Brand' }],
  });
  store.insertKeywordsBatch({
    runId: r.run_id, adsAccountId: ACCOUNT,
    rows: [{ keyword: 'acme shop', matchType: 'EXACT', campaignName: 'DE-Search-Brand', adGroupName: 'AG-Brand' }],
  });
}
