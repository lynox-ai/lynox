/**
 * Independent LLM-as-judge — Kimi K2 (Moonshot) via Fireworks.
 *
 * WHY independent: an LLM judge has a SELF-PREFERENCE bias — a Claude judge
 * scores Claude higher, a Mistral judge scores Mistral higher (rafael
 * 2026-07-19). The invariant is simply **judge ∉ candidate families** — not an
 * ordinal. It is stated that way because the ordinal version went stale twice:
 * the roster grew past "Claude + Mistral", GLM became a candidate while the docs
 * still named it the judge, and comments counting "a third family" now undercount
 * a roster spanning six. Today: Kimi K2 (`kimi-k2p6`) over the Fireworks
 * OpenAI-compatible endpoint with FIREWORKS_API_KEY. Add a candidate from Kimi's
 * family and the judge moves again; `run.ts` prints the judge it used, so the
 * claim is checkable from a run rather than from this comment.
 *
 * SCOPE: "candidates" means `models.ts` `ALL_CANDIDATES`, the roster this judge
 * actually scores. The sibling instruments in this directory carry their own
 * rosters (`replay.ts` and `artefact.ts` both list a Kimi) and do not import this
 * judge, so seeing one there is not a violation. The id-level half of the
 * invariant is asserted in `tests/model-fitness-models.test.ts`; the family-level
 * half — "no candidate from Kimi's family" — is still prose, because a model id
 * does not carry its family.
 *
 * Bias mitigations: ABSOLUTE rubric scoring (score each answer 1-5 against a
 * fixed rubric) — NOT pairwise A-vs-B — which sidesteps POSITION bias entirely.
 * Residual caveats we do NOT fully fix in v1: VERBOSITY bias (judges lean toward
 * longer answers) and the judge's own family/style bias (smaller than in-family,
 * not zero). Temperature 0 for repeatability. A judge score is a SOFT ranking
 * signal for the subjective quality axis — the hard cases' objective state
 * assertions remain the primary, bias-free discriminator.
 */
export const JUDGE_MODEL = 'accounts/fireworks/models/kimi-k2p6';
const JUDGE_BASE = 'https://api.fireworks.ai/inference/v1';

/** True when an independent judge can run (FIREWORKS_API_KEY present). */
export function judgeAvailable(): boolean {
  return !!process.env['FIREWORKS_API_KEY'];
}

/** The judge model id + provider, for provenance in reports. */
export const JUDGE_ID = `Kimi K2 via Fireworks (${JUDGE_MODEL}) — chosen because it is NOT in the candidate roster`;

/** A failure of the JUDGE, not of the candidate. Tagged so the runner does not
 *  mistake the judge's rate limit for the candidate's and re-run a paid case. */
export class JudgeError extends Error {
  override readonly name = 'JudgeError';
}

interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: unknown;
}

/**
 * Score one answer 1-5 against a rubric with the independent judge.
 *
 * Two outcomes that used to look identical and must not: `null` means the judge
 * did not SPEAK — no key configured, or it answered with nothing scorable — and
 * the caller soft-passes, leaving the quality axis blank. A configured judge that
 * FAILS TO ANSWER (non-2xx, unreachable) throws a `JudgeError`, so the run records
 * an error instead of a pass. That distinction is the point: `grounding-discipline`
 * gates all three tiers, so a judge outage used to turn silently into FIT for every
 * candidate.
 *
 * The residual, stated rather than glossed: a reachable judge that replies without
 * a parseable score still soft-passes. Throwing there would let one malformed reply
 * disqualify a candidate for something that is not the candidate's doing, which is
 * the worse of the two errors — but it is the same hole in miniature.
 *
 * Kimi reasons before answering, so we allow room + parse the score from anywhere
 * in the reply (prefer an explicit JSON, then `N/5`, then a bare 1-5), taking the
 * LAST match (its conclusion) not the first (its scratch work).
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
    if (!res.ok) throw new JudgeError(`judge HTTP ${res.status} — a configured judge that fails is an error, not a pass`);
    const data = (await res.json()) as OpenAIChatResponse;
    text = data.choices?.[0]?.message?.content ?? '';
  } catch (e) {
    // Two independent producers of the tag, deliberately: the explicit throw above
    // sits INSIDE this try, so even if it were changed back to a plain Error this
    // wrapper would still tag it. Neither is dead code — removing either one alone
    // is unobservable, removing both loses the tag and the runner starts re-running
    // paid cases on the judge's rate limit. Measured, not assumed.
    throw e instanceof JudgeError ? e : new JudgeError(`judge call failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  // Take the LAST score-like match — Kimi reasons first, concludes last.
  const patterns = [/SCORE:\s*([1-5])\s*\/\s*5/gi, /\b([1-5])\s*\/\s*5\b/g, /"?score"?\s*[:=]\s*([1-5])\b/gi];
  for (const re of patterns) {
    const matches = [...text.matchAll(re)];
    const last = matches[matches.length - 1];
    if (last?.[1]) return { score: Number(last[1]), reason: text.trim().slice(-140) };
  }
  return null;
}
