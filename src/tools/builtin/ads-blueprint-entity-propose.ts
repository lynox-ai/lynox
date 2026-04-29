/**
 * Tool: ads_blueprint_entity_propose
 *
 * Agent-driven companion to `ads_blueprint_run`. The deterministic
 * orchestrator only produces KEEP/RENAME/PAUSE/NEW for the snapshot
 * entity types it can derive from data (campaigns, ad-groups, keywords,
 * asset-groups, plus generated negatives). Anything that needs
 * qualitative reasoning — new RSAs, asset proposals for low-strength
 * Asset Groups, audience signals, sitelinks/callouts copy, validated
 * PMAX SPLIT/MERGE — gets persisted via this tool.
 *
 * Workflow position: AFTER `ads_blueprint_run`, BEFORE `ads_emit_csv`.
 * The agent reads the audit findings + low-strength asset-group surface
 * from the blueprint report, runs DataForSEO/LP-crawl/customer-profile
 * lookups, and then submits each proposal through this tool.
 *
 * SPLIT and MERGE proposals are run through `evaluateRestructureSafeguards`
 * before being persisted. A blocked proposal is rejected with the full
 * reason set so the agent can adjust (raise confidence, expand
 * rationale, defer until smart-bidding-guard expires).
 *
 * Idempotent: same payload + same external_id → row is upserted, not
 * duplicated. The agent can re-call to revise an earlier proposal.
 *
 * Gated by feature flag 'ads-optimizer'.
 */
import type { ToolEntry, IAgent } from '../../types/index.js';
import type {
  AdsDataStore,
  AdsBlueprintEntityKind,
  InsertBlueprintEntityInput,
  AdsAccountRow,
  AdsAuditRunRow,
} from '../../core/ads-data-store.js';
import {
  evaluateRestructureSafeguards,
  type RestructureKind,
  type RestructureProposal,
} from '../../core/ads-pmax-restructure.js';
import { checkName } from '../../core/ads-naming-convention.js';
import { getErrorMessage } from '../../core/utils.js';
import { createHash } from 'node:crypto';

interface AdsBlueprintEntityProposeInput {
  ads_account_id: string;
  entity_type: 'campaign' | 'ad_group' | 'rsa_ad' | 'asset_group' | 'asset'
              | 'audience_signal' | 'listing_group' | 'sitelink' | 'callout' | 'negative';
  kind: AdsBlueprintEntityKind;
  /**
   * Free-form payload — its required keys depend on entity_type. See the
   * tool description for the canonical shape per type. The shape mirrors
   * the field names emit-engine reads, so the agent can match its model
   * of "what to ask for" 1:1 against what Editor receives.
   */
  payload: Record<string, unknown>;
  confidence: number;
  rationale: string;
  /** Optional: target a specific run. Defaults to the latest SUCCESS run. */
  run_id?: number | undefined;
  /** Optional explicit external_id; auto-derived from payload when omitted. */
  external_id?: string | undefined;
  /** SPLIT/MERGE only: the asset_group external_ids the operation acts on. */
  source_external_ids?: readonly string[] | undefined;
  /** SPLIT/MERGE only: external_ids of the new asset-groups the operation creates. */
  proposed_external_ids?: readonly string[] | undefined;
}

const DESCRIPTION = [
  'Persist an agent-derived blueprint entity (asset, asset-group, audience signal, RSA, sitelink, callout, etc.).',
  '',
  'Workflow position: AFTER `ads_blueprint_run`, BEFORE `ads_emit_csv`. Use this',
  'tool to record:',
  '  - new RSA ads (use entity_type="rsa_ad", kind="NEW", payload={ad_group_name,',
  '    headlines: [...], descriptions: [...], final_url, ...}).',
  '  - asset proposals for low-strength PMAX asset-groups (entity_type="asset",',
  '    kind="NEW", payload={asset_group_name, field_type ∈ {HEADLINE, LONG_HEADLINE,',
  '    DESCRIPTION, BUSINESS_NAME, CALL_TO_ACTION, IMAGE, LOGO, VIDEO}, index, text}).',
  '  - audience signals (entity_type="audience_signal", payload={asset_group_name,',
  '    audience_name, interest_categories?, custom_audience_segments?, ...}).',
  '  - new asset-groups (entity_type="asset_group", kind="NEW", payload={campaign_name,',
  '    asset_group_name, final_url}).',
  '  - sitelinks/callouts (entity_type ∈ {sitelink, callout}, payload={text, ...}).',
  '  - PMAX SPLIT/MERGE: kind="SPLIT" or "MERGE" + source_external_ids +',
  '    proposed_external_ids. The tool runs the safeguards; blocked proposals',
  '    are rejected with the full reason set.',
  '',
  'Every proposal lands as source="agent" so a re-run of `ads_blueprint_run`',
  'does not wipe it. Re-calling with the same external_id (or with the same',
  'auto-derived one from a stable payload) updates the row in place.',
].join('\n');

