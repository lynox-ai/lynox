/**
 * lynox Ads Optimizer — Google Ads export (22 CSVs)
 * =================================================
 * Customer-deployed Google Ads Script that writes a snapshot of the account
 * to Google Drive. lynox reads the snapshot via the customer's BYOK Google
 * Workspace integration. The lynox engine never calls the Google Ads API
 * directly.
 *
 * Setup:
 *   1. Open Google Ads → Tools → Bulk actions → Scripts → New script
 *   2. Paste this entire file
 *   3. Set DRIVE_ROOT_FOLDER_ID and ACCOUNT_LABEL below
 *   4. "Authorize" — grant Drive write permission
 *   5. Click "Run" once manually to verify, then add a monthly time-trigger
 *
 * Output (under <root>/<account>/ads/):
 *     LASTRUN.txt
 *     campaigns.csv                 ad_groups.csv             keywords.csv
 *     campaign_performance.csv      ads_rsa.csv               assets.csv
 *     asset_groups.csv              asset_group_assets.csv    listing_groups.csv
 *     shopping_products.csv         conversions.csv           campaign_targeting.csv
 *     search_terms.csv              pmax_search_terms.csv     pmax_placements.csv
 *     landing_pages.csv             ad_asset_ratings.csv      audience_signals.csv
 *     device_performance.csv        geo_performance.csv       change_history.csv
 *
 * Format: UTF-8 CSV, snake_case headers, cost in micros (1_000_000 = 1 unit
 * of account currency), CTR/IS as decimals (0.05 = 5%). All 22 files share
 * this convention so the lynox CSV reader can ingest them without per-file
 * coercion rules.
 *
 * License: ELv2 (matches the rest of @lynox-ai/core).
 */

// ─── Configuration ───────────────────────────────────────────
var DRIVE_ROOT_FOLDER_ID = 'YOUR_DRIVE_ROOT_FOLDER_ID';
var ACCOUNT_LABEL = 'YOUR_ACCOUNT_LABEL';   // e.g. 'acme-shop'
var DATE_RANGE = 'LAST_30_DAYS';            // GAQL date filter
var SEARCH_TERMS_LIMIT = 5000;
var PRODUCTS_LIMIT = 1000;
var CHANGE_HISTORY_DAYS = 14;

function main() {
  var rootFolder = DriveApp.getFolderById(DRIVE_ROOT_FOLDER_ID);
  var accountFolder = ensureSubfolder(rootFolder, ACCOUNT_LABEL);
  var adsFolder = ensureSubfolder(accountFolder, 'ads');

  // The 22 CSVs. Each export is independent — a failure in one file does not
  // block the rest. We log per-file outcome via Logger.log so Apps Script's
  // execution log makes failures obvious.
  safeExport_('campaigns.csv',              adsFolder, exportCampaigns);
  safeExport_('campaign_performance.csv',   adsFolder, exportCampaignPerformance);
  safeExport_('ad_groups.csv',              adsFolder, exportAdGroups);
  safeExport_('keywords.csv',               adsFolder, exportKeywords);
  safeExport_('ads_rsa.csv',                adsFolder, exportRsaAds);
  safeExport_('asset_groups.csv',           adsFolder, exportAssetGroups);
  safeExport_('asset_group_assets.csv',     adsFolder, exportAssetGroupAssets);
  safeExport_('assets.csv',                 adsFolder, exportAssets);
  safeExport_('listing_groups.csv',         adsFolder, exportListingGroups);
  safeExport_('shopping_products.csv',      adsFolder, exportShoppingProducts);
  safeExport_('conversions.csv',            adsFolder, exportConversionActions);
  safeExport_('campaign_targeting.csv',     adsFolder, exportCampaignTargeting);
  safeExport_('search_terms.csv',           adsFolder, exportSearchTerms);
  safeExport_('pmax_search_terms.csv',      adsFolder, exportPmaxSearchTerms);
  safeExport_('pmax_placements.csv',        adsFolder, exportPmaxPlacements);
  safeExport_('landing_pages.csv',          adsFolder, exportLandingPages);
  safeExport_('ad_asset_ratings.csv',       adsFolder, exportAdAssetRatings);
  safeExport_('audience_signals.csv',       adsFolder, exportAudienceSignals);
  safeExport_('device_performance.csv',     adsFolder, exportDevicePerformance);
  safeExport_('geo_performance.csv',        adsFolder, exportGeoPerformance);
  safeExport_('change_history.csv',         adsFolder, exportChangeHistory);

  writeFile_(adsFolder, 'LASTRUN.txt', new Date().toISOString());
  Logger.log('Done. 22 CSVs + LASTRUN.txt written to ' + ACCOUNT_LABEL + '/ads/');
}

