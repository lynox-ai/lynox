import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdsDataStore } from './ads-data-store.js';
import { runBlueprint, BlueprintPreconditionError } from './ads-blueprint-engine.js';

const ACCOUNT = '123-456-7890';
const CUSTOMER = 'acme-shop';

describe('runBlueprint', () => {
  let tempDir: string;
  let store: AdsDataStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-blueprint-test-'));
    store = new AdsDataStore(join(tempDir, 'ads-optimizer.db'));
  });

  afterEach(async () => {
    store.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('throws when account is unknown', () => {
    expect(() => runBlueprint(store, 'no-such')).toThrow(BlueprintPreconditionError);
  });

  it('throws when no successful audit run exists', () => {
    seedCustomerAndAccount(store);
    store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    // Run is RUNNING, not SUCCESS.
    expect(() => runBlueprint(store, ACCOUNT)).toThrow(BlueprintPreconditionError);
  });

  it('throws when customer profile is missing', () => {
    store.upsertCustomerProfile({ customerId: CUSTOMER, clientName: 'Acme' });
    store.upsertAdsAccount({ adsAccountId: ACCOUNT, customerId: CUSTOMER, accountLabel: 'Main' });
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);
    // Drop profile to simulate missing-profile path. Disabling FKs is
    // intentional here for this fixture only.
    type RawDb = { db?: { prepare(sql: string): { run(...args: unknown[]): unknown }; pragma(s: string): unknown } };
    const raw = store as unknown as RawDb;
    raw.db?.pragma('foreign_keys = OFF');
    raw.db?.prepare('DELETE FROM customer_profiles WHERE customer_id = ?').run(CUSTOMER);
    raw.db?.pragma('foreign_keys = ON');

    expect(() => runBlueprint(store, ACCOUNT)).toThrow(/Customer profile missing/);
  });

  it('runs in BOOTSTRAP mode for first cycle: every snapshot entity becomes KEEP', () => {
    seedCustomerAndAccount(store);
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);
    seedCampaign(store, r.run_id, 'c1', 'DE-Search-Brand-Exact');
    seedCampaign(store, r.run_id, 'c2', 'DE-Search-Generic-Phrase');

    const result = runBlueprint(store, ACCOUNT);
    expect(result.mode).toBe('BOOTSTRAP');
    expect(result.previousRun).toBeNull();
    const campaigns = result.historyByType.get('campaign')!;
    expect(campaigns).toHaveLength(2);
    expect(campaigns.every(d => d.kind === 'KEEP')).toBe(true);
    // Persisted to ads_blueprint_entities + ads_run_decisions.
    expect(store.listBlueprintEntities(r.run_id, { entityType: 'campaign' })).toHaveLength(2);
    expect(store.getRunDecisions(r.run_id, { entityType: 'campaign' })).toHaveLength(2);
  });

  it('throws BlueprintPendingImportNotice when previous run has unimported entities', async () => {
    const { BlueprintPendingImportNotice } = await import('./ads-blueprint-engine.js');
    seedCustomerAndAccount(store, { competitors: ['Bosch', 'Dewalt'] });
    const r1 = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r1.run_id);
    seedCampaign(store, r1.run_id, 'c1', 'DE-Search-Brand-Exact');
    // First blueprint inserts KEEP + 2 NEW competitor negatives — pending > 0.
    runBlueprint(store, ACCOUNT);

    const r2 = store.createAuditRun({
      adsAccountId: ACCOUNT, mode: 'OPTIMIZE', previousRunId: r1.run_id,
    });
    store.completeAuditRun(r2.run_id);
    seedCampaign(store, r2.run_id, 'c1', 'DE-Search-Brand-Exact');
    seedPerformanceDays(store, r2.run_id, 'c1', 30);

    // No import recorded → pending guard must trigger.
    expect(() => runBlueprint(store, ACCOUNT)).toThrow(BlueprintPendingImportNotice);
  });

  it('skips pending guard once a major import is recorded after the previous blueprint', () => {
    seedCustomerAndAccount(store, { competitors: ['Bosch', 'Dewalt'] });
    const r1 = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r1.run_id);
    seedCampaign(store, r1.run_id, 'c1', 'DE-Search-Brand-Exact');
    runBlueprint(store, ACCOUNT);

    // Record import strictly after run #1's finished_at.
    store.recordMajorImport(ACCOUNT, new Date(Date.now() + 1000).toISOString());

    const r2 = store.createAuditRun({
      adsAccountId: ACCOUNT, mode: 'OPTIMIZE', previousRunId: r1.run_id,
    });
    store.completeAuditRun(r2.run_id);
    seedCampaign(store, r2.run_id, 'c1', 'DE-Search-Brand-Exact');
    seedPerformanceDays(store, r2.run_id, 'c1', 30);

    expect(() => runBlueprint(store, ACCOUNT)).not.toThrow();
  });

  it('runs in OPTIMIZE mode: history-match across runs', () => {
    seedCustomerAndAccount(store);
    const r1 = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r1.run_id);
    seedCampaign(store, r1.run_id, 'c1', 'DE-Search-Brand-Exact');
    seedCampaign(store, r1.run_id, 'c2', 'DE-Search-Generic-Phrase');

    const r2 = store.createAuditRun({
      adsAccountId: ACCOUNT, mode: 'OPTIMIZE', previousRunId: r1.run_id,
    });
    store.completeAuditRun(r2.run_id);
    seedCampaign(store, r2.run_id, 'c1', 'DE-Search-Brand-Exact');           // KEEP
    seedCampaign(store, r2.run_id, 'c3', 'DE-Search-Awareness-Phrase');       // NEW
    // c2 absent → PAUSE
    // pickMode requires ≥ 30 perf-days on the current run to clear OPTIMIZE.
    seedPerformanceDays(store, r2.run_id, 'c1', 30);

    const result = runBlueprint(store, ACCOUNT);
    expect(result.mode).toBe('OPTIMIZE');
    const campaigns = result.historyByType.get('campaign')!;
    const kinds = campaigns.map(d => d.kind).sort();
    expect(kinds).toEqual(['KEEP', 'NEW', 'PAUSE']);
  });

  it('flags naming-convention violations on KEEP entities', () => {
    seedCustomerAndAccount(store, { naming: '{LANG}-{CHANNEL}-{THEME}-{MATCHTYPE}' });
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);
    seedCampaign(store, r.run_id, 'c1', 'DE-Search-Brand-Exact');               // valid
    seedCampaign(store, r.run_id, 'c2', 'just_some_random_name');               // invalid

    const result = runBlueprint(store, ACCOUNT);
    expect(result.namingViolations).toHaveLength(1);
    expect(result.namingViolations[0]?.externalId).toBe('c2');
    // The naming-error column on the bad blueprint row reflects this.
    const stored = store.listBlueprintEntities(r.run_id, { entityType: 'campaign' });
    const c2Row = stored.find(s => s.external_id === 'c2');
    expect(c2Row?.naming_valid).toBe(0);
    expect(JSON.parse(c2Row!.naming_errors_json).length).toBeGreaterThan(0);
  });

  it('does not enforce naming convention on keywords', () => {
    seedCustomerAndAccount(store, { naming: '{LANG}-{CHANNEL}-{THEME}-{MATCHTYPE}' });
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);
    store.insertKeywordsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [
        { keyword: 'beste schraubenzieher', matchType: 'PHRASE', campaignName: 'C', adGroupName: 'AG' },
      ],
    });
    const result = runBlueprint(store, ACCOUNT);
    expect(result.namingViolations.find(v => v.entityType === 'keyword')).toBeUndefined();
  });

  it('persists generated negatives as NEW entity_type=negative rows', () => {
    seedCustomerAndAccount(store, {
      pmaxOwned: ['drills', 'sanders'],
      competitors: ['BoschTools'],
      goal: 'roas',
    });
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);

    const result = runBlueprint(store, ACCOUNT);
    expect(result.negatives.length).toBeGreaterThan(0);
    const negativeRows = store.listBlueprintEntities(r.run_id, { entityType: 'negative' });
    expect(negativeRows.length).toBe(result.negatives.length);
    expect(negativeRows.every(n => n.kind === 'NEW')).toBe(true);
  });

  it('counts KEEP/NEW/PAUSE/RENAME correctly via store.countBlueprintEntities', () => {
    seedCustomerAndAccount(store);
    const r1 = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r1.run_id);
    seedCampaign(store, r1.run_id, 'c1', 'DE-Search-Brand-Exact');

    const r2 = store.createAuditRun({
      adsAccountId: ACCOUNT, mode: 'OPTIMIZE', previousRunId: r1.run_id,
    });
    store.completeAuditRun(r2.run_id);
    seedCampaign(store, r2.run_id, 'c1', 'DE-Search-Brand-Exact');            // KEEP
    seedCampaign(store, r2.run_id, 'c2', 'DE-Search-Generic-Exact');          // NEW
    seedPerformanceDays(store, r2.run_id, 'c1', 30);

    const result = runBlueprint(store, ACCOUNT);
    expect(result.counts.KEEP).toBe(1);
    expect(result.counts.NEW).toBe(1);
    // No others yet.
    expect(result.counts.PAUSE).toBe(0);
    expect(result.counts.RENAME).toBe(0);
  });

  it('surfaces low-strength asset groups in result', () => {
    seedCustomerAndAccount(store);
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);
    store.insertAssetGroupsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [
        { assetGroupId: 'ag1', assetGroupName: 'Strong', adStrength: 'EXCELLENT', costMicros: 50_000_000 },
        { assetGroupId: 'ag2', assetGroupName: 'Weak', adStrength: 'POOR', costMicros: 30_000_000 },
      ],
    });
    const result = runBlueprint(store, ACCOUNT);
    expect(result.lowStrengthAssetGroups.map(a => a.externalId)).toEqual(['ag2']);
  });

  it('writes ads_run_decisions parallel to ads_blueprint_entities', () => {
    seedCustomerAndAccount(store);
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);
    seedCampaign(store, r.run_id, 'c1', 'DE-Search-Brand-Exact');

    runBlueprint(store, ACCOUNT);
    const decisions = store.getRunDecisions(r.run_id);
    expect(decisions).toHaveLength(1); // 1 campaign, no negatives (no profile pmax_owned)
    expect(decisions[0]?.entity_external_id).toBe('c1');
    expect(decisions[0]?.decision).toBe('KEEP');
  });

  it('emits Brand-Search-Campaign + ad_groups + keywords + cross-channel negatives from brand-inflation finding', () => {
    seedCustomerAndAccount(store, { pmaxOwned: ['aquanatura', 'maunawai'] });
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);
    seedCampaign(store, r.run_id, 'pmax1', 'PMax | Gesamtsortiment', { channelType: 'PERFORMANCE_MAX' });
    seedCampaign(store, r.run_id, 'pmax2', 'PMax | Wasserfilter', { channelType: 'PERFORMANCE_MAX' });
    // Synthetic brand-inflation finding mirrors what audit produces.
    store.insertFinding({
      runId: r.run_id, adsAccountId: ACCOUNT,
      area: 'pmax_brand_inflation', severity: 'HIGH', source: 'deterministic',
      text: 'PMax bedient Brand-Cluster …', confidence: 0.9,
      evidence: {
        branded_clusters: 15, total_pmax_clusters: 600, share_pct: 2,
        brand_tokens: ['aquanatura', 'maunawai'],
        suggested_defaults: { dailyBudgetChf: 22, targetCpaChf: 9 },
      },
    });

    runBlueprint(store, ACCOUNT);

    const newCampaigns = store.listBlueprintEntities(r.run_id, { entityType: 'campaign', kind: 'NEW' });
    expect(newCampaigns).toHaveLength(1);
    expect(newCampaigns[0]!.external_id).toBe('bp.campaign.search-brand');
    const campPayload = JSON.parse(newCampaigns[0]!.payload_json) as Record<string, unknown>;
    expect(campPayload['campaign_name']).toBe('Search | Brand');
    expect(campPayload['channel_type']).toBe('SEARCH');
    expect(campPayload['budget_chf']).toBe(22);
    expect(campPayload['target_cpa_chf']).toBe(9);

    const adGroups = store.listBlueprintEntities(r.run_id, { entityType: 'ad_group', kind: 'NEW' });
    expect(adGroups).toHaveLength(2);
    const agNames = adGroups.map(a => JSON.parse(a.payload_json).ad_group_name as string).sort();
    expect(agNames).toEqual(['Brand-Aquanatura', 'Brand-Maunawai']);

    const keywords = store.listBlueprintEntities(r.run_id, { entityType: 'keyword', kind: 'NEW' });
    // 2 brands × 2 match types (Phrase + Exact) = 4 keywords.
    expect(keywords).toHaveLength(4);
    const matchTypes = keywords.map(k => JSON.parse(k.payload_json).match_type as string).sort();
    expect(matchTypes).toEqual(['Exact', 'Exact', 'Phrase', 'Phrase']);

    // Cross-channel negatives: 2 brands × 2 PMax campaigns = 4 entries.
    const negatives = store.listBlueprintEntities(r.run_id, { entityType: 'negative' })
      .map(n => JSON.parse(n.payload_json) as Record<string, unknown>)
      .filter(p => p['source'] === 'brand_inflation_block');
    expect(negatives).toHaveLength(4);
    const negTargets = new Set(negatives.map(n => n['scope_target']));
    expect(negTargets).toEqual(new Set(['PMax | Gesamtsortiment', 'PMax | Wasserfilter']));

    // Brand-Search must use MAXIMIZE_CONVERSIONS — Editor blocks
    // standalone TARGET_CPA on new Search campaigns (deprecated).
    expect(campPayload['bidding_strategy_type']).toBe('MAXIMIZE_CONVERSIONS');

    // Each Brand-Search ad-group must ship with an RSA — without it
    // Editor warns "Anzeigengruppe enthält keine aktivierten Anzeigen"
    // and the ad-group can't serve.
    const rsas = store.listBlueprintEntities(r.run_id, { entityType: 'rsa_ad', kind: 'NEW' });
    expect(rsas).toHaveLength(2);
    const rsaPayloads = rsas.map(r => JSON.parse(r.payload_json) as Record<string, unknown>);
    expect(new Set(rsaPayloads.map(p => p['ad_group_name']))).toEqual(
      new Set(['Brand-Aquanatura', 'Brand-Maunawai']),
    );
    for (const p of rsaPayloads) {
      const headlines = p['headlines'] as string[];
      const descriptions = p['descriptions'] as string[];
      expect(headlines.length).toBeGreaterThanOrEqual(3);
      expect(descriptions.length).toBeGreaterThanOrEqual(2);
      expect(p['final_url']).toMatch(/^https?:\/\//);
      for (const h of headlines) expect(h.length).toBeLessThanOrEqual(30);
      for (const d of descriptions) expect(d.length).toBeLessThanOrEqual(90);
    }
  });

  it('Theme-expansion AGs ship with HEADLINE + LONG_HEADLINE + DESCRIPTION placeholder assets', () => {
    seedCustomerAndAccount(store);
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);
    seedCampaign(store, r.run_id, 'pmax1', 'PMax | Gesamtsortiment', { channelType: 'PERFORMANCE_MAX' });
    // Synthetic theme-coverage finding mirrors what audit produces. Three
    // strong themes is the minimum for the expansion path to fire.
    store.insertFinding({
      runId: r.run_id, adsAccountId: ACCOUNT,
      area: 'pmax_theme_coverage_gap', severity: 'MEDIUM', source: 'deterministic',
      text: 'PMax-Themen ohne AG …', confidence: 0.75,
      evidence: {
        themes: [
          { token: 'kefir', clusters: 32, sample: ['kefir milch', 'kefir set'] },
          { token: 'kombucha', clusters: 24, sample: ['kombucha kaufen'] },
          { token: 'glas', clusters: 12, sample: ['glasflasche'] },
        ],
        existing_asset_groups: [],
      },
    });

    runBlueprint(store, ACCOUNT);

    // Each theme-AG must have at least 1 LONG_HEADLINE — PMax requires it
    // and Editor blocks the AG without one ("Fügen Sie mindestens 1 langen
    // Anzeigentitel hinzu").
    const newAssets = store.listBlueprintEntities(r.run_id, { entityType: 'asset', kind: 'NEW' })
      .map(a => JSON.parse(a.payload_json) as Record<string, unknown>);
    const longHeadlines = newAssets.filter(a => a['field_type'] === 'LONG_HEADLINE');
    const headlines = newAssets.filter(a => a['field_type'] === 'HEADLINE');
    const descriptions = newAssets.filter(a => a['field_type'] === 'DESCRIPTION');
    // Three theme-AGs × ≥1 long headline.
    expect(longHeadlines.length).toBeGreaterThanOrEqual(3);
    expect(headlines.length).toBeGreaterThanOrEqual(9); // ≥3 short headlines per AG
    expect(descriptions.length).toBeGreaterThanOrEqual(6);
    // Length caps must hold: HEADLINE ≤ 30, LONG_HEADLINE/DESCRIPTION ≤ 90.
    for (const h of headlines) expect((h['text'] as string).length).toBeLessThanOrEqual(30);
    for (const lh of longHeadlines) expect((lh['text'] as string).length).toBeLessThanOrEqual(90);
    for (const d of descriptions) expect((d['text'] as string).length).toBeLessThanOrEqual(90);
  });

  it('Strategist-brief hold_themes is a hard constraint: matching theme-AGs are not generated', () => {
    // Reproduces AquaNatura cycle 14: brief said "do not build keramik and
    // selber yet" but blueprint built them anyway. With the hold_themes
    // hard-constraint, those theme-AGs never make it into the run; a
    // tracking finding `theme_held_by_strategist_brief` is persisted so
    // the operator sees what was suppressed.
    seedCustomerAndAccount(store);
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);
    seedCampaign(store, r.run_id, 'pmax1', 'PMax | Gesamtsortiment', { channelType: 'PERFORMANCE_MAX' });
    store.insertFinding({
      runId: r.run_id, adsAccountId: ACCOUNT,
      area: 'pmax_theme_coverage_gap', severity: 'MEDIUM', source: 'deterministic',
      text: 'PMax-Themen ohne AG …', confidence: 0.75,
      evidence: {
        // All three themes are 'actionable' so the uncertain default-deny
        // doesn't fire; the only reason keramik + selber are skipped is
        // because the strategist brief lists them in hold_themes.
        themes: [
          { token: 'glas', clusters: 29, sample: ['glasflasche'], category: 'actionable' },
          { token: 'keramik', clusters: 15, sample: ['keramik'], category: 'actionable' },
          { token: 'selber', clusters: 11, sample: ['selber bauen'], category: 'actionable' },
        ],
        existing_asset_groups: [],
      },
    });
    // Brief explicitly holds keramik + selber.
    store.insertStrategistBrief({
      runId: r.run_id, adsAccountId: ACCOUNT, accountState: 'bootstrap',
      headline: 'Bootstrap with intent gaps on keramik / selber',
      priorities: [], risks: [], doNotTouch: [],
      classificationReason: 'first run', llmFailed: false,
      holdThemes: ['keramik', 'selber'],
    });

    runBlueprint(store, ACCOUNT);

    const themeAgs = store.listBlueprintEntities(r.run_id, { entityType: 'asset_group', kind: 'NEW' })
      .map(e => JSON.parse(e.payload_json) as Record<string, unknown>);
    const tokens = themeAgs.map(p => (p['theme_token'] as string | undefined)?.toLowerCase()).filter(Boolean);
    expect(tokens).toContain('glas');
    expect(tokens).not.toContain('keramik');
    expect(tokens).not.toContain('selber');

    // The held themes are surfaced as a deterministic finding for traceability.
    const heldFindings = store.listFindings(r.run_id, { area: 'theme_held_by_strategist_brief' });
    expect(heldFindings).toHaveLength(1);
    const evidence = JSON.parse(heldFindings[0]!.evidence_json) as { held_themes: string[] };
    expect(evidence.held_themes.sort()).toEqual(['keramik', 'selber']);
  });

  it('hold_themes is case-insensitive and tolerates legacy briefs without the column', () => {
    seedCustomerAndAccount(store);
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);
    seedCampaign(store, r.run_id, 'pmax1', 'PMax | Gesamtsortiment', { channelType: 'PERFORMANCE_MAX' });
    store.insertFinding({
      runId: r.run_id, adsAccountId: ACCOUNT,
      area: 'pmax_theme_coverage_gap', severity: 'MEDIUM', source: 'deterministic',
      text: 'themes', confidence: 0.75,
      evidence: { themes: [
        { token: 'KERAMIK', clusters: 15, sample: [] },
        { token: 'GLAS', clusters: 29, sample: [] },
      ] },
    });
    // Brief lists hold-token in mixed case — must still match.
    store.insertStrategistBrief({
      runId: r.run_id, adsAccountId: ACCOUNT, accountState: 'bootstrap',
      headline: 'h', priorities: [], risks: [], doNotTouch: [],
      classificationReason: '', llmFailed: false, holdThemes: ['Keramik'],
    });
    runBlueprint(store, ACCOUNT);
    const tokens = store.listBlueprintEntities(r.run_id, { entityType: 'asset_group', kind: 'NEW' })
      .map(e => (JSON.parse(e.payload_json) as { theme_token?: string }).theme_token?.toLowerCase());
    expect(tokens).toContain('glas');
    expect(tokens).not.toContain('keramik');
  });

  it('Brand-RSA: 2 brand tokens + 5 LPs without slug match → needs_review marker on each RSA, emit blocks', async () => {
    seedCustomerAndAccount(store, { pmaxOwned: ['hamoni', 'maunawai'] });
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);
    seedCampaign(store, r.run_id, 'pmax1', 'PMax | Gesamtsortiment', { channelType: 'PERFORMANCE_MAX' });
    // Five LPs, none of whose URLs contain the brand token in the slug —
    // the URL picker must mark every Brand-RSA for operator review.
    store.insertLandingPagesBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [
        { landingPageUrl: 'https://acme-shop.example/wasser', clicks: 200, conversions: 6 },
        { landingPageUrl: 'https://acme-shop.example/luft',   clicks: 150, conversions: 4 },
        { landingPageUrl: 'https://acme-shop.example/produkte/glas', clicks: 80,  conversions: 2 },
        { landingPageUrl: 'https://acme-shop.example/sortiment',     clicks: 60,  conversions: 1 },
        { landingPageUrl: 'https://acme-shop.example/',              clicks: 300, conversions: 9 },
      ],
    });
    store.insertFinding({
      runId: r.run_id, adsAccountId: ACCOUNT,
      area: 'pmax_brand_inflation', severity: 'HIGH', source: 'deterministic',
      text: 'PMax bedient Brand-Cluster …', confidence: 0.9,
      evidence: { brand_tokens: ['hamoni', 'maunawai'] },
    });

    runBlueprint(store, ACCOUNT);

    const rsas = store.listBlueprintEntities(r.run_id, { entityType: 'rsa_ad', kind: 'NEW' });
    expect(rsas).toHaveLength(2);
    for (const rsa of rsas) {
      const reviews = JSON.parse(rsa.needs_review_json) as Array<{ field: string; reason: string; candidates: unknown[] }>;
      expect(reviews).toHaveLength(1);
      expect(reviews[0]!.field).toBe('final_url');
      expect(reviews[0]!.reason).toMatch(/no_slug_match/);
      // Operator gets ≥2 candidates (top 3 by traffic).
      expect((reviews[0]!.candidates as unknown[]).length).toBeGreaterThanOrEqual(2);
    }

    // listEntitiesNeedingReview surfaces both rows.
    const pending = store.listEntitiesNeedingReview(r.run_id);
    expect(pending).toHaveLength(2);

    // Emit blocks while reviews are pending.
    const { runEmit, EmitPreconditionError } = await import('./ads-emit-engine.js');
    expect(() => runEmit(store, ACCOUNT)).toThrow(EmitPreconditionError);
    expect(() => runEmit(store, ACCOUNT)).toThrow(/pending Operator-Review/);

    // applyEntityReviewPick clears the marker and writes the chosen value.
    const chosenUrl = 'https://acme-shop.example/marken/hamoni';
    store.applyEntityReviewPick(pending[0]!.blueprint_id, 'final_url', chosenUrl);
    const after = store.listEntitiesNeedingReview(r.run_id);
    expect(after).toHaveLength(1);
    const updated = store.listBlueprintEntities(r.run_id, { entityType: 'rsa_ad' })
      .find(e => e.blueprint_id === pending[0]!.blueprint_id)!;
    expect(JSON.parse(updated.payload_json).final_url).toBe(chosenUrl);
  });

  it('uncertain themes are NOT auto-built; they surface as theme_uncertain_intent_pending finding', () => {
    // Architecture change (post AquaNatura cycle 14): uncertain category
    // themes were previously auto-built with a theme-uncertainty review
    // marker that the operator had to dismiss. Now they're suppressed
    // entirely — the agent must validate intent via DataForSEO and propose
    // explicitly. This eliminates the dismiss-pick dance and pushes intent
    // judgment to the layer that has the data (the agent).
    seedCustomerAndAccount(store);
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);
    seedCampaign(store, r.run_id, 'pmax1', 'PMax | Gesamtsortiment', { channelType: 'PERFORMANCE_MAX' });
    store.insertLandingPagesBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [
        { landingPageUrl: 'https://acme-shop.example/produkte/kefir',    clicks: 120, conversions: 4 },
        { landingPageUrl: 'https://acme-shop.example/produkte/fermenten', clicks: 30, conversions: 1 },
        { landingPageUrl: 'https://acme-shop.example/',                  clicks: 300, conversions: 9 },
      ],
    });
    store.insertFinding({
      runId: r.run_id, adsAccountId: ACCOUNT,
      area: 'pmax_theme_coverage_gap', severity: 'MEDIUM', source: 'deterministic',
      text: '2 klassifizierte Themen …', confidence: 0.75,
      evidence: {
        themes: [
          { token: 'kefir',    clusters: 30, sample: ['kefir milch'], category: 'actionable' },
          { token: 'fermenten', clusters: 6, sample: [], category: 'uncertain', classification_reason: 'plausibly product but not in offer' },
        ],
        existing_asset_groups: [],
      },
    });

    runBlueprint(store, ACCOUNT);

    const ags = store.listBlueprintEntities(r.run_id, { entityType: 'asset_group', kind: 'NEW' });
    expect(ags).toHaveLength(1);
    const tokens = ags.map(a => JSON.parse(a.payload_json).theme_token as string);
    expect(tokens).toEqual(['kefir']);

    // The uncertain theme is surfaced as an explicit agent-action finding.
    const pendingFindings = store.listFindings(r.run_id, { area: 'theme_uncertain_intent_pending' });
    expect(pendingFindings).toHaveLength(1);
    const evidence = JSON.parse(pendingFindings[0]!.evidence_json) as {
      themes: Array<{ token: string; classification_reason: string; suggested_dataforseo_seed: string }>;
    };
    expect(evidence.themes).toHaveLength(1);
    expect(evidence.themes[0]!.token).toBe('fermenten');
    expect(evidence.themes[0]!.suggested_dataforseo_seed).toBe('fermenten');
  });

  it('Theme-AG: clear slug match → no review marker; ambiguous → review marker on asset_group', () => {
    seedCustomerAndAccount(store);
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);
    seedCampaign(store, r.run_id, 'pmax1', 'PMax | Gesamtsortiment', { channelType: 'PERFORMANCE_MAX' });
    // Two themes: 'kefir' has a slug-matching LP (clear pick); 'glas'
    // has no match, must trigger a review marker.
    store.insertLandingPagesBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [
        { landingPageUrl: 'https://acme-shop.example/produkte/kefir', clicks: 120, conversions: 4 },
        { landingPageUrl: 'https://acme-shop.example/wasser',         clicks: 200, conversions: 6 },
        { landingPageUrl: 'https://acme-shop.example/',               clicks: 300, conversions: 9 },
      ],
    });
    store.insertFinding({
      runId: r.run_id, adsAccountId: ACCOUNT,
      area: 'pmax_theme_coverage_gap', severity: 'MEDIUM', source: 'deterministic',
      text: 'PMax-Themen ohne AG …', confidence: 0.75,
      evidence: {
        themes: [
          { token: 'kefir', clusters: 32, sample: ['kefir milch'] },
          { token: 'glas',  clusters: 12, sample: ['glasflasche'] },
        ],
      },
    });

    runBlueprint(store, ACCOUNT);

    const ags = store.listBlueprintEntities(r.run_id, { entityType: 'asset_group', kind: 'NEW' });
    expect(ags).toHaveLength(2);
    const byTheme = new Map(ags.map(a => [JSON.parse(a.payload_json).theme_token as string, a]));
    // kefir: slug match wins, no review.
    expect(JSON.parse(byTheme.get('kefir')!.needs_review_json)).toEqual([]);
    expect(JSON.parse(byTheme.get('kefir')!.payload_json).final_url).toContain('kefir');
    // glas: no slug match, review fires.
    const glasReviews = JSON.parse(byTheme.get('glas')!.needs_review_json) as Array<{ field: string }>;
    expect(glasReviews).toHaveLength(1);
    expect(glasReviews[0]!.field).toBe('final_url');
  });

  it('drops orphan ad_group / keyword / asset_group whose campaign is not in the snapshot', () => {
    // Real-world data exposes parents in REMOVED state filtered by GAS
    // while children remained ENABLED — the orphan filter must drop
    // these or emit's cross-reference HARD validator blocks the run.
    seedCustomerAndAccount(store);
    const r = store.createAuditRun({ adsAccountId: ACCOUNT, mode: 'BOOTSTRAP' });
    store.completeAuditRun(r.run_id);
    seedCampaign(store, r.run_id, 'c1', 'Real-Campaign');
    store.insertAdGroupsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [
        { campaignName: 'Real-Campaign', adGroupName: 'AG-real', adGroupId: 'agR' },
        { campaignName: 'REMOVED-PARENT', adGroupName: 'AG-orphan', adGroupId: 'agO' },
      ],
    });
    store.insertKeywordsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [
        { keyword: 'real-kw', matchType: 'EXACT', campaignName: 'Real-Campaign', adGroupName: 'AG-real' },
        { keyword: 'orphan-kw', matchType: 'EXACT', campaignName: 'REMOVED-PARENT', adGroupName: 'AG-orphan' },
      ],
    });
    store.insertAssetGroupsBatch({
      runId: r.run_id, adsAccountId: ACCOUNT,
      rows: [
        { assetGroupId: 'agg-real', assetGroupName: 'AG-Real', campaignName: 'Real-Campaign' },
        { assetGroupId: 'agg-orphan', assetGroupName: 'AG-Orphan', campaignName: 'REMOVED-PARENT' },
      ],
    });

    const result = runBlueprint(store, ACCOUNT);
    const adGroupIds = result.historyByType.get('ad_group')!.map(d => d.externalId);
    const keywordRows = result.historyByType.get('keyword')!;
    const assetGroupIds = result.historyByType.get('asset_group')!.map(d => d.externalId);
    expect(adGroupIds).toEqual(['agR']);
    expect(keywordRows).toHaveLength(1);
    expect((keywordRows[0]?.payload as { keyword?: string } | undefined)?.keyword).toBe('real-kw');
    expect(assetGroupIds).toEqual(['agg-real']);
  });
});