interface KnowledgeLayerLite {
  store(
    text: string,
    namespace: 'knowledge' | 'methods' | 'status' | 'learnings',
    scope: { type: 'global' | 'context' | 'user'; id: string },
    options?: { sourceRunId?: string | undefined; skipContradictionCheck?: boolean | undefined } | undefined,
  ): Promise<{ memoryId: string; stored: boolean; deduplicated: boolean }>;
}

export function createAdsBlueprintEntityProposeTool(store: AdsDataStore): ToolEntry<AdsBlueprintEntityProposeInput> {
  return {
    definition: {
      name: 'ads_blueprint_entity_propose',
      description: DESCRIPTION,
      input_schema: {
        type: 'object' as const,
        properties: {
          ads_account_id: { type: 'string', description: 'Google Ads Customer ID, e.g. "123-456-7890".' },
          entity_type: { type: 'string', enum: ['campaign', 'ad_group', 'rsa_ad', 'asset_group', 'asset', 'audience_signal', 'listing_group', 'sitelink', 'callout', 'negative'] },
          kind: { type: 'string', enum: ['KEEP', 'RENAME', 'NEW', 'PAUSE', 'SPLIT', 'MERGE'] },
          payload: { type: 'object', description: 'Entity-specific payload — see the tool description for required keys per entity_type.' },
          confidence: { type: 'number', description: '0..1; PMAX SPLIT/MERGE require ≥ 0.9 to clear safeguards.' },
          rationale: { type: 'string', description: 'Why this proposal exists. PMAX SPLIT/MERGE require ≥ 30 chars for the safeguards.' },
          run_id: { type: 'integer', description: 'Optional: target a specific run. Defaults to latest SUCCESS run.' },
          external_id: { type: 'string', description: 'Optional explicit external_id; auto-derived when omitted.' },
          source_external_ids: { type: 'array', items: { type: 'string' }, description: 'SPLIT/MERGE only: source asset-group external_ids.' },
          proposed_external_ids: { type: 'array', items: { type: 'string' }, description: 'SPLIT/MERGE only: new asset-group external_ids the op creates.' },
        },
        required: ['ads_account_id', 'entity_type', 'kind', 'payload', 'confidence', 'rationale'],
      },
    },
    handler: async (input: AdsBlueprintEntityProposeInput, agent: IAgent): Promise<string> => {
      try {
        const account = store.getAdsAccount(input.ads_account_id);
        if (!account) {
          return `ads_blueprint_entity_propose failed: unknown ads_account_id "${input.ads_account_id}".`;
        }
        const customer = store.getCustomerProfile(account.customer_id);
        if (!customer) {
          return `ads_blueprint_entity_propose failed: customer profile missing for "${account.customer_id}".`;
        }

        // Resolve run. Priority:
        //   1. Explicit input.run_id (validated for account match).
        //   2. Pending-import run: if a previous run produced action entities
        //      and the customer hasn't imported them yet, agent additions
        //      should land on THAT run so emit picks them up alongside the
        //      pending pack. Mirrors emit's fallback logic.
        //   3. Latest successful audit run.
        let runId: number;
        if (input.run_id !== undefined) {
          const run = store.getAuditRun(input.run_id);
          if (!run || run.ads_account_id !== input.ads_account_id) {
            return `ads_blueprint_entity_propose failed: run_id ${input.run_id} not found for account ${input.ads_account_id}.`;
          }
          runId = input.run_id;
        } else {
          const pending = findPendingProposalRun(store, account);
          if (pending) {
            runId = pending.run_id;
          } else {
            const run = store.getLatestSuccessfulAuditRun(input.ads_account_id);
            if (!run) {
              return `ads_blueprint_entity_propose failed: no successful run for ${input.ads_account_id}. Run ads_blueprint_run first.`;
            }
            runId = run.run_id;
          }
        }

        // Auto-derive campaign_name when the agent only knows the asset_group
        // (for asset / audience_signal) or when the account has exactly one
        // campaign (for callout / sitelink). The validator runs after this so
        // the agent's payload effectively grows a campaign_name field.
        autofillCampaignName(input, store, runId);

        // Validate input shape.
        const validation = validatePayload(input);
        if (!validation.ok) {
          const knownCampaigns = store.listCampaignNamesForRun(runId, input.ads_account_id);
          const hint = knownCampaigns.length > 0
            ? ` Known campaigns in run ${runId}: ${knownCampaigns.map(n => `"${n}"`).join(', ')}.`
            : '';
          return `ads_blueprint_entity_propose failed: ${validation.error}${hint}`;
        }

        // PMAX SPLIT/MERGE: run safeguards.
        if (input.kind === 'SPLIT' || input.kind === 'MERGE') {
          if (input.entity_type !== 'asset_group') {
            return `ads_blueprint_entity_propose failed: SPLIT/MERGE only valid for entity_type='asset_group'.`;
          }
          if (!input.source_external_ids || !input.proposed_external_ids) {
            return `ads_blueprint_entity_propose failed: SPLIT/MERGE require source_external_ids + proposed_external_ids.`;
          }
          const proposal: RestructureProposal = {
            kind: input.kind as RestructureKind,
            sourceExternalIds: input.source_external_ids,
            proposedExternalIds: input.proposed_external_ids,
            confidence: input.confidence,
            rationale: input.rationale,
          };
          const sourceVolumes = input.source_external_ids.map(id => ({
            externalId: id,
            conversions30d: lookupAssetGroupConv30d(store, runId, input.ads_account_id, id),
          }));
          const evalResult = evaluateRestructureSafeguards(proposal, sourceVolumes, account);
          if (!evalResult.allowed) {
            return [
              `ads_blueprint_entity_propose blocked: PMAX-Safeguards verletzen Voraussetzungen für ${input.kind}.`,
              ...evalResult.blockedReasons.map(r => `  - ${r}`),
              `(Hinweis: confidence ≥ 0.9, rationale ≥ 30 Zeichen, Asset-Groups < 30 conv/30d ODER beide; letzter Import ≥ 14d her.)`,
            ].join('\n');
          }
        }

        // Naming-convention check on KEEP/RENAME/NEW for visible entity types.
        const namingResult = runNamingCheck(input, customer);

        // Auto-derive external_id from payload when missing.
        const externalId = input.external_id ?? deriveExternalId(input);

        const persistInput: InsertBlueprintEntityInput = {
          runId,
          adsAccountId: input.ads_account_id,
          entityType: input.entity_type,
          kind: input.kind,
          externalId,
          ...(input.source_external_ids?.[0] !== undefined ? { previousExternalId: input.source_external_ids[0] } : {}),
          payload: input.payload,
          confidence: input.confidence,
          rationale: input.rationale,
          source: 'agent',
          ...(namingResult ? { namingValid: namingResult.valid, namingErrors: namingResult.errors } : {}),
        };

        // Idempotent: drop any existing agent row with the same
        // (run_id, entity_type, external_id) before re-inserting. The
        // companion run-decisions row is upserted by insertRunDecision.
        store.deleteAgentBlueprintEntity(runId, input.entity_type, externalId);

        const row = store.insertBlueprintEntity(persistInput);

        // Companion ads_run_decisions row.
        store.insertRunDecision({
          runId,
          entityType: toDecisionEntityType(input.entity_type),
          entityExternalId: externalId,
          decision: input.kind,
          ...(input.source_external_ids?.[0] !== undefined ? { previousExternalId: input.source_external_ids[0] } : {}),
          confidence: input.confidence,
          rationale: input.rationale,
        });

        // KG mirror — semantic search across cycles for proposed entities.
        const kg = agent.toolContext.knowledgeLayer as KnowledgeLayerLite | null;
        if (kg) {
          try {
            await kg.store(
              `[ads-blueprint ${runId} • ${input.kind} ${input.entity_type}] ${input.rationale}`,
              'knowledge',
              { type: 'context', id: input.ads_account_id },
              { sourceRunId: String(runId), skipContradictionCheck: true },
            );
          } catch {
            // best-effort
          }
        }

        return `Blueprint-Vorschlag aufgenommen: #${row.blueprint_id} (${input.kind} ${input.entity_type}/${externalId}) auf Run ${runId}.`;
      } catch (err) {
        return `ads_blueprint_entity_propose failed: ${getErrorMessage(err)}`;
      }
    },
  };
}