// ─── 22 Export functions ──────────────────────────────────────

function exportCampaigns() {
  var q = 'SELECT campaign.id, campaign.name, campaign.status, ' +
    'campaign.advertising_channel_type, campaign.optimization_score, ' +
    'campaign.bidding_strategy_type, ' +
    'campaign.target_roas.target_roas, ' +
    'campaign.target_cpa.target_cpa_micros, ' +
    'campaign.maximize_conversion_value.target_roas, ' +
    'campaign.maximize_conversions.target_cpa_micros, ' +
    'campaign_budget.amount_micros, ' +
    'metrics.impressions, metrics.clicks, metrics.cost_micros, ' +
    'metrics.conversions, metrics.conversions_value, metrics.ctr, ' +
    'metrics.average_cpc, metrics.search_impression_share, ' +
    'metrics.search_top_impression_share, ' +
    'metrics.search_absolute_top_impression_share, ' +
    'metrics.search_budget_lost_impression_share, ' +
    'metrics.search_rank_lost_impression_share ' +
    'FROM campaign WHERE segments.date DURING ' + DATE_RANGE + ' ' +
    'AND campaign.status != "REMOVED"';
  var header = 'campaign_id,campaign_name,status,channel_type,opt_score,' +
    'bidding_strategy_type,target_roas,target_cpa_micros,' +
    'budget_micros,impressions,clicks,cost_micros,conversions,conv_value,' +
    'ctr,avg_cpc,search_is,search_top_is,search_abs_top_is,budget_lost_is,rank_lost_is';
  return runQueryToCsv_(q, header, function (row) {
    // Target lives on either campaign.target_roas / target_cpa (when the bid
    // strategy is TARGET_ROAS / TARGET_CPA) or on the strategy-specific
    // sub-message (Maximize Conversions / Maximize Conversion Value with
    // optional target). Pick whichever is set.
    var tRoas = (row.campaign.targetRoas && row.campaign.targetRoas.targetRoas) ||
      (row.campaign.maximizeConversionValue && row.campaign.maximizeConversionValue.targetRoas);
    var tCpaMicros = (row.campaign.targetCpa && row.campaign.targetCpa.targetCpaMicros) ||
      (row.campaign.maximizeConversions && row.campaign.maximizeConversions.targetCpaMicros);
    return [
      row.campaign.id,
      csvStr_(row.campaign.name),
      row.campaign.status,
      row.campaign.advertisingChannelType,
      numOrEmpty_(row.campaign.optimizationScore),
      row.campaign.biddingStrategyType || '',
      numOrEmpty_(tRoas),
      intOrEmpty_(tCpaMicros),
      intOrEmpty_(row.campaignBudget && row.campaignBudget.amountMicros),
      intOrEmpty_(row.metrics.impressions),
      intOrEmpty_(row.metrics.clicks),
      intOrEmpty_(row.metrics.costMicros),
      numOrEmpty_(row.metrics.conversions),
      numOrEmpty_(row.metrics.conversionsValue),
      numOrEmpty_(row.metrics.ctr),
      intOrEmpty_(row.metrics.averageCpc),
      numOrEmpty_(row.metrics.searchImpressionShare),
      numOrEmpty_(row.metrics.searchTopImpressionShare),
      numOrEmpty_(row.metrics.searchAbsoluteTopImpressionShare),
      numOrEmpty_(row.metrics.searchBudgetLostImpressionShare),
      numOrEmpty_(row.metrics.searchRankLostImpressionShare),
    ];
  });
}

