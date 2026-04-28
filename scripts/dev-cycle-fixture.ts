#!/usr/bin/env npx tsx
/**
 * Dev cycle — drive the full Ads Optimizer pipeline (pull → audit →
 * blueprint → emit) against a local CSV fixture. No real Google
 * Drive, no agent loop, no DataForSEO. Validates the deterministic
 * mechanics end-to-end against any 22-CSV pack the operator points
 * the script at.
 *
 * Env vars (all optional except the fixture path):
 *
 *   LYNOX_ADS_DEV_FIXTURE_PATH   absolute path to a directory holding
 *                                the 21 ads CSVs (campaigns.csv,
 *                                ad_groups.csv, …). Required.
 *
 *   LYNOX_ADS_DEV_ACCOUNT_ID     Google Ads CID, format 123-456-7890.
 *                                Default: 123-456-7890.
 *
 *   LYNOX_ADS_DEV_CUSTOMER_ID    Stable slug. Default: demo-shop.
 *
 *   LYNOX_ADS_DEV_PROFILE_PATH   path to a JSON file matching
 *                                UpsertCustomerProfileInput; merged on
 *                                top of the placeholder defaults.
 *
 * Usage:
 *
 *   LYNOX_ADS_DEV_FIXTURE_PATH=/path/to/ads-csvs \
 *     npx tsx scripts/dev-cycle-fixture.ts
 *
 * Customer-specific profile values (own brands, competitors, target
 * ROAS, naming convention, …) live OUTSIDE this repo. Place them in
 * a local JSON file and point LYNOX_ADS_DEV_PROFILE_PATH at it.
 */

import { mkdtempSync, mkdirSync, copyFileSync, readdirSync, writeFileSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdsDataStore, type UpsertCustomerProfileInput } from '../src/core/ads-data-store.js';
import { runAdsDataPull, type IDriveReader } from '../src/tools/builtin/ads-data-pull.js';
import { runAudit } from '../src/core/ads-audit-engine.js';
import { renderMarkdownReport as renderAuditReport } from '../src/tools/builtin/ads-audit-run.js';
import { runBlueprint } from '../src/core/ads-blueprint-engine.js';
import { renderBlueprintReport } from '../src/tools/builtin/ads-blueprint-run.js';
import { runEmit } from '../src/core/ads-emit-engine.js';

// ── Config ────────────────────────────────────────────────────────────

const ARCHIVE_PATH = process.env['LYNOX_ADS_DEV_FIXTURE_PATH'];
const ADS_ACCOUNT_ID = process.env['LYNOX_ADS_DEV_ACCOUNT_ID'] ?? '123-456-7890';
const CUSTOMER_ID = process.env['LYNOX_ADS_DEV_CUSTOMER_ID'] ?? 'demo-shop';
const PROFILE_PATH = process.env['LYNOX_ADS_DEV_PROFILE_PATH'];
const FOLDER_MIME = 'application/vnd.google-apps.folder';

// Generic placeholder profile — keeps the dev script free of
// customer-specific data. Override real fields via
// LYNOX_ADS_DEV_PROFILE_PATH (a JSON file matching this shape).
const DEFAULT_PROFILE: UpsertCustomerProfileInput = {
  customerId: CUSTOMER_ID,
  clientName: 'Demo Shop',
  businessModel: 'ecommerce',
  offerSummary: 'Generic e-commerce placeholder profile.',
  primaryGoal: 'roas',
  targetRoas: 4.0,
  monthlyBudgetChf: 1000,
  typicalCpcChf: 1.0,
  country: 'CH',
  timezone: 'Europe/Zurich',
  languages: ['de'],
  topProducts: [],
  ownBrands: [],
  soldBrands: [],
  competitors: [],
  pmaxOwnedHeadTerms: [],
  namingConventionPattern: undefined,
  trackingNotes: {},
};

// ── DiskDriveReader (matches the integration test pattern) ────────────

interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
}