// ── Validation per entity_type ────────────────────────────────────────

/** Mutates input.payload to fill in campaign_name when the agent left it
 *  blank but it is recoverable from the snapshot. Avoids forcing the agent
 *  to guess campaign names it can derive from the data. */
/** Find the run an agent proposal should land on by default: the latest
 *  run whose action entities (NEW/RENAME/PAUSE/SPLIT/MERGE) are not yet
 *  reflected by a customer import. If the customer is current, falls back
 *  to the latest SUCCESS run via the caller. */
function findPendingProposalRun(store: AdsDataStore, account: AdsAccountRow): AdsAuditRunRow | null {
  const candidate = store.findLatestRunWithBlueprintEntities(account.ads_account_id);
  if (!candidate || !candidate.finished_at) return null;
  const counts = store.countBlueprintEntities(candidate.run_id);
  const pendingActions = counts.NEW + counts.RENAME + counts.PAUSE + counts.SPLIT + counts.MERGE;
  if (pendingActions === 0) return null;
  const lastImport = account.last_major_import_at;
  if (lastImport === null) return candidate;
  if (new Date(lastImport).getTime() < new Date(candidate.finished_at).getTime()) return candidate;
  return null;
}

function autofillCampaignName(
  input: AdsBlueprintEntityProposeInput,
  store: AdsDataStore,
  runId: number,
): void {
  const p = input.payload;
  const has = (k: string): boolean => typeof p[k] === 'string' && (p[k] as string).length > 0;
  if (has('campaign_name')) return;

  const groupBound: ReadonlySet<string> = new Set(['asset', 'audience_signal']);
  if (groupBound.has(input.entity_type) && has('asset_group_name')) {
    const resolved = store.findCampaignNameByAssetGroup(
      runId, input.ads_account_id, p['asset_group_name'] as string,
    );
    if (resolved) {
      p['campaign_name'] = resolved;
      return;
    }
  }

  const campaignBound: ReadonlySet<string> = new Set(['callout', 'sitelink']);
  if (campaignBound.has(input.entity_type)) {
    const known = store.listCampaignNamesForRun(runId, input.ads_account_id);
    if (known.length === 1) {
      p['campaign_name'] = known[0];
    }
  }
}

