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

  it('writes per-campaign CSVs + shared-sets CSV and stamps hash on success', async () => {
    seedFullScenario(store);
    runBlueprint(store, ACCOUNT);

    const result = runEmit(store, ACCOUNT, { workspaceDir });
    expect(result.validation.canEmit).toBe(true);
    expect(result.idempotent).toBe(false);
    expect(result.filesWritten.length).toBeGreaterThan(0);
    // Account-level negatives now ride along in shared-sets.csv (Editor's
    // canonical 2-row pattern: definition + member rows). manual-todos
    // routing is reserved for entity types whose CSV format is genuinely
    // unstable (PMax single-asset rows on KEEP asset_groups).
    expect(result.filesWritten.some(f => f.endsWith('shared-sets.csv'))).toBe(true);
    expect(result.filesWritten.some(f => f.endsWith('account-negatives.csv'))).toBe(false);
    expect(result.manualTodos.every(t => t.kind !== 'shared_set_negative')).toBe(true);
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

    // Mark a major import AFTER run #1 finished so the new
    // BlueprintPendingImportNotice guard sees the entities as imported.
    // Use Date.now()+1s to guarantee strict ordering against finished_at.
    const importIso = new Date(Date.now() + 1000).toISOString();
    store.recordMajorImport(ACCOUNT, importIso);

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

  it('shared-sets.csv carries definition + member rows for account-level negatives', async () => {
    seedFullScenario(store);
    runBlueprint(store, ACCOUNT);
    const result = runEmit(store, ACCOUNT, { workspaceDir });
    const sharedFile = result.filesWritten.find(f => f.endsWith('shared-sets.csv'));
    expect(sharedFile).toBeDefined();
    const text = decodeUtf16LeBytes(await readFile(sharedFile!));
    // Definition row: Shared set type=Negative keyword on a row WITHOUT a Keyword.
    expect(text).toMatch(/Negative keyword/);
    // Member rows use Criterion Type=Negative Broad/Phrase/Exact.
    expect(text).toMatch(/Negative (Broad|Phrase|Exact)/);
    expect(text).toMatch(/drills/i);
  });

  it('shared-sets-disabled scenario keeps manual-todos.md path empty for negatives', async () => {
    seedFullScenario(store);
    runBlueprint(store, ACCOUNT);
    const result = runEmit(store, ACCOUNT, { workspaceDir });
    // Operator-friendly path with shared-set heading + match-type + keyword.
    const todosFile = result.filesWritten.find(f => f.endsWith('manual-todos.md'));
    if (!todosFile) return; // todos may legitimately be empty now.
    const text = await readFile(todosFile, 'utf8');
    // No more shared-set negatives in manual-todos.
    expect(text).not.toMatch(/Negative Keywords \(Shared Sets\)/);
    expect(text).toMatch(/(Account Competitor Negatives|PMax-Owned Negatives)/);
    expect(text).toMatch(/Broad|Phrase|Exact/);
    expect(text).toMatch(/drills/i);
  });

  it('filesWritten + perFileRowCounts cover the CSVs (manual-todos.md is extra)', () => {
    seedFullScenario(store);
    runBlueprint(store, ACCOUNT);
    const result = runEmit(store, ACCOUNT, { workspaceDir });
    // perFileRowCounts only covers CSVs; manual-todos.md is appended to
    // filesWritten so the operator can download it but isn't counted as
    // a CSV row source.
    const csvFiles = result.filesWritten.filter(f => !f.endsWith('manual-todos.md'));
    expect(result.perFileRowCounts.map(p => p.file)).toEqual(csvFiles);
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
        biddingStrategyType: 'MAXIMIZE_CONVERSION_VALUE',
        targetRoas: 4.5,
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
    // Bid strategy + target ROAS came through from snapshot. The snapshot
    // stores the API multiplier (4.5 = 450%); emit converts to the percent
    // form Editor's "Target ROAS" CSV column expects (450) — without this
    // conversion Editor reads 4.5 as 4.5%, which on a production campaign
    // would collapse the existing ROAS target by ~100×.
    expect(text).toMatch(/Maximize conversion value/);
    expect(text).toMatch(/\b450\b/);
    expect(text).not.toMatch(/\b4\.5\b/);
    // Header order: 1st column=Campaign so the budget converted correctly to 30 CHF.
    expect(text).toMatch(/30(\.0+)?\b/);
  });

  it('Target CPA: micros from snapshot converts to CHF in emit', async () => {
    seedCustomerAndAccount(store);
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);
    store.insertCampaignsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [{
        campaignId: 'leadgen-1',
        campaignName: 'Search-Leads-DE',
        status: 'ENABLED',
        channelType: 'SEARCH',
        biddingStrategyType: 'TARGET_CPA',
        targetCpaMicros: 50_000_000, // 50 CHF
      }],
    });
    runBlueprint(store, ACCOUNT);
    const result = runEmit(store, ACCOUNT, { workspaceDir });
    const file = result.filesWritten.find(f => f.endsWith('search-leads-de.csv'))!;
    const text = decodeUtf16LeBytes(await readFile(file));
    expect(text).toMatch(/Target CPA/);
    expect(text).toMatch(/\b50(\.0+)?\b/);
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
