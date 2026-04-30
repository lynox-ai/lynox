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
     conv_value REAL,
     observed_at TEXT NOT NULL
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

  // Migration v2: ads_findings — qualitative + deterministic audit insights, run-keyed
  // for cross-run diff. Mirrored as KG facts for semantic pattern-detection in later cycles.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (2);

   CREATE TABLE IF NOT EXISTS ads_findings (
     finding_id INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id INTEGER NOT NULL REFERENCES ads_audit_runs(run_id),
     ads_account_id TEXT NOT NULL,
     area TEXT NOT NULL,
     severity TEXT NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH')),
     source TEXT NOT NULL CHECK (source IN ('deterministic', 'agent')),
     text TEXT NOT NULL,
     confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
     evidence_json TEXT NOT NULL DEFAULT '{}',
     kg_memory_id TEXT,
     created_at TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_findings_run ON ads_findings(run_id, severity);
   CREATE INDEX IF NOT EXISTS idx_findings_area ON ads_findings(ads_account_id, area);`,

  // Migration v3: ads_blueprint_entities — proposed entity changes from the
  // P3 Blueprint phase. Run-keyed; P4 Emit reads via run_id and renders the
  // Editor-CSV. The companion ads_run_decisions table persists the
  // KEEP/RENAME/PAUSE/NEW classification at history-preservation time;
  // ads_blueprint_entities additionally carries the full entity payload.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (3);

   CREATE TABLE IF NOT EXISTS ads_blueprint_entities (
     blueprint_id INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id INTEGER NOT NULL REFERENCES ads_audit_runs(run_id),
     ads_account_id TEXT NOT NULL,
     entity_type TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('KEEP', 'RENAME', 'NEW', 'PAUSE', 'SPLIT', 'MERGE')),
     external_id TEXT NOT NULL,
     previous_external_id TEXT,
     payload_json TEXT NOT NULL DEFAULT '{}',
     confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
     rationale TEXT NOT NULL DEFAULT '',
     naming_valid INTEGER NOT NULL DEFAULT 1,
     naming_errors_json TEXT NOT NULL DEFAULT '[]',
     created_at TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_blueprint_run ON ads_blueprint_entities(run_id, entity_type);
   CREATE INDEX IF NOT EXISTS idx_blueprint_kind ON ads_blueprint_entities(run_id, kind);
   CREATE INDEX IF NOT EXISTS idx_blueprint_account ON ads_blueprint_entities(ads_account_id, entity_type);`,

  // Migration v4: track blueprint-row source so an `ads_blueprint_run`
  // re-run can wipe its own deterministic rows without trampling the
  // agent's qualitative additions (asset proposals, audience signals,
  // PMAX SPLIT/MERGE proposals validated through the safeguards).
  `INSERT OR IGNORE INTO schema_version (version) VALUES (4);

   ALTER TABLE ads_blueprint_entities
     ADD COLUMN source TEXT NOT NULL DEFAULT 'deterministic'
     CHECK (source IN ('deterministic', 'agent'));
   CREATE INDEX IF NOT EXISTS idx_blueprint_source ON ads_blueprint_entities(run_id, source);`,

  // Migration v5: campaign-level bid-strategy + targets. The audit's
  // performance-verification compares delivered ROAS/CPA against the
  // customer profile default today; once these columns are populated
  // by the GAS export, the audit can compare against the actual
  // campaign-level target. Critical for PMAX optimisation decisions
  // because PMAX campaigns often have heterogeneous targets even
  // within one customer.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (5);

   ALTER TABLE ads_campaigns ADD COLUMN bidding_strategy_type TEXT;
   ALTER TABLE ads_campaigns ADD COLUMN target_roas REAL;
   ALTER TABLE ads_campaigns ADD COLUMN target_cpa_micros INTEGER;`,

  // Migration v6: Phase A operator-review queue. Blueprint generators
  // attach review markers to entities whose deterministic pick is
  // ambiguous (e.g. theme-AG without a slug-matching landing page,
  // brand-AG whose top-clicks LP doesn't carry the brand token).
  // The companion ads_blueprint_review_picks tool drains this queue
  // via a single batched ask_user prompt and writes the operator's
  // chosen value back into payload_json; emit blocks while pending
  // reviews exist for the run.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (6);

   ALTER TABLE ads_blueprint_entities
     ADD COLUMN needs_review_json TEXT NOT NULL DEFAULT '[]';
   CREATE INDEX IF NOT EXISTS idx_blueprint_review
     ON ads_blueprint_entities(run_id) WHERE needs_review_json != '[]';`,

  // Migration v7: Phase C pre-emit sanity-check findings need a
  // dedicated severity 'BLOCK' that the emit engine treats as a
  // hard gate. Existing 'HIGH' findings continue to render as
  // warnings — they predate Phase C and never blocked emit.
  // SQLite's CHECK constraint cannot be ALTER'd in place, so the
  // table is rebuilt the standard way: rename, recreate, copy.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (7);

   ALTER TABLE ads_findings RENAME TO ads_findings_v6;
   CREATE TABLE ads_findings (
     finding_id INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id INTEGER NOT NULL REFERENCES ads_audit_runs(run_id),
     ads_account_id TEXT NOT NULL,
     area TEXT NOT NULL,
     severity TEXT NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'BLOCK')),
     source TEXT NOT NULL CHECK (source IN ('deterministic', 'agent')),
     text TEXT NOT NULL,
     confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
     evidence_json TEXT NOT NULL DEFAULT '{}',
     kg_memory_id TEXT,
     created_at TEXT NOT NULL
   );
   INSERT INTO ads_findings (
     finding_id, run_id, ads_account_id, area, severity, source,
     text, confidence, evidence_json, kg_memory_id, created_at
   ) SELECT
     finding_id, run_id, ads_account_id, area, severity, source,
     text, confidence, evidence_json, kg_memory_id, created_at
   FROM ads_findings_v6;
   DROP TABLE ads_findings_v6;
   CREATE INDEX IF NOT EXISTS idx_findings_run ON ads_findings(run_id, severity);
   CREATE INDEX IF NOT EXISTS idx_findings_area ON ads_findings(ads_account_id, area);`,

  // Migration v8: Strategist-Brief + Critique persistence. The brief
  // is the LLM-synthesized headline + priorities + risks + do-not-touch
  // list emitted by ads_strategist_brief after each audit run; the
  // critique is the LLM-driven challenge of the auto-blueprint emitted
  // by ads_blueprint_critique. Both are persisted so subsequent cycles
  // can reference / diff against them, and so the audit Markdown can
  // include them as the "lead" section.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (8);

   CREATE TABLE IF NOT EXISTS ads_strategist_briefs (
     brief_id INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id INTEGER NOT NULL REFERENCES ads_audit_runs(run_id),
     ads_account_id TEXT NOT NULL,
     account_state TEXT NOT NULL CHECK (account_state IN
       ('greenfield', 'bootstrap', 'messy_running', 'structured_optimizing', 'high_performance')),
     headline TEXT NOT NULL,
     priorities_json TEXT NOT NULL DEFAULT '[]',
     risks_json TEXT NOT NULL DEFAULT '[]',
     do_not_touch_json TEXT NOT NULL DEFAULT '[]',
     classification_reason TEXT NOT NULL DEFAULT '',
     llm_failed INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_briefs_run ON ads_strategist_briefs(run_id);
   CREATE INDEX IF NOT EXISTS idx_briefs_account_state ON ads_strategist_briefs(ads_account_id, account_state);

   CREATE TABLE IF NOT EXISTS ads_blueprint_critiques (
     critique_id INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id INTEGER NOT NULL REFERENCES ads_audit_runs(run_id),
     ads_account_id TEXT NOT NULL,
     challenges_json TEXT NOT NULL DEFAULT '[]',
     llm_failed INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_critiques_run ON ads_blueprint_critiques(run_id);`,

  // Migration v9: P3 Customer-Profile-Depth. Six optional JSON / text
  // fields that flesh out the customer profile so D4 Strategist Brief
  // and D5 Blueprint Critique can synthesize sharper, more contextual
  // recommendations (persona-aware copy, brand-voice-aware critique,
  // compliance-aware Negatives, etc). All fields default to empty —
  // graceful degradation when an operator hasn't filled them yet.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (9);

   ALTER TABLE customer_profiles ADD COLUMN personas_json TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE customer_profiles ADD COLUMN brand_voice_json TEXT NOT NULL DEFAULT '{}';
   ALTER TABLE customer_profiles ADD COLUMN usp_json TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE customer_profiles ADD COLUMN compliance_constraints TEXT NOT NULL DEFAULT '';
   ALTER TABLE customer_profiles ADD COLUMN pricing_strategy TEXT NOT NULL DEFAULT '';
   ALTER TABLE customer_profiles ADD COLUMN seasonal_patterns TEXT NOT NULL DEFAULT '';`,

  // Migration v10: P4 last-cycle-impact field on strategist briefs.
  // The brief now carries an optional narrative that compares the
  // PREVIOUS cycle's proposed priorities to what was actually
  // implemented (manual-change drift) and the measured effect (KPI
  // verification). Only populated from cycle 2 onwards — cycle 1
  // briefs leave it blank.
  `INSERT OR IGNORE INTO schema_version (version) VALUES (10);

   ALTER TABLE ads_strategist_briefs ADD COLUMN last_cycle_impact TEXT NOT NULL DEFAULT '';`,
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
  // P3 depth fields — all optional, default empty so cycle-1 customers
  // without a refined profile still flow through. Strategist + Critique
  // read these when present and ignore them when blank.
  personas_json: string;
  brand_voice_json: string;
  usp_json: string;
  compliance_constraints: string;
  pricing_strategy: string;
  seasonal_patterns: string;
  created_at: string;
  updated_at: string;
}

/** Persona shape used inside personas_json. Free-form by design — the
 *  agent / operator picks the depth they want. Only `name` is required. */
export interface CustomerPersona {
  name: string;
  age_range?: string | undefined;
  motivation?: string | undefined;
  pain_points?: readonly string[] | undefined;
  buying_triggers?: readonly string[] | undefined;
}

/** Brand-voice descriptor used inside brand_voice_json. Same free-form
 *  rule — operator can fill what's relevant, omit the rest. */
export interface CustomerBrandVoice {
  tone?: string | undefined;
  voice_examples?: readonly string[] | undefined;
  do_not_use?: readonly string[] | undefined;
  signature_phrases?: readonly string[] | undefined;
}

export interface AdsAccountRow {
  ads_account_id: string;
  customer_id: string;
  account_label: string;
  currency_code: string | null;
  timezone: string | null;
  mode: 'BOOTSTRAP' | 'FIRST_IMPORT' | 'OPTIMIZE';
  drive_folder_id: string | null;
  last_major_import_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AdsAuditRunRow {
  run_id: number;
  ads_account_id: string;
  status: 'RUNNING' | 'SUCCESS' | 'FAILED' | 'LOCKED';
  mode: 'BOOTSTRAP' | 'FIRST_IMPORT' | 'OPTIMIZE';
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

export type AdsFindingSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'BLOCK';

export type AdsAccountState =
  | 'greenfield'
  | 'bootstrap'
  | 'messy_running'
  | 'structured_optimizing'
  | 'high_performance';

export interface StrategistPriority {
  title: string;
  rationale: string;
  actions: string[];
}

export interface StrategistBriefRow {
  brief_id: number;
  run_id: number;
  ads_account_id: string;
  account_state: AdsAccountState;
  headline: string;
  priorities_json: string;
  risks_json: string;
  do_not_touch_json: string;
  classification_reason: string;
  llm_failed: number;
  /** P4: optional narrative comparing previous-cycle proposals to
   *  what was implemented and the measured effect. Empty on cycle 1. */
  last_cycle_impact: string;
  created_at: string;
}

export interface InsertStrategistBriefInput {
  runId: number;
  adsAccountId: string;
  accountState: AdsAccountState;
  headline: string;
  priorities: readonly StrategistPriority[];
  risks: readonly string[];
  doNotTouch: readonly string[];
  classificationReason: string;
  llmFailed: boolean;
  /** P4: optional last-cycle narrative. Pass empty string when not
   *  applicable (cycle 1) or when no previous brief exists. */
  lastCycleImpact?: string | undefined;
}

export interface BlueprintCritiqueChallenge {
  title: string;
  challenge: string;
  /** Optional pointer back to the blueprint entity / finding the
   *  challenge concerns, so the operator can drill in. */
  ref?: string | undefined;
}

export interface BlueprintCritiqueRow {
  critique_id: number;
  run_id: number;
  ads_account_id: string;
  challenges_json: string;
  llm_failed: number;
  created_at: string;
}

export interface InsertBlueprintCritiqueInput {
  runId: number;
  adsAccountId: string;
  challenges: readonly BlueprintCritiqueChallenge[];
  llmFailed: boolean;
}
export type AdsFindingSource = 'deterministic' | 'agent';

export type AdsBlueprintEntityKind = 'KEEP' | 'RENAME' | 'NEW' | 'PAUSE' | 'SPLIT' | 'MERGE';
export type AdsBlueprintSource = 'deterministic' | 'agent';

export interface AdsBlueprintEntityRow {
  blueprint_id: number;
  run_id: number;
  ads_account_id: string;
  entity_type: string;
  kind: AdsBlueprintEntityKind;
  external_id: string;
  previous_external_id: string | null;
  payload_json: string;
  confidence: number;
  rationale: string;
  naming_valid: number;
  naming_errors_json: string;
  source: AdsBlueprintSource;
  needs_review_json: string;
  created_at: string;
}

/** A pending operator-review marker attached to a blueprint entity.
 *  Surfaced through `ads_blueprint_review_picks` as a single batched
 *  ask_user dialog; the operator's chosen `value` is written into
 *  payload_json.{field} and the marker is removed. Emit blocks until
 *  every review for the run is drained. */
export interface BlueprintReviewItem {
  /** payload_json field that will be overwritten with the chosen value. */
  field: string;
  /** Machine-readable category, e.g. 'ambiguous_url_pick'. */
  reason: string;
  /** Operator-facing question (German). */
  prompt: string;
  /** Choices. Each candidate is shown to the operator with `label`; the
   *  resolved `value` is what gets written into payload_json.{field}. */
  candidates: ReadonlyArray<{
    value: string;
    label: string;
    /** Optional supplemental info for the operator (e.g. clicks/conversions). */
    hint?: string | undefined;
  }>;
}

export interface InsertBlueprintEntityInput {
  runId: number;
  adsAccountId: string;
  entityType: string;
  kind: AdsBlueprintEntityKind;
  externalId: string;
  previousExternalId?: string | undefined;
  payload?: Record<string, unknown> | undefined;
  confidence: number;
  rationale?: string | undefined;
  namingValid?: boolean | undefined;
  namingErrors?: readonly string[] | undefined;
  source?: AdsBlueprintSource | undefined;
  needsReview?: readonly BlueprintReviewItem[] | undefined;
}

export interface AdsFindingRow {
  finding_id: number;
  run_id: number;
  ads_account_id: string;
  area: string;
  severity: AdsFindingSeverity;
  source: AdsFindingSource;
  text: string;
  confidence: number;
  evidence_json: string;
  kg_memory_id: string | null;
  created_at: string;
}

export interface InsertFindingInput {
  runId: number;
  adsAccountId: string;
  area: string;
  severity: AdsFindingSeverity;
  source: AdsFindingSource;
  text: string;
  confidence: number;
  evidence?: Record<string, unknown> | undefined;
  kgMemoryId?: string | undefined;
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
  // P3 depth fields — all optional. Pass undefined to leave the
  // existing value untouched (upsert preserves prior depth on partial
  // updates so iterative refinement doesn't wipe earlier inputs).
  personas?: readonly CustomerPersona[] | undefined;
  brandVoice?: CustomerBrandVoice | undefined;
  usp?: readonly string[] | undefined;
  complianceConstraints?: string | undefined;
  pricingStrategy?: string | undefined;
  seasonalPatterns?: string | undefined;
}

export interface UpsertAdsAccountInput {
  adsAccountId: string;
  customerId: string;
  accountLabel: string;
  currencyCode?: string | undefined;
  timezone?: string | undefined;
  mode?: 'BOOTSTRAP' | 'FIRST_IMPORT' | 'OPTIMIZE' | undefined;
  driveFolderId?: string | undefined;
}

export interface CreateAuditRunInput {
  adsAccountId: string;
  mode: 'BOOTSTRAP' | 'FIRST_IMPORT' | 'OPTIMIZE';
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

    // P3 partial-update preservation: when an input field is undefined
    // AND the row already exists, keep the existing column value.
    // This lets the operator iteratively refine the profile across
    // calls (set personas in call 1, brand_voice in call 2) without
    // each call wiping the prior depth fields.
    const personasJson = input.personas !== undefined
      ? JSON.stringify(input.personas)
      : (existing?.personas_json ?? '[]');
    const brandVoiceJson = input.brandVoice !== undefined
      ? JSON.stringify(input.brandVoice)
      : (existing?.brand_voice_json ?? '{}');
    const uspJson = input.usp !== undefined
      ? JSON.stringify(input.usp)
      : (existing?.usp_json ?? '[]');
    const complianceConstraints = input.complianceConstraints ?? existing?.compliance_constraints ?? '';
    const pricingStrategy = input.pricingStrategy ?? existing?.pricing_strategy ?? '';
    const seasonalPatterns = input.seasonalPatterns ?? existing?.seasonal_patterns ?? '';

    this.db.prepare(`
      INSERT INTO customer_profiles (
        customer_id, client_name, business_model, offer_summary, primary_goal,
        target_roas, target_cpa_chf, monthly_budget_chf, typical_cpc_chf,
        country, timezone, languages, top_products, own_brands, sold_brands,
        competitors, pmax_owned_head_terms, naming_convention_pattern,
        tracking_notes,
        personas_json, brand_voice_json, usp_json,
        compliance_constraints, pricing_strategy, seasonal_patterns,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        personas_json = excluded.personas_json,
        brand_voice_json = excluded.brand_voice_json,
        usp_json = excluded.usp_json,
        compliance_constraints = excluded.compliance_constraints,
        pricing_strategy = excluded.pricing_strategy,
        seasonal_patterns = excluded.seasonal_patterns,
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
      personasJson, brandVoiceJson, uspJson,
      complianceConstraints, pricingStrategy, seasonalPatterns,
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

  /** Look up the campaign_name for an asset_group_name within a run. Returns
   *  null if no asset_group with that name exists, or the name is ambiguous
   *  (multiple asset_groups with the same name in different campaigns).
   *
   *  Resolves in two passes: first the snapshot (`ads_asset_groups` table),
   *  then NEW asset_groups proposed in the current run's blueprint. The
   *  blueprint pass is essential when the agent proposes assets for an
   *  asset_group that was created earlier in the same run — without it the
   *  agent has to guess `campaign_name` and routinely picks the wrong one
   *  (see aquanatura cycle 6: "Wasserfilter-Kaufen" was created under
   *  "PMax | Gesamtsortiment" but assets ended up under "PMax | Wasserfilter"
   *  because the agent inferred from the name).
   */
  findCampaignNameByAssetGroup(runId: number, adsAccountId: string, assetGroupName: string): string | null {
    const snapshotRows = this.db.prepare(
      'SELECT DISTINCT campaign_name FROM ads_asset_groups ' +
      'WHERE source_run_id = ? AND ads_account_id = ? AND asset_group_name = ? AND campaign_name IS NOT NULL',
    ).all(runId, adsAccountId, assetGroupName) as Array<{ campaign_name: string }>;
    if (snapshotRows.length === 1) return snapshotRows[0]!.campaign_name;
    if (snapshotRows.length > 1) return null;

    // Snapshot didn't resolve. Try NEW asset_groups proposed in this run.
    const blueprintRows = this.db.prepare(
      `SELECT DISTINCT json_extract(payload_json, '$.campaign_name') AS campaign_name
       FROM ads_blueprint_entities
       WHERE run_id = ? AND ads_account_id = ?
         AND entity_type = 'asset_group' AND kind = 'NEW'
         AND json_extract(payload_json, '$.asset_group_name') = ?
         AND json_extract(payload_json, '$.campaign_name') IS NOT NULL`,
    ).all(runId, adsAccountId, assetGroupName) as Array<{ campaign_name: string }>;
    if (blueprintRows.length === 1) return blueprintRows[0]!.campaign_name;
    return null;
  }

  /** List distinct campaign names from the snapshot for a run. Used to surface
   *  the choice set in error messages when an agent needs to pick one. */
  listCampaignNamesForRun(runId: number, adsAccountId: string): string[] {
    return (this.db.prepare(
      'SELECT DISTINCT campaign_name FROM ads_campaigns ' +
      'WHERE source_run_id = ? AND ads_account_id = ? AND campaign_name IS NOT NULL ORDER BY campaign_name',
    ).all(runId, adsAccountId) as Array<{ campaign_name: string }>)
      .map(r => r.campaign_name);
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

  /** Stamp the canonical-blueprint hash onto an already-SUCCESS run (called by P4 emit). */
  setEmittedCsvHash(runId: number, hash: string): void {
    this.db.prepare('UPDATE ads_audit_runs SET emitted_csv_hash = ? WHERE run_id = ?')
      .run(hash, runId);
  }

  /** Record a customer's Editor import timestamp — drives the 14d Smart-Bidding-Guard. */
  setLastMajorImportAt(adsAccountId: string, iso: string): void {
    this.db.prepare(`
      UPDATE ads_accounts SET last_major_import_at = ?, updated_at = ?
      WHERE ads_account_id = ?
    `).run(iso, new Date().toISOString(), adsAccountId);
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

  /** Latest SUCCESS run that actually has at least one blueprint_entity row.
   *  Used by emit to bridge the chicken-and-egg case where a fresh data_pull
   *  created a newer audit run but its blueprint was skipped (pending import
   *  from the previous run). */
  findLatestRunWithBlueprintEntities(adsAccountId: string): AdsAuditRunRow | null {
    return this.db.prepare(`
      SELECT r.* FROM ads_audit_runs r
      WHERE r.ads_account_id = ? AND r.status = 'SUCCESS'
        AND EXISTS (SELECT 1 FROM ads_blueprint_entities e WHERE e.run_id = r.run_id)
      ORDER BY r.finished_at DESC, r.run_id DESC LIMIT 1
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

  // ── Findings ─────────────────────────────────────────────────
  // Hybrid storage: structured row here for cross-run diff + queryability,
  // optional kg_memory_id back-reference when the same finding is also
  // mirrored to KG via knowledgeLayer.store() for semantic pattern detection.

  insertFinding(input: InsertFindingInput): AdsFindingRow {
    const now = new Date().toISOString();
    const evidence = JSON.stringify(input.evidence ?? {});
    const result = this.db.prepare(`
      INSERT INTO ads_findings (
        run_id, ads_account_id, area, severity, source, text,
        confidence, evidence_json, kg_memory_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.runId, input.adsAccountId, input.area, input.severity,
      input.source, input.text, input.confidence, evidence,
      input.kgMemoryId ?? null, now,
    );
    return this.db.prepare('SELECT * FROM ads_findings WHERE finding_id = ?')
      .get(Number(result.lastInsertRowid)) as AdsFindingRow;
  }

  setFindingKgMemoryId(findingId: number, kgMemoryId: string): void {
    this.db.prepare('UPDATE ads_findings SET kg_memory_id = ? WHERE finding_id = ?')
      .run(kgMemoryId, findingId);
  }

  /** Delete every finding for a run whose area starts with the given
   *  prefix. Used by the Phase-C pre-emit-review tool to clear its
   *  prior verdict before re-running so the operator's fixes get
   *  re-evaluated against the current blueprint state. */
  deleteFindingsByAreaPrefix(runId: number, areaPrefix: string): number {
    const result = this.db.prepare(`
      DELETE FROM ads_findings WHERE run_id = ? AND area LIKE ? || '%'
    `).run(runId, areaPrefix);
    return Number(result.changes);
  }

  /** Delete every finding for a run with the given source. The audit
   *  tool calls this before persisting so re-runs replace (not
   *  accumulate) deterministic findings. Phase-C tool findings live
   *  under source='agent' and are unaffected. */
  deleteFindingsBySource(runId: number, source: AdsFindingSource): number {
    const result = this.db.prepare(`
      DELETE FROM ads_findings WHERE run_id = ? AND source = ?
    `).run(runId, source);
    return Number(result.changes);
  }

  // ── Strategist Brief (D4) ──────────────────────────────────────
  // The brief is the LLM-synthesized "lead" of the audit Markdown:
  // account-state classification + 3 priorities + risks + don't-touch
  // list. Replaces (not appends) on re-run so the audit Markdown
  // stays accurate when the user re-triggers ads_audit_run.

  insertStrategistBrief(input: InsertStrategistBriefInput): StrategistBriefRow {
    const now = new Date().toISOString();
    // Replace pattern — re-running audit re-synthesizes the brief.
    this.db.prepare('DELETE FROM ads_strategist_briefs WHERE run_id = ?').run(input.runId);
    const result = this.db.prepare(`
      INSERT INTO ads_strategist_briefs (
        run_id, ads_account_id, account_state, headline,
        priorities_json, risks_json, do_not_touch_json,
        classification_reason, llm_failed, last_cycle_impact, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.runId, input.adsAccountId, input.accountState, input.headline,
      JSON.stringify(input.priorities), JSON.stringify(input.risks),
      JSON.stringify(input.doNotTouch),
      input.classificationReason, input.llmFailed ? 1 : 0,
      input.lastCycleImpact ?? '', now,
    );
    return this.db.prepare('SELECT * FROM ads_strategist_briefs WHERE brief_id = ?')
      .get(Number(result.lastInsertRowid)) as StrategistBriefRow;
  }

  /** Fetch the strategist brief for the run that immediately preceded
   *  the given run on the same account. Used by the brief generator
   *  to ground the last-cycle-impact narrative. Returns null when
   *  there is no previous run or no brief was ever stored. */
  getPreviousBrief(currentRunId: number, adsAccountId: string): StrategistBriefRow | null {
    return this.db.prepare(`
      SELECT * FROM ads_strategist_briefs
      WHERE ads_account_id = ? AND run_id < ?
      ORDER BY run_id DESC
      LIMIT 1
    `).get(adsAccountId, currentRunId) as StrategistBriefRow | undefined ?? null;
  }

  getStrategistBrief(runId: number): StrategistBriefRow | null {
    return this.db.prepare('SELECT * FROM ads_strategist_briefs WHERE run_id = ?')
      .get(runId) as StrategistBriefRow | undefined ?? null;
  }

  // ── Blueprint Critique (D5) ────────────────────────────────────
  // The critique is the LLM-driven challenge of the auto-blueprint —
  // 3-5 challenges that the operator should consider before emit.
  // Replaces on re-run so a fresh blueprint always gets a fresh
  // critique.

  insertBlueprintCritique(input: InsertBlueprintCritiqueInput): BlueprintCritiqueRow {
    const now = new Date().toISOString();
    this.db.prepare('DELETE FROM ads_blueprint_critiques WHERE run_id = ?').run(input.runId);
    const result = this.db.prepare(`
      INSERT INTO ads_blueprint_critiques (
        run_id, ads_account_id, challenges_json, llm_failed, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      input.runId, input.adsAccountId,
      JSON.stringify(input.challenges), input.llmFailed ? 1 : 0, now,
    );
    return this.db.prepare('SELECT * FROM ads_blueprint_critiques WHERE critique_id = ?')
      .get(Number(result.lastInsertRowid)) as BlueprintCritiqueRow;
  }

  getBlueprintCritique(runId: number): BlueprintCritiqueRow | null {
    return this.db.prepare('SELECT * FROM ads_blueprint_critiques WHERE run_id = ?')
      .get(runId) as BlueprintCritiqueRow | undefined ?? null;
  }

  listFindings(
    runId: number,
    opts?: { severity?: AdsFindingSeverity | undefined; area?: string | undefined; source?: AdsFindingSource | undefined } | undefined,
  ): AdsFindingRow[] {
    const clauses: string[] = ['run_id = ?'];
    const params: unknown[] = [runId];
    if (opts?.severity) { clauses.push('severity = ?'); params.push(opts.severity); }
    if (opts?.area) { clauses.push('area = ?'); params.push(opts.area); }
    if (opts?.source) { clauses.push('source = ?'); params.push(opts.source); }
    return this.db.prepare(`
      SELECT * FROM ads_findings WHERE ${clauses.join(' AND ')}
      ORDER BY
        CASE severity
          WHEN 'BLOCK' THEN 0 WHEN 'HIGH' THEN 1
          WHEN 'MEDIUM' THEN 2 ELSE 3 END,
        finding_id ASC
    `).all(...params) as AdsFindingRow[];
  }

  countFindings(runId: number): { high: number; medium: number; low: number; total: number } {
    const row = this.db.prepare(`
      SELECT
        SUM(CASE WHEN severity = 'HIGH'   THEN 1 ELSE 0 END) AS high,
        SUM(CASE WHEN severity = 'MEDIUM' THEN 1 ELSE 0 END) AS medium,
        SUM(CASE WHEN severity = 'LOW'    THEN 1 ELSE 0 END) AS low,
        COUNT(*) AS total
      FROM ads_findings WHERE run_id = ?
    `).get(runId) as { high: number | null; medium: number | null; low: number | null; total: number };
    return {
      high: row.high ?? 0,
      medium: row.medium ?? 0,
      low: row.low ?? 0,
      total: row.total,
    };
  }

  // ── Blueprint Entities ───────────────────────────────────────
  // P3 writes the proposed entity set here. P4 Emit reads it via run_id
  // and converts it to per-campaign Editor-CSV files. Each blueprint row
  // is paired with an ads_run_decisions row carrying the same
  // KEEP/RENAME/PAUSE/NEW/SPLIT/MERGE classification — the run_decisions
  // table is the canonical history-preservation log and contains no
  // payload, while this table holds the full structured entity payload
  // so emit can build a CSV without re-reading any snapshot.

  insertBlueprintEntity(input: InsertBlueprintEntityInput): AdsBlueprintEntityRow {
    const now = new Date().toISOString();
    const payload = JSON.stringify(input.payload ?? {});
    const errors = JSON.stringify(input.namingErrors ?? []);
    const reviews = JSON.stringify(input.needsReview ?? []);
    const result = this.db.prepare(`
      INSERT INTO ads_blueprint_entities (
        run_id, ads_account_id, entity_type, kind,
        external_id, previous_external_id, payload_json,
        confidence, rationale, naming_valid, naming_errors_json, source,
        needs_review_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.runId, input.adsAccountId, input.entityType, input.kind,
      input.externalId, input.previousExternalId ?? null, payload,
      input.confidence, input.rationale ?? '',
      input.namingValid === false ? 0 : 1, errors,
      input.source ?? 'deterministic', reviews, now,
    );
    return this.db.prepare('SELECT * FROM ads_blueprint_entities WHERE blueprint_id = ?')
      .get(Number(result.lastInsertRowid)) as AdsBlueprintEntityRow;
  }

  /** List blueprint entities for a run that still carry pending operator
   *  review markers. Used by ads_blueprint_review_picks to drain the
   *  queue and by ads_emit_csv to gate emission. */
  listEntitiesNeedingReview(runId: number): AdsBlueprintEntityRow[] {
    return this.db.prepare(`
      SELECT * FROM ads_blueprint_entities
      WHERE run_id = ? AND needs_review_json != '[]'
      ORDER BY entity_type, blueprint_id ASC
    `).all(runId) as AdsBlueprintEntityRow[];
  }

  /** Hard-delete an asset_group entity plus every dependent
   *  asset / audience_signal / listing_group row that linked to it via
   *  (campaign_name, asset_group_name). Used when the operator answers
   *  `__DROP__` to a Phase-B theme-uncertainty review: the AG never
   *  reaches Editor and child assets do not strand in manual-todos.
   *  Returns the number of rows removed (≥ 1 includes the AG itself). */
  dropAssetGroupEntityAndChildren(blueprintId: number): number {
    return this.transaction(() => {
      const row = this.db.prepare(
        'SELECT run_id, entity_type, external_id, payload_json FROM ads_blueprint_entities WHERE blueprint_id = ?',
      ).get(blueprintId) as
        { run_id: number; entity_type: string; external_id: string; payload_json: string } | undefined;
      if (!row) throw new Error(`blueprint_id ${blueprintId} not found`);
      if (row.entity_type !== 'asset_group') {
        throw new Error(`dropAssetGroupEntityAndChildren only supports entity_type=asset_group (got "${row.entity_type}")`);
      }
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(row.payload_json) as Record<string, unknown>; } catch { /* */ }
      const campaignName = typeof payload['campaign_name'] === 'string' ? payload['campaign_name'] as string : '';
      const assetGroupName = typeof payload['asset_group_name'] === 'string' ? payload['asset_group_name'] as string : '';

      let removed = 0;
      // Children first so the parent removal does not orphan rows mid-tx.
      if (campaignName && assetGroupName) {
        const childRows = this.db.prepare(`
          SELECT blueprint_id, payload_json FROM ads_blueprint_entities
          WHERE run_id = ? AND entity_type IN ('asset', 'audience_signal', 'listing_group')
        `).all(row.run_id) as Array<{ blueprint_id: number; payload_json: string }>;
        for (const c of childRows) {
          let cPayload: Record<string, unknown> = {};
          try { cPayload = JSON.parse(c.payload_json) as Record<string, unknown>; } catch { continue; }
          if (cPayload['campaign_name'] !== campaignName) continue;
          if (cPayload['asset_group_name'] !== assetGroupName) continue;
          const r = this.db.prepare('DELETE FROM ads_blueprint_entities WHERE blueprint_id = ?')
            .run(c.blueprint_id);
          removed += Number(r.changes);
          // Mirror cleanup in ads_run_decisions.
          this.db.prepare(`
            DELETE FROM ads_run_decisions
            WHERE run_id = ? AND entity_type = 'asset' AND entity_external_id IN (
              SELECT external_id FROM ads_blueprint_entities
              WHERE blueprint_id = ?
            )
          `).run(row.run_id, c.blueprint_id);
        }
      }
      const r = this.db.prepare('DELETE FROM ads_blueprint_entities WHERE blueprint_id = ?')
        .run(blueprintId);
      removed += Number(r.changes);
      this.db.prepare(`
        DELETE FROM ads_run_decisions
        WHERE run_id = ? AND entity_type = 'asset_group' AND entity_external_id = ?
      `).run(row.run_id, row.external_id);
      return removed;
    });
  }

  /** Apply a single operator pick to a blueprint entity. Atomically
   *  overwrites payload_json.{field} with the chosen value and removes
   *  the matching {field} entry from needs_review_json. Throws when the
   *  blueprint row is missing or the field has no pending review. */
  applyEntityReviewPick(blueprintId: number, field: string, value: unknown): void {
    this.transaction(() => {
      const row = this.db.prepare(
        'SELECT payload_json, needs_review_json FROM ads_blueprint_entities WHERE blueprint_id = ?',
      ).get(blueprintId) as { payload_json: string; needs_review_json: string } | undefined;
      if (!row) throw new Error(`blueprint_id ${blueprintId} not found`);

      let reviews: BlueprintReviewItem[] = [];
      try {
        const parsed = JSON.parse(row.needs_review_json);
        reviews = Array.isArray(parsed) ? parsed as BlueprintReviewItem[] : [];
      } catch { reviews = []; }
      const beforeLen = reviews.length;
      reviews = reviews.filter(r => r.field !== field);
      if (reviews.length === beforeLen) {
        throw new Error(`blueprint_id ${blueprintId} has no pending review for field "${field}"`);
      }

      let payload: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(row.payload_json);
        payload = (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
          ? parsed as Record<string, unknown> : {};
      } catch { payload = {}; }
      payload[field] = value;

      this.db.prepare(`
        UPDATE ads_blueprint_entities
        SET payload_json = ?, needs_review_json = ?
        WHERE blueprint_id = ?
      `).run(JSON.stringify(payload), JSON.stringify(reviews), blueprintId);
    });
  }

  /**
   * Atomically clear blueprint rows of one source for a run, plus the
   * matching ads_run_decisions rows. Used by `runBlueprint` to wipe its
   * own deterministic output before re-writing on a re-run, leaving
   * agent-source rows (asset proposals, validated PMAX SPLIT/MERGE)
   * intact.
   */
  clearBlueprintEntities(runId: number, source: AdsBlueprintSource): { entitiesDeleted: number; decisionsDeleted: number } {
    return this.transaction(() => {
      const pairs = this.db.prepare(`
        SELECT entity_type, external_id FROM ads_blueprint_entities
        WHERE run_id = ? AND source = ?
      `).all(runId, source) as Array<{ entity_type: string; external_id: string }>;

      let decisionsDeleted = 0;
      if (pairs.length > 0) {
        const decStmt = this.db.prepare(`
          DELETE FROM ads_run_decisions
          WHERE run_id = ? AND entity_type = ? AND entity_external_id = ?
        `);
        for (const p of pairs) {
          const r = decStmt.run(runId, p.entity_type, p.external_id);
          decisionsDeleted += Number(r.changes);
        }
      }
      const result = this.db.prepare(`
        DELETE FROM ads_blueprint_entities WHERE run_id = ? AND source = ?
      `).run(runId, source);
      return { entitiesDeleted: Number(result.changes), decisionsDeleted };
    });
  }

  /**
   * Delete a single agent-source blueprint entity for a run, scoped by
   * entity-type + external-id. Used by `ads_blueprint_entity_propose` to
   * make re-calls idempotent — deterministic-source rows are never touched
   * (those are managed via `clearBlueprintEntities`).
   */
  deleteAgentBlueprintEntity(runId: number, entityType: string, externalId: string): number {
    const result = this.db.prepare(`
      DELETE FROM ads_blueprint_entities
      WHERE run_id = ? AND entity_type = ? AND external_id = ? AND source = 'agent'
    `).run(runId, entityType, externalId);
    return Number(result.changes);
  }

  listBlueprintEntities(
    runId: number,
    opts?: { entityType?: string | undefined; kind?: AdsBlueprintEntityKind | undefined } | undefined,
  ): AdsBlueprintEntityRow[] {
    const clauses: string[] = ['run_id = ?'];
    const params: unknown[] = [runId];
    if (opts?.entityType) { clauses.push('entity_type = ?'); params.push(opts.entityType); }
    if (opts?.kind) { clauses.push('kind = ?'); params.push(opts.kind); }
    return this.db.prepare(`
      SELECT * FROM ads_blueprint_entities WHERE ${clauses.join(' AND ')}
      ORDER BY entity_type, kind, blueprint_id ASC
    `).all(...params) as AdsBlueprintEntityRow[];
  }

  countBlueprintEntities(runId: number): Record<AdsBlueprintEntityKind, number> & { total: number } {
    const row = this.db.prepare(`
      SELECT
        SUM(CASE WHEN kind = 'KEEP'   THEN 1 ELSE 0 END) AS k_keep,
        SUM(CASE WHEN kind = 'RENAME' THEN 1 ELSE 0 END) AS k_rename,
        SUM(CASE WHEN kind = 'NEW'    THEN 1 ELSE 0 END) AS k_new,
        SUM(CASE WHEN kind = 'PAUSE'  THEN 1 ELSE 0 END) AS k_pause,
        SUM(CASE WHEN kind = 'SPLIT'  THEN 1 ELSE 0 END) AS k_split,
        SUM(CASE WHEN kind = 'MERGE'  THEN 1 ELSE 0 END) AS k_merge,
        COUNT(*) AS total
      FROM ads_blueprint_entities WHERE run_id = ?
    `).get(runId) as Record<string, number | null>;
    return {
      KEEP: row['k_keep'] ?? 0, RENAME: row['k_rename'] ?? 0,
      NEW: row['k_new'] ?? 0, PAUSE: row['k_pause'] ?? 0,
      SPLIT: row['k_split'] ?? 0, MERGE: row['k_merge'] ?? 0,
      total: row['total'] ?? 0,
    };
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
        'bidding_strategy_type', 'target_roas', 'target_cpa_micros',
        'budget_micros', 'impressions', 'clicks', 'cost_micros', 'conversions',
        'conv_value', 'ctr', 'avg_cpc', 'search_is', 'search_top_is',
        'search_abs_top_is', 'budget_lost_is', 'rank_lost_is'],
      input.runId, input.adsAccountId, input.rows,
      r => [r.campaignId, r.campaignName, r.status ?? null, r.channelType ?? null, r.optScore ?? null,
        r.biddingStrategyType ?? null, r.targetRoas ?? null, r.targetCpaMicros ?? null,
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
    if (!ALLOWED_SNAPSHOT_TABLES.has(table)) {
      throw new Error(`Unknown snapshot table "${table}". Allowed: ${[...ALLOWED_SNAPSHOT_TABLES].join(', ')}`);
    }
    const resolvedRunId = this._resolveRunId(adsAccountId, opts?.runId);
    if (resolvedRunId === null) return [];
    const limit = opts?.limit !== undefined ? Math.max(1, Math.min(opts.limit, 5000)) : null;
    const limitClause = limit ? ` LIMIT ${limit}` : '';
    return this.db.prepare(`
      SELECT * FROM "${table}" WHERE source_run_id = ? AND ads_account_id = ?${limitClause}
    `).all(resolvedRunId, adsAccountId) as T[];
  }

  countSnapshotRows(table: string, adsAccountId: string, runId?: number | undefined): number {
    if (!ALLOWED_SNAPSHOT_TABLES.has(table)) {
      throw new Error(`Unknown snapshot table "${table}". Allowed: ${[...ALLOWED_SNAPSHOT_TABLES].join(', ')}`);
    }
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

const ALLOWED_SNAPSHOT_TABLES: ReadonlySet<string> = new Set([
  'ads_campaigns',
  'ads_campaign_performance',
  'ads_ad_groups',
  'ads_keywords',
  'ads_rsa_ads',
  'ads_asset_groups',
  'ads_asset_group_assets',
  'ads_assets',
  'ads_listing_groups',
  'ads_shopping_products',
  'ads_conversion_actions',
  'ads_campaign_targeting',
  'ads_search_terms',
  'ads_pmax_search_terms',
  'ads_pmax_placements',
  'ads_landing_pages',
  'ads_ad_asset_ratings',
  'ads_audience_signals',
  'ads_device_performance',
  'ads_geo_performance',
  'ads_change_history',
  'ga4_observations',
  'gsc_observations',
]);
