/**
 * Pre-Emit Validators.
 *
 * Hard-error checks that must pass before `ads_emit_csv` writes any
 * file to disk. Each blueprint entity is run through the relevant
 * subset of validators; any HARD error blocks the entire emit (the
 * Editor file would fail to import or, worse, import broken state),
 * any WARN is surfaced in the markdown summary but does not block.
 *
 * V1 covers the validators called out in the PRD:
 *   - Final URL: HTTPS scheme, well-formed (no live HTTP probe — that
 *     is the agent's job via http_request before calling emit).
 *   - Field-length limits per Google Ads Editor spec
 *     (Headline ≤ 30, Description ≤ 90, Sitelink text ≤ 25).
 *   - RSA minimum count: ≥ 5 headlines and ≥ 2 descriptions per ad.
 *   - Competitor-trademark scan against `customer_profile.competitors`
 *     (case-insensitive substring) on Headlines/Descriptions.
 *   - Cross-references: every `keyword.ad_group` must exist in the
 *     emitted ad-groups list, every ad-group's `campaign` must exist
 *     in the emitted campaigns list. Naming-convention violations
 *     persisted from P3 are surfaced here as WARN (already documented
 *     on the blueprint row).
 *
 * Pure utility, no I/O.
 */

import type { AdsBlueprintEntityRow, CustomerProfileRow } from './ads-data-store.js';

export type ValidatorSeverity = 'HARD' | 'WARN';

export interface ValidatorIssue {
  severity: ValidatorSeverity;
  area: string;
  externalId: string;
  entityType: string;
  message: string;
}

export interface ValidationSummary {
  hard: ValidatorIssue[];
  warn: ValidatorIssue[];
  /** True iff hard.length === 0. */
  canEmit: boolean;
}

interface RsaPayload {
  headlines?: readonly string[] | undefined;
  descriptions?: readonly string[] | undefined;
  finalUrl?: string | undefined;
}

const HEADLINE_MAX = 30;
const DESCRIPTION_MAX = 90;
const SITELINK_TEXT_MAX = 25;
const RSA_MIN_HEADLINES = 5;
const RSA_MIN_DESCRIPTIONS = 2;

export interface ValidationContext {
  customer: CustomerProfileRow;
}

/**
 * Validate every blueprint entity for one run.
 *
 * Returned `canEmit` is the gate the orchestrator checks before
 * writing files. The full hard/warn list is kept verbatim for the
 * markdown summary so the operator sees every reason an emit was
 * blocked, not just the first.
 */