/** Editor character limits enforced at propose-time so the agent fails fast
 *  instead of writing entities that emit will reject. Numbers match Google
 *  Ads Editor's import expectations. */
const FIELD_LIMITS = {
  headline: 30,        // RSA headlines, asset HEADLINE
  description: 90,     // RSA descriptions, asset DESCRIPTION
  longHeadline: 90,    // PMax LONG_HEADLINE
  sitelink: 25,        // sitelink display text
  callout: 25,         // callout text
} as const;

const ASSET_FIELD_LIMIT: Record<string, number> = {
  HEADLINE: FIELD_LIMITS.headline,
  LONG_HEADLINE: FIELD_LIMITS.longHeadline,
  DESCRIPTION: FIELD_LIMITS.description,
};

function collectLengthViolations(values: unknown[], limit: number, label: string): string | null {
  const violations: string[] = [];
  for (const v of values) {
    if (typeof v !== 'string') continue;
    if (v.length > limit) violations.push(`${label} > ${limit} Zeichen: "${v}" (${v.length})`);
  }
  return violations.length > 0 ? violations.join(' | ') : null;
}

function validatePayload(input: AdsBlueprintEntityProposeInput): { ok: true } | { ok: false; error: string } {
  if (typeof input.confidence !== 'number' || input.confidence < 0 || input.confidence > 1) {
    return { ok: false, error: 'confidence must be a number in [0, 1]' };
  }
  if (typeof input.rationale !== 'string' || input.rationale.trim().length < 5) {
    return { ok: false, error: 'rationale must be ≥ 5 characters' };
  }
  const p = input.payload;
  const need = (k: string): string | null => {
    const v = p[k];
    return typeof v === 'string' && v.length > 0 ? null : `payload.${k} required (string)`;
  };
  switch (input.entity_type) {
    case 'campaign': {
      const e = need('campaign_name');
      return e ? { ok: false, error: e } : { ok: true };
    }
    case 'ad_group': {
      const e = need('campaign_name') ?? need('ad_group_name');
      return e ? { ok: false, error: e } : { ok: true };
    }
    case 'rsa_ad': {
      const e = need('campaign_name') ?? need('ad_group_name') ?? need('final_url');
      if (e) return { ok: false, error: e };
      const heads = p['headlines'];
      const descs = p['descriptions'];
      if (!Array.isArray(heads) || heads.length < 5) return { ok: false, error: 'rsa_ad needs ≥ 5 headlines' };
      if (!Array.isArray(descs) || descs.length < 2) return { ok: false, error: 'rsa_ad needs ≥ 2 descriptions' };
      const headViolations = collectLengthViolations(heads, FIELD_LIMITS.headline, 'Headline');
      if (headViolations) return { ok: false, error: headViolations };
      const descViolations = collectLengthViolations(descs, FIELD_LIMITS.description, 'Description');
      if (descViolations) return { ok: false, error: descViolations };
      return { ok: true };
    }
    case 'asset_group': {
      const e = need('campaign_name') ?? need('asset_group_name');
      return e ? { ok: false, error: e } : { ok: true };
    }
    case 'asset': {
      const e = need('campaign_name') ?? need('asset_group_name') ?? need('field_type');
      if (e) return { ok: false, error: e };
      const fieldType = String(p['field_type']).toUpperCase();
      const text = p['text'];
      if (typeof text === 'string') {
        const limit = ASSET_FIELD_LIMIT[fieldType];
        if (limit !== undefined && text.length > limit) {
          return { ok: false, error: `${fieldType} > ${limit} Zeichen: "${text}" (${text.length})` };
        }
      }
      return { ok: true };
    }
    case 'audience_signal': {
      const e = need('campaign_name') ?? need('asset_group_name') ?? need('audience_name');
      return e ? { ok: false, error: e } : { ok: true };
    }
    case 'listing_group': {
      const e = need('campaign_name') ?? need('product_group');
      return e ? { ok: false, error: e } : { ok: true };
    }
    case 'sitelink': {
      const e = need('campaign_name') ?? need('text') ?? need('final_url');
      if (e) return { ok: false, error: e };
      const text = String(p['text']);
      if (text.length > FIELD_LIMITS.sitelink) {
        return { ok: false, error: `Sitelink-Text > ${FIELD_LIMITS.sitelink} Zeichen: "${text}" (${text.length})` };
      }
      return { ok: true };
    }
    case 'callout': {
      const e = need('campaign_name') ?? need('text');
      if (e) return { ok: false, error: e };
      const text = String(p['text']);
      if (text.length > FIELD_LIMITS.callout) {
        return { ok: false, error: `Callout > ${FIELD_LIMITS.callout} Zeichen: "${text}" (${text.length})` };
      }
      return { ok: true };
    }
    case 'negative': {
      const e = need('keyword_text') ?? need('match_type');
      return e ? { ok: false, error: e } : { ok: true };
    }
  }
}

