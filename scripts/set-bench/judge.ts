/**
 * Set-Bench v4 — LLM-as-judge graded-quality layer (opt-in via `--judge`).
 *
 * The deterministic `passCheck` in each scenario is a HARD GATE (binary,
 * regex-pinned). This module adds a COMPLEMENTARY graded signal: judges score
 * the substantive quality of the final answer 1–5. It never overrides the gate.
 *
 * FAIRNESS — multi-vendor judge panel. A SINGLE judge would bake in
 * self-preference (an Anthropic judge rates Anthropic prose higher, etc.),
 * which is fatal on a Mistral-vs-Anthropic bench. Instead every answer is
 * scored by a PANEL of judges drawn from different model families
 * (Anthropic + Mistral). We report each judge's score, the mean, and the
 * cross-family bias delta. Symmetric self-preference cancels in the mean AND
 * becomes visible per-judge; if both families' judges agree on the ranking the
 * signal is trustworthy, if they diverge that divergence IS the bias.
 * Judges run at temperature 0 for reproducibility and never see which model
 * produced an answer (no identity leak — only the answer text + the task).
 */

import Anthropic from '@anthropic-ai/sdk';
import { OpenAIAdapter } from '../../src/core/openai-adapter.js';
import type { SetBenchScenario, ToolCallTrace } from './types.js';

export type JudgeFamily = 'anthropic' | 'mistral';

export interface JudgeConfig {
  /** Stable id used as the per-judge column key in the report. */
  readonly id: string;
  readonly family: JudgeFamily;
  readonly provider: 'anthropic' | 'openai';
  readonly modelId: string;
  /** Base URL for openai-compat judges (Mistral). Omitted for Anthropic. */
  readonly apiBaseURL?: string;
  readonly apiKeyEnv: string;
}

/**
 * The fairness panel: one strong judge per model family. A model under test is
 * still judged by its own family here (not excluded) — self-preference is made
 * VISIBLE via per-judge reporting and cancelled in the mean, rather than hidden.
 */
export const JUDGE_PANEL: readonly JudgeConfig[] = [
  {
    // Sonnet, not Opus: opus-4-7 rejects the `temperature` param ("deprecated
    // for this model"), and Sonnet 4.6 demonstrably discriminates (2.0–5.0
    // spread on the design axis) where the Mistral judge clusters at 5 — so
    // it carries the discriminating Anthropic vote at lower cost.
    id: 'anthropic-sonnet',
    family: 'anthropic',
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-6',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
  },
  {
    id: 'mistral-large',
    family: 'mistral',
    provider: 'openai',
    modelId: 'mistral-large-2512',
    apiBaseURL: 'https://api.mistral.ai/v1',
    apiKeyEnv: 'MISTRAL_API_KEY',
  },
];

export interface QualityVerdict {
  /** 1 (poor) … 5 (excellent). */
  readonly score: number;
  /** One-line rationale for the report. */
  readonly reason: string;
}

const RUBRIC = [
  'You are an impartial evaluator scoring the QUALITY of an AI agent\'s final answer',
  'to a task in a benchmark. A separate deterministic check already verified factual',
  'correctness, so do NOT re-judge whether the headline facts are right — instead score',
  'the SUBSTANTIVE QUALITY of the answer on a 1–5 integer scale:',
  '',
  '  5 = excellent — complete, well-reasoned, precise, nothing material missing',
  '  4 = good — correct and complete with only minor gaps or imprecision',
  '  3 = acceptable — addresses the task but with noticeable gaps or shallow reasoning',
  '  2 = weak — partial, vague, or poorly organised; misses important aspects',
  '  1 = poor — irrelevant, contradictory, or near-useless as an answer',
  '',
  'Judge ONLY the answer text on its merits for the task. Ignore response length for',
  'its own sake; reward density and relevance, penalise padding and hedging. Be',
  'consistent and calibrated across models — do not favour any particular writing style.',
  '',
  'Respond with ONLY a single-line JSON object, no prose, no code fence:',
  '{"score": <1-5 integer>, "reason": "<≤20 word rationale>"}',
].join('\n');

function buildJudgePrompt(
  scenario: SetBenchScenario,
  finalText: string,
  toolCalls: readonly ToolCallTrace[],
): string {
  const toolSummary = toolCalls.length === 0
    ? '(none)'
    : toolCalls.map((t) => t.name).join(', ');
  return [
    `## Task given to the agent (axis: ${scenario.axis})`,
    scenario.description,
    '',
    '### Exact prompt',
    scenario.prompt,
    '',
    `### Tools the agent called (${toolCalls.length})`,
    toolSummary,
    '',
    '### Agent final answer',
    finalText.length === 0 ? '(empty)' : finalText,
  ].join('\n');
}

interface JudgeUsage {
  input_tokens?: number;
  output_tokens?: number;
}

