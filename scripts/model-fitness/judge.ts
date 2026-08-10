/**
 * Independent LLM-as-judge — Kimi K2 (Moonshot) via Fireworks.
 *
 * WHY independent: an LLM judge has a SELF-PREFERENCE bias — a Claude judge
 * scores Claude higher, a Mistral judge scores Mistral higher (rafael
 * 2026-07-19). The judge MUST share a family with NO candidate. The candidates
 * are now Claude + Mistral + **GLM** (added as a cheaper-Opus deep candidate),
 * so the judge moved OFF GLM to **Kimi K2** (`kimi-k2p6`), a 4th family — over
 * the Fireworks OpenAI-compatible endpoint with FIREWORKS_API_KEY. (Invariant:
 * if you add a candidate from Kimi's family, move the judge again.)
 *
 * Bias mitigations: ABSOLUTE rubric scoring (score each answer 1-5 against a
 * fixed rubric) — NOT pairwise A-vs-B — which sidesteps POSITION bias entirely.
 * Residual caveats we do NOT fully fix in v1: VERBOSITY bias (judges lean toward
 * longer answers) and the judge's own family/style bias (smaller than in-family,
 * not zero). Temperature 0 for repeatability. A judge score is a SOFT ranking
 * signal for the subjective quality axis — the hard cases' objective state
 * assertions remain the primary, bias-free discriminator.
 */
const JUDGE_MODEL = 'accounts/fireworks/models/kimi-k2p6';
const JUDGE_BASE = 'https://api.fireworks.ai/inference/v1';

/** True when an independent judge can run (FIREWORKS_API_KEY present). */
export function judgeAvailable(): boolean {
  return !!process.env['FIREWORKS_API_KEY'];
}

/** The judge model id + provider, for provenance in reports. */
export const JUDGE_ID = 'Kimi K2 (Fireworks, independent of Claude+Mistral+GLM)';

interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: unknown;
}

/**
 * Score one answer 1-5 against a rubric with the independent judge. Returns null
 * when the judge is unavailable or its reply can't be parsed (fail-soft — a
 * missing judge score never fails a candidate, it just leaves the quality axis
 * blank). GLM 5.2 reasons before answering, so we allow room + parse the score
 * from anywhere in the reply (prefer an explicit JSON, then `N/5`, then a bare
 * 1-5), taking the LAST match (its conclusion) not the first (its scratch work).
 */
export async function judgeQuality(opts: { task: string; answer: string; rubric: string }): Promise<{ score: number; reason: string } | null> {
  const key = process.env['FIREWORKS_API_KEY'];
  if (!key) return null;
  const prompt =
    `You are an impartial evaluator. Score the ASSISTANT ANSWER from 1 (poor) to 5 (excellent) on the RUBRIC.\n` +
    `Be strict and consistent; judge substance, not length.\n\n` +
    `RUBRIC: ${opts.rubric}\n\nTASK: ${opts.task}\n\nASSISTANT ANSWER:\n${opts.answer}\n\n` +
    `End your reply with EXACTLY one line: SCORE: <n>/5  (n an integer 1-5).`;
  let text = '';
  try {
    const res = await fetch(`${JUDGE_BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: JUDGE_MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: 1200, temperature: 0 }),
    });
    const data = (await res.json()) as OpenAIChatResponse;
    text = data.choices?.[0]?.message?.content ?? '';
  } catch {
    return null;
  }
  // Take the LAST score-like match — GLM reasons first, concludes last.
  const patterns = [/SCORE:\s*([1-5])\s*\/\s*5/gi, /\b([1-5])\s*\/\s*5\b/g, /"?score"?\s*[:=]\s*([1-5])\b/gi];
  for (const re of patterns) {
    const matches = [...text.matchAll(re)];
    const last = matches[matches.length - 1];
    if (last?.[1]) return { score: Number(last[1]), reason: text.trim().slice(-140) };
  }
  return null;
}