export function validateBlueprint(
  entities: readonly AdsBlueprintEntityRow[],
  context: ValidationContext,
): ValidationSummary {
  const hard: ValidatorIssue[] = [];
  const warn: ValidatorIssue[] = [];

  // Build cross-reference indexes once.
  const campaignNames = new Set<string>();
  const adGroupKeys = new Set<string>(); // "campaign||adGroup"
  // Asset-content map per asset_group: counts headline + description assets
  // by (campaign||asset_group). Used to enforce that NEW asset_groups have
  // ≥5 headlines + ≥2 descriptions before emit — Editor accepts an empty
  // asset-group row but the resulting AG ships with no creative content,
  // which is a silent regression on import.
  const assetCounts = new Map<string, { headlines: number; descriptions: number }>();
  const bumpAsset = (key: string, kind: 'headlines' | 'descriptions'): void => {
    const c = assetCounts.get(key) ?? { headlines: 0, descriptions: 0 };
    c[kind]++;
    assetCounts.set(key, c);
  };
  for (const e of entities) {
    const payload = parsePayload(e.payload_json);
    if (e.entity_type === 'campaign') {
      const name = stringField(payload, 'campaign_name');
      if (name) campaignNames.add(name);
    }
    if (e.entity_type === 'ad_group') {
      const campaign = stringField(payload, 'campaign_name');
      const adGroup = stringField(payload, 'ad_group_name');
      if (campaign && adGroup) adGroupKeys.add(`${campaign}||${adGroup}`);
    }
    if (e.entity_type === 'asset') {
      const campaign = stringField(payload, 'campaign_name');
      const ag = stringField(payload, 'asset_group_name');
      const fieldType = (stringField(payload, 'field_type') ?? '').toUpperCase();
      if (campaign && ag) {
        const key = `${campaign}||${ag}`;
        if (fieldType === 'HEADLINE') bumpAsset(key, 'headlines');
        else if (fieldType === 'DESCRIPTION') bumpAsset(key, 'descriptions');
      }
    }
  }

  // Surface naming violations from P3 as WARN (each violation already
  // documented on its row).
  for (const e of entities) {
    if (e.naming_valid !== 0) continue;
    const errors = parseStringArray(e.naming_errors_json);
    warn.push({
      severity: 'WARN', area: 'naming_convention',
      externalId: e.external_id, entityType: e.entity_type,
      message: `Naming-Konvention verletzt: ${errors.join('; ') || 'keine Details'}`,
    });
  }

  // Per-entity validation.
  const competitors = parseStringArray(context.customer.competitors)
    .map(s => s.trim()).filter(s => s.length > 0);

  for (const e of entities) {
    const payload = parsePayload(e.payload_json);
    switch (e.entity_type) {
      case 'campaign':
        // No payload-level validators in V1 (status, budget already from snapshot).
        break;
      case 'ad_group': {
        const campaign = stringField(payload, 'campaign_name');
        if (campaign && !campaignNames.has(campaign)) {
          hard.push({
            severity: 'HARD', area: 'cross_reference',
            externalId: e.external_id, entityType: e.entity_type,
            message: `ad_group verweist auf campaign "${campaign}", die nicht im Blueprint emittiert wird.`,
          });
        }
        break;
      }
      case 'keyword': {
        const campaign = stringField(payload, 'campaign_name');
        const adGroup = stringField(payload, 'ad_group_name');
        if (campaign && adGroup && !adGroupKeys.has(`${campaign}||${adGroup}`)) {
          hard.push({
            severity: 'HARD', area: 'cross_reference',
            externalId: e.external_id, entityType: e.entity_type,
            message: `keyword verweist auf ad_group "${adGroup}" in campaign "${campaign}", die nicht im Blueprint emittiert wird.`,
          });
        }
        break;
      }
      case 'rsa_ad': {
        const rsa = payload as RsaPayload;
        const heads = (rsa.headlines ?? []).filter(h => typeof h === 'string' && h.length > 0);
        const descs = (rsa.descriptions ?? []).filter(d => typeof d === 'string' && d.length > 0);
        if (heads.length < RSA_MIN_HEADLINES) {
          hard.push({
            severity: 'HARD', area: 'rsa_min_count',
            externalId: e.external_id, entityType: e.entity_type,
            message: `RSA hat ${heads.length} Headlines (min. ${RSA_MIN_HEADLINES}).`,
          });
        }
        if (descs.length < RSA_MIN_DESCRIPTIONS) {
          hard.push({
            severity: 'HARD', area: 'rsa_min_count',
            externalId: e.external_id, entityType: e.entity_type,
            message: `RSA hat ${descs.length} Descriptions (min. ${RSA_MIN_DESCRIPTIONS}).`,
          });
        }
        for (const h of heads) {
          if (h.length > HEADLINE_MAX) {
            hard.push({
              severity: 'HARD', area: 'field_length',
              externalId: e.external_id, entityType: e.entity_type,
              message: `Headline > ${HEADLINE_MAX} Zeichen: "${h}" (${h.length})`,
            });
          }
          for (const c of competitors) {
            if (h.toLowerCase().includes(c.toLowerCase())) {
              hard.push({
                severity: 'HARD', area: 'competitor_trademark',
                externalId: e.external_id, entityType: e.entity_type,
                message: `Headline enthält Competitor-Trademark "${c}": "${h}".`,
              });
            }
          }
        }
        for (const d of descs) {
          if (d.length > DESCRIPTION_MAX) {
            hard.push({
              severity: 'HARD', area: 'field_length',
              externalId: e.external_id, entityType: e.entity_type,
              message: `Description > ${DESCRIPTION_MAX} Zeichen: "${d}" (${d.length})`,
            });
          }
          for (const c of competitors) {
            if (d.toLowerCase().includes(c.toLowerCase())) {
              hard.push({
                severity: 'HARD', area: 'competitor_trademark',
                externalId: e.external_id, entityType: e.entity_type,
                message: `Description enthält Competitor-Trademark "${c}": "${d}".`,
              });
            }
          }
        }
        if (rsa.finalUrl !== undefined) {
          const urlIssue = checkFinalUrl(rsa.finalUrl);
          if (urlIssue !== null) {
            hard.push({
              severity: 'HARD', area: 'final_url',
              externalId: e.external_id, entityType: e.entity_type,
              message: urlIssue,
            });
          }
        }
        break;
      }
      case 'asset': {
        // PMax asset additions to existing asset groups. Field-length is
        // governed by field_type — Editor refuses imports with over-limit
        // text and aquanatura's first run shipped two 130-char descriptions
        // because propose-side validation didn't exist yet.
        const text = stringField(payload, 'text');
        const fieldType = (stringField(payload, 'field_type') ?? '').toUpperCase();
        if (text) {
          const limit = fieldType === 'HEADLINE' ? HEADLINE_MAX
            : fieldType === 'LONG_HEADLINE' ? 90
            : fieldType === 'DESCRIPTION' ? DESCRIPTION_MAX
            : null;
          if (limit !== null && text.length > limit) {
            hard.push({
              severity: 'HARD', area: 'field_length',
              externalId: e.external_id, entityType: e.entity_type,
              message: `${fieldType} > ${limit} Zeichen: "${text}" (${text.length})`,
            });
          }
          for (const c of competitors) {
            if (text.toLowerCase().includes(c.toLowerCase())) {
              hard.push({
                severity: 'HARD', area: 'competitor_trademark',
                externalId: e.external_id, entityType: e.entity_type,
                message: `${fieldType} enthält Competitor-Trademark "${c}": "${text}".`,
              });
            }
          }
        }
        break;
      }
      case 'sitelink': {
        const text = stringField(payload, 'text');
        if (text && text.length > SITELINK_TEXT_MAX) {
          hard.push({
            severity: 'HARD', area: 'field_length',
            externalId: e.external_id, entityType: e.entity_type,
            message: `Sitelink-Text > ${SITELINK_TEXT_MAX} Zeichen: "${text}" (${text.length})`,
          });
        }
        // desc1 required on NEW sitelinks. Editor accepts the row but warns
        // ("Der Sitelink umfasst keine Textzeile") and live CTR suffers; we
        // catch it as HARD here so the bundle is import-clean. KEEP rows
        // pre-existed in the account and are not subject to this gate.
        if (e.kind === 'NEW') {
          const desc1 = stringField(payload, 'desc1');
          if (!desc1 || desc1.trim().length === 0) {
            hard.push({
              severity: 'HARD', area: 'sitelink_desc_missing',
              externalId: e.external_id, entityType: e.entity_type,
              message: `NEW sitelink "${text ?? '(no text)'}" hat keine desc1 — Editor warnt, CTR sinkt.`,
            });
          }
        }
        const url = stringField(payload, 'final_url');
        if (url) {
          const urlIssue = checkFinalUrl(url);
          if (urlIssue !== null) {
            hard.push({
              severity: 'HARD', area: 'final_url',
              externalId: e.external_id, entityType: e.entity_type,
              message: urlIssue,
            });
          }
        }
        break;
      }
      case 'asset_group': {
        // Content-completeness for NEW asset_groups: Editor accepts an
        // empty asset_group row but the resulting AG ships with no
        // creative content, which silently regresses the import (PMax
        // can't serve assets that don't exist). Enforce min ≥5
        // headlines + ≥2 descriptions across sibling asset entities.
        // KEEP asset_groups are existing — Editor leaves their assets
        // untouched, no enforcement needed.
        if (e.kind !== 'NEW') break;
        const campaign = stringField(payload, 'campaign_name');
        const ag = stringField(payload, 'asset_group_name');
        if (!campaign || !ag) break;
        const counts = assetCounts.get(`${campaign}||${ag}`) ?? { headlines: 0, descriptions: 0 };
        if (counts.headlines < RSA_MIN_HEADLINES) {
          hard.push({
            severity: 'HARD', area: 'asset_group_content',
            externalId: e.external_id, entityType: e.entity_type,
            message:
              `NEW asset_group "${ag}" hat ${counts.headlines} Headlines (min. ${RSA_MIN_HEADLINES}). ` +
              `Per propose 5+ HEADLINE-Assets ergänzen oder die Theme-Expansion erneut aufrufen.`,
          });
        }
        if (counts.descriptions < RSA_MIN_DESCRIPTIONS) {
          hard.push({
            severity: 'HARD', area: 'asset_group_content',
            externalId: e.external_id, entityType: e.entity_type,
            message:
              `NEW asset_group "${ag}" hat ${counts.descriptions} Descriptions (min. ${RSA_MIN_DESCRIPTIONS}). ` +
              `Per propose 2+ DESCRIPTION-Assets ergänzen oder die Theme-Expansion erneut aufrufen.`,
          });
        }
        break;
      }
      // negative / listing_group: no V1 validators
      default:
        break;
    }
  }

  return { hard, warn, canEmit: hard.length === 0 };
}

// ── Helpers ───────────────────────────────────────────────────────────

function checkFinalUrl(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed.length === 0) return 'Final URL ist leer.';
  if (!/^https:\/\//iu.test(trimmed)) {
    return `Final URL muss HTTPS sein, bekommt: "${trimmed}".`;
  }
  try {
    new URL(trimmed);
    return null;
  } catch {
    return `Final URL ist nicht parsebar: "${trimmed}".`;
  }
}

function parsePayload(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function stringField(p: Record<string, unknown>, key: string): string | null {
  const v = p[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function parseStringArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
