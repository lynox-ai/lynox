import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdsDataStore } from '../../core/ads-data-store.js';
import { createAdsMarkImportedTool } from './ads-mark-imported.js';
import type { IAgent } from '../../types/index.js';

const ACCOUNT = '123-456-7890';
const CUSTOMER = 'acme-shop';
const fakeAgent = {} as unknown as IAgent;

describe('ads_mark_imported tool', () => {
  let tempDir: string;
  let store: AdsDataStore;
  let tool: ReturnType<typeof createAdsMarkImportedTool>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-mark-imported-'));
    store = new AdsDataStore(join(tempDir, 'ads-optimizer.db'));
    tool = createAdsMarkImportedTool(store);
    store.upsertCustomerProfile({ customerId: CUSTOMER, clientName: 'Acme' });
    store.upsertAdsAccount({ adsAccountId: ACCOUNT, customerId: CUSTOMER, accountLabel: 'Main' });
  });

  afterEach(async () => {
    store.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns an error for unknown account', async () => {
    const out = await tool.handler({ ads_account_id: 'no-such' }, fakeAgent);
    expect(out).toMatch(/unknown ads_account_id/);
  });

  it('stamps current time when imported_at is omitted', async () => {
    const before = Date.now();
    const out = await tool.handler({ ads_account_id: ACCOUNT }, fakeAgent);
    const after = Date.now();
    expect(out).toMatch(/Editor-Import vermerkt/);
    const stamped = store.getAdsAccount(ACCOUNT)!.last_major_import_at;
    expect(stamped).not.toBeNull();
    const t = new Date(stamped!).getTime();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after + 5);
  });

  it('accepts a backdated ISO timestamp', async () => {
    const past = '2026-04-01T12:00:00Z';
    const expectedNormalised = '2026-04-01T12:00:00.000Z';
    const out = await tool.handler({ ads_account_id: ACCOUNT, imported_at: past }, fakeAgent);
    expect(out).toContain(expectedNormalised);
    expect(store.getAdsAccount(ACCOUNT)!.last_major_import_at).toBe(expectedNormalised);
  });

  it('rejects an invalid timestamp', async () => {
    const out = await tool.handler({ ads_account_id: ACCOUNT, imported_at: 'not-a-date' }, fakeAgent);
    expect(out).toMatch(/not a valid ISO 8601 timestamp/);
    expect(store.getAdsAccount(ACCOUNT)!.last_major_import_at).toBeNull();
  });

  it('idempotent re-stamping is fine (overwrites previous)', async () => {
    await tool.handler({ ads_account_id: ACCOUNT, imported_at: '2026-04-01T00:00:00Z' }, fakeAgent);
    await tool.handler({ ads_account_id: ACCOUNT, imported_at: '2026-04-15T00:00:00Z' }, fakeAgent);
    expect(store.getAdsAccount(ACCOUNT)!.last_major_import_at).toBe('2026-04-15T00:00:00.000Z');
  });
});