class DiskDriveReader implements IDriveReader {
  async findSubfolder(parentId: string, name: string): Promise<FakeFile | null> {
    const candidate = join(parentId, name);
    if (!existsSync(candidate) || !statSync(candidate).isDirectory()) return null;
    return {
      id: candidate, name, mimeType: FOLDER_MIME,
      modifiedTime: statSync(candidate).mtime.toISOString(),
    };
  }
  async listFiles(folderId: string): Promise<FakeFile[]> {
    return readdirSync(folderId)
      .filter(name => statSync(join(folderId, name)).isFile())
      .map(name => ({
        id: join(folderId, name),
        name,
        mimeType: name.endsWith('.csv') ? 'text/csv' : 'text/plain',
        modifiedTime: statSync(join(folderId, name)).mtime.toISOString(),
      }));
  }
  async readText(fileId: string): Promise<string> {
    return readFileSync(fileId, 'utf-8');
  }
}

// ── Pipeline ───────────────────────────────────────────────────────────

function loadProfile(): UpsertCustomerProfileInput {
  if (!PROFILE_PATH) return DEFAULT_PROFILE;
  if (!existsSync(PROFILE_PATH)) {
    console.error(`✗ LYNOX_ADS_DEV_PROFILE_PATH=${PROFILE_PATH} does not exist`);
    process.exit(1);
  }
  const overrides = JSON.parse(readFileSync(PROFILE_PATH, 'utf-8')) as Partial<UpsertCustomerProfileInput>;
  return { ...DEFAULT_PROFILE, ...overrides, customerId: CUSTOMER_ID };
}

