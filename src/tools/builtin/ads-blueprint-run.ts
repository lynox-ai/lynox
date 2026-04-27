/**
 * Tool: ads_blueprint_run
 *
 * Runs the deterministic P3 Blueprint phase against the latest
 * successful Ads Optimizer audit run. The orchestrator persists every
 * proposal into ads_blueprint_entities (full payload for P4 emit) and
 * mirrors the KEEP/RENAME/PAUSE/NEW classification into
 * ads_run_decisions (canonical history-preservation log). The tool
 * returns a Markdown blueprint report intended for direct thread
 * display.
 *
 * Workflow expectation — call AFTER `ads_audit_run` has succeeded for
 * the account. The Blueprint phase reads the audit run's snapshot,
 * findings, and customer profile; the only side-effect besides the
 * persisted blueprint is a `last_blueprint_run_at`-style update on
 * the account row (handled implicitly by the orchestrator). It does
 * not call DataForSEO/LP-crawl/GA4 — those are agent-driven and feed
 * the Audit phase via ads_finding_add.
 *
 * Gated by feature flag 'ads-optimizer'.
 */
import type { ToolEntry, IAgent } from '../../types/index.js';
import type {
  AdsDataStore,
  AdsBlueprintEntityKind,
} from '../../core/ads-data-store.js';
import {
  runBlueprint,
  BlueprintPreconditionError,
  type BlueprintResult,
} from '../../core/ads-blueprint-engine.js';
import type { NegativeProposal } from '../../core/ads-negative-generator.js';
import type { LowStrengthAssetGroup } from '../../core/ads-pmax-restructure.js';
import { getErrorMessage } from '../../core/utils.js';

interface AdsBlueprintRunInput {
  ads_account_id: string;
  /** Override waste-spend threshold for cross_campaign negatives (CHF). Default 5. */
  waste_spend_threshold_chf?: number | undefined;
}

const DESCRIPTION = [
  'Run the deterministic P3 Blueprint phase against the latest successful audit run.',
  '',
  'Workflow position — call AFTER `ads_audit_run` has succeeded AND after you have',
  'recorded all qualitative findings via `ads_finding_add` (DataForSEO keyword research,',
  'LP-crawl outcomes, tracking-audit results). The orchestrator reads the audit run\'s',
  'snapshot, the customer profile, and the previous-run decisions, then produces:',
  '  - History-preserving KEEP/RENAME/NEW/PAUSE classifications per entity type',
  '    (campaigns, ad-groups, keywords, asset-groups), with token-set-ratio',
  '    rename detection ≥ 0.8 plus stable-id match.',
  '  - Three-fold negative-keyword proposals (pmax_owned, competitor, cross_campaign).',
  '  - Naming-convention validation against the customer-profile token template;',
  '    violations are tagged on the blueprint row so emit can fail fast.',
  '  - Surface of low-strength asset-groups for additive attention.',
  '',
  'BOOTSTRAP-mode (first cycle or insufficient data) emits every current entity as KEEP',
  'plus additive negatives — no rename/pause logic. OPTIMIZE-mode runs the full',
  'history-preservation across the previous run.',
  '',
  'Returns a Markdown blueprint report intended for direct thread display. The full',
  'structured proposals are persisted into ads_blueprint_entities so `ads_emit_csv`',
  'can read them via run_id without re-running the orchestrator.',
].join('\n');

export function createAdsBlueprintRunTool(store: AdsDataStore): ToolEntry<AdsBlueprintRunInput> {
  return {
    definition: {
      name: 'ads_blueprint_run',
      description: DESCRIPTION,
      input_schema: {
        type: 'object' as const,
        properties: {
          ads_account_id: {
            type: 'string',
            description: 'Google Ads Customer ID (e.g. "123-456-7890") to plan a blueprint for.',
          },
          waste_spend_threshold_chf: {
            type: 'number',
            description: 'Override the cross_campaign waste-spend threshold. Default 5 CHF.',
          },
        },
        required: ['ads_account_id'],
      },
    },
    handler: async (input: AdsBlueprintRunInput, _agent: IAgent): Promise<string> => {
      try {
        const result = runBlueprint(store, input.ads_account_id, {
          ...(input.waste_spend_threshold_chf !== undefined
            ? { wasteSpendThreshold: input.waste_spend_threshold_chf } : {}),
        });
        return renderBlueprintReport(result);
      } catch (err) {
        if (err instanceof BlueprintPreconditionError) {
          return `ads_blueprint_run failed: ${err.message}`;
        }
        return `ads_blueprint_run failed: ${getErrorMessage(err)}`;
      }
    },
  };
}