function exportCampaignPerformance() {
  var q = 'SELECT segments.date, campaign.id, campaign.name, ' +
    'campaign.advertising_channel_type, ' +
    'metrics.impressions, metrics.clicks, metrics.cost_micros, ' +
    'metrics.conversions, metrics.conversions_value ' +
    'FROM campaign WHERE segments.date DURING ' + DATE_RANGE + ' ' +
    'AND campaign.status != "REMOVED"';
  var header = 'date,campaign_id,campaign_name,channel_type,impressions,clicks,' +
    'cost_micros,conversions,conv_value';
  return runQueryToCsv_(q, header, function (row) {
    return [
      row.segments.date,
      row.campaign.id,
      csvStr_(row.campaign.name),
      row.campaign.advertisingChannelType,
      intOrEmpty_(row.metrics.impressions),
      intOrEmpty_(row.metrics.clicks),
      intOrEmpty_(row.metrics.costMicros),
      numOrEmpty_(row.metrics.conversions),
      numOrEmpty_(row.metrics.conversionsValue),
    ];
  });
}

function exportAdGroups() {
  var q = 'SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ' +
    'ad_group.status, metrics.impressions, metrics.clicks, metrics.cost_micros, ' +
    'metrics.conversions, metrics.conversions_value, metrics.ctr, metrics.average_cpc ' +
    'FROM ad_group WHERE segments.date DURING ' + DATE_RANGE + ' ' +
    'AND ad_group.status != "REMOVED"';
  var header = 'campaign_id,campaign_name,ad_group_id,ad_group_name,status,' +
    'impressions,clicks,cost_micros,conversions,conv_value,ctr,avg_cpc';
  return runQueryToCsv_(q, header, function (row) {
    return [
      row.campaign.id,
      csvStr_(row.campaign.name),
      row.adGroup.id,
      csvStr_(row.adGroup.name),
      row.adGroup.status,
      intOrEmpty_(row.metrics.impressions),
      intOrEmpty_(row.metrics.clicks),
      intOrEmpty_(row.metrics.costMicros),
      numOrEmpty_(row.metrics.conversions),
      numOrEmpty_(row.metrics.conversionsValue),
      numOrEmpty_(row.metrics.ctr),
      intOrEmpty_(row.metrics.averageCpc),
    ];
  });
}

function exportKeywords() {
  var q = 'SELECT campaign.name, ad_group.name, ad_group_criterion.keyword.text, ' +
    'ad_group_criterion.keyword.match_type, ad_group_criterion.status, ' +
    'ad_group_criterion.quality_info.quality_score, ' +
    'metrics.impressions, metrics.clicks, metrics.cost_micros, ' +
    'metrics.conversions, metrics.conversions_value, metrics.ctr, ' +
    'metrics.average_cpc, metrics.search_impression_share ' +
    'FROM keyword_view WHERE segments.date DURING ' + DATE_RANGE + ' ' +
    'AND ad_group_criterion.status != "REMOVED"';
  var header = 'campaign_name,ad_group_name,keyword,match_type,status,quality_score,' +
    'impressions,clicks,cost_micros,conversions,conv_value,ctr,avg_cpc,search_is';
  return runQueryToCsv_(q, header, function (row) {
    var crit = row.adGroupCriterion;
    var qInfo = crit.qualityInfo;
    return [
      csvStr_(row.campaign.name),
      csvStr_(row.adGroup.name),
      csvStr_(crit.keyword.text),
      crit.keyword.matchType,
      crit.status,
      intOrEmpty_(qInfo && qInfo.qualityScore),
      intOrEmpty_(row.metrics.impressions),
      intOrEmpty_(row.metrics.clicks),
      intOrEmpty_(row.metrics.costMicros),
      numOrEmpty_(row.metrics.conversions),
      numOrEmpty_(row.metrics.conversionsValue),
      numOrEmpty_(row.metrics.ctr),
      intOrEmpty_(row.metrics.averageCpc),
      numOrEmpty_(row.metrics.searchImpressionShare),
    ];
  });
}

