import { describe, it, expect } from 'vitest';
import { parseAdsCsv, ALL_ADS_CSV_KINDS, ParseError } from './ads-csv-reader.js';

describe('ads-csv-reader: header validation', () => {
  it('strict-fails when a required column is missing', () => {
    const csv = 'campaign_name,status\n"PMax",ENABLED\n';
    expect(() => parseAdsCsv('campaigns', 'campaigns.csv', csv))
      .toThrow(ParseError);
    expect(() => parseAdsCsv('campaigns', 'campaigns.csv', csv))
      .toThrow(/Missing required column "campaign_id"/);
  });

  it('warns and continues when an unknown extra column is present', () => {
    const csv = 'campaign_id,campaign_name,exotic_new_col\n123,"X",foo\n';
    const result = parseAdsCsv('campaigns', 'campaigns.csv', csv);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.campaignId).toBe('123');
    expect(result.warnings.some(w => /Unknown column "exotic_new_col"/.test(w.message))).toBe(true);
  });

  it('throws ParseError on a CSV with no header row at all', () => {
    expect(() => parseAdsCsv('campaigns', 'campaigns.csv', ''))
      .toThrow(/CSV is empty/);
  });
});

describe('ads-csv-reader: value coercion', () => {
  it('treats "undefined" / "" / "null" cells as absent fields', () => {
    const csv = 'campaign_name,ad_group_name,keyword,impressions,ctr,avg_cpc\n' +
      '"camp","ag","kw","",undefined,null\n';
    const r = parseAdsCsv('keywords', 'keywords.csv', csv);
    expect(r.rows[0]?.impressions).toBeUndefined();
    expect(r.rows[0]?.ctr).toBeUndefined();
    expect(r.rows[0]?.avgCpc).toBeUndefined();
  });

  it('parses real-shaped Aquanatura keyword row from the archive fixture', () => {
    const csv = 'campaign_name,ad_group_name,keyword,match_type,status,quality_score,impressions,clicks,cost_micros,conversions,conv_value,ctr,avg_cpc,search_is\n' +
      '"Plai-Ad text ideas-1691069714939","Search Ad Group","wasseraufbereitung",EXACT,ENABLED,,0,0,0,0,0,undefined,undefined,\n';
    const r = parseAdsCsv('keywords', 'keywords.csv', csv);
    expect(r.rows[0]).toMatchObject({
      campaignName: 'Plai-Ad text ideas-1691069714939',
      adGroupName: 'Search Ad Group',
      keyword: 'wasseraufbereitung',
      matchType: 'EXACT',
      status: 'ENABLED',
      impressions: 0,
      clicks: 0,
      costMicros: 0,
      conversions: 0,
    });
    expect(r.rows[0]?.qualityScore).toBeUndefined();
    expect(r.rows[0]?.ctr).toBeUndefined();
    expect(r.rows[0]?.searchIs).toBeUndefined();
  });

  it('warns and yields undefined on non-numeric KPI cells', () => {
    const csv = 'campaign_id,campaign_name,impressions\n123,X,not-a-number\n';
    const r = parseAdsCsv('campaigns', 'campaigns.csv', csv);
    expect(r.rows[0]?.impressions).toBeUndefined();
    expect(r.warnings.some(w => /Non-numeric value/.test(w.message))).toBe(true);
  });

  it('strips a leading UTF-8 BOM', () => {
    const csv = '﻿campaign_id,campaign_name\n123,X\n';
    const r = parseAdsCsv('campaigns', 'campaigns.csv', csv);
    expect(r.rows[0]?.campaignId).toBe('123');
  });
});

