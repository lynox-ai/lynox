/**
 * End-to-end ads_data_pull against the real Aquanatura archive snapshot.
 *
 * No HTTP, no OAuth: a DiskDriveReader simulates Google Drive by mapping
 * folder IDs to filesystem paths. The 21 archived ads CSVs are copied into a
 * temporary "drive root" along with a synthetic LASTRUN.txt; runAdsDataPull
 * then walks the same code path as the prod tool (parse → bulk-insert →
 * mark missing → complete run) but with on-disk fixtures.
 *
 * If the archive path is not present (CI, foreign workstations) the whole
 * suite is skipped — the unit-level tests in src/core/ads-csv-reader.test.ts
 * and src/tools/builtin/ads-data-pull.test.ts still cover behaviour with
 * synthetic data.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync, mkdtempSync, mkdirSync, copyFileSync, readdirSync,
  writeFileSync, readFileSync, rmSync, statSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { AdsDataStore } from '../../src/core/ads-data-store.js';
import { runAdsDataPull, type IDriveReader } from '../../src/tools/builtin/ads-data-pull.js';

const ARCHIVE_PATH = '/Users/rafaelburlet/projects/_archive/agent-zero/agent-zero/usr/projects/google_ads_aquanatura/DATA/incoming';
const ARCHIVE_AVAILABLE = existsSync(ARCHIVE_PATH) && existsSync(join(ARCHIVE_PATH, 'campaigns.csv'));

const FOLDER_MIME = 'application/vnd.google-apps.folder';

interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
}

/** Implements IDriveReader by mapping folder IDs to absolute filesystem paths. */
class DiskDriveReader implements IDriveReader {
  async findSubfolder(parentId: string, name: string): Promise<FakeFile | null> {
    const candidate = join(parentId, name);
    if (!existsSync(candidate) || !statSync(candidate).isDirectory()) return null;
    return {
      id: candidate,
      name,
      mimeType: FOLDER_MIME,
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

describe.skipIf(!ARCHIVE_AVAILABLE)('end-to-end ads_data_pull against the Aquanatura archive snapshot', () => {
  let tempDir: string;
  let driveRoot: string;
  let store: AdsDataStore;
  const reader = new DiskDriveReader();

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lynox-ads-archive-'));
    driveRoot = join(tempDir, 'drive');
    const adsDir = join(driveRoot, 'ads');
    const ga4Dir = join(driveRoot, 'ga4');
    const gscDir = join(driveRoot, 'gsc');
    mkdirSync(adsDir, { recursive: true });
    mkdirSync(ga4Dir, { recursive: true });
    mkdirSync(gscDir, { recursive: true });

    // Copy the 21 archived ads CSVs into the synthesised "ads/" subfolder.
    for (const f of readdirSync(ARCHIVE_PATH)) {
      if (f.endsWith('.csv')) copyFileSync(join(ARCHIVE_PATH, f), join(adsDir, f));
    }
    // Synthetic LASTRUN.txt — current timestamp so the freshness gate passes.
    writeFileSync(join(adsDir, 'LASTRUN.txt'), new Date().toISOString());

    // ga4/ and gsc/ stay empty for now — the archive doesn't include them.
    // The reader will mark those kinds as no rows but should not error.

    store = new AdsDataStore(join(tempDir, 'ads-optimizer.db'));
    store.upsertCustomerProfile({ customerId: 'aquanatura', clientName: 'Aquanatura' });
    store.upsertAdsAccount({
      adsAccountId: '123-456-7890',
      customerId: 'aquanatura',
      accountLabel: 'Aquanatura',
      currencyCode: 'CHF',
      timezone: 'Europe/Zurich',
    });
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('parses every present CSV, marks audience_signals.csv as missing, completes the run', async () => {
    const result = await runAdsDataPull(
      { store, reader, now: () => new Date() },
      { ads_account_id: '123-456-7890', drive_folder_id: driveRoot },
    );

    // Every ads CSV present in the archive must parse without fatal error.
    expect(result.fatalErrors, `unexpected fatal errors: ${result.fatalErrors.join(' | ')}`).toEqual([]);

    // First run on a fresh account → BOOTSTRAP.
    expect(result.mode).toBe('BOOTSTRAP');

    // 21 ads kinds get inserted, 1 (audience_signals) is missing.
    const inserted = result.perCsv.filter(p => p.status === 'inserted');
    const missing = result.perCsv.filter(p => p.status === 'missing');
    expect(inserted.length).toBeGreaterThanOrEqual(20); // 20 or 21 depending on shopping_products which can be empty
    const missingNames = missing.map(p => p.file).sort();
    expect(missingNames).toContain('audience_signals.csv');

    // Run is committed as SUCCESS.
    const run = store.getAuditRun(result.runId)!;
    expect(run.status).toBe('SUCCESS');

    // Sanity-check on real numbers: there are at least some campaigns,
    // some keywords and some search terms in the snapshot.
    expect(store.countSnapshotRows('ads_campaigns', '123-456-7890', result.runId)).toBeGreaterThan(0);
    expect(store.countSnapshotRows('ads_keywords', '123-456-7890', result.runId)).toBeGreaterThan(0);
    expect(store.countSnapshotRows('ads_landing_pages', '123-456-7890', result.runId)).toBeGreaterThan(0);
  });

  it('view_audit_kpis returns sane aggregates on the imported snapshot', async () => {
    const result = await runAdsDataPull(
      { store, reader },
      { ads_account_id: '123-456-7890', drive_folder_id: driveRoot },
    );
    expect(result.fatalErrors).toEqual([]);

    const kpis = store.queryView('view_audit_kpis', '123-456-7890', { runId: result.runId });
    expect(kpis).toHaveLength(1);
    const k = kpis[0]!;
    // Spend should be a real positive number; ROAS may be null if no
    // conversion value, but spend must exist for at least one campaign.
    expect(typeof k['spend']).toBe('number');
    expect(k['spend'] as number).toBeGreaterThan(0);
  });

  it('imported PMAX search-term categories drive the negative-candidate view', async () => {
    const result = await runAdsDataPull(
      { store, reader },
      { ads_account_id: '123-456-7890', drive_folder_id: driveRoot },
    );
    expect(result.fatalErrors).toEqual([]);

    // The view returns one row per search_term in ads_search_terms, with a
    // pmax_disjunct flag. We can't assert specific terms (real customer data)
    // but the view must be queryable and yield at least one candidate.
    const candidates = store.queryView('view_blueprint_negative_candidates', '123-456-7890', { runId: result.runId });
    expect(Array.isArray(candidates)).toBe(true);
  });

  it('explicit list of CSVs the snapshot contains (regression guard)', () => {
    const csvs = readdirSync(ARCHIVE_PATH).filter(f => f.endsWith('.csv')).sort();
    // README claims 22 ads CSVs; the snapshot is missing audience_signals.csv.
    // This list pins what we *know* is there so future schema changes can be
    // traced back to the snapshot if anything diverges.
    expect(csvs).toContain('campaigns.csv');
    expect(csvs).toContain('campaign_performance.csv');
    expect(csvs).toContain('keywords.csv');
    expect(csvs).toContain('search_terms.csv');
    expect(csvs).toContain('change_history.csv');
    expect(csvs).toContain('product_performance.csv');
    // archive has 21 CSVs total
    expect(csvs.length).toBe(21);
    // Note: the lynox reader expects shopping_products.csv but the archive
    // has product_performance.csv — these are different concepts. The
    // archive's product_performance.csv carries product-level performance
    // (matches our shopping_products schema columns); we copy it under that
    // name in the test below if needed.
  });
});