/** Minimal client surface shared by the Anthropic SDK and the OpenAIAdapter. */
interface JudgeClientLike {
  beta: {
    messages: {
      stream: (params: {
        model: string;
        max_tokens: number;
        temperature?: number;
        system?: string;
        messages: Array<{ role: 'user' | 'assistant'; content: string }>;
        [key: string]: unknown;
      }) => {
        finalMessage: () => Promise<{
          content: Array<{ type: string; text?: string }>;
          usage?: JudgeUsage;
        }>;
      };
    };
  };
}

function buildJudgeClient(judge: JudgeConfig, apiKey: string): JudgeClientLike {
  if (judge.provider === 'anthropic') {
    return new Anthropic({ apiKey }) as unknown as JudgeClientLike;
  }
  if (!judge.apiBaseURL) throw new Error(`judge ${judge.id} missing apiBaseURL`);
  return new OpenAIAdapter({
    baseURL: judge.apiBaseURL,
    apiKey,
    modelId: judge.modelId,
  }) as unknown as JudgeClientLike;
}

/**
 * Parse the judge's JSON reply defensively. Returns undefined when the reply
 * can't be coerced into a valid 1–5 score (caller treats as "unscored").
 */
export function parseVerdict(text: string): QualityVerdict | undefined {
  const match = text.match(/\{[^}]*"score"[^}]*\}/);
  if (!match) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(match[0]); } catch { return undefined; }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  const raw = obj['score'];
  const score = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(score) || score < 1 || score > 5) return undefined;
  const reason = typeof obj['reason'] === 'string' ? obj['reason'] : '';
  return { score: Math.round(score), reason };
}

interface SingleJudgeResult {
  readonly judgeId: string;
  readonly verdict?: QualityVerdict;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly error?: string;
}

/** Run one judge over one answer. Best-effort — never throws. */
async function runOneJudge(
  judge: JudgeConfig,
  rubric: string,
  prompt: string,
): Promise<SingleJudgeResult> {
  const apiKey = process.env[judge.apiKeyEnv];
  if (!apiKey) {
    return { judgeId: judge.id, tokensIn: 0, tokensOut: 0, error: `missing ${judge.apiKeyEnv}` };
  }
  try {
    const client = buildJudgeClient(judge, apiKey);
    const stream = client.beta.messages.stream({
      model: judge.modelId,
      max_tokens: 256,
      temperature: 0,
      system: rubric,
      messages: [{ role: 'user', content: prompt }],
    });
    const msg = await stream.finalMessage();
    const usage = msg.usage ?? {};
    const text = msg.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
    const verdict = parseVerdict(text);
    return {
      judgeId: judge.id,
      ...(verdict ? { verdict } : { error: 'unparseable reply' }),
      tokensIn: usage.input_tokens ?? 0,
      tokensOut: usage.output_tokens ?? 0,
    };
  } catch (err) {
    return {
      judgeId: judge.id,
      tokensIn: 0,
      tokensOut: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface JudgeResult {
  /** Panel consensus: mean of the per-judge scores (undefined if none scored). */
  readonly verdict?: QualityVerdict;
  /** Per-judge score, keyed by judge id — powers the cross-family bias report. */
  readonly byJudge: Record<string, number>;
  readonly judgeTokensIn: number;
  readonly judgeTokensOut: number;
  readonly error?: string;
}

/**
 * Score one agent answer with the full judge panel. Judges run sequentially
 * (Mistral Tier-1 is 1 RPS; parallel would 429). Returns the mean score plus
 * the per-judge breakdown. Any judge that errors is simply omitted from the
 * mean; if none scored, verdict is undefined.
 */
export async function judgeQuality(
  scenario: SetBenchScenario,
  finalText: string,
  toolCalls: readonly ToolCallTrace[],
): Promise<JudgeResult> {
  const rubric = scenario.judgeRubric ?? RUBRIC;
  const prompt = buildJudgePrompt(scenario, finalText, toolCalls);

  const results: SingleJudgeResult[] = [];
  for (const judge of JUDGE_PANEL) {
    results.push(await runOneJudge(judge, rubric, prompt));
  }

  const byJudge: Record<string, number> = {};
  const reasons: string[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  const errors: string[] = [];
  for (const r of results) {
    tokensIn += r.tokensIn;
    tokensOut += r.tokensOut;
    if (r.verdict) {
      byJudge[r.judgeId] = r.verdict.score;
      reasons.push(`${r.judgeId}:${r.verdict.score} (${r.verdict.reason})`);
    } else if (r.error) {
      errors.push(`${r.judgeId}:${r.error}`);
    }
  }

  const scores = Object.values(byJudge);
  const mean = scores.length === 0
    ? undefined
    : scores.reduce((a, b) => a + b, 0) / scores.length;

  return {
    ...(mean !== undefined ? { verdict: { score: mean, reason: reasons.join(' | ') } } : {}),
    byJudge,
    judgeTokensIn: tokensIn,
    judgeTokensOut: tokensOut,
    ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
  };
}