describe('ads-csv-reader: campaign mapping', () => {
  it('parses a real-shaped Aquanatura PMAX campaign row', () => {
    const csv = 'campaign_id,campaign_name,status,channel_type,opt_score,budget_micros,impressions,clicks,cost_micros,conversions,conv_value,ctr,avg_cpc,search_is,search_top_is,search_abs_top_is,budget_lost_is,rank_lost_is\n' +
      '18132985374,"PMax | Wasserfilter",ENABLED,PERFORMANCE_MAX,0.958134688801621,34000000,42988,517,794300396,26.954508,5582.236962,0.012026612077789151,1536364.4023210832,0.18105894253781057,,,0.005514297698058277,0.8134267597641311\n';
    const r = parseAdsCsv('campaigns', 'campaigns.csv', csv);
    expect(r.rows).toHaveLength(1);
    const c = r.rows[0]!;
    expect(c.campaignId).toBe('18132985374');
    expect(c.campaignName).toBe('PMax | Wasserfilter');
    expect(c.status).toBe('ENABLED');
    expect(c.channelType).toBe('PERFORMANCE_MAX');
    expect(c.optScore).toBeCloseTo(0.9581, 4);
    expect(c.budgetMicros).toBe(34_000_000);
    expect(c.costMicros).toBe(794_300_396);
    expect(c.conversions).toBeCloseTo(26.95, 2);
    expect(c.convValue).toBeCloseTo(5582.24, 2);
    expect(c.searchTopIs).toBeUndefined(); // empty cell
    expect(c.searchAbsTopIs).toBeUndefined();
    expect(c.budgetLostIs).toBeCloseTo(0.0055, 4);
  });
});

describe('ads-csv-reader: rsa headlines/descriptions list parsing', () => {
  it('splits pipe-separated headlines into a string array', () => {
    const csv = 'campaign_name,ad_group_name,ad_id,headlines,descriptions,final_url,status,ad_strength\n' +
      '"camp","ag","rsa-1","Nachhaltige Wasserfilter | Filter-Systeme | Hydratation","Beschreibung A | Beschreibung B","https://x.ch",ENABLED,POOR\n';
    const r = parseAdsCsv('ads_rsa', 'ads_rsa.csv', csv);
    expect(r.rows[0]?.headlines).toEqual(['Nachhaltige Wasserfilter', 'Filter-Systeme', 'Hydratation']);
    expect(r.rows[0]?.descriptions).toEqual(['Beschreibung A', 'Beschreibung B']);
    expect(r.rows[0]?.adStrength).toBe('POOR');
  });

  it('returns undefined for empty headlines cell', () => {
    const csv = 'campaign_name,ad_group_name,ad_id,headlines,descriptions\n' +
      '"camp","ag","rsa-1",,\n';
    const r = parseAdsCsv('ads_rsa', 'ads_rsa.csv', csv);
    expect(r.rows[0]?.headlines).toBeUndefined();
    expect(r.rows[0]?.descriptions).toBeUndefined();
  });
});

describe('ads-csv-reader: search_terms with quoted commas', () => {
  it('preserves commas inside quoted cells', () => {
    const csv = 'search_term,campaign_name,impressions,clicks,cost_micros\n' +
      '"wasserfilter, kefir",camp,100,5,1000000\n';
    const r = parseAdsCsv('search_terms', 'search_terms.csv', csv);
    expect(r.rows[0]?.searchTerm).toBe('wasserfilter, kefir');
    expect(r.rows[0]?.impressions).toBe(100);
  });
});

describe('ads-csv-reader: boolean coercion in conversion actions', () => {
  it('parses true/false strings into boolean snapshot fields', () => {
    const csv = 'conv_action_id,name,primary_for_goal,in_conversions_metric\n' +
      '504968635,"Calls",true,false\n';
    const r = parseAdsCsv('conversions', 'conversions.csv', csv);
    expect(r.rows[0]?.primaryForGoal).toBe(true);
    expect(r.rows[0]?.inConversionsMetric).toBe(false);
  });

  it('treats empty boolean cell as undefined', () => {
    const csv = 'conv_action_id,name,primary_for_goal\n504968635,"Lead",\n';
    const r = parseAdsCsv('conversions', 'conversions.csv', csv);
    expect(r.rows[0]?.primaryForGoal).toBeUndefined();
  });
});