// ── Markdown rendering ────────────────────────────────────────────────

export function renderBlueprintReport(result: BlueprintResult): string {
  const { account, customer, run, previousRun, mode, historyByType, negatives,
    lowStrengthAssetGroups, counts, namingViolations } = result;

  const lines: string[] = [];
  lines.push(`# Blueprint Report — ${customer?.client_name ?? account.customer_id} (${account.ads_account_id})`);
  lines.push('');
  lines.push(`**Run:** #${run.run_id} (${run.mode}) → Blueprint-Mode **${mode}**`);
  if (previousRun) {
    lines.push(`**Vorgänger:** #${previousRun.run_id} (${previousRun.mode}) · finished ${previousRun.finished_at ?? '?'}`);
  } else {
    lines.push('**Vorgänger:** keiner — Erstrun.');
  }
  lines.push('');
  lines.push(`**Persistierte Entities:** ${counts.total} (KEEP ${counts.KEEP} · RENAME ${counts.RENAME} · NEW ${counts.NEW} · PAUSE ${counts.PAUSE} · SPLIT ${counts.SPLIT} · MERGE ${counts.MERGE})`);
  lines.push('');

  appendModeGate(lines, mode);
  appendHistorySummary(lines, historyByType);
  appendNegatives(lines, negatives);
  appendNamingViolations(lines, namingViolations);
  appendLowStrengthAssetGroups(lines, lowStrengthAssetGroups);
  appendTradeOffWarnings(lines, mode, lowStrengthAssetGroups);
  appendNextSteps(lines, mode, namingViolations.length, negatives.length);

  return lines.join('\n');
}

function appendModeGate(lines: string[], mode: 'BOOTSTRAP' | 'OPTIMIZE'): void {
  lines.push('## Mode-Gate');
  lines.push('');
  if (mode === 'BOOTSTRAP') {
    lines.push('🟡 **BOOTSTRAP** — additive Empfehlungen only. Alle aktuellen Entities sind als KEEP klassifiziert; ' +
      'kein RENAME/PAUSE-Restructure. PMAX-Splits/Merges sind in diesem Mode generell deaktiviert.');
  } else {
    lines.push('🟢 **OPTIMIZE** — voller History-Preservation-Restructure aktiv. Renames werden erkannt, ' +
      'PMAX-Splits/Merges können vom Agent vorgeschlagen werden (Safeguards in `ads_pmax_proposal_add` V2).');
  }
  lines.push('');
}

function appendHistorySummary(lines: string[], historyByType: Map<string, ReturnType<BlueprintResult['historyByType']['get']> & object>): void {
  lines.push('## History-Preservation pro Entity-Typ');
  lines.push('');
  lines.push('| Entity-Typ | KEEP | RENAME | NEW | PAUSE |');
  lines.push('|---|---|---|---|---|');
  for (const [entityType, decisions] of historyByType) {
    if (!decisions) continue;
    const counts = { KEEP: 0, RENAME: 0, NEW: 0, PAUSE: 0 };
    for (const d of decisions) counts[d.kind]++;
    if (decisions.length === 0) continue;
    lines.push(`| ${entityType} | ${counts.KEEP} | ${counts.RENAME} | ${counts.NEW} | ${counts.PAUSE} |`);
  }
  lines.push('');
}

function appendNegatives(lines: string[], negatives: NegativeProposal[]): void {
  lines.push(`## Negative-Keyword-Proposals (${negatives.length})`);
  lines.push('');
  if (negatives.length === 0) {
    lines.push('Keine. Customer-Profile hat keine pmax_owned_head_terms / competitors gepflegt, ' +
      'und keine wasted Search-Terms im Snapshot — ungewöhnlich, qualitative Prüfung empfohlen.');
    lines.push('');
    return;
  }
  const bySource = {
    pmax_owned: negatives.filter(n => n.source === 'pmax_owned'),
    competitor: negatives.filter(n => n.source === 'competitor'),
    cross_campaign: negatives.filter(n => n.source === 'cross_campaign'),
  };
  lines.push(`- pmax_owned: **${bySource.pmax_owned.length}** Exact-Match account-weit`);
  lines.push(`- competitor: **${bySource.competitor.length}** Broad-Match account-weit`);
  lines.push(`- cross_campaign: **${bySource.cross_campaign.length}** auf Kampagnen-Level (gemischte Match-Types)`);
  lines.push('');
  if (bySource.cross_campaign.length > 0) {
    lines.push('### cross_campaign Top 10 (nach Spend)');
    lines.push('');
    const top = [...bySource.cross_campaign]
      .sort((a, b) => Number(b.evidence?.['spend_chf'] ?? 0) - Number(a.evidence?.['spend_chf'] ?? 0))
      .slice(0, 10);
    lines.push('| Term | Match | Kampagne | Spend (CHF) |');
    lines.push('|---|---|---|---|');
    for (const n of top) {
      const spend = Number(n.evidence?.['spend_chf'] ?? 0).toFixed(2);
      lines.push(`| \`${n.keywordText}\` | ${n.matchType} | ${n.scopeTarget ?? '–'} | ${spend} |`);
    }
    lines.push('');
  }
}