function exportRsaAds() {
  var q = 'SELECT campaign.name, ad_group.name, ad_group_ad.ad.id, ' +
    'ad_group_ad.ad.responsive_search_ad.headlines, ' +
    'ad_group_ad.ad.responsive_search_ad.descriptions, ' +
    'ad_group_ad.ad.final_urls, ad_group_ad.status, ad_group_ad.ad_strength, ' +
    'metrics.impressions, metrics.clicks, metrics.cost_micros, ' +
    'metrics.conversions, metrics.ctr ' +
    'FROM ad_group_ad WHERE ad_group_ad.ad.type = "RESPONSIVE_SEARCH_AD" ' +
    'AND ad_group_ad.status != "REMOVED" ' +
    'AND segments.date DURING ' + DATE_RANGE;
  var header = 'campaign_name,ad_group_name,ad_id,headlines,descriptions,' +
    'final_url,status,ad_strength,impressions,clicks,cost_micros,conversions,ctr';
  return runQueryToCsv_(q, header, function (row) {
    var ad = row.adGroupAd.ad;
    var rsa = ad.responsiveSearchAd;
    var headlines = (rsa && rsa.headlines || []).map(function (h) { return h.text; }).join(' | ');
    var descriptions = (rsa && rsa.descriptions || []).map(function (d) { return d.text; }).join(' | ');
    var finalUrl = (ad.finalUrls && ad.finalUrls[0]) || '';
    return [
      csvStr_(row.campaign.name),
      csvStr_(row.adGroup.name),
      ad.id,
      csvStr_(headlines),
      csvStr_(descriptions),
      csvStr_(finalUrl),
      row.adGroupAd.status,
      row.adGroupAd.adStrength,
      intOrEmpty_(row.metrics.impressions),
      intOrEmpty_(row.metrics.clicks),
      intOrEmpty_(row.metrics.costMicros),
      numOrEmpty_(row.metrics.conversions),
      numOrEmpty_(row.metrics.ctr),
    ];
  });
}

function exportAssetGroups() {
  var q = 'SELECT campaign.id, campaign.name, asset_group.id, asset_group.name, ' +
    'asset_group.status, asset_group.ad_strength, ' +
    'metrics.impressions, metrics.clicks, metrics.cost_micros, ' +
    'metrics.conversions, metrics.conversions_value ' +
    'FROM asset_group WHERE segments.date DURING ' + DATE_RANGE + ' ' +
    'AND asset_group.status != "REMOVED"';
  var header = 'campaign_id,campaign_name,asset_group_id,asset_group_name,status,' +
    'ad_strength,impressions,clicks,cost_micros,conversions,conv_value';
  return runQueryToCsv_(q, header, function (row) {
    return [
      row.campaign.id,
      csvStr_(row.campaign.name),
      row.assetGroup.id,
      csvStr_(row.assetGroup.name),
      row.assetGroup.status,
      row.assetGroup.adStrength,
      intOrEmpty_(row.metrics.impressions),
      intOrEmpty_(row.metrics.clicks),
      intOrEmpty_(row.metrics.costMicros),
      numOrEmpty_(row.metrics.conversions),
      numOrEmpty_(row.metrics.conversionsValue),
    ];
  });
}

function exportAssetGroupAssets() {
  var q = 'SELECT campaign.name, asset_group.name, asset_group_asset.field_type, ' +
    'asset_group_asset.status, asset.id, asset.name, asset.type, ' +
    'asset.text_asset.text, asset.image_asset.full_size.url ' +
    'FROM asset_group_asset ' +
    'WHERE asset_group_asset.status != "REMOVED"';
  var header = 'campaign_name,asset_group_name,field_type,asset_status,asset_id,' +
    'asset_name,asset_type,text_content,image_url';
  return runQueryToCsv_(q, header, function (row) {
    var asset = row.asset;
    var textContent = asset.textAsset ? asset.textAsset.text : '';
    var imageUrl = asset.imageAsset && asset.imageAsset.fullSize ? asset.imageAsset.fullSize.url : '';
    return [
      csvStr_(row.campaign.name),
      csvStr_(row.assetGroup.name),
      row.assetGroupAsset.fieldType,
      row.assetGroupAsset.status,
      asset.id,
      csvStr_(asset.name),
      asset.type,
      csvStr_(textContent),
      csvStr_(imageUrl),
    ];
  });
}

function exportAssets() {
  // Sitelinks, callouts, structured snippets — account-level extension assets.
  var q = 'SELECT asset.id, asset.name, asset.type, ' +
    'asset.sitelink_asset.link_text, asset.sitelink_asset.description1, ' +
    'asset.sitelink_asset.description2, asset.callout_asset.callout_text, ' +
    'asset.structured_snippet_asset.header, ' +
    'asset.structured_snippet_asset.values ' +
    'FROM asset WHERE asset.type IN ("SITELINK","CALLOUT","STRUCTURED_SNIPPET")';
  var header = 'asset_id,name,type,sitelink_text,sitelink_desc1,sitelink_desc2,' +
    'callout_text,snippet_header,snippet_values';
  return runQueryToCsv_(q, header, function (row) {
    var a = row.asset;
    var sl = a.sitelinkAsset || {};
    var co = a.calloutAsset || {};
    var ss = a.structuredSnippetAsset || {};
    var snippetValues = (ss.values || []).join(' | ');
    return [
      a.id,
      csvStr_(a.name),
      a.type,
      csvStr_(sl.linkText || ''),
      csvStr_(sl.description1 || ''),
      csvStr_(sl.description2 || ''),
      csvStr_(co.calloutText || ''),
      csvStr_(ss.header || ''),
      csvStr_(snippetValues),
    ];
  });
}

