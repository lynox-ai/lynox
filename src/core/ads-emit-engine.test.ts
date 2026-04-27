import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdsDataStore } from './ads-data-store.js';
import { runEmit, EmitPreconditionError } from './ads-emit-engine.js';
import { runBlueprint } from './ads-blueprint-engine.js';

const ACCOUNT = '123-456-7890';
const CUSTOMER = 'acme-shop';

describe('runEmit', () => {
  let tempDir: string;
  let workspaceDir: string;
  let store: AdsDataStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-emit-test-'));
    workspaceDir = await mkdtemp(join(tmpdir(), 'lynox-emit-ws-'));
    store = new AdsDataStore(join(tempDir, 'ads-optimizer.db'));
  });

  afterEach(async () => {
    store.close();
    await rm(tempDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it('throws on unknown account', () => {
    expect(() => runEmit(store, 'nope')).toThrow(EmitPreconditionError);
  });

  it('throws when no audit run exists', () => {
    seedCustomerAndAccount(store);
    expect(() => runEmit(store, ACCOUNT)).toThrow(/No successful audit run/);
  });

  it('throws when blueprint phase has not been run yet', () => {
    seedCustomerAndAccount(store);
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);
    expect(() => runEmit(store, ACCOUNT)).toThrow(/No blueprint entities/);
  });

  it('writes per-campaign + account-negatives CSVs and stamps hash on success', async () => {
    seedFullScenario(store);
    runBlueprint(store, ACCOUNT);

    const result = runEmit(store, ACCOUNT, { workspaceDir });
    expect(result.validation.canEmit).toBe(true);
    expect(result.idempotent).toBe(false);
    expect(result.filesWritten.length).toBeGreaterThan(0);
    expect(result.filesWritten.some(f => f.endsWith('account-negatives.csv'))).toBe(true);
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);

    // Hash stamped onto the run
    const run = store.getLatestSuccessfulAuditRun(ACCOUNT)!;
    expect(run.emitted_csv_hash).toBe(result.hash);
  });

  it('idempotent re-run does not write files when blueprint hash unchanged', async () => {
    seedFullScenario(store);
    runBlueprint(store, ACCOUNT);
    const first = runEmit(store, ACCOUNT, { workspaceDir });
    expect(first.idempotent).toBe(false);

    // Simulate a second cycle with the SAME blueprint state by linking
    // a new run as previous=first-run with the same hash already stamped.
    const r2 = store.createAuditRun({
      adsAccountId: ACCOUNT, mode: 'OPTIMIZE', previousRunId: first.run.run_id,
    });
    store.completeAuditRun(r2.run_id);
    // Re-run blueprint (will produce identical entities since snapshot is identical).
    seedSameSnapshot(store, r2.run_id);
    runBlueprint(store, ACCOUNT);

    const second = runEmit(store, ACCOUNT, { workspaceDir });
    expect(second.hash).toBe(first.hash);
    expect(second.idempotent).toBe(true);
    expect(second.filesWritten).toHaveLength(0);
    expect(second.blockedReason).toMatch(/identisch/);
  });

  it('blocks emit when validators report HARD errors', () => {
    seedCustomerAndAccount(store, { competitors: ['Bosch'] });
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);
    // Insert a synthetic RSA blueprint entity with too few headlines.
    store.insertBlueprintEntity({
      runId: r.run_id, adsAccountId: ACCOUNT, entityType: 'rsa_ad',
      kind: 'NEW', externalId: 'rsa1',
      payload: { headlines: ['only one'], descriptions: ['one'] },
      confidence: 1, rationale: '',
    });
    const result = runEmit(store, ACCOUNT, { workspaceDir });
    expect(result.validation.canEmit).toBe(false);
    expect(result.filesWritten).toHaveLength(0);
    expect(result.blockedReason).toMatch(/HARD-Errors/);
  });

  it('CSV files start with UTF-16 LE BOM', async () => {
    seedFullScenario(store);
    runBlueprint(store, ACCOUNT);
    const result = runEmit(store, ACCOUNT, { workspaceDir });
    expect(result.filesWritten.length).toBeGreaterThan(0);
    const file = result.filesWritten[0]!;
    const bytes = await readFile(file);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xfe);
  });

  it('accountnegatives file holds account-level negatives only', async () => {
    seedFullScenario(store);
    runBlueprint(store, ACCOUNT);
    const result = runEmit(store, ACCOUNT, { workspaceDir });
    const negFile = result.filesWritten.find(f => f.endsWith('account-negatives.csv'));
    expect(negFile).toBeDefined();
    const bytes = await readFile(negFile!);
    // decode UTF-16 LE manually
    const text = decodeUtf16LeBytes(bytes);
    expect(text).toMatch(/Campaign Negative/);
    expect(text).toMatch(/drills/i);
  });

  it('filesWritten + perFileRowCounts agree', () => {
    seedFullScenario(store);
    runBlueprint(store, ACCOUNT);
    const result = runEmit(store, ACCOUNT, { workspaceDir });
    expect(result.perFileRowCounts.map(p => p.file)).toEqual(result.filesWritten);
  });

  it('PMAX end-to-end: campaign + asset_groups round-trip into editor CSV', async () => {
    seedCustomerAndAccount(store);
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);
    store.insertCampaignsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [{
        campaignId: 'pmax-1',
        campaignName: 'PMAX-Drills-DE',
        status: 'ENABLED',
        channelType: 'PERFORMANCE_MAX',
        budgetMicros: 30_000_000, // 30 CHF / day
      }],
    });
    store.insertAssetGroupsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [
        { assetGroupId: 'ag-power', assetGroupName: 'Power-Drills', campaignName: 'PMAX-Drills-DE', adStrength: 'EXCELLENT' },
        { assetGroupId: 'ag-cordless', assetGroupName: 'Cordless-Drills', campaignName: 'PMAX-Drills-DE', adStrength: 'GOOD' },
      ],
    });
    runBlueprint(store, ACCOUNT);

    const result = runEmit(store, ACCOUNT, { workspaceDir });
    expect(result.validation.canEmit).toBe(true);
    expect(result.totals.assetGroups).toBe(2);
    expect(result.totals.campaigns).toBe(1);

    const pmaxFile = result.filesWritten.find(f => f.endsWith('pmax-drills-de.csv'));
    expect(pmaxFile).toBeDefined();
    const text = decodeUtf16LeBytes(await readFile(pmaxFile!));
    expect(text).toMatch(/PMAX-Drills-DE/);
    expect(text).toMatch(/Performance Max/);
    expect(text).toMatch(/Power-Drills/);
    expect(text).toMatch(/Cordless-Drills/);
    // Header order: 1st column=Campaign so the budget converted correctly to 30 CHF.
    expect(text).toMatch(/30(\.0+)?\b/);
  });
});

