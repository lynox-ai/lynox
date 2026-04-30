/**
 * Phase-C pre-emit sanity-check engine.
 *
 * Runs deterministic semantic checks across the persisted blueprint
 * for one audit run, producing a list of `pre_emit_review:*` findings.
 *
 *   - severity = 'BLOCK'  → emit refuses to write CSVs until the
 *                           operator either fixes the blueprint and
 *                           re-runs review, or overrides explicitly.
 *   - severity = 'HIGH'   → renders as a warning in the review report
 *                           and audit Markdown but does not block emit.
 *
 * The engine is pure: no LLM, no I/O beyond the AdsDataStore reads.
 * The companion tool wrapper (`ads_blueprint_review`) clears prior
 * `pre_emit_review:*` findings before it asks the engine to re-check,
 * so the queue is idempotent on every call.
 *
 * Re-entry contract — explicit, in three steps so a hard_block never
 * strands the cycle:
 *   1. ads_blueprint_review re-checks → BLOCK findings persist.
 *   2. Operator fixes the underlying blueprint entity (via
 *      ads_blueprint_entity_propose) OR re-runs review with override.
 *   3. ads_emit_csv re-counts BLOCK findings → 0 → emit proceeds.
 *      Otherwise an EmitPreconditionError lists the BLOCK areas.
 */
import type {
  AdsDataStore, AdsBlueprintEntityRow, CustomerProfileRow,
  AdsFindingSeverity,
} from './ads-data-store.js';

/** Findings produced by the pre-emit review engine. They get persisted
 *  via `ads_findings` so emit can count them and the audit report can
 *  surface them on subsequent cycles. */
export interface PreEmitReviewFinding {
  area: `pre_emit_review:${string}`;
  severity: 'BLOCK' | 'HIGH';
  text: string;
  confidence: number;
  evidence: Record<string, unknown>;
}

export interface BlueprintReviewResult {
  findings: PreEmitReviewFinding[];
  /** Convenience: split for the tool wrapper's report. */
  blocks: PreEmitReviewFinding[];
  warnings: PreEmitReviewFinding[];
}

export function runBlueprintReview(
  store: AdsDataStore,
  runId: number,
  customer: CustomerProfileRow,
): BlueprintReviewResult {
  const entities = store.listBlueprintEntities(runId);
  const findings: PreEmitReviewFinding[] = [];

  findings.push(...detectDuplicateFinalUrls(entities));
  findings.push(...detectGenericAdCopyOnSpecialty(entities));
  findings.push(...detectBrandNamingDrift(entities, customer));
  findings.push(...detectThemeMismatch(entities, customer));
  findings.push(...detectBudgetAnomalies(entities, customer));

  return {
    findings,
    blocks: findings.filter(f => f.severity === 'BLOCK'),
    warnings: findings.filter(f => f.severity === 'HIGH'),
  };
}

export function isBlockingSeverity(s: AdsFindingSeverity): boolean {
  return s === 'BLOCK';
}

function detectDuplicateFinalUrls(entities: readonly AdsBlueprintEntityRow[]): PreEmitReviewFinding[] {
  type Bucket = { campaign: string; adGroup: string; entityType: string }[];
  const byUrl = new Map<string, Bucket>();
  for (const e of entities) {
    if (e.kind !== 'NEW') continue;
    if (e.entity_type !== 'rsa_ad' && e.entity_type !== 'asset_group') continue;
    const payload = parsePayload(e.payload_json);
    const url = stringField(payload, 'final_url');
    if (!url) continue;
    const campaign = stringField(payload, 'campaign_name') ?? '?';
    const ag = stringField(payload, 'ad_group_name')
      ?? stringField(payload, 'asset_group_name') ?? e.external_id;
    const key = url.trim().toLowerCase();
    const bucket = byUrl.get(key) ?? [];
    bucket.push({ campaign, adGroup: ag, entityType: e.entity_type });
    byUrl.set(key, bucket);
  }
  const out: PreEmitReviewFinding[] = [];
  for (const [url, bucket] of byUrl) {
    if (bucket.length < 2) continue;
    const labels = bucket.map(b => `${b.campaign}/${b.adGroup}`).join(' · ');
    out.push({
      area: 'pre_emit_review:duplicate_final_url',
      severity: 'BLOCK',
      confidence: 0.95,
      text: `${bucket.length} NEW Ad-Groups zeigen auf dieselbe Final URL "${url}": ${labels}. ` +
        `Wahrscheinliche Ursache: vergessener URL-Review oder zu enger Ad-Group-Split. ` +
        `Vor Emit korrigieren oder Override über ads_blueprint_review setzen.`,
      evidence: { url, ad_groups: bucket },
    });
  }
  return out;
}

const GENERIC_HEADLINES = new Set([
  'jetzt entdecken', 'mehr erfahren', 'jetzt online', 'online kaufen',
  'jetzt bestellen', 'jetzt kaufen', 'shop now', 'learn more',
]);

function detectGenericAdCopyOnSpecialty(entities: readonly AdsBlueprintEntityRow[]): PreEmitReviewFinding[] {
  const out: PreEmitReviewFinding[] = [];
  for (const e of entities) {
    if (e.entity_type !== 'rsa_ad' || e.kind !== 'NEW') continue;
    const payload = parsePayload(e.payload_json);
    const adGroup = stringField(payload, 'ad_group_name') ?? '';
    const isSpecialty = /^Brand-|^Theme-/.test(adGroup);
    if (!isSpecialty) continue;
    const headlines = arrayField<string>(payload, 'headlines') ?? [];
    if (headlines.length === 0) continue;
    const allGeneric = headlines.every(h => GENERIC_HEADLINES.has(h.trim().toLowerCase()));
    if (!allGeneric) continue;
    out.push({
      area: 'pre_emit_review:generic_copy_on_specialty',
      severity: 'HIGH',
      confidence: 0.85,
      text: `RSA für "${adGroup}" enthält ausschliesslich generische Headlines (${headlines.join(', ')}). ` +
        `Smart Bidding kann die Theme-Specifity nicht lernen — Operator soll vor Emit themed Headlines hinzufügen.`,
      evidence: { ad_group_name: adGroup, headlines },
    });
  }
  return out;
}