interface NamingResult { valid: boolean; errors: string[]; }

function runNamingCheck(
  input: AdsBlueprintEntityProposeInput,
  customer: { naming_convention_pattern: string | null; languages: string; own_brands: string },
): NamingResult | null {
  const pattern = customer.naming_convention_pattern;
  if (!pattern) return null;
  // Check the entity types whose name flows into Editor naming.
  const nameKey = ({
    campaign: 'campaign_name', ad_group: 'ad_group_name', asset_group: 'asset_group_name',
  } as Record<string, string | undefined>)[input.entity_type];
  if (!nameKey) return null;
  const name = input.payload[nameKey];
  if (typeof name !== 'string' || name.length === 0) return null;
  const r = checkName(name, pattern, {
    languages: parseStringArray(customer.languages),
    ownBrands: parseStringArray(customer.own_brands),
  });
  return { valid: r.valid, errors: r.errors };
}

function parseStringArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

// ── External-id derivation + decision-type mapping ───────────────────

function deriveExternalId(input: AdsBlueprintEntityProposeInput): string {
  const p = input.payload;
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 60);
  switch (input.entity_type) {
    case 'campaign':
      return `bp.campaign.${slug(String(p['campaign_name'] ?? ''))}`;
    case 'ad_group':
      return `bp.ag.${slug(String(p['campaign_name'] ?? ''))}.${slug(String(p['ad_group_name'] ?? ''))}`;
    case 'rsa_ad':
      return `bp.rsa.${slug(String(p['campaign_name'] ?? ''))}.${slug(String(p['ad_group_name'] ?? ''))}.${shortHash(JSON.stringify(p['headlines'] ?? []))}`;
    case 'asset_group':
      return `bp.assetgroup.${slug(String(p['campaign_name'] ?? ''))}.${slug(String(p['asset_group_name'] ?? ''))}`;
    case 'asset':
      return `bp.asset.${slug(String(p['asset_group_name'] ?? ''))}.${slug(String(p['field_type'] ?? ''))}.${p['index'] ?? '0'}.${shortHash(String(p['text'] ?? p['video_id'] ?? p['asset_name'] ?? ''))}`;
    case 'audience_signal':
      return `bp.audience.${slug(String(p['asset_group_name'] ?? ''))}.${slug(String(p['audience_name'] ?? ''))}`;
    case 'listing_group':
      return `bp.listing.${slug(String(p['campaign_name'] ?? ''))}.${slug(String(p['product_group'] ?? ''))}`;
    case 'sitelink':
      return `bp.sitelink.${slug(String(p['campaign_name'] ?? ''))}.${slug(String(p['text'] ?? ''))}`;
    case 'callout':
      return `bp.callout.${slug(String(p['campaign_name'] ?? ''))}.${slug(String(p['text'] ?? ''))}`;
    case 'negative': {
      const scopeTarget = String(p['scope_target'] ?? 'account');
      return `bp.neg.${slug(scopeTarget)}.${slug(String(p['keyword_text'] ?? ''))}.${slug(String(p['match_type'] ?? 'broad'))}`;
    }
  }
}

function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 8);
}

function toDecisionEntityType(entityType: AdsBlueprintEntityProposeInput['entity_type']): 'campaign' | 'ad_group' | 'keyword' | 'rsa_ad' | 'asset_group' | 'asset' | 'listing_group' | 'sitelink' | 'callout' | 'snippet' | 'negative' {
  if (entityType === 'audience_signal') return 'asset_group';
  return entityType;
}

function lookupAssetGroupConv30d(
  store: AdsDataStore, runId: number, accountId: string, externalId: string,
): number {
  // ads_asset_groups stores rolling 30d performance directly (per the
  // GAS export's window). Match by asset_group_id; fall back to 0 if
  // the id is not in the snapshot (which the safeguards then treat as
  // below-floor — the most conservative outcome for unknown groups).
  const rows = store.getSnapshotRows<{ asset_group_id: string; conversions: number | null }>(
    'ads_asset_groups', accountId, { runId },
  );
  const match = rows.find(r => r.asset_group_id === externalId);
  return match?.conversions ?? 0;
}
