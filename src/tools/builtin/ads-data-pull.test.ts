import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdsDataStore } from '../../core/ads-data-store.js';
import { runAdsDataPull, type IDriveReader } from './ads-data-pull.js';

interface FakeFile { id: string; name: string; mimeType: string; modifiedTime: string; content?: string }

class FakeDrive implements IDriveReader {
  private folders = new Map<string, Map<string, FakeFile>>();

  setFolder(folderId: string, files: FakeFile[]): void {
    this.folders.set(folderId, new Map(files.map(f => [f.id, f])));
  }

  async findSubfolder(parentId: string, name: string): Promise<FakeFile | null> {
    const parent = this.folders.get(parentId);
    if (!parent) return null;
    for (const f of parent.values()) {
      if (f.name === name && f.mimeType === 'application/vnd.google-apps.folder') return f;
    }
    return null;
  }

  async listFiles(folderId: string): Promise<FakeFile[]> {
    return Array.from(this.folders.get(folderId)?.values() ?? [])
      .filter(f => f.mimeType !== 'application/vnd.google-apps.folder');
  }

  async readText(fileId: string): Promise<string> {
    for (const folder of this.folders.values()) {
      const f = folder.get(fileId);
      if (f) return f.content ?? '';
    }
    throw new Error(`File not found: ${fileId}`);
  }
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';

function makeFolder(id: string, name: string): FakeFile {
  return { id, name, mimeType: FOLDER_MIME, modifiedTime: '2026-04-27T10:00:00Z' };
}
function makeFile(id: string, name: string, content: string): FakeFile {
  return { id, name, mimeType: 'text/csv', modifiedTime: '2026-04-27T10:00:00Z', content };
}

describe('runAdsDataPull — happy path', () => {
  let tempDir: string;
  let store: AdsDataStore;
  let drive: FakeDrive;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-ads-pull-'));
    store = new AdsDataStore(join(tempDir, 'ads-optimizer.db'));
    store.upsertCustomerProfile({ customerId: 'aquanatura', clientName: 'Aquanatura' });
    store.upsertAdsAccount({
      adsAccountId: '123-456-7890', customerId: 'aquanatura', accountLabel: 'A1',
    });
    drive = new FakeDrive();
  });