function detectBrandNamingDrift(
  entities: readonly AdsBlueprintEntityRow[],
  customer: CustomerProfileRow,
): PreEmitReviewFinding[] {
  const knownBrands = new Set([
    ...parseStringArray(customer.own_brands),
    ...parseStringArray(customer.sold_brands),
  ].map(b => b.toLowerCase().trim()).filter(Boolean));
  if (knownBrands.size === 0) return [];

  const out: PreEmitReviewFinding[] = [];
  for (const e of entities) {
    if (e.entity_type !== 'ad_group' || e.kind !== 'NEW') continue;
    const payload = parsePayload(e.payload_json);
    const name = stringField(payload, 'ad_group_name') ?? '';
    const m = /^Brand-(.+)$/.exec(name);
    if (!m) continue;
    const brand = m[1]!.trim().toLowerCase();
    if (knownBrands.has(brand)) continue;
    out.push({
      area: 'pre_emit_review:brand_naming_drift',
      severity: 'HIGH',
      confidence: 0.8,
      text: `Brand-Search-Ad-Group "${name}" referenziert die Marke "${brand}", die im Customer-Profile (own_brands/sold_brands) nicht gepflegt ist. ` +
        `Entweder Customer-Profile via ads_customer_profile_set ergänzen oder die Ad-Group umbenennen, sonst läuft Brand-Reporting an der Marke vorbei.`,
      evidence: { ad_group_name: name, brand_token: brand, known_brands: Array.from(knownBrands) },
    });
  }
  return out;
}

function detectThemeMismatch(
  entities: readonly AdsBlueprintEntityRow[],
  customer: CustomerProfileRow,
): PreEmitReviewFinding[] {
  const tops = parseStringArray(customer.top_products).map(s => s.toLowerCase().trim()).filter(Boolean);
  if (tops.length === 0) return [];
  const tokens = new Set<string>();
  for (const t of tops) for (const w of t.split(/\s+/)) if (w.length >= 4) tokens.add(w);

  const out: PreEmitReviewFinding[] = [];
  for (const e of entities) {
    if (e.entity_type !== 'asset_group' || e.kind !== 'NEW') continue;
    const payload = parsePayload(e.payload_json);
    const theme = stringField(payload, 'theme_token') ?? '';
    if (!theme) continue;
    if (matchesAny(theme.toLowerCase(), tokens)) continue;
    out.push({
      area: 'pre_emit_review:theme_mismatch_catalogue',
      severity: 'HIGH',
      confidence: 0.7,
      text: `Theme-AG "${theme}" überschneidet sich mit keinem Eintrag aus customer.top_products (${tops.join(', ')}). ` +
        `Entweder Customer-Profile erweitern oder vor Emit prüfen, ob das Thema wirklich zur Marke passt.`,
      evidence: { theme_token: theme, top_products: tops },
    });
  }
  return out;
}

function detectBudgetAnomalies(
  entities: readonly AdsBlueprintEntityRow[],
  customer: CustomerProfileRow,
): PreEmitReviewFinding[] {
  const monthly = customer.monthly_budget_chf ?? 0;
  if (monthly <= 0) return [];
  const dailyExpected = monthly / 30;

  const out: PreEmitReviewFinding[] = [];
  for (const e of entities) {
    if (e.entity_type !== 'campaign' || e.kind !== 'NEW') continue;
    const payload = parsePayload(e.payload_json);
    const name = stringField(payload, 'campaign_name') ?? '';
    const dailyBudget = numberField(payload, 'budget_chf');
    if (dailyBudget === null) continue;
    if (dailyBudget > dailyExpected * 24) {
      out.push({
        area: 'pre_emit_review:budget_anomaly_block',
        severity: 'BLOCK',
        confidence: 0.95,
        text: `NEW Campaign "${name}" hat Tagesbudget ${dailyBudget} CHF — frisst ≥80% des monatlichen Customer-Budgets (${monthly} CHF). ` +
          `Wahrscheinlich Tippfehler. Vor Emit korrigieren oder Override setzen.`,
        evidence: { campaign_name: name, daily_budget_chf: dailyBudget, monthly_budget_chf: monthly },
      });
    } else if (dailyBudget > dailyExpected * 9) {
      out.push({
        area: 'pre_emit_review:budget_anomaly_warning',
        severity: 'HIGH',
        confidence: 0.8,
        text: `NEW Campaign "${name}" hat Tagesbudget ${dailyBudget} CHF — entspricht ≥30% des Customer-Monatsbudgets (${monthly} CHF). ` +
          `Vor Emit prüfen, ob das gewollt ist.`,
        evidence: { campaign_name: name, daily_budget_chf: dailyBudget, monthly_budget_chf: monthly },
      });
    }
  }
  return out;
}

function parsePayload(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json);
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, unknown> : {};
  } catch { return {}; }
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function numberField(payload: Record<string, unknown>, key: string): number | null {
  const v = payload[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function arrayField<T>(payload: Record<string, unknown>, key: string): T[] | null {
  const v = payload[key];
  return Array.isArray(v) ? v as T[] : null;
}

function parseStringArray(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

function matchesAny(haystack: string, tokens: ReadonlySet<string>): boolean {
  for (const t of tokens) {
    if (haystack.includes(t) || t.includes(haystack)) return true;
  }
  return false;
}
