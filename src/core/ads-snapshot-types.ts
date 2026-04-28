/**
 * Input shapes for one snapshot row of every Ads Optimizer table.
 *
 * Naming convention: camelCase fields. The bulk-insert layer maps these to
 * the snake_case DB columns in fixed order. Snapshot consumers (CSV reader,
 * tests) construct these objects; they never write SQL directly.
 */

export interface CampaignSnapshot {
  campaignId: string;
  campaignName: string;
  status?: string | undefined;
  channelType?: string | undefined;
  optScore?: number | undefined;
  /** Google Ads `BiddingStrategyType` enum value (e.g. TARGET_ROAS, MAXIMIZE_CONVERSION_VALUE). */
  biddingStrategyType?: string | undefined;
  /** Campaign-level Target ROAS (e.g. 4.0 = 400 %). Set on TARGET_ROAS or
   *  MAXIMIZE_CONVERSION_VALUE-with-target campaigns. */
  targetRoas?: number | undefined;
  /** Campaign-level Target CPA in micros. Set on TARGET_CPA or
   *  MAXIMIZE_CONVERSIONS-with-target campaigns. */
  targetCpaMicros?: number | undefined;
  budgetMicros?: number | undefined;
  impressions?: number | undefined;
  clicks?: number | undefined;
  costMicros?: number | undefined;
  conversions?: number | undefined;
  convValue?: number | undefined;
  ctr?: number | undefined;
  avgCpc?: number | undefined;
  searchIs?: number | undefined;
  searchTopIs?: number | undefined;
  searchAbsTopIs?: number | undefined;
  budgetLostIs?: number | undefined;
  rankLostIs?: number | undefined;
}

export interface CampaignPerformanceSnapshot {
  date: string;
  campaignId: string;
  campaignName?: string | undefined;
  channelType?: string | undefined;
  impressions?: number | undefined;
  clicks?: number | undefined;
  costMicros?: number | undefined;
  conversions?: number | undefined;
  convValue?: number | undefined;
}

export interface AdGroupSnapshot {
  campaignName: string;
  adGroupName: string;
  campaignId?: string | undefined;
  adGroupId?: string | undefined;
  status?: string | undefined;
  impressions?: number | undefined;
  clicks?: number | undefined;
  costMicros?: number | undefined;
  conversions?: number | undefined;
  convValue?: number | undefined;
  ctr?: number | undefined;
  avgCpc?: number | undefined;
}

export interface KeywordSnapshot {
  campaignName: string;
  adGroupName: string;
  keyword: string;
  matchType?: string | undefined;
  status?: string | undefined;
  qualityScore?: number | undefined;
  impressions?: number | undefined;
  clicks?: number | undefined;
  costMicros?: number | undefined;
  conversions?: number | undefined;
  convValue?: number | undefined;
  ctr?: number | undefined;
  avgCpc?: number | undefined;
  searchIs?: number | undefined;
}

export interface RsaAdSnapshot {
  campaignName: string;
  adGroupName: string;
  adId: string;
  headlines?: readonly string[] | undefined;
  descriptions?: readonly string[] | undefined;
  finalUrl?: string | undefined;
  status?: string | undefined;
  adStrength?: string | undefined;
  impressions?: number | undefined;
  clicks?: number | undefined;
  costMicros?: number | undefined;
  conversions?: number | undefined;
  ctr?: number | undefined;
}

export interface AssetGroupSnapshot {
  assetGroupId: string;
  assetGroupName: string;
  campaignId?: string | undefined;
  campaignName?: string | undefined;
  status?: string | undefined;
  adStrength?: string | undefined;
  impressions?: number | undefined;
  clicks?: number | undefined;
  costMicros?: number | undefined;
  conversions?: number | undefined;
  convValue?: number | undefined;
}

export interface AssetGroupAssetSnapshot {
  assetGroupName: string;
  fieldType: string;
  campaignName?: string | undefined;
  assetStatus?: string | undefined;
  assetId?: string | undefined;
  assetName?: string | undefined;
  assetType?: string | undefined;
  textContent?: string | undefined;
  imageUrl?: string | undefined;
}

export interface AssetSnapshot {
  assetId: string;
  type: string;
  name?: string | undefined;
  sitelinkText?: string | undefined;
  sitelinkDesc1?: string | undefined;
  sitelinkDesc2?: string | undefined;
  calloutText?: string | undefined;
  snippetHeader?: string | undefined;
  snippetValues?: string | undefined;
}

export interface ListingGroupSnapshot {
  campaignName?: string | undefined;
  assetGroupName?: string | undefined;
  filterId?: string | undefined;
  filterType?: string | undefined;
  brand?: string | undefined;
  categoryId?: string | undefined;
  productType?: string | undefined;
  customAttribute?: string | undefined;
}