  afterEach(async () => {
    store.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('imports campaigns, search_terms, GA4 and GSC, completes the run', async () => {
    drive.setFolder('root', [
      makeFolder('ads-folder', 'ads'),
      makeFolder('ga4-folder', 'ga4'),
      makeFolder('gsc-folder', 'gsc'),
    ]);
    drive.setFolder('ads-folder', [
      makeFile('lr', 'LASTRUN.txt', '2026-04-27T10:00:00Z'),
      makeFile('c', 'campaigns.csv',
        'campaign_id,campaign_name,cost_micros,conversions\n' +
        '18132,X,500000000,12\n' +
        '18133,Y,200000000,5\n'),
      makeFile('st', 'search_terms.csv',
        'search_term,impressions,clicks,cost_micros\n' +
        'wasserfilter,1000,50,10000000\n'),
    ]);
    drive.setFolder('ga4-folder', [
      makeFile('g4', 'ga4_2026-04.csv',
        'date,session_source,session_medium,sessions,conversions\n' +
        '2026-04-01,google,cpc,1200,18\n'),
    ]);
    drive.setFolder('gsc-folder', [
      makeFile('gs', 'gsc_2026-04.csv',
        'date_month,query,clicks,impressions,position\n' +
        '2026-04,wasseraufbereitung,120,4500,6.2\n'),
    ]);

    const result = await runAdsDataPull(
      { store, reader: drive, now: () => new Date('2026-04-27T11:00:00Z') },
      { ads_account_id: '123-456-7890', drive_folder_id: 'root' },
    );

    expect(result.fatalErrors).toEqual([]);
    expect(result.mode).toBe('BOOTSTRAP'); // no prior run
    expect(result.totalRows).toBe(5); // 2 campaigns + 1 search term + 1 GA4 + 1 GSC
    const inserted = result.perCsv.filter(p => p.status === 'inserted');
    expect(inserted.map(p => p.kind)).toEqual(expect.arrayContaining([
      'campaigns', 'search_terms', 'ga4', 'gsc',
    ]));

    // Run is now SUCCESS
    const run = store.getAuditRun(result.runId)!;
    expect(run.status).toBe('SUCCESS');
    expect(run.gas_export_lastrun).toBe('2026-04-27T10:00:00.000Z');

    // Snapshot persisted
    expect(store.countSnapshotRows('ads_campaigns', '123-456-7890', result.runId)).toBe(2);
    expect(store.countSnapshotRows('ads_search_terms', '123-456-7890', result.runId)).toBe(1);
    expect(store.countSnapshotRows('ga4_observations', '123-456-7890', result.runId)).toBe(1);
    expect(store.countSnapshotRows('gsc_observations', '123-456-7890', result.runId)).toBe(1);
  });

  it('uses OPTIMIZE mode when a prior successful run exists', async () => {
    // Bootstrap run first
    drive.setFolder('root', [makeFolder('ads', 'ads')]);
    drive.setFolder('ads', [
      makeFile('lr', 'LASTRUN.txt', '2026-04-27T10:00:00Z'),
      makeFile('c', 'campaigns.csv', 'campaign_id,campaign_name\nc1,X\n'),
    ]);
    const r1 = await runAdsDataPull(
      { store, reader: drive, now: () => new Date('2026-04-27T11:00:00Z') },
      { ads_account_id: '123-456-7890', drive_folder_id: 'root' },
    );
    expect(r1.mode).toBe('BOOTSTRAP');

    // Second run picks up the previous one
    const r2 = await runAdsDataPull(
      { store, reader: drive, now: () => new Date('2026-04-27T12:00:00Z') },
      { ads_account_id: '123-456-7890', drive_folder_id: 'root' },
    );
    expect(r2.mode).toBe('OPTIMIZE');
    const run2 = store.getAuditRun(r2.runId)!;
    expect(run2.previous_run_id).toBe(r1.runId);
  });

  it('marks missing CSVs without aborting', async () => {
    drive.setFolder('root', [makeFolder('ads', 'ads')]);
    drive.setFolder('ads', [
      makeFile('lr', 'LASTRUN.txt', '2026-04-27T10:00:00Z'),
      makeFile('c', 'campaigns.csv', 'campaign_id,campaign_name\nc1,X\n'),
      // 20 other ads files are absent
    ]);
    const result = await runAdsDataPull(
      { store, reader: drive, now: () => new Date('2026-04-27T11:00:00Z') },
      { ads_account_id: '123-456-7890', drive_folder_id: 'root' },
    );
    expect(result.fatalErrors).toEqual([]);
    expect(result.perCsv.filter(p => p.status === 'missing').length).toBeGreaterThan(15);
    expect(store.getAuditRun(result.runId)?.status).toBe('SUCCESS');
  });

  it('records failed CSVs and fails the run cleanly', async () => {
    drive.setFolder('root', [makeFolder('ads', 'ads')]);
    drive.setFolder('ads', [
      makeFile('lr', 'LASTRUN.txt', '2026-04-27T10:00:00Z'),
      // campaigns.csv missing required column → ParseError → fatal
      makeFile('c', 'campaigns.csv', 'wrong_column\nfoo\n'),
    ]);
    const result = await runAdsDataPull(
      { store, reader: drive, now: () => new Date('2026-04-27T11:00:00Z') },
      { ads_account_id: '123-456-7890', drive_folder_id: 'root' },
    );
    expect(result.fatalErrors.length).toBeGreaterThan(0);
    expect(result.fatalErrors[0]).toMatch(/Missing required column/);
    expect(store.getAuditRun(result.runId)?.status).toBe('FAILED');
  });
});

describe('runAdsDataPull — freshness check', () => {
  let tempDir: string;
  let store: AdsDataStore;
  let drive: FakeDrive;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-ads-fresh-'));
    store = new AdsDataStore(join(tempDir, 'ads-optimizer.db'));
    store.upsertCustomerProfile({ customerId: 'c', clientName: 'C' });
    store.upsertAdsAccount({ adsAccountId: 'a1', customerId: 'c', accountLabel: 'A' });
    drive = new FakeDrive();
  });

