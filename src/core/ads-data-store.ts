/**
 * Ads Optimizer — SQLite storage layer.
 *
 * Source: GAS-exported CSVs in customer's Google Drive (22 Ads + GA4 + GSC).
 * lynox engine does NOT call Google Ads / GA4 / GSC APIs directly.
 * Adding any direct-API code path here violates the project's data-access architecture.
 *
 * Storage model: append-only snapshots per audit run.
 * Each entity row carries source_run_id (FK to ads_audit_runs) for cross-run diff
 * and provenance. Latest-state queries select WHERE source_run_id = MAX(...).
 *
 * Strictly qualitative records (AdsFinding, AdsRunProvenance) live in the
 * Knowledge Layer, not here.
 *
 * Gated by feature flag 'ads-optimizer' (default off).
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getLynoxDir } from './config.js';
import type {
  CampaignSnapshot,
  CampaignPerformanceSnapshot,
  AdGroupSnapshot,
  KeywordSnapshot,
  RsaAdSnapshot,
  AssetGroupSnapshot,
  AssetGroupAssetSnapshot,
  AssetSnapshot,
  ListingGroupSnapshot,
  ShoppingProductSnapshot,
  ConversionActionSnapshot,
  CampaignTargetingSnapshot,
  SearchTermSnapshot,
  PmaxSearchTermSnapshot,
  PmaxPlacementSnapshot,
  LandingPageSnapshot,
  AdAssetRatingSnapshot,
  AudienceSignalSnapshot,
  DevicePerformanceSnapshot,
  GeoPerformanceSnapshot,
  ChangeHistorySnapshot,
  Ga4ObservationSnapshot,
  GscObservationSnapshot,
} from './ads-snapshot-types.js';

const MIGRATIONS: string[] = [
  `INSERT OR IGNORE INTO schema_version (version) VALUES (1);

   CREATE TABLE IF NOT EXISTS customer_profiles (
     customer_id TEXT PRIMARY KEY,
     client_name TEXT NOT NULL,
     business_model TEXT,
     offer_summary TEXT,
     primary_goal TEXT,
     target_roas REAL,
     target_cpa_chf REAL,
     monthly_budget_chf REAL,
     typical_cpc_chf REAL,
     country TEXT,
     timezone TEXT,
     languages TEXT NOT NULL DEFAULT '[]',
     top_products TEXT NOT NULL DEFAULT '[]',
     own_brands TEXT NOT NULL DEFAULT '[]',
     sold_brands TEXT NOT NULL DEFAULT '[]',
     competitors TEXT NOT NULL DEFAULT '[]',
     pmax_owned_head_terms TEXT NOT NULL DEFAULT '[]',
     naming_convention_pattern TEXT,
     tracking_notes TEXT NOT NULL DEFAULT '{}',
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );

   CREATE TABLE IF NOT EXISTS ads_accounts (
     ads_account_id TEXT PRIMARY KEY,
     customer_id TEXT NOT NULL REFERENCES customer_profiles(customer_id),
     account_label TEXT NOT NULL,
     currency_code TEXT,
     timezone TEXT,
     mode TEXT NOT NULL DEFAULT 'BOOTSTRAP',
     drive_folder_id TEXT,
     last_major_import_at TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_ads_accounts_customer ON ads_accounts(customer_id);

   CREATE TABLE IF NOT EXISTS ads_audit_runs (
     run_id INTEGER PRIMARY KEY AUTOINCREMENT,
     ads_account_id TEXT NOT NULL REFERENCES ads_accounts(ads_account_id),
     status TEXT NOT NULL DEFAULT 'RUNNING',
     mode TEXT NOT NULL,
     started_at TEXT NOT NULL,
     finished_at TEXT,
     gas_export_lastrun TEXT,
     keywords_hash TEXT,
     previous_run_id INTEGER REFERENCES ads_audit_runs(run_id),
     emitted_csv_hash TEXT,
     token_cost_micros INTEGER,
     error_message TEXT
   );
   CREATE INDEX IF NOT EXISTS idx_audit_runs_account ON ads_audit_runs(ads_account_id, started_at DESC);
   CREATE INDEX IF NOT EXISTS idx_audit_runs_status ON ads_audit_runs(ads_account_id, status);

   CREATE TABLE IF NOT EXISTS ads_run_decisions (
     run_id INTEGER NOT NULL REFERENCES ads_audit_runs(run_id),
     entity_type TEXT NOT NULL,
     entity_external_id TEXT NOT NULL,
     decision TEXT NOT NULL,
     previous_external_id TEXT,
     confidence REAL NOT NULL,
     rationale TEXT NOT NULL,
     smart_bidding_guard_passed INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL,
     PRIMARY KEY (run_id, entity_type, entity_external_id)
   );
   CREATE INDEX IF NOT EXISTS idx_run_decisions_decision ON ads_run_decisions(run_id, decision);

   CREATE TABLE IF NOT EXISTS ads_campaigns (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     source_run_id INTEGER NOT NULL REFERENCES ads_audit_runs(run_id),
     ads_account_id TEXT NOT NULL,
     campaign_id TEXT NOT NULL,
     campaign_name TEXT NOT NULL,
     status TEXT,
     channel_type TEXT,
     opt_score REAL,
     budget_micros INTEGER,
     impressions INTEGER,
     clicks INTEGER,
     cost_micros INTEGER,
     conversions REAL,
     conv_value REAL,
     ctr REAL,
     avg_cpc REAL,
     search_is REAL,
     search_top_is REAL,
     search_abs_top_is REAL,
     budget_lost_is REAL,
     rank_lost_is REAL,
     observed_at TEXT NOT NULL
   );
   CREATE UNIQUE INDEX IF NOT EXISTS uniq_campaigns_run ON ads_campaigns(source_run_id, ads_account_id, campaign_id);
   CREATE INDEX IF NOT EXISTS idx_campaigns_name ON ads_campaigns(source_run_id, campaign_name);

   CREATE TABLE IF NOT EXISTS ads_campaign_performance (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     source_run_id INTEGER NOT NULL REFERENCES ads_audit_runs(run_id),
     ads_account_id TEXT NOT NULL,
     date TEXT NOT NULL,
     campaign_id TEXT NOT NULL,
     campaign_name TEXT,
     channel_type TEXT,
     impressions INTEGER,
     clicks INTEGER,
     cost_micros INTEGER,
     conversions REAL,
     conv_value REAL
   );
   CREATE INDEX IF NOT EXISTS idx_camp_perf_run ON ads_campaign_performance(source_run_id, ads_account_id, date);
   CREATE INDEX IF NOT EXISTS idx_camp_perf_campaign ON ads_campaign_performance(source_run_id, campaign_id, date);

   CREATE TABLE IF NOT EXISTS ads_ad_groups (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     source_run_id INTEGER NOT NULL REFERENCES ads_audit_runs(run_id),
     ads_account_id TEXT NOT NULL,
     campaign_id TEXT,
     campaign_name TEXT NOT NULL,
     ad_group_id TEXT,
     ad_group_name TEXT NOT NULL,
     status TEXT,
     impressions INTEGER,
     clicks INTEGER,
     cost_micros INTEGER,
     conversions REAL,
     conv_value REAL,
     ctr REAL,
     avg_cpc REAL,
     observed_at TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_ad_groups_run ON ads_ad_groups(source_run_id, ads_account_id);
   CREATE INDEX IF NOT EXISTS idx_ad_groups_campaign ON ads_ad_groups(source_run_id, campaign_name);

   CREATE TABLE IF NOT EXISTS ads_keywords (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     source_run_id INTEGER NOT NULL REFERENCES ads_audit_runs(run_id),
     ads_account_id TEXT NOT NULL,
     campaign_name TEXT NOT NULL,
     ad_group_name TEXT NOT NULL,
     keyword TEXT NOT NULL,
     match_type TEXT,
     status TEXT,
     quality_score INTEGER,
     impressions INTEGER,
     clicks INTEGER,
     cost_micros INTEGER,
     conversions REAL,
     conv_value REAL,
     ctr REAL,
     avg_cpc REAL,
     search_is REAL,
     observed_at TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_keywords_run ON ads_keywords(source_run_id, ads_account_id);
   CREATE INDEX IF NOT EXISTS idx_keywords_campaign ON ads_keywords(source_run_id, campaign_name, ad_group_name);

   CREATE TABLE IF NOT EXISTS ads_rsa_ads (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     source_run_id INTEGER NOT NULL REFERENCES ads_audit_runs(run_id),
     ads_account_id TEXT NOT NULL,
     campaign_name TEXT NOT NULL,
     ad_group_name TEXT NOT NULL,
     ad_id TEXT NOT NULL,
     headlines TEXT NOT NULL DEFAULT '[]',
     descriptions TEXT NOT NULL DEFAULT '[]',
     final_url TEXT,
     status TEXT,
     ad_strength TEXT,
     impressions INTEGER,
     clicks INTEGER,
     cost_micros INTEGER,
     conversions REAL,
     ctr REAL,
     observed_at TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_rsa_run ON ads_rsa_ads(source_run_id, ads_account_id);

   CREATE TABLE IF NOT EXISTS ads_asset_groups (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     source_run_id INTEGER NOT NULL REFERENCES ads_audit_runs(run_id),
     ads_account_id TEXT NOT NULL,
     campaign_id TEXT,
     campaign_name TEXT,
     asset_group_id TEXT NOT NULL,
     asset_group_name TEXT NOT NULL,
     status TEXT,
     ad_strength TEXT,
     impressions INTEGER,
     clicks INTEGER,
     cost_micros INTEGER,
     conversions REAL,
     conv_value REAL,
     observed_at TEXT NOT NULL
   );
   CREATE UNIQUE INDEX IF NOT EXISTS uniq_asset_groups_run ON ads_asset_groups(source_run_id, ads_account_id, asset_group_id);

   CREATE TABLE IF NOT EXISTS ads_asset_group_assets (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     source_run_id INTEGER NOT NULL REFERENCES ads_audit_runs(run_id),
     ads_account_id TEXT NOT NULL,
     campaign_name TEXT,
     asset_group_name TEXT NOT NULL,
     field_type TEXT NOT NULL,
     asset_status TEXT,
     asset_id TEXT,
     asset_name TEXT,
     asset_type TEXT,
     text_content TEXT,
     image_url TEXT,
     observed_at TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_aga_run ON ads_asset_group_assets(source_run_id, ads_account_id);
   CREATE INDEX IF NOT EXISTS idx_aga_group ON ads_asset_group_assets(source_run_id, asset_group_name);

   CREATE TABLE IF NOT EXISTS ads_assets (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     source_run_id INTEGER NOT NULL REFERENCES ads_audit_runs(run_id),
     ads_account_id TEXT NOT NULL,
     asset_id TEXT NOT NULL,
     name TEXT,
     type TEXT NOT NULL,
     sitelink_text TEXT,
     sitelink_desc1 TEXT,
     sitelink_desc2 TEXT,
     callout_text TEXT,
     snippet_header TEXT,
     snippet_values TEXT,
     observed_at TEXT NOT NULL
   );
   CREATE UNIQUE INDEX IF NOT EXISTS uniq_assets_run ON ads_assets(source_run_id, ads_account_id, asset_id);

   CREATE TABLE IF NOT EXISTS ads_listing_groups (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     source_run_id INTEGER NOT NULL REFERENCES ads_audit_runs(run_id),
     ads_account_id TEXT NOT NULL,
     campaign_name TEXT,
     asset_group_name TEXT,
     filter_id TEXT,
     filter_type TEXT,
     brand TEXT,
     category_id TEXT,
     product_type TEXT,
     custom_attribute TEXT,
     observed_at TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_lg_run ON ads_listing_groups(source_run_id, ads_account_id);

   CREATE TABLE IF NOT EXISTS ads_shopping_products (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     source_run_id INTEGER NOT NULL REFERENCES ads_audit_runs(run_id),
     ads_account_id TEXT NOT NULL,
     campaign_name TEXT,
     item_id TEXT,
     title TEXT,
     brand TEXT,
     status TEXT,
     channel TEXT,
     language TEXT,
     issues TEXT,
     impressions INTEGER,
     clicks INTEGER,
     cost_micros INTEGER,
     observed_at TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_shop_run ON ads_shopping_products(source_run_id, ads_account_id);

   CREATE TABLE IF NOT EXISTS ads_conversion_actions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     source_run_id INTEGER NOT NULL REFERENCES ads_audit_runs(run_id),
     ads_account_id TEXT NOT NULL,
     conv_action_id TEXT NOT NULL,
     name TEXT,
     type TEXT,
     category TEXT,
     status TEXT,
     primary_for_goal INTEGER,
     counting_type TEXT,
     attribution_model TEXT,
     default_value REAL,
     in_conversions_metric INTEGER,
     observed_at TEXT NOT NULL
   );
   CREATE UNIQUE INDEX IF NOT EXISTS uniq_conv_run ON ads_conversion_actions(source_run_id, ads_account_id, conv_action_id);

   CREATE TABLE IF NOT EXISTS ads_campaign_targeting (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     source_run_id INTEGER NOT NULL REFERENCES ads_audit_runs(run_id),
     ads_account_id TEXT NOT NULL,
     campaign_id TEXT,
     campaign_name TEXT,
     criterion_type TEXT NOT NULL,
     is_negative INTEGER NOT NULL DEFAULT 0,
     status TEXT,
     bid_modifier REAL,
     geo_target TEXT,
     language TEXT,
     keyword_text TEXT,
     match_type TEXT,
     observed_at TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_target_run ON ads_campaign_targeting(source_run_id, ads_account_id);
   CREATE INDEX IF NOT EXISTS idx_target_neg ON ads_campaign_targeting(source_run_id, is_negative);

   CREATE TABLE IF NOT EXISTS ads_search_terms (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     source_run_id INTEGER NOT NULL REFERENCES ads_audit_runs(run_id),
     ads_account_id TEXT NOT NULL,
     campaign_name TEXT,
     channel_type TEXT,
     ad_group_name TEXT,
     search_term TEXT NOT NULL,
     term_status TEXT,
     impressions INTEGER,
     clicks INTEGER,
     cost_micros INTEGER,
     conversions REAL,
     conv_value REAL,
     ctr REAL,
     observed_at TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_st_run ON ads_search_terms(source_run_id, ads_account_id);
   CREATE INDEX IF NOT EXISTS idx_st_term ON ads_search_terms(source_run_id, search_term);

   CREATE TABLE IF NOT EXISTS ads_pmax_search_terms (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     source_run_id INTEGER NOT NULL REFERENCES ads_audit_runs(run_id),
     ads_account_id TEXT NOT NULL,
     campaign_id TEXT,
     campaign_name TEXT,
     search_category TEXT,
     insight_id TEXT,
     observed_at TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_pst_run ON ads_pmax_search_terms(source_run_id, ads_account_id);

   CREATE TABLE IF NOT EXISTS ads_pmax_placements (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     source_run_id INTEGER NOT NULL REFERENCES ads_audit_runs(run_id),
     ads_account_id TEXT NOT NULL,
     campaign_id TEXT,
     campaign_name TEXT,
     placement TEXT,
     placement_type TEXT,
     target_url TEXT,
     observed_at TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_pp_run ON ads_pmax_placements(source_run_id, ads_account_id);

   CREATE TABLE IF NOT EXISTS ads_landing_pages (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     source_run_id INTEGER NOT NULL REFERENCES ads_audit_runs(run_id),
     ads_account_id TEXT NOT NULL,
     campaign_name TEXT,
     landing_page_url TEXT NOT NULL,
     impressions INTEGER,
     clicks INTEGER,
     cost_micros INTEGER,
     conversions REAL,
     conv_value REAL,
     avg_cpc REAL,
     observed_at TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_lp_run ON ads_landing_pages(source_run_id, ads_account_id);
   CREATE INDEX IF NOT EXISTS idx_lp_url ON ads_landing_pages(source_run_id, landing_page_url);

   CREATE TABLE IF NOT EXISTS ads_ad_asset_ratings (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     source_run_id INTEGER NOT NULL REFERENCES ads_audit_runs(run_id),
     ads_account_id TEXT NOT NULL,
     campaign_name TEXT,
     ad_group_name TEXT,
     field_type TEXT NOT NULL,
     performance_label TEXT,
     enabled INTEGER NOT NULL DEFAULT 1,
     text_content TEXT,
     impressions INTEGER,
     clicks INTEGER,
     cost_micros INTEGER,
     conversions REAL,
     observed_at TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_aar_run ON ads_ad_asset_ratings(source_run_id, ads_account_id);

   CREATE TABLE IF NOT EXISTS ads_audience_signals (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     source_run_id INTEGER NOT NULL REFERENCES ads_audit_runs(run_id),
     ads_account_id TEXT NOT NULL,
     campaign_name TEXT,
     asset_group_name TEXT,
     signal_type TEXT,
     signal_label TEXT,
     observed_at TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_aud_run ON ads_audience_signals(source_run_id, ads_account_id);

   CREATE TABLE IF NOT EXISTS ads_device_performance (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     source_run_id INTEGER NOT NULL REFERENCES ads_audit_runs(run_id),
     ads_account_id TEXT NOT NULL,
     campaign_id TEXT,
     campaign_name TEXT,
     channel_type TEXT,
     device TEXT NOT NULL,
     impressions INTEGER,
     clicks INTEGER,
     cost_micros INTEGER,
     conversions REAL,
     conv_value REAL,
     ctr REAL,
     observed_at TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_dev_run ON ads_device_performance(source_run_id, ads_account_id);

   CREATE TABLE IF NOT EXISTS ads_geo_performance (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     source_run_id INTEGER NOT NULL REFERENCES ads_audit_runs(run_id),
     ads_account_id TEXT NOT NULL,
     campaign_id TEXT,
     campaign_name TEXT,
     country_id TEXT,
     location_type TEXT,
     geo_target_region TEXT,
     impressions INTEGER,
     clicks INTEGER,
     cost_micros INTEGER,
     conversions REAL,
     conv_value REAL,
     observed_at TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_geo_run ON ads_geo_performance(source_run_id, ads_account_id);

   CREATE TABLE IF NOT EXISTS ads_change_history (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     source_run_id INTEGER NOT NULL REFERENCES ads_audit_runs(run_id),
     ads_account_id TEXT NOT NULL,
     change_date TEXT NOT NULL,
     resource_type TEXT,
     operation TEXT,
     changed_fields TEXT,
     user_email TEXT,
     client_type TEXT,
     campaign_name TEXT,
     observed_at TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_change_run ON ads_change_history(source_run_id, ads_account_id, change_date DESC);

   CREATE TABLE IF NOT EXISTS ga4_observations (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     source_run_id INTEGER NOT NULL REFERENCES ads_audit_runs(run_id),
     ads_account_id TEXT NOT NULL,
     date TEXT NOT NULL,
     session_source TEXT,
     session_medium TEXT,
     sessions INTEGER,
     total_users INTEGER,
     new_users INTEGER,
     bounce_rate REAL,
     avg_session_duration REAL,
     conversions REAL,
     event_count INTEGER,
     observed_at TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_ga4_run ON ga4_observations(source_run_id, ads_account_id, date);
   CREATE INDEX IF NOT EXISTS idx_ga4_source ON ga4_observations(source_run_id, session_source, session_medium);

   CREATE TABLE IF NOT EXISTS gsc_observations (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     source_run_id INTEGER NOT NULL REFERENCES ads_audit_runs(run_id),
     ads_account_id TEXT NOT NULL,
     date_month TEXT NOT NULL,
     query TEXT,
     page TEXT,
     country TEXT,
     device TEXT,
     clicks INTEGER,
     impressions INTEGER,
     ctr REAL,
     position REAL,
     observed_at TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_gsc_run ON gsc_observations(source_run_id, ads_account_id, date_month);
   CREATE INDEX IF NOT EXISTS idx_gsc_query ON gsc_observations(source_run_id, query);
   CREATE INDEX IF NOT EXISTS idx_gsc_page ON gsc_observations(source_run_id, page);

   CREATE VIEW IF NOT EXISTS view_audit_kpis AS
     SELECT
       source_run_id,
       ads_account_id,
       SUM(cost_micros) / 1000000.0 AS spend,
       SUM(conversions) AS conversions,
       SUM(conv_value) AS conv_value,
       CASE WHEN SUM(cost_micros) > 0
         THEN SUM(conv_value) / (SUM(cost_micros) / 1000000.0)
         ELSE NULL END AS roas,
       CASE WHEN SUM(conversions) > 0
         THEN (SUM(cost_micros) / 1000000.0) / SUM(conversions)
         ELSE NULL END AS cpa,
       CASE WHEN SUM(impressions) > 0
         THEN CAST(SUM(clicks) AS REAL) / SUM(impressions)
         ELSE NULL END AS ctr
     FROM ads_campaigns
     GROUP BY source_run_id, ads_account_id;

   CREATE VIEW IF NOT EXISTS view_audit_campaign_summary AS
     SELECT
       source_run_id,
       ads_account_id,
       campaign_id,
       campaign_name,
       channel_type,
       status,
       opt_score,
       budget_micros / 1000000.0 AS budget,
       cost_micros / 1000000.0 AS spend,
       conversions,
       conv_value,
       CASE WHEN cost_micros > 0
         THEN conv_value / (cost_micros / 1000000.0) ELSE NULL END AS roas,
       CASE WHEN conversions > 0
         THEN (cost_micros / 1000000.0) / conversions ELSE NULL END AS cpa,
       ctr,
       search_is,
       search_top_is,
       budget_lost_is
     FROM ads_campaigns;

   CREATE VIEW IF NOT EXISTS view_audit_device_split AS
     SELECT
       source_run_id, ads_account_id, campaign_name, device,
       cost_micros / 1000000.0 AS spend,
       conversions, conv_value, ctr,
       CASE WHEN cost_micros > 0
         THEN conv_value / (cost_micros / 1000000.0) ELSE NULL END AS roas
     FROM ads_device_performance;

   CREATE VIEW IF NOT EXISTS view_audit_geo_top10 AS
     SELECT
       source_run_id, ads_account_id, campaign_name, geo_target_region,
       cost_micros / 1000000.0 AS spend,
       conversions, conv_value
     FROM ads_geo_performance
     ORDER BY cost_micros DESC;

   CREATE VIEW IF NOT EXISTS view_audit_top_search_terms AS
     SELECT
       source_run_id, ads_account_id, campaign_name, search_term, term_status,
       impressions, clicks, cost_micros / 1000000.0 AS spend,
       conversions, conv_value, ctr,
       CASE WHEN conversions = 0 AND cost_micros > 100000 THEN 'WASTE'
            WHEN conversions > 0 AND ctr > 0.05 THEN 'OPPORTUNITY'
            ELSE 'NEUTRAL' END AS classification
     FROM ads_search_terms;

   CREATE VIEW IF NOT EXISTS view_audit_pmax_categories AS
     SELECT source_run_id, ads_account_id, campaign_name, search_category, insight_id
     FROM ads_pmax_search_terms;

   CREATE VIEW IF NOT EXISTS view_audit_low_performers AS
     SELECT
       source_run_id, ads_account_id, 'rsa_ad' AS entity_type,
       campaign_name || ' / ' || ad_group_name AS scope,
       ad_id AS entity_id, ad_strength AS label,
       cost_micros / 1000000.0 AS spend, conversions
     FROM ads_rsa_ads
     WHERE ad_strength IN ('POOR', 'AVERAGE')
     UNION ALL
     SELECT
       source_run_id, ads_account_id, 'asset_rating',
       campaign_name || ' / ' || ad_group_name,
       text_content, performance_label,
       cost_micros / 1000000.0, conversions
     FROM ads_ad_asset_ratings
     WHERE performance_label = 'LOW';

   CREATE VIEW IF NOT EXISTS view_audit_disapproved_products AS
     SELECT
       source_run_id, ads_account_id, campaign_name, item_id, title, brand,
       status, issues
     FROM ads_shopping_products
     WHERE issues IS NOT NULL AND issues != '';

   CREATE VIEW IF NOT EXISTS view_audit_change_history_summary AS
     SELECT
       source_run_id, ads_account_id, resource_type, operation,
       COUNT(*) AS change_count,
       MIN(change_date) AS first_change,
       MAX(change_date) AS last_change
     FROM ads_change_history
     GROUP BY source_run_id, ads_account_id, resource_type, operation;

   CREATE VIEW IF NOT EXISTS view_blueprint_negative_candidates AS
     SELECT
       st.source_run_id, st.ads_account_id, st.search_term,
       SUM(st.cost_micros) / 1000000.0 AS spend,
       SUM(st.conversions) AS conversions,
       NOT EXISTS (
         SELECT 1 FROM ads_pmax_search_terms p
         WHERE p.source_run_id = st.source_run_id
           AND p.ads_account_id = st.ads_account_id
           AND lower(p.search_category) = lower(st.search_term)
       ) AS pmax_disjunct
     FROM ads_search_terms st
     GROUP BY st.source_run_id, st.ads_account_id, st.search_term;

   CREATE VIEW IF NOT EXISTS view_blueprint_organic_overlap AS
     SELECT
       g.source_run_id, g.ads_account_id, g.query,
       SUM(g.clicks) AS organic_clicks,
       SUM(g.impressions) AS organic_impressions,
       AVG(g.position) AS avg_position,
       NOT EXISTS (
         SELECT 1 FROM ads_search_terms st
         WHERE st.source_run_id = g.source_run_id
           AND st.ads_account_id = g.ads_account_id
           AND lower(st.search_term) = lower(g.query)
       ) AS paid_disjunct
     FROM gsc_observations g
     WHERE g.query IS NOT NULL AND g.query != ''
     GROUP BY g.source_run_id, g.ads_account_id, g.query;

   CREATE VIEW IF NOT EXISTS view_blueprint_ga4_conversion_delta AS
     SELECT
       ga.source_run_id, ga.ads_account_id, ga.session_source, ga.session_medium,
       SUM(ga.conversions) AS ga4_conversions,
       (SELECT SUM(conversions) FROM ads_campaigns c
          WHERE c.source_run_id = ga.source_run_id
            AND c.ads_account_id = ga.ads_account_id) AS ads_conversions
     FROM ga4_observations ga
     GROUP BY ga.source_run_id, ga.ads_account_id, ga.session_source, ga.session_medium;

   CREATE VIEW IF NOT EXISTS view_blueprint_landing_page_perf AS
     SELECT
       lp.source_run_id, lp.ads_account_id, lp.landing_page_url,
       lp.cost_micros / 1000000.0 AS paid_spend,
       lp.clicks AS paid_clicks,
       CASE WHEN lp.clicks > 0
         THEN CAST(lp.conversions AS REAL) / lp.clicks ELSE NULL END AS paid_cr,
       (SELECT SUM(g.clicks) FROM gsc_observations g
          WHERE g.source_run_id = lp.source_run_id
            AND g.ads_account_id = lp.ads_account_id
            AND g.page = lp.landing_page_url) AS organic_clicks
     FROM ads_landing_pages lp;`,
];

export interface CustomerProfileRow {
  customer_id: string;
  client_name: string;
  business_model: string | null;
  offer_summary: string | null;
  primary_goal: string | null;
  target_roas: number | null;
  target_cpa_chf: number | null;
  monthly_budget_chf: number | null;
  typical_cpc_chf: number | null;
  country: string | null;
  timezone: string | null;
  languages: string;
  top_products: string;
  own_brands: string;
  sold_brands: string;
  competitors: string;
  pmax_owned_head_terms: string;
  naming_convention_pattern: string | null;
  tracking_notes: string;
  created_at: string;
  updated_at: string;
}

export interface AdsAccountRow {
  ads_account_id: string;
  customer_id: string;
  account_label: string;
  currency_code: string | null;
  timezone: string | null;
  mode: 'BOOTSTRAP' | 'OPTIMIZE';
  drive_folder_id: string | null;
  last_major_import_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AdsAuditRunRow {
  run_id: number;
  ads_account_id: string;
  status: 'RUNNING' | 'SUCCESS' | 'FAILED' | 'LOCKED';
  mode: 'BOOTSTRAP' | 'OPTIMIZE';
  started_at: string;
  finished_at: string | null;
  gas_export_lastrun: string | null;
  keywords_hash: string | null;
  previous_run_id: number | null;
  emitted_csv_hash: string | null;
  token_cost_micros: number | null;
  error_message: string | null;
}

export type AdsDecisionEntityType =
  | 'campaign' | 'ad_group' | 'keyword' | 'rsa_ad'
  | 'asset_group' | 'asset' | 'listing_group' | 'sitelink'
  | 'callout' | 'snippet' | 'negative';

export type AdsDecision = 'KEEP' | 'RENAME' | 'PAUSE' | 'NEW' | 'SPLIT' | 'MERGE';

export interface AdsRunDecisionRow {
  run_id: number;
  entity_type: AdsDecisionEntityType;
  entity_external_id: string;
  decision: AdsDecision;
  previous_external_id: string | null;
  confidence: number;
  rationale: string;
  smart_bidding_guard_passed: number;
  created_at: string;
}

export interface UpsertCustomerProfileInput {
  customerId: string;
  clientName: string;
  businessModel?: string | undefined;
  offerSummary?: string | undefined;
  primaryGoal?: string | undefined;
  targetRoas?: number | undefined;
  targetCpaChf?: number | undefined;
  monthlyBudgetChf?: number | undefined;
  typicalCpcChf?: number | undefined;
  country?: string | undefined;
  timezone?: string | undefined;
  languages?: readonly string[] | undefined;
  topProducts?: readonly string[] | undefined;
  ownBrands?: readonly string[] | undefined;
  soldBrands?: readonly string[] | undefined;
  competitors?: readonly string[] | undefined;
  pmaxOwnedHeadTerms?: readonly string[] | undefined;
  namingConventionPattern?: string | undefined;
  trackingNotes?: Record<string, unknown> | undefined;
}

export interface UpsertAdsAccountInput {
  adsAccountId: string;
  customerId: string;
  accountLabel: string;
  currencyCode?: string | undefined;
  timezone?: string | undefined;
  mode?: 'BOOTSTRAP' | 'OPTIMIZE' | undefined;
  driveFolderId?: string | undefined;
}

export interface CreateAuditRunInput {
  adsAccountId: string;
  mode: 'BOOTSTRAP' | 'OPTIMIZE';
  gasExportLastrun?: string | undefined;
  keywordsHash?: string | undefined;
  previousRunId?: number | undefined;
}

export interface InsertRunDecisionInput {
  runId: number;
  entityType: AdsDecisionEntityType;
  entityExternalId: string;
  decision: AdsDecision;
  previousExternalId?: string | undefined;
  confidence: number;
  rationale: string;
  smartBiddingGuardPassed?: boolean | undefined;
}

export class AdsDataStore {
  private db: Database.Database;
  private readonly dbPath: string;

  constructor(dbPath?: string | undefined) {
    this.dbPath = dbPath ?? join(getLynoxDir(), 'ads-optimizer.db');
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this._ensureSchemaVersion();
    this._migrate();
  }

  get path(): string { return this.dbPath; }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  private _ensureSchemaVersion(): void {
    this.db.prepare('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)').run();
  }

  private _getVersion(): number {
    try {
      const row = this.db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null } | undefined;
      return row?.v ?? 0;
    } catch {
      return 0;
    }
  }

  private _migrate(): void {
    const currentVersion = this._getVersion();
    for (let i = currentVersion; i < MIGRATIONS.length; i++) {
      this.db.exec(MIGRATIONS[i]!);
    }
  }

  upsertCustomerProfile(input: UpsertCustomerProfileInput): CustomerProfileRow {
    const now = new Date().toISOString();
    const existing = this.getCustomerProfile(input.customerId);
    const createdAt = existing?.created_at ?? now;

    this.db.prepare(`
      INSERT INTO customer_profiles (
        customer_id, client_name, business_model, offer_summary, primary_goal,
        target_roas, target_cpa_chf, monthly_budget_chf, typical_cpc_chf,
        country, timezone, languages, top_products, own_brands, sold_brands,
        competitors, pmax_owned_head_terms, naming_convention_pattern,
        tracking_notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(customer_id) DO UPDATE SET
        client_name = excluded.client_name,
        business_model = excluded.business_model,
        offer_summary = excluded.offer_summary,
        primary_goal = excluded.primary_goal,
        target_roas = excluded.target_roas,
        target_cpa_chf = excluded.target_cpa_chf,
        monthly_budget_chf = excluded.monthly_budget_chf,
        typical_cpc_chf = excluded.typical_cpc_chf,
        country = excluded.country,
        timezone = excluded.timezone,
        languages = excluded.languages,
        top_products = excluded.top_products,
        own_brands = excluded.own_brands,
        sold_brands = excluded.sold_brands,
        competitors = excluded.competitors,
        pmax_owned_head_terms = excluded.pmax_owned_head_terms,
        naming_convention_pattern = excluded.naming_convention_pattern,
        tracking_notes = excluded.tracking_notes,
        updated_at = excluded.updated_at
    `).run(
      input.customerId, input.clientName,
      input.businessModel ?? null, input.offerSummary ?? null, input.primaryGoal ?? null,
      input.targetRoas ?? null, input.targetCpaChf ?? null,
      input.monthlyBudgetChf ?? null, input.typicalCpcChf ?? null,
      input.country ?? null, input.timezone ?? null,
      JSON.stringify(input.languages ?? []),
      JSON.stringify(input.topProducts ?? []),
      JSON.stringify(input.ownBrands ?? []),
      JSON.stringify(input.soldBrands ?? []),
      JSON.stringify(input.competitors ?? []),
      JSON.stringify(input.pmaxOwnedHeadTerms ?? []),
      input.namingConventionPattern ?? null,
      JSON.stringify(input.trackingNotes ?? {}),
      createdAt, now,
    );

    return this.getCustomerProfile(input.customerId)!;
  }

  getCustomerProfile(customerId: string): CustomerProfileRow | null {
    return this.db.prepare('SELECT * FROM customer_profiles WHERE customer_id = ?')
      .get(customerId) as CustomerProfileRow | undefined ?? null;
  }

  upsertAdsAccount(input: UpsertAdsAccountInput): AdsAccountRow {
    const now = new Date().toISOString();
    const existing = this.getAdsAccount(input.adsAccountId);
    const createdAt = existing?.created_at ?? now;

    this.db.prepare(`
      INSERT INTO ads_accounts (
        ads_account_id, customer_id, account_label, currency_code, timezone,
        mode, drive_folder_id, last_major_import_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ads_account_id) DO UPDATE SET
        customer_id = excluded.customer_id,
        account_label = excluded.account_label,
        currency_code = excluded.currency_code,
        timezone = excluded.timezone,
        mode = excluded.mode,
        drive_folder_id = excluded.drive_folder_id,
        updated_at = excluded.updated_at
    `).run(
      input.adsAccountId, input.customerId, input.accountLabel,
      input.currencyCode ?? null, input.timezone ?? null,
      input.mode ?? 'BOOTSTRAP', input.driveFolderId ?? null,
      existing?.last_major_import_at ?? null,
      createdAt, now,
    );

    return this.getAdsAccount(input.adsAccountId)!;
  }

  getAdsAccount(adsAccountId: string): AdsAccountRow | null {
    return this.db.prepare('SELECT * FROM ads_accounts WHERE ads_account_id = ?')
      .get(adsAccountId) as AdsAccountRow | undefined ?? null;
  }

  listAdsAccountsForCustomer(customerId: string): AdsAccountRow[] {
    return this.db.prepare('SELECT * FROM ads_accounts WHERE customer_id = ? ORDER BY account_label')
      .all(customerId) as AdsAccountRow[];
  }

  recordMajorImport(adsAccountId: string, at?: string | undefined): void {
    const ts = at ?? new Date().toISOString();
    this.db.prepare('UPDATE ads_accounts SET last_major_import_at = ?, updated_at = ? WHERE ads_account_id = ?')
      .run(ts, ts, adsAccountId);
  }

  createAuditRun(input: CreateAuditRunInput): AdsAuditRunRow {
    const now = new Date().toISOString();
    return this.transaction(() => {
      const active = this.db.prepare(`
        SELECT run_id, started_at FROM ads_audit_runs
        WHERE ads_account_id = ? AND status = 'RUNNING'
        LIMIT 1
      `).get(input.adsAccountId) as { run_id: number; started_at: string } | undefined;
      if (active) {
        const ageMs = Date.now() - new Date(active.started_at).getTime();
        if (ageMs < 4 * 60 * 60 * 1000) {
          throw new Error(
            `Cannot start a new audit run: run ${active.run_id} is still RUNNING ` +
            `(started ${active.started_at}). Wait for it to finish or call failAuditRun() to clear.`,
          );
        }
        this.db.prepare(`
          UPDATE ads_audit_runs SET status = 'FAILED', finished_at = ?,
            error_message = 'Auto-failed: exceeded 4h concurrency lock' WHERE run_id = ?
        `).run(now, active.run_id);
      }

      const result = this.db.prepare(`
        INSERT INTO ads_audit_runs (
          ads_account_id, status, mode, started_at,
          gas_export_lastrun, keywords_hash, previous_run_id
        ) VALUES (?, 'RUNNING', ?, ?, ?, ?, ?)
      `).run(
        input.adsAccountId, input.mode, now,
        input.gasExportLastrun ?? null, input.keywordsHash ?? null,
        input.previousRunId ?? null,
      );

      return this.getAuditRun(result.lastInsertRowid as number)!;
    });
  }

  completeAuditRun(runId: number, props?: { emittedCsvHash?: string | undefined; tokenCostMicros?: number | undefined } | undefined): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE ads_audit_runs
      SET status = 'SUCCESS', finished_at = ?,
          emitted_csv_hash = COALESCE(?, emitted_csv_hash),
          token_cost_micros = COALESCE(?, token_cost_micros)
      WHERE run_id = ? AND status = 'RUNNING'
    `).run(now, props?.emittedCsvHash ?? null, props?.tokenCostMicros ?? null, runId);
  }

  failAuditRun(runId: number, errorMessage: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE ads_audit_runs SET status = 'FAILED', finished_at = ?, error_message = ?
      WHERE run_id = ? AND status = 'RUNNING'
    `).run(now, errorMessage, runId);
  }

  getAuditRun(runId: number): AdsAuditRunRow | null {
    return this.db.prepare('SELECT * FROM ads_audit_runs WHERE run_id = ?')
      .get(runId) as AdsAuditRunRow | undefined ?? null;
  }

  getLatestSuccessfulAuditRun(adsAccountId: string): AdsAuditRunRow | null {
    // Tiebreaker: run_id DESC handles sub-millisecond runs with identical timestamps.
    return this.db.prepare(`
      SELECT * FROM ads_audit_runs
      WHERE ads_account_id = ? AND status = 'SUCCESS'
      ORDER BY finished_at DESC, run_id DESC LIMIT 1
    `).get(adsAccountId) as AdsAuditRunRow | undefined ?? null;
  }

  getLatestAuditRun(adsAccountId: string): AdsAuditRunRow | null {
    return this.db.prepare(`
      SELECT * FROM ads_audit_runs
      WHERE ads_account_id = ?
      ORDER BY started_at DESC, run_id DESC LIMIT 1
    `).get(adsAccountId) as AdsAuditRunRow | undefined ?? null;
  }

  listAuditRuns(adsAccountId: string, limit = 20): AdsAuditRunRow[] {
    const safeLimit = Math.max(1, Math.min(limit, 200));
    return this.db.prepare(`
      SELECT * FROM ads_audit_runs WHERE ads_account_id = ?
      ORDER BY started_at DESC, run_id DESC LIMIT ?
    `).all(adsAccountId, safeLimit) as AdsAuditRunRow[];
  }

  insertRunDecision(input: InsertRunDecisionInput): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO ads_run_decisions (
        run_id, entity_type, entity_external_id, decision,
        previous_external_id, confidence, rationale, smart_bidding_guard_passed, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, entity_type, entity_external_id) DO UPDATE SET
        decision = excluded.decision,
        previous_external_id = excluded.previous_external_id,
        confidence = excluded.confidence,
        rationale = excluded.rationale,
        smart_bidding_guard_passed = excluded.smart_bidding_guard_passed
    `).run(
      input.runId, input.entityType, input.entityExternalId, input.decision,
      input.previousExternalId ?? null, input.confidence, input.rationale,
      input.smartBiddingGuardPassed === false ? 0 : 1, now,
    );
  }

  getRunDecisions(runId: number, opts?: { entityType?: AdsDecisionEntityType | undefined; decision?: AdsDecision | undefined } | undefined): AdsRunDecisionRow[] {
    const clauses: string[] = ['run_id = ?'];
    const params: unknown[] = [runId];
    if (opts?.entityType) { clauses.push('entity_type = ?'); params.push(opts.entityType); }
    if (opts?.decision) { clauses.push('decision = ?'); params.push(opts.decision); }
    return this.db.prepare(`
      SELECT * FROM ads_run_decisions WHERE ${clauses.join(' AND ')}
      ORDER BY entity_type, entity_external_id
    `).all(...params) as AdsRunDecisionRow[];
  }

  // ── Snapshot Bulk Inserts ────────────────────────────────────
  // All inserts are append-only: every row carries source_run_id and observed_at.
  // The caller is expected to call createAuditRun() first and pass the resulting
  // run_id. Inserts are wrapped in a transaction for atomicity.

  private _insertSnapshot<T>(
    tableName: string,
    columns: readonly string[],
    runId: number,
    adsAccountId: string,
    rows: readonly T[],
    rowMapper: (row: T) => readonly SqlValue[],
    observedAt?: string | undefined,
  ): number {
    if (rows.length === 0) return 0;
    const ts = observedAt ?? new Date().toISOString();
    const allCols = ['source_run_id', 'ads_account_id', ...columns, 'observed_at'];
    const placeholders = allCols.map(() => '?').join(', ');
    // Table name is hard-coded by the caller (this class only) — no user input.
    const colList = allCols.map(c => `"${c}"`).join(', ');
    const sql = `INSERT INTO "${tableName}" (${colList}) VALUES (${placeholders})`;
    const stmt = this.db.prepare(sql);
    return this.transaction(() => {
      let count = 0;
      for (const row of rows) {
        const params: SqlValue[] = [runId, adsAccountId, ...rowMapper(row), ts];
        stmt.run(...params);
        count++;
      }
      return count;
    });
  }

  insertCampaignsBatch(input: SnapshotBatchInput<CampaignSnapshot>): number {
    return this._insertSnapshot(
      'ads_campaigns',
      ['campaign_id', 'campaign_name', 'status', 'channel_type', 'opt_score',
        'budget_micros', 'impressions', 'clicks', 'cost_micros', 'conversions',
        'conv_value', 'ctr', 'avg_cpc', 'search_is', 'search_top_is',
        'search_abs_top_is', 'budget_lost_is', 'rank_lost_is'],
      input.runId, input.adsAccountId, input.rows,
      r => [r.campaignId, r.campaignName, r.status ?? null, r.channelType ?? null, r.optScore ?? null,
        r.budgetMicros ?? null, r.impressions ?? null, r.clicks ?? null, r.costMicros ?? null, r.conversions ?? null,
        r.convValue ?? null, r.ctr ?? null, r.avgCpc ?? null, r.searchIs ?? null, r.searchTopIs ?? null,
        r.searchAbsTopIs ?? null, r.budgetLostIs ?? null, r.rankLostIs ?? null],
      input.observedAt,
    );
  }

  insertCampaignPerformanceBatch(input: SnapshotBatchInput<CampaignPerformanceSnapshot>): number {
    return this._insertSnapshot(
      'ads_campaign_performance',
      ['date', 'campaign_id', 'campaign_name', 'channel_type',
        'impressions', 'clicks', 'cost_micros', 'conversions', 'conv_value'],
      input.runId, input.adsAccountId, input.rows,
      r => [r.date, r.campaignId, r.campaignName ?? null, r.channelType ?? null,
        r.impressions ?? null, r.clicks ?? null, r.costMicros ?? null, r.conversions ?? null, r.convValue ?? null],
      input.observedAt,
    );
  }

  insertAdGroupsBatch(input: SnapshotBatchInput<AdGroupSnapshot>): number {
    return this._insertSnapshot(
      'ads_ad_groups',
      ['campaign_id', 'campaign_name', 'ad_group_id', 'ad_group_name', 'status',
        'impressions', 'clicks', 'cost_micros', 'conversions', 'conv_value', 'ctr', 'avg_cpc'],
      input.runId, input.adsAccountId, input.rows,
      r => [r.campaignId ?? null, r.campaignName, r.adGroupId ?? null, r.adGroupName, r.status ?? null,
        r.impressions ?? null, r.clicks ?? null, r.costMicros ?? null, r.conversions ?? null, r.convValue ?? null, r.ctr ?? null, r.avgCpc ?? null],
      input.observedAt,
    );
  }

  insertKeywordsBatch(input: SnapshotBatchInput<KeywordSnapshot>): number {
    return this._insertSnapshot(
      'ads_keywords',
      ['campaign_name', 'ad_group_name', 'keyword', 'match_type', 'status', 'quality_score',
        'impressions', 'clicks', 'cost_micros', 'conversions', 'conv_value', 'ctr', 'avg_cpc', 'search_is'],
      input.runId, input.adsAccountId, input.rows,
      r => [r.campaignName, r.adGroupName, r.keyword, r.matchType ?? null, r.status ?? null, r.qualityScore ?? null,
        r.impressions ?? null, r.clicks ?? null, r.costMicros ?? null, r.conversions ?? null, r.convValue ?? null, r.ctr ?? null, r.avgCpc ?? null, r.searchIs ?? null],
      input.observedAt,
    );
  }

  insertRsaAdsBatch(input: SnapshotBatchInput<RsaAdSnapshot>): number {
    return this._insertSnapshot(
      'ads_rsa_ads',
      ['campaign_name', 'ad_group_name', 'ad_id', 'headlines', 'descriptions',
        'final_url', 'status', 'ad_strength',
        'impressions', 'clicks', 'cost_micros', 'conversions', 'ctr'],
      input.runId, input.adsAccountId, input.rows,
      r => [r.campaignName, r.adGroupName, r.adId,
        JSON.stringify(r.headlines ?? []), JSON.stringify(r.descriptions ?? []),
        r.finalUrl ?? null, r.status ?? null, r.adStrength ?? null,
        r.impressions ?? null, r.clicks ?? null, r.costMicros ?? null, r.conversions ?? null, r.ctr ?? null],
      input.observedAt,
    );
  }

  insertAssetGroupsBatch(input: SnapshotBatchInput<AssetGroupSnapshot>): number {
    return this._insertSnapshot(
      'ads_asset_groups',
      ['campaign_id', 'campaign_name', 'asset_group_id', 'asset_group_name',
        'status', 'ad_strength', 'impressions', 'clicks', 'cost_micros', 'conversions', 'conv_value'],
      input.runId, input.adsAccountId, input.rows,
      r => [r.campaignId ?? null, r.campaignName ?? null, r.assetGroupId, r.assetGroupName,
        r.status ?? null, r.adStrength ?? null, r.impressions ?? null, r.clicks ?? null, r.costMicros ?? null, r.conversions ?? null, r.convValue ?? null],
      input.observedAt,
    );
  }

  insertAssetGroupAssetsBatch(input: SnapshotBatchInput<AssetGroupAssetSnapshot>): number {
    return this._insertSnapshot(
      'ads_asset_group_assets',
      ['campaign_name', 'asset_group_name', 'field_type', 'asset_status',
        'asset_id', 'asset_name', 'asset_type', 'text_content', 'image_url'],
      input.runId, input.adsAccountId, input.rows,
      r => [r.campaignName ?? null, r.assetGroupName, r.fieldType, r.assetStatus ?? null,
        r.assetId ?? null, r.assetName ?? null, r.assetType ?? null, r.textContent ?? null, r.imageUrl ?? null],
      input.observedAt,
    );
  }

  insertAssetsBatch(input: SnapshotBatchInput<AssetSnapshot>): number {
    return this._insertSnapshot(
      'ads_assets',
      ['asset_id', 'name', 'type', 'sitelink_text', 'sitelink_desc1',
        'sitelink_desc2', 'callout_text', 'snippet_header', 'snippet_values'],
      input.runId, input.adsAccountId, input.rows,
      r => [r.assetId, r.name ?? null, r.type, r.sitelinkText ?? null, r.sitelinkDesc1 ?? null,
        r.sitelinkDesc2 ?? null, r.calloutText ?? null, r.snippetHeader ?? null, r.snippetValues ?? null],
      input.observedAt,
    );
  }

  insertListingGroupsBatch(input: SnapshotBatchInput<ListingGroupSnapshot>): number {
    return this._insertSnapshot(
      'ads_listing_groups',
      ['campaign_name', 'asset_group_name', 'filter_id', 'filter_type',
        'brand', 'category_id', 'product_type', 'custom_attribute'],
      input.runId, input.adsAccountId, input.rows,
      r => [r.campaignName ?? null, r.assetGroupName ?? null, r.filterId ?? null, r.filterType ?? null,
        r.brand ?? null, r.categoryId ?? null, r.productType ?? null, r.customAttribute ?? null],
      input.observedAt,
    );
  }

  insertShoppingProductsBatch(input: SnapshotBatchInput<ShoppingProductSnapshot>): number {
    return this._insertSnapshot(
      'ads_shopping_products',
      ['campaign_name', 'item_id', 'title', 'brand', 'status',
        'channel', 'language', 'issues', 'impressions', 'clicks', 'cost_micros'],
      input.runId, input.adsAccountId, input.rows,
      r => [r.campaignName ?? null, r.itemId ?? null, r.title ?? null, r.brand ?? null, r.status ?? null,
        r.channel ?? null, r.language ?? null, r.issues ?? null, r.impressions ?? null, r.clicks ?? null, r.costMicros ?? null],
      input.observedAt,
    );
  }

  insertConversionActionsBatch(input: SnapshotBatchInput<ConversionActionSnapshot>): number {
    return this._insertSnapshot(
      'ads_conversion_actions',
      ['conv_action_id', 'name', 'type', 'category', 'status',
        'primary_for_goal', 'counting_type', 'attribution_model', 'default_value', 'in_conversions_metric'],
      input.runId, input.adsAccountId, input.rows,
      r => [r.convActionId, r.name ?? null, r.type ?? null, r.category ?? null, r.status ?? null,
        r.primaryForGoal === undefined ? null : (r.primaryForGoal ? 1 : 0),
        r.countingType ?? null, r.attributionModel ?? null, r.defaultValue ?? null,
        r.inConversionsMetric === undefined ? null : (r.inConversionsMetric ? 1 : 0)],
      input.observedAt,
    );
  }

  insertCampaignTargetingBatch(input: SnapshotBatchInput<CampaignTargetingSnapshot>): number {
    return this._insertSnapshot(
      'ads_campaign_targeting',
      ['campaign_id', 'campaign_name', 'criterion_type', 'is_negative', 'status',
        'bid_modifier', 'geo_target', 'language', 'keyword_text', 'match_type'],
      input.runId, input.adsAccountId, input.rows,
      r => [r.campaignId ?? null, r.campaignName ?? null, r.criterionType,
        r.isNegative === undefined ? 0 : (r.isNegative ? 1 : 0), r.status ?? null,
        r.bidModifier ?? null, r.geoTarget ?? null, r.language ?? null, r.keywordText ?? null, r.matchType ?? null],
      input.observedAt,
    );
  }

  insertSearchTermsBatch(input: SnapshotBatchInput<SearchTermSnapshot>): number {
    return this._insertSnapshot(
      'ads_search_terms',
      ['campaign_name', 'channel_type', 'ad_group_name', 'search_term', 'term_status',
        'impressions', 'clicks', 'cost_micros', 'conversions', 'conv_value', 'ctr'],
      input.runId, input.adsAccountId, input.rows,
      r => [r.campaignName ?? null, r.channelType ?? null, r.adGroupName ?? null, r.searchTerm, r.termStatus ?? null,
        r.impressions ?? null, r.clicks ?? null, r.costMicros ?? null, r.conversions ?? null, r.convValue ?? null, r.ctr ?? null],
      input.observedAt,
    );
  }

  insertPmaxSearchTermsBatch(input: SnapshotBatchInput<PmaxSearchTermSnapshot>): number {
    return this._insertSnapshot(
      'ads_pmax_search_terms',
      ['campaign_id', 'campaign_name', 'search_category', 'insight_id'],
      input.runId, input.adsAccountId, input.rows,
      r => [r.campaignId ?? null, r.campaignName ?? null, r.searchCategory ?? null, r.insightId ?? null],
      input.observedAt,
    );
  }

  insertPmaxPlacementsBatch(input: SnapshotBatchInput<PmaxPlacementSnapshot>): number {
    return this._insertSnapshot(
      'ads_pmax_placements',
      ['campaign_id', 'campaign_name', 'placement', 'placement_type', 'target_url'],
      input.runId, input.adsAccountId, input.rows,
      r => [r.campaignId ?? null, r.campaignName ?? null, r.placement ?? null, r.placementType ?? null, r.targetUrl ?? null],
      input.observedAt,
    );
  }

  insertLandingPagesBatch(input: SnapshotBatchInput<LandingPageSnapshot>): number {
    return this._insertSnapshot(
      'ads_landing_pages',
      ['campaign_name', 'landing_page_url', 'impressions', 'clicks',
        'cost_micros', 'conversions', 'conv_value', 'avg_cpc'],
      input.runId, input.adsAccountId, input.rows,
      r => [r.campaignName ?? null, r.landingPageUrl, r.impressions ?? null, r.clicks ?? null,
        r.costMicros ?? null, r.conversions ?? null, r.convValue ?? null, r.avgCpc ?? null],
      input.observedAt,
    );
  }

  insertAdAssetRatingsBatch(input: SnapshotBatchInput<AdAssetRatingSnapshot>): number {
    return this._insertSnapshot(
      'ads_ad_asset_ratings',
      ['campaign_name', 'ad_group_name', 'field_type', 'performance_label', 'enabled',
        'text_content', 'impressions', 'clicks', 'cost_micros', 'conversions'],
      input.runId, input.adsAccountId, input.rows,
      r => [r.campaignName ?? null, r.adGroupName ?? null, r.fieldType, r.performanceLabel ?? null,
        r.enabled === undefined ? 1 : (r.enabled ? 1 : 0),
        r.textContent ?? null, r.impressions ?? null, r.clicks ?? null, r.costMicros ?? null, r.conversions ?? null],
      input.observedAt,
    );
  }

  insertAudienceSignalsBatch(input: SnapshotBatchInput<AudienceSignalSnapshot>): number {
    return this._insertSnapshot(
      'ads_audience_signals',
      ['campaign_name', 'asset_group_name', 'signal_type', 'signal_label'],
      input.runId, input.adsAccountId, input.rows,
      r => [r.campaignName ?? null, r.assetGroupName ?? null, r.signalType ?? null, r.signalLabel ?? null],
      input.observedAt,
    );
  }

  insertDevicePerformanceBatch(input: SnapshotBatchInput<DevicePerformanceSnapshot>): number {
    return this._insertSnapshot(
      'ads_device_performance',
      ['campaign_id', 'campaign_name', 'channel_type', 'device',
        'impressions', 'clicks', 'cost_micros', 'conversions', 'conv_value', 'ctr'],
      input.runId, input.adsAccountId, input.rows,
      r => [r.campaignId ?? null, r.campaignName ?? null, r.channelType ?? null, r.device,
        r.impressions ?? null, r.clicks ?? null, r.costMicros ?? null, r.conversions ?? null, r.convValue ?? null, r.ctr ?? null],
      input.observedAt,
    );
  }

  insertGeoPerformanceBatch(input: SnapshotBatchInput<GeoPerformanceSnapshot>): number {
    return this._insertSnapshot(
      'ads_geo_performance',
      ['campaign_id', 'campaign_name', 'country_id', 'location_type', 'geo_target_region',
        'impressions', 'clicks', 'cost_micros', 'conversions', 'conv_value'],
      input.runId, input.adsAccountId, input.rows,
      r => [r.campaignId ?? null, r.campaignName ?? null, r.countryId ?? null, r.locationType ?? null, r.geoTargetRegion ?? null,
        r.impressions ?? null, r.clicks ?? null, r.costMicros ?? null, r.conversions ?? null, r.convValue ?? null],
      input.observedAt,
    );
  }

  insertChangeHistoryBatch(input: SnapshotBatchInput<ChangeHistorySnapshot>): number {
    return this._insertSnapshot(
      'ads_change_history',
      ['change_date', 'resource_type', 'operation', 'changed_fields',
        'user_email', 'client_type', 'campaign_name'],
      input.runId, input.adsAccountId, input.rows,
      r => [r.changeDate, r.resourceType ?? null, r.operation ?? null, r.changedFields ?? null,
        r.userEmail ?? null, r.clientType ?? null, r.campaignName ?? null],
      input.observedAt,
    );
  }

  insertGa4ObservationsBatch(input: SnapshotBatchInput<Ga4ObservationSnapshot>): number {
    return this._insertSnapshot(
      'ga4_observations',
      ['date', 'session_source', 'session_medium', 'sessions', 'total_users',
        'new_users', 'bounce_rate', 'avg_session_duration', 'conversions', 'event_count'],
      input.runId, input.adsAccountId, input.rows,
      r => [r.date, r.sessionSource ?? null, r.sessionMedium ?? null, r.sessions ?? null, r.totalUsers ?? null,
        r.newUsers ?? null, r.bounceRate ?? null, r.avgSessionDuration ?? null, r.conversions ?? null, r.eventCount ?? null],
      input.observedAt,
    );
  }

  insertGscObservationsBatch(input: SnapshotBatchInput<GscObservationSnapshot>): number {
    return this._insertSnapshot(
      'gsc_observations',
      ['date_month', 'query', 'page', 'country', 'device',
        'clicks', 'impressions', 'ctr', 'position'],
      input.runId, input.adsAccountId, input.rows,
      r => [r.dateMonth, r.query ?? null, r.page ?? null, r.country ?? null, r.device ?? null,
        r.clicks ?? null, r.impressions ?? null, r.ctr ?? null, r.position ?? null],
      input.observedAt,
    );
  }

  // ── Latest-State Readers ──────────────────────────────────────
  // Convenience wrappers around: SELECT * FROM <table> WHERE source_run_id =
  // (latest successful run for this account). Used by audit-tool consumers.

  private _resolveRunId(adsAccountId: string, runId?: number | undefined): number | null {
    if (runId !== undefined) return runId;
    return this.getLatestSuccessfulAuditRun(adsAccountId)?.run_id ?? null;
  }

  /** Generic latest-snapshot read. Returns rows matching source_run_id of the
   *  given run (defaults to latest successful run for the account). */
  getSnapshotRows<T>(table: string, adsAccountId: string, opts?: { runId?: number | undefined; limit?: number | undefined } | undefined): T[] {
    const resolvedRunId = this._resolveRunId(adsAccountId, opts?.runId);
    if (resolvedRunId === null) return [];
    const limit = opts?.limit !== undefined ? Math.max(1, Math.min(opts.limit, 5000)) : null;
    const limitClause = limit ? ` LIMIT ${limit}` : '';
    return this.db.prepare(`
      SELECT * FROM "${table}" WHERE source_run_id = ? AND ads_account_id = ?${limitClause}
    `).all(resolvedRunId, adsAccountId) as T[];
  }

  countSnapshotRows(table: string, adsAccountId: string, runId?: number | undefined): number {
    const resolvedRunId = this._resolveRunId(adsAccountId, runId);
    if (resolvedRunId === null) return 0;
    const row = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM "${table}" WHERE source_run_id = ? AND ads_account_id = ?
    `).get(resolvedRunId, adsAccountId) as { cnt: number };
    return row.cnt;
  }

  /** Total cost (CHF) for all campaigns in the latest run — sanity check helper. */
  getLatestSpend(adsAccountId: string): number {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(cost_micros), 0) as total FROM ads_campaigns
      WHERE source_run_id = (
        SELECT run_id FROM ads_audit_runs
        WHERE ads_account_id = ? AND status = 'SUCCESS'
        ORDER BY finished_at DESC, run_id DESC LIMIT 1
      ) AND ads_account_id = ?
    `).get(adsAccountId, adsAccountId) as { total: number };
    return row.total / 1_000_000;
  }

  /** Run a parameterized aggregation view against a specific run scope.
   *  Returns view rows filtered to the given run_id and account. */
  queryView(
    viewName: string,
    adsAccountId: string,
    opts?: { runId?: number | undefined; limit?: number | undefined; orderBy?: string | undefined } | undefined,
  ): Array<Record<string, unknown>> {
    // Whitelist: only views from this module's schema may be queried.
    // Validated before run resolution so misuse always throws, not silent-empty.
    if (!ALLOWED_VIEW_NAMES.has(viewName)) {
      throw new Error(`Unknown view "${viewName}". Allowed: ${[...ALLOWED_VIEW_NAMES].join(', ')}`);
    }
    const resolvedRunId = this._resolveRunId(adsAccountId, opts?.runId);
    if (resolvedRunId === null) return [];
    const limit = opts?.limit !== undefined ? Math.max(1, Math.min(opts.limit, 5000)) : 500;
    const orderClause = opts?.orderBy && /^[a-z_][a-z0-9_]*( (ASC|DESC))?$/i.test(opts.orderBy)
      ? ` ORDER BY ${opts.orderBy}`
      : '';
    return this.db.prepare(`
      SELECT * FROM "${viewName}"
      WHERE source_run_id = ? AND ads_account_id = ?${orderClause}
      LIMIT ${limit}
    `).all(resolvedRunId, adsAccountId) as Array<Record<string, unknown>>;
  }
}

// ── Module-level helpers (after class so the SqlValue type is visible) ──

type SqlValue = string | number | bigint | Buffer | null;

export interface SnapshotBatchInput<T> {
  runId: number;
  adsAccountId: string;
  rows: readonly T[];
  observedAt?: string | undefined;
}

const ALLOWED_VIEW_NAMES: ReadonlySet<string> = new Set([
  'view_audit_kpis',
  'view_audit_campaign_summary',
  'view_audit_device_split',
  'view_audit_geo_top10',
  'view_audit_top_search_terms',
  'view_audit_pmax_categories',
  'view_audit_low_performers',
  'view_audit_disapproved_products',
  'view_audit_change_history_summary',
  'view_blueprint_negative_candidates',
  'view_blueprint_organic_overlap',
  'view_blueprint_ga4_conversion_delta',
  'view_blueprint_landing_page_perf',
]);