async function main(): Promise<void> {
  if (!ARCHIVE_PATH) {
    console.error('✗ LYNOX_ADS_DEV_FIXTURE_PATH is required (point it at a directory holding the 21 ads CSVs).');
    process.exit(1);
  }
  if (!existsSync(ARCHIVE_PATH) || !existsSync(join(ARCHIVE_PATH, 'campaigns.csv'))) {
    console.error(`✗ Fixture not found at ${ARCHIVE_PATH} (campaigns.csv must be present).`);
    process.exit(1);
  }

  const profile = loadProfile();

  const tempDir = mkdtempSync(join(tmpdir(), 'lynox-ads-cycle-'));
  const driveRoot = join(tempDir, 'drive');
  const workspaceDir = join(tempDir, 'workspace');
  const accountDir = join(driveRoot, profile.customerId);
  const adsDir = join(accountDir, 'ads');
  const ga4Dir = join(accountDir, 'ga4');
  const gscDir = join(accountDir, 'gsc');

  mkdirSync(adsDir, { recursive: true });
  mkdirSync(ga4Dir, { recursive: true });
  mkdirSync(gscDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });

  let copied = 0;
  for (const f of readdirSync(ARCHIVE_PATH)) {
    if (f.endsWith('.csv')) {
      copyFileSync(join(ARCHIVE_PATH, f), join(adsDir, f));
      copied++;
    }
  }
  writeFileSync(join(adsDir, 'LASTRUN.txt'), new Date().toISOString());

  console.log(`Tempdir:        ${tempDir}`);
  console.log(`Drive root:     ${driveRoot}`);
  console.log(`Workspace:      ${workspaceDir}`);
  console.log(`Fixture copied: ${copied} CSVs from ${ARCHIVE_PATH}`);
  console.log(`Customer:       ${profile.clientName} (${profile.customerId})`);
  console.log(`Ads account:    ${ADS_ACCOUNT_ID}`);
  console.log('');

  const dbPath = join(tempDir, 'ads-optimizer.db');
  const store = new AdsDataStore(dbPath);

  store.upsertCustomerProfile(profile);
  store.upsertAdsAccount({
    adsAccountId: ADS_ACCOUNT_ID,
    customerId: profile.customerId,
    accountLabel: profile.customerId,
    currencyCode: 'CHF',
    timezone: profile.timezone ?? 'UTC',
    mode: 'BOOTSTRAP',
    driveFolderId: accountDir,
  });

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Cycle 1 — first run (BOOTSTRAP expected)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const reader = new DiskDriveReader();
  const pull1 = await runAdsDataPull(
    { store, reader },
    { ads_account_id: ADS_ACCOUNT_ID, drive_folder_id: accountDir },
  );
  console.log('');
  console.log(`▶ Pull #1: run_id=${pull1.runId} mode=${pull1.mode} totalRows=${pull1.totalRows} warnings=${pull1.totalWarnings}`);
  if (pull1.fatalErrors.length) console.log(`  fatal: ${pull1.fatalErrors.join('; ')}`);
  console.log(`  per-csv: ${pull1.perCsv.filter(c => c.status === 'inserted').length} inserted, ${pull1.perCsv.filter(c => c.status === 'missing').length} missing, ${pull1.perCsv.filter(c => c.status === 'failed').length} failed`);
  for (const c of pull1.perCsv.filter(c => c.status === 'failed')) {
    console.log(`    FAIL ${c.kind}/${c.file}: ${c.error}`);
  }
  for (const c of pull1.perCsv.filter(c => c.status === 'missing')) {
    console.log(`    MISS ${c.kind}/${c.file}`);
  }

  console.log('');
  console.log('▶ Audit #1');
  const audit1 = runAudit(store, ADS_ACCOUNT_ID);
  for (const f of audit1.findings) {
    store.insertFinding({
      runId: audit1.run.run_id, adsAccountId: ADS_ACCOUNT_ID,
      area: f.area, severity: f.severity, source: 'deterministic',
      text: f.text, confidence: f.confidence, evidence: f.evidence,
    });
  }
  console.log(renderAuditReport(audit1, audit1.findings.length));

  console.log('');
  console.log('▶ Blueprint #1');
  const blueprint1 = runBlueprint(store, ADS_ACCOUNT_ID);
  console.log(renderBlueprintReport(blueprint1));

  console.log('');
  console.log('▶ Emit #1');
  const emit1 = runEmit(store, ADS_ACCOUNT_ID, { workspaceDir });
  console.log(`  canEmit=${emit1.validation.canEmit} hard=${emit1.validation.hard.length} warn=${emit1.validation.warn.length}`);
  console.log(`  hash=${emit1.hash}`);
  console.log(`  idempotent=${emit1.idempotent} blockedReason=${emit1.blockedReason ?? '—'}`);
  console.log(`  files written: ${emit1.filesWritten.length}`);
  for (const fc of emit1.perFileRowCounts) {
    console.log(`    ${fc.rowCount.toString().padStart(5, ' ')} rows · ${fc.file}`);
  }
  console.log(`  totals: campaigns=${emit1.totals.campaigns} adGroups=${emit1.totals.adGroups} keywords=${emit1.totals.keywords} rsas=${emit1.totals.rsas} negatives=${emit1.totals.negatives}`);
  if (emit1.validation.hard.length) {
    console.log('  HARD validator issues:');
    for (const i of emit1.validation.hard.slice(0, 10)) {
      console.log(`    - [${i.area}] ${i.entityType}/${i.externalId}: ${i.message}`);
    }
    if (emit1.validation.hard.length > 10) console.log(`    … +${emit1.validation.hard.length - 10} more`);
  }

  console.log('');
  console.log('▶ Emit #1b (idempotency probe)');
  const emit1b = runEmit(store, ADS_ACCOUNT_ID, { workspaceDir });
  console.log(`  hash=${emit1b.hash}  same-as-#1=${emit1b.hash === emit1.hash}  idempotent=${emit1b.idempotent}`);

  store.close();
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('DONE.');
  console.log(`  inspect emitted CSVs: ls ${workspaceDir}/ads/${ADS_ACCOUNT_ID}/blueprints/`);
  console.log(`  inspect db:           sqlite3 ${dbPath} '.tables'`);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