  afterEach(async () => {
    store.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('throws when LASTRUN is older than 14 days', async () => {
    drive.setFolder('root', [makeFolder('ads', 'ads')]);
    drive.setFolder('ads', [makeFile('lr', 'LASTRUN.txt', '2026-04-01T00:00:00Z')]);
    await expect(runAdsDataPull(
      { store, reader: drive, now: () => new Date('2026-04-27T11:00:00Z') }, // 26 days later
      { ads_account_id: 'a1', drive_folder_id: 'root' },
    )).rejects.toThrow(/stale/);
  });

  it('force=true overrides the freshness limit', async () => {
    drive.setFolder('root', [makeFolder('ads', 'ads')]);
    drive.setFolder('ads', [
      makeFile('lr', 'LASTRUN.txt', '2026-04-01T00:00:00Z'),
      makeFile('c', 'campaigns.csv', 'campaign_id,campaign_name\nc1,X\n'),
    ]);
    const result = await runAdsDataPull(
      { store, reader: drive, now: () => new Date('2026-04-27T11:00:00Z'), },
      { ads_account_id: 'a1', drive_folder_id: 'root', force: true },
    );
    expect(result.fatalErrors).toEqual([]);
  });

  it('throws when LASTRUN is missing and force is not set', async () => {
    drive.setFolder('root', [makeFolder('ads', 'ads')]);
    drive.setFolder('ads', [makeFile('c', 'campaigns.csv', 'campaign_id,campaign_name\nc1,X\n')]);
    await expect(runAdsDataPull(
      { store, reader: drive },
      { ads_account_id: 'a1', drive_folder_id: 'root' },
    )).rejects.toThrow(/no LASTRUN/);
  });

  it('throws when ads/ subfolder is missing', async () => {
    drive.setFolder('root', []); // no ads folder
    await expect(runAdsDataPull(
      { store, reader: drive },
      { ads_account_id: 'a1', drive_folder_id: 'root' },
    )).rejects.toThrow(/no "ads" subfolder/);
  });
});

describe('runAdsDataPull — GA4/GSC monthly filtering', () => {
  let tempDir: string;
  let store: AdsDataStore;
  let drive: FakeDrive;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-ads-monthly-'));
    store = new AdsDataStore(join(tempDir, 'ads-optimizer.db'));
    store.upsertCustomerProfile({ customerId: 'c', clientName: 'C' });
    store.upsertAdsAccount({ adsAccountId: 'a1', customerId: 'c', accountLabel: 'A' });
    drive = new FakeDrive();
  });

  afterEach(async () => {
    store.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('imports multiple ga4_YYYY-MM.csv files and skips other names', async () => {
    drive.setFolder('root', [
      makeFolder('ads', 'ads'),
      makeFolder('ga4', 'ga4'),
    ]);
    drive.setFolder('ads', [
      makeFile('lr', 'LASTRUN.txt', '2026-04-27T10:00:00Z'),
    ]);
    drive.setFolder('ga4', [
      makeFile('g1', 'ga4_2026-03.csv', 'date,sessions\n2026-03-01,500\n'),
      makeFile('g2', 'ga4_2026-04.csv', 'date,sessions\n2026-04-01,800\n'),
      makeFile('g3', 'ga4_summary.csv', 'date,sessions\n2026-04-01,999\n'), // wrong shape — skipped
    ]);
    const result = await runAdsDataPull(
      { store, reader: drive, now: () => new Date('2026-04-27T11:00:00Z') },
      { ads_account_id: 'a1', drive_folder_id: 'root' },
    );
    const ga4Inserts = result.perCsv.filter(p => p.kind === 'ga4' && p.status === 'inserted');
    expect(ga4Inserts.map(p => p.file)).toEqual(['ga4_2026-03.csv', 'ga4_2026-04.csv']);
    expect(store.countSnapshotRows('ga4_observations', 'a1', result.runId)).toBe(2);
  });
});