export interface ShoppingProductSnapshot {
  campaignName?: string | undefined;
  itemId?: string | undefined;
  title?: string | undefined;
  brand?: string | undefined;
  status?: string | undefined;
  channel?: string | undefined;
  language?: string | undefined;
  issues?: string | undefined;
  impressions?: number | undefined;
  clicks?: number | undefined;
  costMicros?: number | undefined;
}

export interface ConversionActionSnapshot {
  convActionId: string;
  name?: string | undefined;
  type?: string | undefined;
  category?: string | undefined;
  status?: string | undefined;
  primaryForGoal?: boolean | undefined;
  countingType?: string | undefined;
  attributionModel?: string | undefined;
  defaultValue?: number | undefined;
  inConversionsMetric?: boolean | undefined;
}

export interface CampaignTargetingSnapshot {
  criterionType: string;
  campaignId?: string | undefined;
  campaignName?: string | undefined;
  isNegative?: boolean | undefined;
  status?: string | undefined;
  bidModifier?: number | undefined;
  geoTarget?: string | undefined;
  language?: string | undefined;
  keywordText?: string | undefined;
  matchType?: string | undefined;
}

export interface SearchTermSnapshot {
  searchTerm: string;
  campaignName?: string | undefined;
  channelType?: string | undefined;
  adGroupName?: string | undefined;
  termStatus?: string | undefined;
  impressions?: number | undefined;
  clicks?: number | undefined;
  costMicros?: number | undefined;
  conversions?: number | undefined;
  convValue?: number | undefined;
  ctr?: number | undefined;
}

export interface PmaxSearchTermSnapshot {
  campaignId?: string | undefined;
  campaignName?: string | undefined;
  searchCategory?: string | undefined;
  insightId?: string | undefined;
}

export interface PmaxPlacementSnapshot {
  campaignId?: string | undefined;
  campaignName?: string | undefined;
  placement?: string | undefined;
  placementType?: string | undefined;
  targetUrl?: string | undefined;
}

export interface LandingPageSnapshot {
  landingPageUrl: string;
  campaignName?: string | undefined;
  impressions?: number | undefined;
  clicks?: number | undefined;
  costMicros?: number | undefined;
  conversions?: number | undefined;
  convValue?: number | undefined;
  avgCpc?: number | undefined;
}

export interface AdAssetRatingSnapshot {
  fieldType: string;
  campaignName?: string | undefined;
  adGroupName?: string | undefined;
  performanceLabel?: string | undefined;
  enabled?: boolean | undefined;
  textContent?: string | undefined;
  impressions?: number | undefined;
  clicks?: number | undefined;
  costMicros?: number | undefined;
  conversions?: number | undefined;
}

export interface AudienceSignalSnapshot {
  campaignName?: string | undefined;
  assetGroupName?: string | undefined;
  signalType?: string | undefined;
  signalLabel?: string | undefined;
}

export interface DevicePerformanceSnapshot {
  device: string;
  campaignId?: string | undefined;
  campaignName?: string | undefined;
  channelType?: string | undefined;
  impressions?: number | undefined;
  clicks?: number | undefined;
  costMicros?: number | undefined;
  conversions?: number | undefined;
  convValue?: number | undefined;
  ctr?: number | undefined;
}

export interface GeoPerformanceSnapshot {
  campaignId?: string | undefined;
  campaignName?: string | undefined;
  countryId?: string | undefined;
  locationType?: string | undefined;
  geoTargetRegion?: string | undefined;
  impressions?: number | undefined;
  clicks?: number | undefined;
  costMicros?: number | undefined;
  conversions?: number | undefined;
  convValue?: number | undefined;
}

export interface ChangeHistorySnapshot {
  changeDate: string;
  resourceType?: string | undefined;
  operation?: string | undefined;
  changedFields?: string | undefined;
  userEmail?: string | undefined;
  clientType?: string | undefined;
  campaignName?: string | undefined;
}

export interface Ga4ObservationSnapshot {
  date: string;
  sessionSource?: string | undefined;
  sessionMedium?: string | undefined;
  sessions?: number | undefined;
  totalUsers?: number | undefined;
  newUsers?: number | undefined;
  bounceRate?: number | undefined;
  avgSessionDuration?: number | undefined;
  conversions?: number | undefined;
  eventCount?: number | undefined;
}

export interface GscObservationSnapshot {
  dateMonth: string;
  query?: string | undefined;
  page?: string | undefined;
  country?: string | undefined;
  device?: string | undefined;
  clicks?: number | undefined;
  impressions?: number | undefined;
  ctr?: number | undefined;
  position?: number | undefined;
}
