/**
 * Tool: ads_blueprint_review
 *
 * Phase-C pre-emit sanity-check. Walks the persisted blueprint for the
 * latest run, applies a set of deterministic semantic detectors, and
 * persists `pre_emit_review:*` findings:
 *
 *   - severity = 'BLOCK'  → ads_emit_csv refuses to write CSVs.
 *   - severity = 'HIGH'   → renders as a warning in the report.
 *
 * Idempotent — the tool clears its own prior `pre_emit_review:*`
 * findings for the run before re-evaluating, so the operator can fix a
 * blueprint entity (via ads_blueprint_entity_propose) and re-run review
 * to see whether the BLOCK is gone.
 *
 * Override path: `override: true` keeps existing BLOCK detectors but
 * downgrades them to HIGH so emit can proceed. The override is recorded
 * as an `pre_emit_review:override` agent finding so the override is
 * auditable in the next cycle's audit Markdown.
 *
 * Gated by feature flag 'ads-optimizer'.
 */
import type { ToolEntry, IAgent } from '../../types/index.js';
import type {
  AdsDataStore, CustomerProfileRow,
} from '../../core/ads-data-store.js';
import {
  runBlueprintReview,
  type PreEmitReviewFinding,
} from '../../core/ads-blueprint-review-engine.js';
import { getErrorMessage } from '../../core/utils.js';

interface AdsBlueprintReviewInput {
  ads_account_id: string;
  /** Explicit run id. Omit for the latest run with blueprint entities. */
  run_id?: number | undefined;
  /** When true, every BLOCK finding is downgraded to HIGH so emit can
   *  proceed. The override is logged as a separate agent-source finding
   *  so it appears in the next audit's Markdown report. */
  override?: boolean | undefined;
  /** Justification text for the override — mandatory when override=true.
   *  Recorded on the override finding's evidence so it's auditable. */
  override_reason?: string | undefined;
}

const DESCRIPTION = [
  'Run pre-emit sanity-checks on the persisted blueprint of the latest run.',
  '',
  'Workflow position — call AFTER `ads_blueprint_run` (and any',
  '`ads_blueprint_review_picks` resolution) and BEFORE `ads_emit_csv`.',
  'Detects:',
  '  - duplicate Final URL across NEW ad-groups (BLOCK)',
  '  - generic ad copy on Brand/Theme ad-groups (warning)',
  '  - brand-naming drift versus customer.own_brands/sold_brands (warning)',
  '  - theme-AG that does not overlap with customer.top_products (warning)',
  '  - daily budget that eats >80% of monthly customer budget (BLOCK)',
  '  - daily budget between 30% and 80% of monthly budget (warning)',
  '',
  'Idempotent: previous `pre_emit_review:*` findings for the run are',
  'cleared before re-evaluation. Operator fix → re-run → BLOCK gone.',
  '',
  'Override: pass `override: true` with a justification in `override_reason`',
  'to downgrade every BLOCK to HIGH. The override is logged as an',
  '`pre_emit_review:override` agent finding so audit reports show it.',
].join('\n');