function appendNamingViolations(
  lines: string[], violations: BlueprintResult['namingViolations'],
): void {
  if (violations.length === 0) return;
  lines.push(`## Naming-Konventions-Verstösse (${violations.length})`);
  lines.push('');
  lines.push('Diese Entities verletzen das Customer-Profile-Pattern. ' +
    'Emit (`ads_emit_csv`) wird sie blockieren bis sie via RENAME-Cycle korrigiert sind.');
  lines.push('');
  lines.push('| Entity-Typ | Name | Verstösse |');
  lines.push('|---|---|---|');
  for (const v of violations.slice(0, 20)) {
    const errs = v.errors.slice(0, 2).join('; ');
    lines.push(`| ${v.entityType} | \`${v.name}\` | ${errs} |`);
  }
  if (violations.length > 20) {
    lines.push(`| _… ${violations.length - 20} weitere_ |  |  |`);
  }
  lines.push('');
}

function appendLowStrengthAssetGroups(lines: string[], groups: LowStrengthAssetGroup[]): void {
  if (groups.length === 0) return;
  lines.push(`## Asset-Gruppen mit niedriger Ad-Strength (${groups.length})`);
  lines.push('');
  lines.push('Additive Aufmerksamkeit empfohlen (zusätzliche Headlines/Descriptions/Assets).');
  lines.push('Kein Split/Merge in V1 — das ist agent-driven über `ads_finding_add`.');
  lines.push('');
  lines.push('| Asset-Group | Kampagne | Strength | Spend (CHF) | Conv |');
  lines.push('|---|---|---|---|---|');
  for (const g of groups.slice(0, 15)) {
    lines.push(`| \`${g.name}\` | ${g.campaignName ?? '–'} | ${g.adStrength} | ${g.spendChf.toFixed(2)} | ${g.conversions.toFixed(1)} |`);
  }
  lines.push('');
}

function appendTradeOffWarnings(
  lines: string[], mode: 'BOOTSTRAP' | 'OPTIMIZE', lowStrength: LowStrengthAssetGroup[],
): void {
  const warnings: string[] = [];
  if (mode === 'OPTIMIZE' && lowStrength.length >= 5) {
    warnings.push(`5+ Asset-Gruppen mit POOR/AVERAGE — vor PMAX-Restructure auf Asset-Refresh fokussieren.`);
  }
  if (warnings.length === 0) return;
  lines.push('## ⚠️ Trade-off-Warnings');
  lines.push('');
  for (const w of warnings) lines.push(`- ${w}`);
  lines.push('');
}

function appendNextSteps(
  lines: string[], mode: 'BOOTSTRAP' | 'OPTIMIZE',
  namingViolationsCount: number, negativeCount: number,
): void {
  lines.push('## Nächste Schritte');
  lines.push('');
  if (namingViolationsCount > 0) {
    lines.push(`1. **Naming-Verstösse beheben** (${namingViolationsCount} Entities) — entweder Pattern in Customer-Profile anpassen oder Renames in nächstem Cycle planen.`);
  }
  if (negativeCount > 0) {
    lines.push(`${namingViolationsCount > 0 ? '2.' : '1.'} \`ads_emit_csv\` aufrufen, um die ${negativeCount} Negatives + History-Decisions als per-Campaign Editor-CSV-Pack zu schreiben.`);
  }
  if (mode === 'BOOTSTRAP') {
    lines.push(`${namingViolationsCount > 0 ? '3.' : (negativeCount > 0 ? '2.' : '1.')} Nach erstem Editor-Import: 14 Tage warten (Smart-Bidding-Lernfenster), dann nächsten Cycle starten — der wechselt dann automatisch in OPTIMIZE-Mode.`);
  }
}

// Suppress unused-import lint warning when AdsBlueprintEntityKind is only
// used via type narrowing in counts. Re-export for downstream callers.
export type { AdsBlueprintEntityKind };