function exportListingGroups() {
  var q = 'SELECT campaign.name, asset_group.name, ' +
    'asset_group_listing_group_filter.id, ' +
    'asset_group_listing_group_filter.type, ' +
    'asset_group_listing_group_filter.case_value.product_brand.value, ' +
    'asset_group_listing_group_filter.case_value.product_category.category_id, ' +
    'asset_group_listing_group_filter.case_value.product_type.value, ' +
    'asset_group_listing_group_filter.case_value.product_custom_attribute.value ' +
    'FROM asset_group_listing_group_filter';
  var header = 'campaign_name,asset_group_name,filter_id,filter_type,brand,' +
    'category_id,product_type,custom_attribute';
  return runQueryToCsv_(q, header, function (row) {
    var lg = row.assetGroupListingGroupFilter;
    var cv = lg.caseValue || {};
    var brand = cv.productBrand ? cv.productBrand.value : '';
    var catId = cv.productCategory ? cv.productCategory.categoryId : '';
    var ptype = cv.productType ? cv.productType.value : '';
    var custom = cv.productCustomAttribute ? cv.productCustomAttribute.value : '';
    return [
      csvStr_(row.campaign.name),
      csvStr_(row.assetGroup.name),
      lg.id,
      lg.type,
      csvStr_(brand),
      csvStr_(catId),
      csvStr_(ptype),
      csvStr_(custom),
    ];
  });
}

function exportShoppingProducts() {
  // Shopping/PMax product level performance — closest available view.
  var q = 'SELECT campaign.name, segments.product_item_id, segments.product_title, ' +
    'segments.product_brand, segments.product_status, ' +
    'segments.product_channel, segments.product_language, ' +
    'metrics.impressions, metrics.clicks, metrics.cost_micros ' +
    'FROM shopping_performance_view ' +
    'WHERE segments.date DURING ' + DATE_RANGE + ' ' +
    'ORDER BY metrics.impressions DESC LIMIT ' + PRODUCTS_LIMIT;
  var header = 'campaign_name,item_id,title,brand,status,channel,language,issues,' +
    'impressions,clicks,cost_micros';
  return runQueryToCsv_(q, header, function (row) {
    var s = row.segments;
    return [
      csvStr_(row.campaign.name),
      csvStr_(s.productItemId || ''),
      csvStr_(s.productTitle || ''),
      csvStr_(s.productBrand || ''),
      s.productStatus || '',
      s.productChannel || '',
      s.productLanguage || '',
      '',  // disapproval issues — not exposed via shopping_performance_view; surface via Merchant Center API in v2
      intOrEmpty_(row.metrics.impressions),
      intOrEmpty_(row.metrics.clicks),
      intOrEmpty_(row.metrics.costMicros),
    ];
  });
}

function exportConversionActions() {
  var q = 'SELECT conversion_action.id, conversion_action.name, ' +
    'conversion_action.type, conversion_action.category, ' +
    'conversion_action.status, conversion_action.primary_for_goal, ' +
    'conversion_action.counting_type, conversion_action.attribution_model_settings.attribution_model, ' +
    'conversion_action.value_settings.default_value, ' +
    'conversion_action.include_in_conversions_metric ' +
    'FROM conversion_action';
  var header = 'conv_action_id,name,type,category,status,primary_for_goal,' +
    'counting_type,attribution_model,default_value,in_conversions_metric';
  return runQueryToCsv_(q, header, function (row) {
    var ca = row.conversionAction;
    var attrModel = ca.attributionModelSettings ? ca.attributionModelSettings.attributionModel : '';
    var defaultValue = ca.valueSettings ? ca.valueSettings.defaultValue : '';
    return [
      ca.id,
      csvStr_(ca.name),
      ca.type,
      ca.category,
      ca.status,
      ca.primaryForGoal === true ? 'true' : 'false',
      ca.countingType,
      attrModel,
      numOrEmpty_(defaultValue),
      ca.includeInConversionsMetric === true ? 'true' : 'false',
    ];
  });
}