// ── Fixtures ──────────────────────────────────────────────────────────

function seedCustomerAndAccount(
  store: AdsDataStore, opts?: { competitors?: readonly string[] | undefined } | undefined,
): void {
  store.upsertCustomerProfile({
    customerId: CUSTOMER, clientName: 'Acme',
    languages: ['DE'],
    pmaxOwnedHeadTerms: ['drills'],
    competitors: opts?.competitors ?? [],
    primaryGoal: 'roas',
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

function seedSameSnapshot(store: AdsDataStore, runId: number): void {
  store.insertCampaignsBatch({
    runId, adsAccountId: ACCOUNT,
    rows: [{ campaignId: 'c1', campaignName: 'DE-Search-Brand', status: 'ENABLED' }],
  });
  store.insertAdGroupsBatch({
    runId, adsAccountId: ACCOUNT,
    rows: [{ adGroupId: 'ag1', adGroupName: 'AG-Brand', campaignName: 'DE-Search-Brand' }],
  });
  store.insertKeywordsBatch({
    runId, adsAccountId: ACCOUNT,
    rows: [{ keyword: 'acme shop', matchType: 'EXACT', campaignName: 'DE-Search-Brand', adGroupName: 'AG-Brand' }],
  });
}

function decodeUtf16LeBytes(bytes: Buffer | Uint8Array): string {
  const u8 = bytes instanceof Buffer ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes;
  // skip BOM
  const slice = u8.slice(2);
  let out = '';
  for (let i = 0; i < slice.length; i += 2) {
    out += String.fromCharCode(slice[i]! | (slice[i + 1]! << 8));
  }
  return out;
}