export function createAdsBlueprintReviewTool(
  store: AdsDataStore,
): ToolEntry<AdsBlueprintReviewInput> {
  return {
    definition: {
      name: 'ads_blueprint_review',
      description: DESCRIPTION,
      input_schema: {
        type: 'object' as const,
        properties: {
          ads_account_id: { type: 'string', description: 'Google Ads Customer ID, e.g. "123-456-7890".' },
          run_id: {
            type: 'integer',
            description: 'Explicit run id. Omit to use the latest run with blueprint entities.',
          },
          override: {
            type: 'boolean',
            description: 'Downgrade every BLOCK finding to HIGH so emit can proceed. Requires override_reason.',
          },
          override_reason: {
            type: 'string',
            description: 'Operator-supplied justification, persisted as an audit-trail finding.',
          },
        },
        required: ['ads_account_id'],
      },
    },
    handler: async (input: AdsBlueprintReviewInput, _agent: IAgent): Promise<string> => {
      try {
        const account = store.getAdsAccount(input.ads_account_id);
        if (!account) {
          return `ads_blueprint_review failed: unknown ads_account_id "${input.ads_account_id}".`;
        }
        const customer = store.getCustomerProfile(account.customer_id);
        if (!customer) {
          return `ads_blueprint_review failed: customer profile missing for "${account.customer_id}".`;
        }
        const runId = input.run_id ?? resolveLatestBlueprintRunId(store, input.ads_account_id);
        if (runId === null) {
          return `ads_blueprint_review: keine Blueprint-Runs für ${input.ads_account_id}. ` +
            `Erst ads_blueprint_run aufrufen.`;
        }

        if (input.override === true && (!input.override_reason || input.override_reason.trim().length < 10)) {
          return `ads_blueprint_review failed: override=true requires override_reason (mind. 10 Zeichen Begründung).`;
        }

        // Idempotent re-run: drop prior verdict for this run.
        store.deleteFindingsByAreaPrefix(runId, 'pre_emit_review:');

        const result = runBlueprintReview(store, runId, customer);

        // Apply override before persistence so emit-engine sees the
        // downgraded severity (and the audit report still has the
        // ground-truth via the override-trail finding).
        const persisted = result.findings.map(f => ({
          ...f,
          severity: input.override === true && f.severity === 'BLOCK' ? 'HIGH' as const : f.severity,
        }));

        for (const f of persisted) {
          store.insertFinding({
            runId, adsAccountId: input.ads_account_id,
            area: f.area, severity: f.severity, source: 'deterministic',
            text: f.text, confidence: f.confidence, evidence: f.evidence,
          });
        }

        if (input.override === true && result.blocks.length > 0) {
          store.insertFinding({
            runId, adsAccountId: input.ads_account_id,
            area: 'pre_emit_review:override',
            severity: 'HIGH', source: 'agent',
            text: `Operator hat ${result.blocks.length} BLOCK-Finding(s) per Override auf HIGH downgrade-t. ` +
              `Begründung: ${input.override_reason}`,
            confidence: 1.0,
            evidence: {
              reason: input.override_reason,
              downgraded_areas: result.blocks.map(b => b.area),
            },
          });
        }

        return renderReport(runId, result, input.override === true, customer);
      } catch (err) {
        return `ads_blueprint_review failed: ${getErrorMessage(err)}`;
      }
    },
  };
}

function resolveLatestBlueprintRunId(store: AdsDataStore, adsAccountId: string): number | null {
  const runs = store.listAuditRuns(adsAccountId, 20);
  for (const r of runs) {
    if (r.status !== 'SUCCESS') continue;
    if (store.listBlueprintEntities(r.run_id).length > 0) return r.run_id;
  }
  return null;
}

function renderReport(
  runId: number,
  result: { blocks: PreEmitReviewFinding[]; warnings: PreEmitReviewFinding[] },
  overridden: boolean,
  customer: CustomerProfileRow,
): string {
  const lines: string[] = [];
  lines.push(`# Pre-Emit Review — Run #${runId} (${customer.client_name})`);
  lines.push('');
  if (result.blocks.length === 0 && result.warnings.length === 0) {
    lines.push('🟢 Kein Befund. `ads_emit_csv` kann starten.');
    return lines.join('\n');
  }
  if (result.blocks.length > 0) {
    if (overridden) {
      lines.push(`🟡 **${result.blocks.length} BLOCK-Finding(s) auf HIGH downgrade-t per Override.** Emit darf trotzdem starten.`);
    } else {
      lines.push(`🔴 **${result.blocks.length} BLOCK-Finding(s) — Emit ist gesperrt.**`);
    }
    lines.push('');
    lines.push('## BLOCK');
    lines.push('');
    for (const b of result.blocks) {
      lines.push(`- **${b.area}**`);
      lines.push(`  ${b.text}`);
    }
    lines.push('');
  }
  if (result.warnings.length > 0) {
    lines.push(`## Warnings (${result.warnings.length})`);
    lines.push('');
    for (const w of result.warnings) {
      lines.push(`- **${w.area}** (Konfidenz ${w.confidence.toFixed(2)})`);
      lines.push(`  ${w.text}`);
    }
    lines.push('');
  }
  if (result.blocks.length > 0 && !overridden) {
    lines.push('## Reentry');
    lines.push('');
    lines.push('1. Blueprint-Entity korrigieren (z.B. `ads_blueprint_entity_propose`).');
    lines.push('2. `ads_blueprint_review` erneut aufrufen — BLOCK sollte verschwinden.');
    lines.push('3. `ads_emit_csv` starten.');
    lines.push('');
    lines.push('Falls die BLOCK-Findings absichtlich bleiben sollen: ' +
      '`ads_blueprint_review override=true override_reason="…"`.');
  } else {
    lines.push('`ads_emit_csv` kann jetzt starten.');
  }
  return lines.join('\n');
}
