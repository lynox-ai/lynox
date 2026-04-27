/**
 * Tool: ads_finding_add
 *
 * Records a qualitative audit finding discovered by the agent during the
 * P2 audit cycle (e.g. via DataForSEO keyword research, landing-page crawl,
 * or GA4 tracking audit). Mirrors to KG so semantic pattern detection picks
 * up recurring themes across cycles.
 *
 * Use after `ads_audit_run` has produced the deterministic baseline. The
 * agent decides which research the report demands, runs it via existing
 * tools (`http_request`, `web_search`, etc.), and writes its conclusions
 * back through this tool. The Blueprint tool then reads ALL findings
 * (deterministic + agent) for `run_id` from ads_findings.
 *
 * Idiomatic: thin writer. Validation, persistence, and KG-mirroring only.
 * No reasoning happens here.
 *
 * Gated by feature flag 'ads-optimizer'.
 */
import type { ToolEntry, IAgent } from '../../types/index.js';
import type {
  AdsDataStore,
  AdsFindingSeverity,
} from '../../core/ads-data-store.js';
import { getErrorMessage } from '../../core/utils.js';

interface AdsFindingAddInput {
  ads_account_id: string;
  area: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  text: string;
  confidence: number;
  evidence?: Record<string, unknown> | undefined;
  /** Optional: target a specific run. Defaults to the latest successful run. */
  run_id?: number | undefined;
}

const DESCRIPTION = [
  'Record a qualitative finding from agent research onto the current Ads Optimizer audit run.',
  '',
  'Call this tool AFTER `ads_audit_run` and AFTER you have done qualitative research',
  '(DataForSEO keyword analysis, LP crawl, GA4 link probe, competitor scan, etc.). The',
  'finding joins the deterministic findings as input for `ads_blueprint`.',
  '',
  'Fields:',
  '  - area: short slug describing the finding type. Reuse existing slugs when possible:',
  '    `keyword_gap`, `keyword_overlap`, `landing_page_relevance`, `landing_page_speed`,',
  '    `tracking_setup`, `competitor_strategy`, `naming_drift`, `asset_freshness`.',
  '    Coin a new slug only when none of the above fits.',
  '  - severity: HIGH if it blocks Blueprint correctness; MEDIUM if it changes a',
  '    recommendation; LOW if it is informational.',
  '  - confidence: 0..1, your subjective confidence in the finding.',
  '  - evidence: arbitrary JSON-serialisable object with sources, URLs, raw numbers,',
  '    quoted text, etc. Keep it small (< 4 KB) — it is stored verbatim.',
  '  - run_id: leave unset to attach to the latest SUCCESS run for the account.',
].join('\n');

interface KnowledgeLayerLite {
  store(
    text: string,
    namespace: 'knowledge' | 'methods' | 'status' | 'learnings',
    scope: { type: 'global' | 'context' | 'user'; id: string },
    options?: { sourceRunId?: string | undefined; skipContradictionCheck?: boolean | undefined } | undefined,
  ): Promise<{ memoryId: string; stored: boolean; deduplicated: boolean }>;
}