describe('ads-csv-reader: GA4 + GSC observations', () => {
  it('parses GA4 monthly export', () => {
    const csv = 'date,session_source,session_medium,sessions,total_users,conversions,event_count\n' +
      '2026-04-01,google,cpc,1200,950,18,4500\n' +
      '2026-04-01,google,organic,800,720,5,2300\n';
    const r = parseAdsCsv('ga4', 'ga4_2026-04.csv', csv);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]?.sessionMedium).toBe('cpc');
    expect(r.rows[0]?.sessions).toBe(1200);
    expect(r.rows[1]?.sessionMedium).toBe('organic');
  });

  it('parses GSC monthly export', () => {
    const csv = 'date_month,query,page,country,device,clicks,impressions,ctr,position\n' +
      '2026-04,wasseraufbereitung schweiz,https://x.ch/lp,che,DESKTOP,120,4500,0.0267,6.2\n';
    const r = parseAdsCsv('gsc', 'gsc_2026-04.csv', csv);
    expect(r.rows[0]?.query).toBe('wasseraufbereitung schweiz');
    expect(r.rows[0]?.position).toBeCloseTo(6.2, 1);
  });
});

describe('ads-csv-reader: smoke test all 22 ads kinds + GA4 + GSC', () => {
  // Minimal valid CSV per kind: only required columns.
  const minimalCsv: Record<string, string> = {
    campaigns: 'campaign_id,campaign_name\nc1,X\n',
    campaign_performance: 'date,campaign_id\n2026-04-01,c1\n',
    ad_groups: 'campaign_name,ad_group_name\nC,A\n',
    keywords: 'campaign_name,ad_group_name,keyword\nC,A,kw\n',
    ads_rsa: 'campaign_name,ad_group_name,ad_id\nC,A,r1\n',
    asset_groups: 'asset_group_id,asset_group_name\nag1,X\n',
    asset_group_assets: 'asset_group_name,field_type\nX,HEADLINE\n',
    assets: 'asset_id,type\na1,SITELINK\n',
    listing_groups: 'campaign_name\nC\n',
    shopping_products: 'campaign_name\nC\n',
    conversions: 'conv_action_id\nca1\n',
    campaign_targeting: 'criterion_type\nLOCATION\n',
    search_terms: 'search_term\nfoo\n',
    pmax_search_terms: 'campaign_id\nc1\n',
    pmax_placements: 'campaign_id\nc1\n',
    landing_pages: 'landing_page_url\nhttps://x.ch\n',
    ad_asset_ratings: 'field_type\nHEADLINE\n',
    audience_signals: 'campaign_name\nC\n',
    device_performance: 'device\nDESKTOP\n',
    geo_performance: 'campaign_id\nc1\n',
    change_history: 'change_date\n2026-04-27\n',
  };

  for (const kind of ALL_ADS_CSV_KINDS) {
    it(`accepts a minimal valid CSV for "${kind}"`, () => {
      const csv = minimalCsv[kind];
      expect(csv).toBeDefined();
      const r = parseAdsCsv(kind, `${kind}.csv`, csv!);
      expect(r.rows.length).toBeGreaterThan(0);
    });
  }
});

/**
 * Apps-script ⇄ reader header agreement.
 * The strings below are the *exact* CSV header lines that the customer-deployed
 * Apps Scripts in scripts/apps-scripts/ emit. If you change either side, this
 * test catches the drift in CI before a real cycle hits prod.
 */