function exportCampaignTargeting() {
  // Geo + language + campaign-level negatives.
  var q = 'SELECT campaign.id, campaign.name, campaign_criterion.type, ' +
    'campaign_criterion.negative, campaign_criterion.status, ' +
    'campaign_criterion.bid_modifier, ' +
    'campaign_criterion.location.geo_target_constant, ' +
    'campaign_criterion.language.language_constant, ' +
    'campaign_criterion.keyword.text, campaign_criterion.keyword.match_type ' +
    'FROM campaign_criterion ' +
    'WHERE campaign_criterion.status != "REMOVED"';
  var header = 'campaign_id,campaign_name,criterion_type,is_negative,status,' +
    'bid_modifier,geo_target,language,keyword_text,match_type';
  return runQueryToCsv_(q, header, function (row) {
    var cc = row.campaignCriterion;
    var geo = cc.location ? cc.location.geoTargetConstant : '';
    var lang = cc.language ? cc.language.languageConstant : '';
    var kw = cc.keyword ? cc.keyword.text : '';
    var mt = cc.keyword ? cc.keyword.matchType : '';
    return [
      row.campaign.id,
      csvStr_(row.campaign.name),
      cc.type,
      cc.negative === true ? 'true' : 'false',
      cc.status,
      numOrEmpty_(cc.bidModifier),
      csvStr_(geo),
      csvStr_(lang),
      csvStr_(kw),
      mt,
    ];
  });
}

function exportSearchTerms() {
  var q = 'SELECT campaign.name, campaign.advertising_channel_type, ad_group.name, ' +
    'search_term_view.search_term, search_term_view.status, ' +
    'metrics.impressions, metrics.clicks, metrics.cost_micros, ' +
    'metrics.conversions, metrics.conversions_value, metrics.ctr ' +
    'FROM search_term_view ' +
    'WHERE segments.date DURING ' + DATE_RANGE + ' ' +
    'ORDER BY metrics.impressions DESC LIMIT ' + SEARCH_TERMS_LIMIT;
  var header = 'campaign_name,channel_type,ad_group_name,search_term,term_status,' +
    'impressions,clicks,cost_micros,conversions,conv_value,ctr';
  return runQueryToCsv_(q, header, function (row) {
    return [
      csvStr_(row.campaign.name),
      row.campaign.advertisingChannelType,
      csvStr_(row.adGroup.name),
      csvStr_(row.searchTermView.searchTerm),
      row.searchTermView.status,
      intOrEmpty_(row.metrics.impressions),
      intOrEmpty_(row.metrics.clicks),
      intOrEmpty_(row.metrics.costMicros),
      numOrEmpty_(row.metrics.conversions),
      numOrEmpty_(row.metrics.conversionsValue),
      numOrEmpty_(row.metrics.ctr),
    ];
  });
}

function exportPmaxSearchTerms() {
  // PMax search-category insights (Google's grouping — no raw queries surface).
  var q = 'SELECT campaign.id, campaign.name, ' +
    'campaign_search_term_insight.category_label, ' +
    'campaign_search_term_insight.id ' +
    'FROM campaign_search_term_insight ' +
    'WHERE segments.date DURING ' + DATE_RANGE;
  var header = 'campaign_id,campaign_name,search_category,insight_id';
  return runQueryToCsv_(q, header, function (row) {
    var insight = row.campaignSearchTermInsight;
    return [
      row.campaign.id,
      csvStr_(row.campaign.name),
      csvStr_(insight.categoryLabel || ''),
      insight.id || '',
    ];
  });
}

function exportPmaxPlacements() {
  var q = 'SELECT campaign.id, campaign.name, performance_max_placement_view.placement, ' +
    'performance_max_placement_view.placement_type, ' +
    'performance_max_placement_view.target_url ' +
    'FROM performance_max_placement_view ' +
    'WHERE segments.date DURING ' + DATE_RANGE;
  var header = 'campaign_id,campaign_name,placement,placement_type,target_url';
  return runQueryToCsv_(q, header, function (row) {
    var p = row.performanceMaxPlacementView;
    return [
      row.campaign.id,
      csvStr_(row.campaign.name),
      csvStr_(p.placement || ''),
      p.placementType || '',
      csvStr_(p.targetUrl || ''),
    ];
  });
}