export function createAdsFindingAddTool(store: AdsDataStore): ToolEntry<AdsFindingAddInput> {
  return {
    definition: {
      name: 'ads_finding_add',
      description: DESCRIPTION,
      input_schema: {
        type: 'object' as const,
        properties: {
          ads_account_id: { type: 'string', description: 'Google Ads Customer ID (e.g. "123-456-7890")' },
          area: { type: 'string', description: 'Short slug for finding type (see tool description for canonical values)' },
          severity: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'], description: 'HIGH blocks Blueprint correctness; MEDIUM changes a recommendation; LOW informational' },
          text: { type: 'string', description: 'Self-contained finding text. Should read as a single insight statement (one or two sentences).' },
          confidence: { type: 'number', description: 'Your subjective confidence, 0..1' },
          evidence: { type: 'object', description: 'JSON-serialisable evidence object (URLs, quotes, raw numbers). Keep < 4 KB.' },
          run_id: { type: 'integer', description: 'Optional: target a specific run. Defaults to the latest SUCCESS run for the account.' },
        },
        required: ['ads_account_id', 'area', 'severity', 'text', 'confidence'],
      },
    },
    handler: async (input: AdsFindingAddInput, agent: IAgent): Promise<string> => {
      try {
        const validated = validateInput(input);
        const account = store.getAdsAccount(validated.ads_account_id);
        if (!account) {
          return `ads_finding_add failed: unknown ads_account_id "${validated.ads_account_id}". Run ads_data_pull first.`;
        }
        let runId: number;
        if (validated.run_id !== undefined) {
          const run = store.getAuditRun(validated.run_id);
          if (!run || run.ads_account_id !== validated.ads_account_id) {
            return `ads_finding_add failed: run_id ${validated.run_id} not found for account ${validated.ads_account_id}.`;
          }
          runId = validated.run_id;
        } else {
          const run = store.getLatestSuccessfulAuditRun(validated.ads_account_id);
          if (!run) {
            return `ads_finding_add failed: no successful run for ${validated.ads_account_id}. Run ads_audit_run first.`;
          }
          runId = run.run_id;
        }

        const row = store.insertFinding({
          runId,
          adsAccountId: validated.ads_account_id,
          area: validated.area,
          severity: validated.severity,
          source: 'agent',
          text: validated.text,
          confidence: validated.confidence,
          evidence: validated.evidence,
        });

        const kg = agent.toolContext.knowledgeLayer as KnowledgeLayerLite | null;
        if (kg) {
          try {
            const stored = await kg.store(
              `[ads-audit ${runId} • ${validated.severity} • ${validated.area}] ${validated.text}`,
              'knowledge',
              { type: 'context', id: validated.ads_account_id },
              { sourceRunId: String(runId), skipContradictionCheck: true },
            );
            if (stored.memoryId) store.setFindingKgMemoryId(row.finding_id, stored.memoryId);
          } catch {
            // best-effort
          }
        }

        return `Finding aufgenommen: #${row.finding_id} (${validated.severity}/${validated.area}) auf Run ${runId}.`;
      } catch (err) {
        return `ads_finding_add failed: ${getErrorMessage(err)}`;
      }
    },
  };
}

interface ValidatedInput {
  ads_account_id: string;
  area: string;
  severity: AdsFindingSeverity;
  text: string;
  confidence: number;
  evidence: Record<string, unknown> | undefined;
  run_id: number | undefined;
}

function validateInput(input: AdsFindingAddInput): ValidatedInput {
  if (!input.ads_account_id || typeof input.ads_account_id !== 'string') {
    throw new Error('ads_account_id required');
  }
  if (!input.area || typeof input.area !== 'string' || input.area.length > 64) {
    throw new Error('area required (≤ 64 chars)');
  }
  if (!isSeverity(input.severity)) {
    throw new Error('severity must be one of LOW, MEDIUM, HIGH');
  }
  if (!input.text || typeof input.text !== 'string' || input.text.length < 5) {
    throw new Error('text required (≥ 5 chars)');
  }
  if (input.text.length > 4000) {
    throw new Error('text too long (> 4000 chars) — split into multiple findings');
  }
  if (typeof input.confidence !== 'number' || input.confidence < 0 || input.confidence > 1 || !Number.isFinite(input.confidence)) {
    throw new Error('confidence must be a number in [0, 1]');
  }
  if (input.evidence !== undefined) {
    const serialised = JSON.stringify(input.evidence);
    if (serialised.length > 4096) {
      throw new Error('evidence too large (> 4 KB serialised)');
    }
  }
  if (input.run_id !== undefined && (!Number.isInteger(input.run_id) || input.run_id < 1)) {
    throw new Error('run_id must be a positive integer');
  }
  return {
    ads_account_id: input.ads_account_id,
    area: input.area,
    severity: input.severity,
    text: input.text,
    confidence: input.confidence,
    evidence: input.evidence,
    run_id: input.run_id,
  };
}

function isSeverity(v: unknown): v is AdsFindingSeverity {
  return v === 'LOW' || v === 'MEDIUM' || v === 'HIGH';
}
