/**
 * Tool: ads_blueprint_review_picks
 *
 * Phase-A operator-review queue drainer. Reads every blueprint entity
 * for the latest run that still carries pending review markers (e.g.
 * ambiguous URL picks for theme-AGs or brand-AGs), surfaces them as a
 * single batched ask_user dialog with one tab per pending decision,
 * and writes the operator's chosen value back into the entity's
 * payload_json. Once the queue is empty, ads_emit_csv stops blocking
 * and the cycle proceeds to CSV emission.
 *
 * Design note (Multi-Pick UX): the tool calls ask_user ONCE with
 * `questions[]`, not per-entity. The chat UI renders each review as a
 * tab so the operator scrolls a single dialog rather than answering N
 * sequential prompts. That is the load-bearing UX for cycles that flag
 * 5–10 ambiguous URLs in one run.
 *
 * Reentry: the queue is persistent. If the operator cancels the
 * dialog, the markers stay on the entity rows and the next call to
 * this tool re-prompts only the still-pending items. ads_emit_csv
 * surfaces "N pending review" precondition errors that name the
 * specific entities, so the operator can decide whether to drain or
 * resolve manually.
 *
 * Gated by feature flag 'ads-optimizer'.
 */
import type { ToolEntry, IAgent } from '../../types/index.js';
import type {
  AdsDataStore, AdsBlueprintEntityRow, BlueprintReviewItem,
} from '../../core/ads-data-store.js';
import { getErrorMessage } from '../../core/utils.js';

interface AdsBlueprintReviewPicksInput {
  ads_account_id: string;
  /** Explicit run id. When omitted, picks the latest run that has any
   *  blueprint entities at all (matches the emit-engine heuristic). */
  run_id?: number | undefined;
}

interface PendingReview {
  blueprintId: number;
  entityType: string;
  entityName: string;
  review: BlueprintReviewItem;
}

const DESCRIPTION = [
  'Drain the operator-review queue for the latest blueprint run.',
  '',
  'Workflow position — call AFTER `ads_blueprint_run` when the blueprint',
  'flagged any entity with an ambiguous deterministic pick (e.g. a Theme',
  'Asset-Group whose token has no slug-matching landing page, or a Brand',
  'Ad-Group whose top-clicks LP does not carry the brand token).',
  '',
  'The tool collects every pending review across the run, asks the operator',
  'in a single tabbed `ask_user` dialog, then writes the chosen value back',
  'into the entity payload. ads_emit_csv blocks until the queue is empty.',
  '',
  'Idempotent — calling the tool with no pending reviews returns a short',
  'no-op summary. Cancelling the dialog leaves markers in place; re-call',
  'to retry.',
].join('\n');