function exportLandingPages() {
  var q = 'SELECT campaign.name, landing_page_view.unexpanded_final_url, ' +
    'metrics.impressions, metrics.clicks, metrics.cost_micros, ' +
    'metrics.conversions, metrics.conversions_value, metrics.average_cpc ' +
    'FROM landing_page_view ' +
    'WHERE segments.date DURING ' + DATE_RANGE + ' ' +
    'ORDER BY metrics.cost_micros DESC';
  var header = 'campaign_name,landing_page_url,impressions,clicks,cost_micros,' +
    'conversions,conv_value,avg_cpc';
  return runQueryToCsv_(q, header, function (row) {
    return [
      csvStr_(row.campaign.name),
      csvStr_(row.landingPageView.unexpandedFinalUrl || ''),
      intOrEmpty_(row.metrics.impressions),
      intOrEmpty_(row.metrics.clicks),
      intOrEmpty_(row.metrics.costMicros),
      numOrEmpty_(row.metrics.conversions),
      numOrEmpty_(row.metrics.conversionsValue),
      intOrEmpty_(row.metrics.averageCpc),
    ];
  });
}

function exportAdAssetRatings() {
  // Per-asset RSA performance ratings (BEST/GOOD/LOW/PENDING).
  var q = 'SELECT campaign.name, ad_group.name, ad_group_ad_asset_view.field_type, ' +
    'ad_group_ad_asset_view.performance_label, ad_group_ad_asset_view.enabled, ' +
    'asset.text_asset.text, ' +
    'metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions ' +
    'FROM ad_group_ad_asset_view ' +
    'WHERE segments.date DURING ' + DATE_RANGE;
  var header = 'campaign_name,ad_group_name,field_type,performance_label,enabled,' +
    'text_content,impressions,clicks,cost_micros,conversions';
  return runQueryToCsv_(q, header, function (row) {
    var v = row.adGroupAdAssetView;
    var text = row.asset && row.asset.textAsset ? row.asset.textAsset.text : '';
    return [
      csvStr_(row.campaign.name),
      csvStr_(row.adGroup.name),
      v.fieldType,
      v.performanceLabel || '',
      v.enabled === true ? 'true' : 'false',
      csvStr_(text),
      intOrEmpty_(row.metrics.impressions),
      intOrEmpty_(row.metrics.clicks),
      intOrEmpty_(row.metrics.costMicros),
      numOrEmpty_(row.metrics.conversions),
    ];
  });
}

function exportAudienceSignals() {
  // PMax audience signals attached to asset groups.
  var q = 'SELECT campaign.name, asset_group.name, asset_group_signal.audience ' +
    'FROM asset_group_signal';
  var header = 'campaign_name,asset_group_name,signal_type,signal_label';
  return runQueryToCsv_(q, header, function (row) {
    var audience = row.assetGroupSignal.audience || '';
    return [
      csvStr_(row.campaign.name),
      csvStr_(row.assetGroup.name),
      'AUDIENCE',
      csvStr_(audience),
    ];
  });
}

function exportDevicePerformance() {
  var q = 'SELECT campaign.id, campaign.name, campaign.advertising_channel_type, ' +
    'segments.device, ' +
    'metrics.impressions, metrics.clicks, metrics.cost_micros, ' +
    'metrics.conversions, metrics.conversions_value, metrics.ctr ' +
    'FROM campaign WHERE segments.date DURING ' + DATE_RANGE + ' ' +
    'AND campaign.status != "REMOVED"';
  var header = 'campaign_id,campaign_name,channel_type,device,impressions,clicks,' +
    'cost_micros,conversions,conv_value,ctr';
  return runQueryToCsv_(q, header, function (row) {
    return [
      row.campaign.id,
      csvStr_(row.campaign.name),
      row.campaign.advertisingChannelType,
      row.segments.device,
      intOrEmpty_(row.metrics.impressions),
      intOrEmpty_(row.metrics.clicks),
      intOrEmpty_(row.metrics.costMicros),
      numOrEmpty_(row.metrics.conversions),
      numOrEmpty_(row.metrics.conversionsValue),
      numOrEmpty_(row.metrics.ctr),
    ];
  });
}