// ── Fixtures ──────────────────────────────────────────────────────────

function seedCustomerAndAccount(
  store: AdsDataStore,
  opts?: {
    naming?: string | undefined;
    pmaxOwned?: readonly string[] | undefined;
    competitors?: readonly string[] | undefined;
    goal?: string | undefined;
  } | undefined,
): void {
  store.upsertCustomerProfile({
    customerId: CUSTOMER, clientName: 'Acme Shop',
    languages: ['DE'],
    ...(opts?.naming !== undefined ? { namingConventionPattern: opts.naming } : {}),
    ...(opts?.pmaxOwned !== undefined ? { pmaxOwnedHeadTerms: opts.pmaxOwned } : {}),
    ...(opts?.competitors !== undefined ? { competitors: opts.competitors } : {}),
    ...(opts?.goal !== undefined ? { primaryGoal: opts.goal } : {}),
  });
  store.upsertAdsAccount({ adsAccountId: ACCOUNT, customerId: CUSTOMER, accountLabel: 'Main' });
}

function seedCampaign(
  store: AdsDataStore, runId: number, id: string, name: string,
  opts?: { channelType?: string | undefined } | undefined,
): void {
  store.insertCampaignsBatch({
    runId, adsAccountId: ACCOUNT,
    rows: [{
      campaignId: id, campaignName: name, status: 'ENABLED',
      ...(opts?.channelType !== undefined ? { channelType: opts.channelType } : {}),
    }],
  });
}

/** Seed `days` distinct daily perf rows so pickMode evaluates OPTIMIZE
 *  (≥ 30 distinct dates needed). Day 0 = 2026-01-01. */
function seedPerformanceDays(store: AdsDataStore, runId: number, campaignId: string, days: number): void {
  const rows = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    rows.push({ date: d, campaignId, clicks: 10, conversions: 1 });
  }
  store.insertCampaignPerformanceBatch({ runId, adsAccountId: ACCOUNT, rows });
}