export function createAdsBlueprintReviewPicksTool(
  store: AdsDataStore,
): ToolEntry<AdsBlueprintReviewPicksInput> {
  return {
    definition: {
      name: 'ads_blueprint_review_picks',
      description: DESCRIPTION,
      input_schema: {
        type: 'object' as const,
        properties: {
          ads_account_id: {
            type: 'string',
            description: 'Google Ads Customer ID, e.g. "123-456-7890".',
          },
          run_id: {
            type: 'integer',
            description: 'Explicit run id. Omit to use the latest run with blueprint entities.',
          },
        },
        required: ['ads_account_id'],
      },
    },
    handler: async (input: AdsBlueprintReviewPicksInput, agent: IAgent): Promise<string> => {
      try {
        const account = store.getAdsAccount(input.ads_account_id);
        if (!account) {
          return `ads_blueprint_review_picks failed: unknown ads_account_id "${input.ads_account_id}".`;
        }
        const runId = input.run_id ?? resolveLatestBlueprintRunId(store, input.ads_account_id);
        if (runId === null) {
          return `ads_blueprint_review_picks: keine Blueprint-Runs für ${input.ads_account_id}. ` +
            `Erst ads_blueprint_run aufrufen.`;
        }

        const pending = collectPending(store, runId);
        if (pending.length === 0) {
          return `ads_blueprint_review_picks: keine offenen Reviews für Run #${runId} — Emit kann starten.`;
        }

        if (!agent.promptUser) {
          return `ads_blueprint_review_picks: ${pending.length} offene Reviews, aber dieser Kontext erlaubt kein interaktives Prompting. ` +
            `Im Web-UI oder CLI ausführen.`;
        }

        // Per-review label projections — each candidate gets a unique
        // display label (with traffic hints) and a reverse map back to
        // its persisted `value` so the operator's tab answer can be
        // resolved without ambiguity.
        const labelToValue = pending.map(p => {
          const map = new Map<string, string>();
          for (const c of p.review.candidates) {
            const display = c.hint ? `${c.label} — ${c.hint}` : c.label;
            map.set(display, c.value);
          }
          return map;
        });

        const questions = pending.map((p, idx) => ({
          question: p.review.prompt,
          header: `Q${idx + 1} ${p.entityType}`,
          options: Array.from(labelToValue[idx]!.keys()),
        }));

        // Single batched ask_user — Multi-Pick UX. The agent harness
        // routes this to a tabbed dialog when promptTabs is wired,
        // otherwise to sequential prompts. Either way, one call, one
        // dialog session.
        const answers: string[] = [];
        if (agent.promptTabs) {
          const result = await agent.promptTabs(questions);
          if (result.length === 0) {
            return `ads_blueprint_review_picks: Operator hat den Dialog abgebrochen. ` +
              `${pending.length} Reviews bleiben offen — Tool erneut aufrufen, wenn die Picks gemacht werden sollen.`;
          }
          for (let i = 0; i < pending.length; i++) {
            answers.push(result[i] ?? '');
          }
        } else {
          for (const q of questions) {
            const ans = await agent.promptUser(q.question, [...q.options, '\x00']);
            answers.push(ans);
          }
        }

        const applied: string[] = [];
        const skipped: string[] = [];
        for (let i = 0; i < pending.length; i++) {
          const p = pending[i]!;
          const display = answers[i];
          if (!display) {
            skipped.push(`${p.entityType}/${p.entityName}: keine Antwort`);
            continue;
          }
          const value = labelToValue[i]!.get(display) ?? display;
          try {
            store.applyEntityReviewPick(p.blueprintId, p.review.field, value);
            applied.push(`${p.entityType}/${p.entityName} → ${p.review.field} = ${value}`);
          } catch (err) {
            skipped.push(`${p.entityType}/${p.entityName}: ${getErrorMessage(err)}`);
          }
        }

        const stillOpen = collectPending(store, runId).length;
        return renderReport(runId, applied, skipped, stillOpen);
      } catch (err) {
        return `ads_blueprint_review_picks failed: ${getErrorMessage(err)}`;
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

function collectPending(store: AdsDataStore, runId: number): PendingReview[] {
  const rows = store.listEntitiesNeedingReview(runId);
  const out: PendingReview[] = [];
  for (const row of rows) {
    let reviews: BlueprintReviewItem[] = [];
    try {
      const parsed = JSON.parse(row.needs_review_json);
      if (Array.isArray(parsed)) reviews = parsed as BlueprintReviewItem[];
    } catch { reviews = []; }
    const name = extractEntityName(row);
    for (const r of reviews) {
      out.push({
        blueprintId: row.blueprint_id,
        entityType: row.entity_type,
        entityName: name,
        review: r,
      });
    }
  }
  return out;
}

function extractEntityName(row: AdsBlueprintEntityRow): string {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.payload_json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch { /* fall through */ }
  for (const k of ['asset_group_name', 'ad_group_name', 'campaign_name']) {
    const v = payload[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return row.external_id;
}

function renderReport(runId: number, applied: string[], skipped: string[], stillOpen: number): string {
  const lines: string[] = [];
  lines.push(`# Operator-Review Picks — Run #${runId}`);
  lines.push('');
  lines.push(`**${applied.length} Picks angewendet**, ${skipped.length} übersprungen, ${stillOpen} weiterhin offen.`);
  lines.push('');
  if (applied.length > 0) {
    lines.push('## Angewendet');
    lines.push('');
    for (const a of applied) lines.push(`- ${a}`);
    lines.push('');
  }
  if (skipped.length > 0) {
    lines.push('## Übersprungen');
    lines.push('');
    for (const s of skipped) lines.push(`- ${s}`);
    lines.push('');
  }
  if (stillOpen === 0) {
    lines.push('Review-Queue leer — `ads_emit_csv` kann jetzt starten.');
  } else {
    lines.push(`Noch ${stillOpen} offen — Tool erneut aufrufen, sobald die Picks vollständig sind.`);
  }
  return lines.join('\n');
}
