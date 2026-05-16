import Anthropic from '@anthropic-ai/sdk';
import { calculateCost } from '../../src/core/pricing.js';
import { MODEL_MAP } from '../../src/types/index.js';
import type { BenchRun, BenchScenario, JudgedRun } from './types.js';

const JUDGE_MODEL = MODEL_MAP.haiku;

const JUDGE_SYSTEM = `Du bist ein strenger, fairer Evaluator für LLM-Outputs. Bewerte wie gut der
tatsächliche Output das Problem gelöst hat, basierend auf der Rubric.

Scoring-Skala:
  5 = exzellent — alle Rubric-Punkte erfüllt, keine Schwächen
  4 = sehr gut — alle kritischen Punkte, kleine Schwächen
  3 = ausreichend — Kernpunkte erfüllt, relevante Lücken
  2 = mangelhaft — nur Teile korrekt, zentrale Punkte fehlen
  1 = ungenügend — Antwort verfehlt den Task oder halluziniert
  0 = Fehler — Run hat gecrasht oder keine Antwort produziert

Antworte IMMER im folgenden Format (genau so, keine Variation):

SCORE: <0-5>
REASONING: <ein Satz warum — nenne spezifische Rubric-Punkte die erfüllt / nicht erfüllt sind>`;

export async function judgeRun(
  scenario: BenchScenario,
  run: BenchRun,
  apiKey: string,
): Promise<JudgedRun> {
  if (run.error) {
    return {
      ...run,
      score: 0,
      judgeReasoning: `Run failed: ${run.error}`,
      judgeCostUSD: 0,
      passed: false,
    };
  }

  const prompt = buildJudgePrompt(scenario, run);
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 512,
    system: JUDGE_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n');

  const { score, reasoning } = parseJudgeResponse(text);
  const judgeCostUSD = calculateCost(JUDGE_MODEL, {
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
  });

  return { ...run, score, judgeReasoning: reasoning, judgeCostUSD, passed: computePassed(scenario, run, score) };
}

/**
 * Pass-Rate logic — the single HN-relevant column. Order matters:
 *   1. Run errored / timed out → fail.
 *   2. Scenario has its own deterministic check → trust it (tool-chain
 *      scenarios use this to verify the agent actually called the tool
 *      instead of fabricating an answer the judge can't distinguish).
 *   3. Fallback: judge score >= 3/5.
 *
 * `iterationsUsed > maxIterations` is NOT a failure on its own — the agent
 * config caps iterations, so hitting the cap means "ran out of budget" not
 * "broke", and the output may still be acceptable. The judge already
 * penalizes incomplete answers via the rubric.
 */
function computePassed(scenario: BenchScenario, run: BenchRun, score: number): boolean {
  if (run.error) return false;
  if (scenario.passCheck) {
    const verdict = scenario.passCheck(run);
    if (verdict !== null) return verdict;
  }
  return score >= 3;
}

function buildJudgePrompt(scenario: BenchScenario, run: BenchRun): string {
  return `Szenario: ${scenario.description}

Rubric:
${scenario.judgeRubric.map((r, i) => `  ${i + 1}. ${r}`).join('\n')}

Referenz-Antwort (als Orientierung, nicht als exakter Match):
---
${scenario.referenceAnswer}
---

Tatsächlicher Output:
---
${run.output.slice(0, 8000)}
---

Bewerte den tatsächlichen Output gegen die Rubric. Sei streng: Rubric-Punkte die nicht erfüllt sind ziehen direkt Score.`;
}

function parseJudgeResponse(text: string): { score: number; reasoning: string } {
  const scoreMatch = text.match(/SCORE:\s*([0-5])/i);
  const reasonMatch = text.match(/REASONING:\s*([\s\S]+)/i);
  const score = scoreMatch ? parseInt(scoreMatch[1]!, 10) : 0;
  const reasoning = reasonMatch?.[1]?.trim() ?? text.slice(0, 300);
  return { score, reasoning };
}