function exportGeoPerformance() {
  var q = 'SELECT campaign.id, campaign.name, geographic_view.country_criterion_id, ' +
    'geographic_view.location_type, segments.geo_target_region, ' +
    'metrics.impressions, metrics.clicks, metrics.cost_micros, ' +
    'metrics.conversions, metrics.conversions_value ' +
    'FROM geographic_view WHERE segments.date DURING ' + DATE_RANGE;
  var header = 'campaign_id,campaign_name,country_id,location_type,geo_target_region,' +
    'impressions,clicks,cost_micros,conversions,conv_value';
  return runQueryToCsv_(q, header, function (row) {
    var gv = row.geographicView;
    return [
      row.campaign.id,
      csvStr_(row.campaign.name),
      gv.countryCriterionId || '',
      gv.locationType || '',
      csvStr_(row.segments.geoTargetRegion || ''),
      intOrEmpty_(row.metrics.impressions),
      intOrEmpty_(row.metrics.clicks),
      intOrEmpty_(row.metrics.costMicros),
      numOrEmpty_(row.metrics.conversions),
      numOrEmpty_(row.metrics.conversionsValue),
    ];
  });
}

function exportChangeHistory() {
  var sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - CHANGE_HISTORY_DAYS);
  var since = sinceDate.toISOString().slice(0, 10);
  var q = 'SELECT change_event.change_date_time, change_event.resource_type, ' +
    'change_event.change_resource_type, change_event.user_email, ' +
    'change_event.client_type, change_event.changed_fields, ' +
    'change_event.campaign ' +
    'FROM change_event ' +
    'WHERE change_event.change_date_time >= "' + since + '" ' +
    'ORDER BY change_event.change_date_time DESC LIMIT 5000';
  var header = 'change_date,resource_type,operation,changed_fields,user_email,' +
    'client_type,campaign_name';
  return runQueryToCsv_(q, header, function (row) {
    var ce = row.changeEvent;
    var changedFields = '';
    if (ce.changedFields && ce.changedFields.paths) {
      changedFields = ce.changedFields.paths.join(' | ');
    } else if (typeof ce.changedFields === 'string') {
      changedFields = ce.changedFields;
    }
    return [
      ce.changeDateTime,
      ce.resourceType,
      ce.changeResourceType || '',
      csvStr_(changedFields),
      csvStr_(ce.userEmail || ''),
      ce.clientType || '',
      csvStr_(ce.campaign || ''),
    ];
  });
}

// ─── Helpers ──────────────────────────────────────────────────

/** Wrap a string for CSV output: replace embedded quotes, wrap in double quotes. */
function csvStr_(s) {
  if (s === null || s === undefined) return '""';
  return '"' + String(s).replace(/"/g, '""') + '"';
}

function numOrEmpty_(v) {
  if (v === null || v === undefined || v === '') return '';
  var n = Number(v);
  return isNaN(n) ? '' : String(n);
}

function intOrEmpty_(v) {
  if (v === null || v === undefined || v === '') return '';
  var n = Number(v);
  return isNaN(n) ? '' : String(Math.trunc(n));
}

/** Iterate AdsApp.search results, emit a CSV string. */
function runQueryToCsv_(query, header, rowMapper) {
  var iter = AdsApp.search(query);
  var lines = [header];
  while (iter.hasNext()) {
    var row = iter.next();
    try {
      lines.push(rowMapper(row).join(','));
    } catch (rowErr) {
      Logger.log('Skipped malformed row: ' + rowErr);
    }
  }
  return lines.join('\n') + '\n';
}

/** Wrap an exporter so a single failure logs but does not abort the whole run.
 *  On failure: do NOT write a file. The lynox reader marks absent files as
 *  status=missing (non-fatal) so missing data is visible without producing
 *  a malformed CSV that would fail header validation. */
function safeExport_(filename, folder, exporterFn) {
  try {
    var csv = exporterFn();
    writeFile_(folder, filename, csv);
    Logger.log('OK ' + filename);
  } catch (err) {
    Logger.log('FAIL ' + filename + ': ' + err);
  }
}

function ensureSubfolder(parent, name) {
  var iter = parent.getFoldersByName(name);
  if (iter.hasNext()) return iter.next();
  return parent.createFolder(name);
}

/** Idempotent write: trash any prior file with this name, then create. */
function writeFile_(folder, filename, content) {
  var existing = folder.getFilesByName(filename);
  while (existing.hasNext()) existing.next().setTrashed(true);
  folder.createFile(filename, content, MimeType.CSV);
}