describe('apps-script CSV header agreement', () => {
  const APPS_SCRIPT_HEADERS: Record<string, string> = {
    campaigns:             'campaign_id,campaign_name,status,channel_type,opt_score,budget_micros,impressions,clicks,cost_micros,conversions,conv_value,ctr,avg_cpc,search_is,search_top_is,search_abs_top_is,budget_lost_is,rank_lost_is',
    campaign_performance:  'date,campaign_id,campaign_name,channel_type,impressions,clicks,cost_micros,conversions,conv_value',
    ad_groups:             'campaign_id,campaign_name,ad_group_id,ad_group_name,status,impressions,clicks,cost_micros,conversions,conv_value,ctr,avg_cpc',
    keywords:              'campaign_name,ad_group_name,keyword,match_type,status,quality_score,impressions,clicks,cost_micros,conversions,conv_value,ctr,avg_cpc,search_is',
    ads_rsa:               'campaign_name,ad_group_name,ad_id,headlines,descriptions,final_url,status,ad_strength,impressions,clicks,cost_micros,conversions,ctr',
    asset_groups:          'campaign_id,campaign_name,asset_group_id,asset_group_name,status,ad_strength,impressions,clicks,cost_micros,conversions,conv_value',
    asset_group_assets:    'campaign_name,asset_group_name,field_type,asset_status,asset_id,asset_name,asset_type,text_content,image_url',
    assets:                'asset_id,name,type,sitelink_text,sitelink_desc1,sitelink_desc2,callout_text,snippet_header,snippet_values',
    listing_groups:        'campaign_name,asset_group_name,filter_id,filter_type,brand,category_id,product_type,custom_attribute',
    shopping_products:     'campaign_name,item_id,title,brand,status,channel,language,issues,impressions,clicks,cost_micros',
    conversions:           'conv_action_id,name,type,category,status,primary_for_goal,counting_type,attribution_model,default_value,in_conversions_metric',
    campaign_targeting:    'campaign_id,campaign_name,criterion_type,is_negative,status,bid_modifier,geo_target,language,keyword_text,match_type',
    search_terms:          'campaign_name,channel_type,ad_group_name,search_term,term_status,impressions,clicks,cost_micros,conversions,conv_value,ctr',
    pmax_search_terms:     'campaign_id,campaign_name,search_category,insight_id',
    pmax_placements:       'campaign_id,campaign_name,placement,placement_type,target_url',
    landing_pages:         'campaign_name,landing_page_url,impressions,clicks,cost_micros,conversions,conv_value,avg_cpc',
    ad_asset_ratings:      'campaign_name,ad_group_name,field_type,performance_label,enabled,text_content,impressions,clicks,cost_micros,conversions',
    audience_signals:      'campaign_name,asset_group_name,signal_type,signal_label',
    device_performance:    'campaign_id,campaign_name,channel_type,device,impressions,clicks,cost_micros,conversions,conv_value,ctr',
    geo_performance:       'campaign_id,campaign_name,country_id,location_type,geo_target_region,impressions,clicks,cost_micros,conversions,conv_value',
    change_history:        'change_date,resource_type,operation,changed_fields,user_email,client_type,campaign_name',
    ga4:                   'date,session_source,session_medium,sessions,total_users,new_users,bounce_rate,avg_session_duration,conversions,event_count',
    gsc:                   'date_month,query,page,country,device,clicks,impressions,ctr,position',
  };

  for (const kind of ALL_ADS_CSV_KINDS) {
    it(`apps-script "${kind}" header passes reader validation with no missing-column errors`, () => {
      const header = APPS_SCRIPT_HEADERS[kind];
      expect(header, `no apps-script header recorded for kind "${kind}"`).toBeDefined();
      // Header line only, no data rows — header validation should still succeed.
      const csv = header + '\n';
      const result = parseAdsCsv(kind, `${kind}.csv`, csv);
      expect(result.rows).toHaveLength(0);
      // No "Unknown column" warnings — the apps-script columns must be a
      // subset of the reader's required + optional sets.
      const unknownColWarnings = result.warnings.filter(w => /Unknown column/.test(w.message));
      expect(unknownColWarnings, `apps-script ${kind} emits columns the reader doesn't know: ${unknownColWarnings.map(w => w.message).join(', ')}`).toEqual([]);
    });
  }

  it('apps-script "ga4" header passes reader validation', () => {
    const csv = APPS_SCRIPT_HEADERS['ga4'] + '\n';
    const result = parseAdsCsv('ga4', 'ga4_2026-04.csv', csv);
    expect(result.rows).toHaveLength(0);
    const unknown = result.warnings.filter(w => /Unknown column/.test(w.message));
    expect(unknown).toEqual([]);
  });

  it('apps-script "gsc" header passes reader validation', () => {
    const csv = APPS_SCRIPT_HEADERS['gsc'] + '\n';
    const result = parseAdsCsv('gsc', 'gsc_2026-04.csv', csv);
    expect(result.rows).toHaveLength(0);
    const unknown = result.warnings.filter(w => /Unknown column/.test(w.message));
    expect(unknown).toEqual([]);
  });
});
