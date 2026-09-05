/**
 * Pure logic for the FAST-slot measurement instruments (P3 design, 2026-07):
 *
 *   - `fast-bench.ts`        — compaction-summary benchmark over the hand-authored
 *                              stress corpus (`fast-corpus/*.json`)
 *   - `fast-classify-replay.ts` — inbox-classification replay over captured
 *                              tier=fast raw wire bodies
 *
 * Everything that decides a verdict lives HERE, exported and covered by
 * `tests/model-fitness-fast-bench.test.ts` — same arrangement as `replay.ts` /
 * `tests/model-fitness-replay.test.ts`: `scripts/` is outside tsconfig+vitest
 * include, so an inline helper would be neither typechecked nor executed by CI.
 */
import { MODEL_MAP } from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// Corpus schema
// ---------------------------------------------------------------------------

/** Deterministic filler block inside a tool_result — expands to `lines` of
 *  realistic log/table noise so a transcript reaches real thread length
 *  (20k-80k tokens) without a megabyte of literal JSON in the repo. The
 *  PLANTED ground truth never lives in a pad: checklist literals are always
 *  hand-authored `text` blocks, and the corpus test enforces that. */
export interface PadBlock {
  type: 'pad';
  generator: 'httplog' | 'buildlog' | 'sqlrows' | 'maillist' | 'csv';
  lines: number;
  seed: number;
}

export interface TextBlock { type: 'text'; text: string }
export interface ToolUseBlock { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
export interface ToolResultBlock { type: 'tool_result'; tool_use_id: string; content: Array<TextBlock | PadBlock> }

export type TranscriptBlock = TextBlock | ToolUseBlock | ToolResultBlock | PadBlock;

export interface TranscriptMessage {
  role: 'user' | 'assistant';
  content: TranscriptBlock[];
}

/**
 * One planted literal: a single string, or an ANY-OF list of accepted variants.
 * Variants exist for content the summarizer legitimately re-renders — language
 * flips ("24 von 31" / "24 of 31"), magnitude rewrites ("48'200'113" / "48.2M").
 * The FIRST variant is canonical: it is what must occur in the transcript and
 * what reports show. Calibration lesson (run 2026-08-09T21-18): format-exact
 * literals made the haiku-4.5 REFERENCE miss the 95% bar (91.5%) — an
 * unresolvable bar measures the checklist, not the candidate.
 */
export type Literal = string | string[];

export function literalVariants(l: Literal): string[] {
  return Array.isArray(l) ? l : [l];
}

export function literalName(l: Literal): string {
  return Array.isArray(l) ? l[0] ?? '' : l;
}

export interface TranscriptChecklist {
  /** Mechanically-checked literals (paths / ids / amounts / names) a correct
   *  summary MUST contain. Scored by `scoreLiteralRecall`, no LLM involved. */
  literals: Literal[];
  /** Exactly 8 judge-rubric elements (decisions / context / next steps),
   *  scored PASS/FAIL each by the deep judge. */
  rubric: string[];
}

export interface Transcript {
  schema: 'fast-bench-transcript/v1';
  id: string;
  title: string;
  /** Expanded size target — the corpus test asserts the expansion lands in
   *  [20k, 80k] approx tokens (chars/4). */
  targetTokens: number;
  messages: TranscriptMessage[];
  checklist: TranscriptChecklist;
}

/** Narrowing loader — corpus files are repo-controlled but the loader still
 *  refuses shape drift loudly instead of scoring garbage. */
export function parseTranscript(json: unknown): Transcript {
  if (typeof json !== 'object' || json === null) throw new Error('transcript: not an object');
  const t = json as Record<string, unknown>;
  if (t['schema'] !== 'fast-bench-transcript/v1') throw new Error(`transcript: bad schema ${String(t['schema'])}`);
  if (typeof t['id'] !== 'string' || t['id'].length === 0) throw new Error('transcript: missing id');
  if (typeof t['title'] !== 'string') throw new Error(`transcript ${t['id'] as string}: missing title`);
  if (typeof t['targetTokens'] !== 'number') throw new Error(`transcript ${t['id'] as string}: missing targetTokens`);
  if (!Array.isArray(t['messages']) || t['messages'].length === 0) throw new Error(`transcript ${t['id'] as string}: missing messages`);
  const checklist = t['checklist'] as Record<string, unknown> | undefined;
  if (!checklist || !Array.isArray(checklist['literals']) || checklist['literals'].length === 0) {
    throw new Error(`transcript ${t['id'] as string}: checklist.literals missing/empty`);
  }
  for (const l of checklist['literals']) {
    const ok = typeof l === 'string'
      ? l.length > 0
      : Array.isArray(l) && l.length > 0 && l.every(v => typeof v === 'string' && v.length > 0);
    if (!ok) throw new Error(`transcript ${t['id'] as string}: literal entries must be non-empty strings or non-empty string arrays`);
  }
  if (!Array.isArray(checklist['rubric']) || checklist['rubric'].length !== RUBRIC_SIZE) {
    throw new Error(`transcript ${t['id'] as string}: checklist.rubric must have exactly ${RUBRIC_SIZE} elements`);
  }
  return json as Transcript;
}

// ---------------------------------------------------------------------------
// Deterministic pad expansion
// ---------------------------------------------------------------------------

/** mulberry32 — tiny deterministic PRNG; same seed → same filler bytes forever,
 *  so recall numbers are comparable across runs and machines. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PAD_METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const;
const PAD_PATHS = ['/api/orders', '/api/customers', '/api/products', '/api/invoices', '/api/shipments', '/wp-json/wc/v3/orders', '/api/threads', '/api/health'];
const PAD_STATUS = [200, 200, 200, 200, 201, 204, 301, 400, 401, 403, 404, 429, 500, 502];
const PAD_PKGS = ['@acme/web', '@acme/api', '@acme/shared', '@acme/worker', '@acme/mailer'];
const PAD_SENDERS = ['newsletter@techdigest.example', 'noreply@shipfast.example', 'billing@cloudmetrics.example', 'updates@daily-briefing.example', 'info@webinar-hub.example'];

function padLine(generator: PadBlock['generator'], rnd: () => number, i: number): string {
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!;
  const n = (max: number): number => Math.floor(rnd() * max);
  switch (generator) {
    case 'httplog':
      return `2026-06-${String(1 + n(28)).padStart(2, '0')}T${String(n(24)).padStart(2, '0')}:${String(n(60)).padStart(2, '0')}:${String(n(60)).padStart(2, '0')}.${String(n(1000)).padStart(3, '0')}Z 10.0.${n(8)}.${n(255)} "${pick(PAD_METHODS)} ${pick(PAD_PATHS)}/${1000 + n(9000)} HTTP/1.1" ${pick(PAD_STATUS)} ${n(40000)} ${n(900)}ms`;
    case 'buildlog':
      return `[${String(i).padStart(4, '0')}] ${pick(PAD_PKGS)}: ${pick(['compiling', 'bundling', 'emitted', 'cached', 'transformed'])} ${pick(['src/index.ts', 'src/routes.ts', 'src/db.ts', 'src/render.tsx', 'src/queue.ts'])} (${n(2000)}ms, ${n(900)}kB)`;
    case 'sqlrows':
      return `| ${10000 + n(90000)} | 2026-0${1 + n(6)}-${String(1 + n(28)).padStart(2, '0')} | ${(rnd() * 900).toFixed(2)} | ${pick(['paid', 'open', 'draft', 'overdue', 'refunded'])} | ${pick(['CHF', 'EUR', 'USD'])} |`;
    case 'maillist':
      return `${String(i).padStart(3, '0')}  ${pick(PAD_SENDERS)}  "${pick(['Your weekly digest', 'Delivery update', 'Usage report ready', 'Webinar reminder', 'New features this month'])}"  ${n(24)}h ago  [auto_handled]`;
    case 'csv':
      return `${7000 + n(3000)},2026-0${1 + n(6)}-${String(1 + n(28)).padStart(2, '0')},${(rnd() * 500).toFixed(2)},${pick(['ok', 'pending', 'failed'])},${pick(['web', 'pos', 'api'])}`;
  }
}

export function expandPad(pad: PadBlock): string {
  const rnd = mulberry32(pad.seed);
  const lines: string[] = [];
  for (let i = 0; i < pad.lines; i++) lines.push(padLine(pad.generator, rnd, i));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Transcript expansion → wire-shaped messages
// ---------------------------------------------------------------------------

interface WireTextBlock { type: 'text'; text: string }
interface WireToolUseBlock { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
interface WireToolResultBlock { type: 'tool_result'; tool_use_id: string; content: WireTextBlock[] }
export type WireBlock = WireTextBlock | WireToolUseBlock | WireToolResultBlock;
export interface WireMessage { role: 'user' | 'assistant'; content: WireBlock[] }

export interface ExpandedTranscript {
  messages: WireMessage[];
  /** All visible text (message text + tool results incl. expanded pads),
   *  concatenated — the surface the corpus test checks planted literals against. */
  text: string;
  approxTokens: number;
}

export function approxTokens(text: string): number {
  return Math.round(text.length / 4);
}

export function expandTranscript(t: Transcript): ExpandedTranscript {
  const texts: string[] = [];
  const messages: WireMessage[] = t.messages.map((m) => {
    const content: WireBlock[] = m.content.map((b): WireBlock => {
      if (b.type === 'pad') {
        const text = expandPad(b);
        texts.push(text);
        return { type: 'text', text };
      }
      if (b.type === 'text') { texts.push(b.text); return b; }
      if (b.type === 'tool_use') { texts.push(JSON.stringify(b.input)); return b; }
      // tool_result
      const inner: WireTextBlock[] = b.content.map((c) => {
        const text = c.type === 'pad' ? expandPad(c) : c.text;
        texts.push(text);
        return { type: 'text', text };
      });
      return { type: 'tool_result', tool_use_id: b.tool_use_id, content: inner };
    });
    return { role: m.role, content };
  });
  const text = texts.join('\n');
  return { messages, text, approxTokens: approxTokens(text) };
}

/** Which checklist literals are planted in HAND-AUTHORED text (i.e. NOT inside a
 *  pad)? The corpus test uses this to prove every literal really exists in the
 *  transcript the candidate sees — a literal that never occurs would silently
 *  cap recall below 1.0 for every model (broken instrument, plausible number). */
export function handAuthoredText(t: Transcript): string {
  const handTexts: string[] = [];
  for (const m of t.messages) {
    for (const b of m.content) {
      if (b.type === 'text') handTexts.push(b.text);
      else if (b.type === 'tool_use') handTexts.push(JSON.stringify(b.input));
      else if (b.type === 'tool_result') {
        for (const c of b.content) if (c.type === 'text') handTexts.push(c.text);
      }
    }
  }
  return handTexts.join('\n');
}

export function literalsMissingFromTranscript(t: Transcript): string[] {
  const haystack = normalizeForMatch(handAuthoredText(t));
  return t.checklist.literals
    .filter(l => !literalVariants(l).some(v => haystack.includes(normalizeForMatch(v))))
    .map(literalName);
}

// ---------------------------------------------------------------------------
// Scoring 1: mechanical literal recall
// ---------------------------------------------------------------------------

/** Case/whitespace-insensitive; typographic quotes/dashes folded so a summary
 *  that re-typesets an id (or the corpus author's editor did) still matches.
 *  Calibration additions (run 2026-08-09T21-18, reference missed 8.5pp on
 *  formatting alone): digit-group separators inside numbers are folded
 *  (48'200'113 == 48,200,113 == 48200113), spaces around '/' collapse
 *  (4 vCPU / 16 GB == 4 vCPU/16 GB), and a space before '%' folds (15 % == 15%).
 *  Ordering matters: quote folding runs first so ’ used as a digit separator is
 *  already ' when the digit fold looks for it. */
export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/(\d)[', \u00A0\u202F](?=\d{3})/g, '$1')
    
    .replace(/\s*\/\s*/g, '/')
    .replace(/(\d)\s+%/g, '$1%')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface LiteralRecall {
  hits: string[];
  misses: string[];
  recall: number;
  /** True when the literal list was empty — an empty checklist must not read
   *  as a perfect score (fail-closed, per the guard-direction rule). */
  invalid: boolean;
}

export function scoreLiteralRecall(summary: string, literals: readonly Literal[]): LiteralRecall {
  if (literals.length === 0) return { hits: [], misses: [], recall: 0, invalid: true };
  const hay = normalizeForMatch(summary);
  const hits: string[] = [];
  const misses: string[] = [];
  for (const l of literals) {
    const hit = literalVariants(l).some(v => hay.includes(normalizeForMatch(v)));
    (hit ? hits : misses).push(literalName(l));
  }
  return { hits, misses, recall: hits.length / literals.length, invalid: false };
}

// ---------------------------------------------------------------------------
// Scoring 2: deep-judge rubric
// ---------------------------------------------------------------------------

export const RUBRIC_SIZE = 8;

/** DEF-replay-judge-self-family: the judge must NEVER share a model family with
 *  the candidate it scores (self-judge bias). Primary judge = the deep slot
 *  (MODEL_MAP.deep, Anthropic); when the candidate is itself an Anthropic model
 *  (incl. the haiku-4.5 reference), the judge flips to the prod deep-slot
 *  Fireworks model (glm-5p2) — and vice versa for a glm candidate. */
export interface JudgeSpec {
  modelId: string;
  provider: 'anthropic' | 'openai';
  keyName: 'anthropic' | 'fireworks';
  apiBaseURL?: string;
}

export const FIREWORKS_BASE = 'https://api.fireworks.ai/inference/v1';
const GLM_DEEP = 'accounts/fireworks/models/glm-5p2';

export function modelFamily(modelId: string): string {
  const short = modelId.replace(/^accounts\/fireworks\/models\//, '').toLowerCase();
  if (short.startsWith('claude')) return 'anthropic';
  if (short.startsWith('glm')) return 'zhipu';
  if (short.startsWith('deepseek')) return 'deepseek';
  if (short.startsWith('qwen')) return 'qwen';
  if (short.startsWith('kimi')) return 'moonshot';
  if (short.startsWith('gpt-oss')) return 'openai';
  if (short.startsWith('ministral') || short.startsWith('mistral')) return 'mistral';
  if (short.startsWith('minimax')) return 'minimax';
  return short.split(/[-/]/)[0] ?? short;
}

export function pickJudgeModel(candidateModelId: string): JudgeSpec {
  const anthropicJudge: JudgeSpec = { modelId: MODEL_MAP.deep, provider: 'anthropic', keyName: 'anthropic' };
  const glmJudge: JudgeSpec = { modelId: GLM_DEEP, provider: 'openai', keyName: 'fireworks', apiBaseURL: FIREWORKS_BASE };
  const fam = modelFamily(candidateModelId);
  if (fam === modelFamily(anthropicJudge.modelId)) return glmJudge;
  return anthropicJudge;
}

export interface RubricJudgeResult {
  perElement: boolean[];
  score: number;
  reasoning: string;
  /** Fail-closed: a reply that does not carry a verdict for EVERY rubric element
   *  is not a measurement — score 0 + invalid, never a partial guess. */
  invalid: boolean;
}

export function buildRubricJudgePrompt(rubric: readonly string[], transcriptDigest: string, summary: string): string {
  const items = rubric.map((r, i) => `ELEMENT ${i + 1}: ${r}`).join('\n');
  return `You are grading a COMPACTION SUMMARY of a long assistant thread. The summary's only job: let work continue without the full history.

Ground-truth checklist (what a correct summary must preserve):
${items}

Thread digest (context for you, the grader):
---
${transcriptDigest}
---

Summary under evaluation:
---
${summary}
---

For EVERY element above, judge whether the summary preserves it (content match, not wording). Keep any private deliberation SHORT — a quick check per element, no extended reasoning. Reply in EXACTLY this format, one line per element, then the total:

ELEMENT 1: PASS|FAIL — <one short reason>
...
ELEMENT ${rubric.length}: PASS|FAIL — <one short reason>
SCORE: <number of PASS>`;
}

export function parseRubricJudgeResponse(text: string, expected: number = RUBRIC_SIZE): RubricJudgeResult {
  // Reasoning-model tolerance: strip an exposed reasoning channel (<think>/
  // <reasoning> blocks) so a verdict list AFTER the reasoning parses, and a
  // PASS/FAIL mentioned INSIDE the reasoning cannot be read as a verdict.
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '');
  const perElement: boolean[] = [];
  const reasons: string[] = [];
  for (let i = 1; i <= expected; i++) {
    // Tolerant per-line shape: markdown decoration between "ELEMENT n" and the
    // verdict (e.g. "**ELEMENT 1:** PASS") is allowed; the verdict is the first
    // whole-word PASS/FAIL on that line. \b keeps "passes"/"failing" prose from
    // matching. \d guard: "ELEMENT 1" must not swallow "ELEMENT 12".
    const m = cleaned.match(new RegExp(`ELEMENT\\s*${i}(?!\\d)[^\\n]*?\\b(PASS|FAIL)\\b([^\\n]*)`, 'i'));
    if (!m) return { perElement: [], score: 0, reasoning: `missing verdict for element ${i}`, invalid: true };
    perElement.push(m[1]!.toUpperCase() === 'PASS');
    reasons.push(`E${i}:${m[1]!.toUpperCase()}${(m[2] ?? '').trim() ? ' ' + (m[2] ?? '').trim() : ''}`);
  }
  // The counted PASSes are authoritative; a contradicting SCORE line is noted, not trusted.
  const score = perElement.filter(Boolean).length;
  const declared = cleaned.match(/SCORE:\s*(\d+)/i);
  const note = declared && Number(declared[1]) !== score ? ` (declared SCORE ${declared[1]!} != counted ${score})` : '';
  return { perElement, score, reasoning: reasons.join(' · ') + note, invalid: false };
}

// ---------------------------------------------------------------------------
// Served-model guard
// ---------------------------------------------------------------------------

/**
 * Per-run verification of which model actually answered (the replay.ts
 * served-model-guard idea): a gateway silently substituting a different model
 * would otherwise be measured under the wrong label.
 *
 * THREE states, not two (revised after run 2026-08-09T21-18): `OpenAIAdapter`
 * emits `model: ''` in message_start and never propagates the wire's `model`
 * field, so EVERY openai-wire candidate (Mistral + all Fireworks) is
 * structurally `unreported` — the original fail-closed boolean therefore
 * invalidated 5 of 6 candidates by construction: the guard blocked the
 * instrument instead of guarding it. `unreported` is now a REPORTED
 * limitation, not an invalidation; positive evidence of substitution
 * (`mismatch`) still invalidates. The degraded-provider case the boolean was
 * worried about (tok in=1, garbage out) is caught by `checkInputSanity`
 * instead — a check on evidence that IS available.
 */
export type ServedStatus = 'verified' | 'unreported' | 'mismatch';

export function checkServedModel(requested: string, served: string | undefined): { status: ServedStatus; note: string } {
  if (!served || served.trim() === '') return { status: 'unreported', note: 'provider did not report a served model (openai-adapter drops the wire model field)' };
  const norm = (s: string): string => s.replace(/^accounts\/fireworks\/models\//, '').toLowerCase().trim();
  const r = norm(requested);
  const s = norm(served);
  if (r === s || s.startsWith(r) || r.startsWith(s)) return { status: 'verified', note: served };
  return { status: 'mismatch', note: `requested ${requested} but provider served ${served}` };
}

/**
 * Degradation tripwire (coordinator finding, partial run 2026-08-09): a
 * suspended/degraded provider returned rows with `tok in=1 / out=4096` —
 * the prompt was never processed, yet the row would have carried a recall
 * number. A reported input-token count wildly below the transcript's known
 * size means the model cannot have seen the thread. The 5% floor tolerates
 * real provider-tokenizer variance (observed 0.3x-3x of chars/4 across
 * Anthropic/Mistral/Fireworks); a zero/absent report stays acceptable —
 * some providers legitimately omit usage.
 */
export const INPUT_SANITY_FLOOR = 0.05;

export function checkInputSanity(reportedInTok: number, expectedApproxTokens: number): { ok: boolean; note: string } {
  if (reportedInTok <= 0) return { ok: true, note: 'no usage reported' };
  if (reportedInTok < expectedApproxTokens * INPUT_SANITY_FLOOR) {
    return { ok: false, note: `reported ${reportedInTok} input tokens for a ~${expectedApproxTokens}-token transcript — prompt not processed` };
  }
  return { ok: true, note: '' };
}

// ---------------------------------------------------------------------------
// Decision rule (P3): HOLD iff literal recall ≥95% AND judge within-noise of
// the reference model (haiku-4.5)
// ---------------------------------------------------------------------------

export const LITERAL_RECALL_BAR = 0.95;
/** Noise floor on the 8-point rubric scale — with few reference runs the
 *  sample std understates real run-to-run noise, so the band never collapses
 *  below half a rubric point. */
export const MIN_JUDGE_NOISE = 0.5;

export interface CandidateAggregate {
  literalRecall: number;
  judgeMean: number;
  /** Any run invalid (judge parse failure, empty literals, served-model
   *  mismatch) marks the aggregate invalid → verdict INVALID, never HOLD. */
  invalid: boolean;
}

export interface ReferenceAggregate {
  /** The reference's own literal recall — the bar-resolvability input: a 95%
   *  bar the reference itself misses measures the checklist, not candidates
   *  (eval-design; observed 2026-08-09: reference at 91.5% made every verdict
   *  meaningless). */
  literalRecall: number;
  judgeMean: number;
  judgeStd: number;
  invalid: boolean;
}

export interface FastSlotVerdict {
  verdict: 'HOLD' | 'FAIL' | 'INVALID';
  reasons: string[];
}

export function decideFastSlot(cand: CandidateAggregate, ref: ReferenceAggregate): FastSlotVerdict {
  if (cand.invalid || ref.invalid) {
    return { verdict: 'INVALID', reasons: [cand.invalid ? 'candidate aggregate invalid' : 'reference aggregate invalid'] };
  }
  // Bar resolvability: if the CURRENT PROD MODEL cannot reach the recall bar,
  // the checklist is miscalibrated and no candidate verdict from this corpus
  // is quotable — fix the checklist (or the matcher), do not fail candidates.
  if (ref.literalRecall < LITERAL_RECALL_BAR) {
    return {
      verdict: 'INVALID',
      reasons: [`recall bar unresolvable: reference itself at ${(ref.literalRecall * 100).toFixed(1)}% < ${LITERAL_RECALL_BAR * 100}% — recalibrate the checklist before quoting verdicts`],
    };
  }
  const reasons: string[] = [];
  if (cand.literalRecall < LITERAL_RECALL_BAR) {
    reasons.push(`literal recall ${(cand.literalRecall * 100).toFixed(1)}% < ${LITERAL_RECALL_BAR * 100}%`);
  }
  const noise = Math.max(ref.judgeStd, MIN_JUDGE_NOISE);
  if (cand.judgeMean < ref.judgeMean - noise) {
    reasons.push(`judge ${cand.judgeMean.toFixed(2)} below reference ${ref.judgeMean.toFixed(2)} − noise ${noise.toFixed(2)}`);
  }
  return reasons.length === 0
    ? { verdict: 'HOLD', reasons: ['literal recall and judge score both within bar'] }
    : { verdict: 'FAIL', reasons };
}

export function mean(nums: readonly number[]): number {
  return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function stddev(nums: readonly number[]): number {
  if (nums.length < 2) return 0;
  const m = mean(nums);
  return Math.sqrt(nums.reduce((a, b) => a + (b - m) ** 2, 0) / (nums.length - 1));
}

// ---------------------------------------------------------------------------
// Classification replay scoring
// ---------------------------------------------------------------------------

export type ExpectedBucket = 'requires_user' | 'draft_ready' | 'auto_handled';

export interface ClassifyLabelEntry { file: string; expected: ExpectedBucket }

export function parseLabelsFile(json: unknown): ClassifyLabelEntry[] {
  if (typeof json !== 'object' || json === null || !Array.isArray((json as Record<string, unknown>)['entries'])) {
    throw new Error('labels file: expected { "entries": [{ "file", "expected" }, ...] }');
  }
  const entries = (json as { entries: unknown[] }).entries;
  return entries.map((e, i) => {
    const r = e as Record<string, unknown>;
    if (typeof r['file'] !== 'string' || r['file'].length === 0) throw new Error(`labels entry ${i}: missing file`);
    const expected = r['expected'];
    if (expected !== 'requires_user' && expected !== 'draft_ready' && expected !== 'auto_handled') {
      throw new Error(`labels entry ${i} (${r['file'] as string}): expected must be requires_user|draft_ready|auto_handled, got ${String(expected)}`);
    }
    return { file: r['file'], expected };
  });
}

export interface ClassifyRunScore {
  correct: boolean;
  /** THE asymmetric-risk miss: ground truth requires_user, candidate routed it
   *  elsewhere. A single one of these disqualifies (mail the user had to act
   *  on, silently swallowed). */
  missedRequiresUser: boolean;
  /** The candidate's reply failed the strict schema and fell closed to
   *  requires_user — safe, but a capability signal worth reporting. */
  failClosed: boolean;
}

export function scoreClassification(
  verdict: { bucket: string; failReason: string | null },
  expected: ExpectedBucket,
): ClassifyRunScore {
  const correct = verdict.bucket === expected;
  return {
    correct,
    missedRequiresUser: expected === 'requires_user' && verdict.bucket !== 'requires_user',
    failClosed: verdict.failReason !== null,
  };
}

export interface ClassifyAggregate {
  total: number;
  accuracy: number;
  missedRequiresUser: number;
  failClosedRate: number;
  invalid: boolean;
}

export function aggregateClassify(rows: readonly ClassifyRunScore[]): ClassifyAggregate {
  if (rows.length === 0) return { total: 0, accuracy: 0, missedRequiresUser: 0, failClosedRate: 0, invalid: true };
  return {
    total: rows.length,
    accuracy: rows.filter(r => r.correct).length / rows.length,
    missedRequiresUser: rows.filter(r => r.missedRequiresUser).length,
    failClosedRate: rows.filter(r => r.failClosed).length / rows.length,
    invalid: false,
  };
}

/** Classification hold rule: ZERO missed requires_user, and accuracy within
 *  noise of the reference. Noise floor = one mail's worth of accuracy (1/n) —
 *  below that, two candidates differ by ground-truth disagreement, not skill. */
export function decideClassifySlot(cand: ClassifyAggregate, ref: ClassifyAggregate): FastSlotVerdict {
  if (cand.invalid || ref.invalid) {
    return { verdict: 'INVALID', reasons: [cand.invalid ? 'candidate aggregate invalid' : 'reference aggregate invalid'] };
  }
  const reasons: string[] = [];
  if (cand.missedRequiresUser > 0) reasons.push(`${cand.missedRequiresUser} missed requires_user (asymmetric risk — disqualifying)`);
  const noise = Math.max(1 / cand.total, 0.02);
  if (cand.accuracy < ref.accuracy - noise) {
    reasons.push(`accuracy ${(cand.accuracy * 100).toFixed(1)}% below reference ${(ref.accuracy * 100).toFixed(1)}% − noise ${(noise * 100).toFixed(1)}%`);
  }
  return reasons.length === 0
    ? { verdict: 'HOLD', reasons: ['no missed requires_user, accuracy within noise of reference'] }
    : { verdict: 'FAIL', reasons };
}

// ---------------------------------------------------------------------------
// Report rendering (style of scripts/model-fitness/replay.ts + bench-models/report.ts)
// ---------------------------------------------------------------------------

export interface BenchRow {
  label: string;
  transcriptId: string;
  run: number;
  literalRecall: number;
  misses: string[];
  judgeScore: number;
  judgeInvalid: boolean;
  judgeModel: string;
  served: ServedStatus;
  servedNote: string;
  /** Input-sanity verdict (degraded-provider tripwire). */
  sanityOk: boolean;
  sanityNote: string;
  latencyMs: number;
  inTok: number;
  outTok: number;
  /** Candidate + judge stop reasons — a judge that hit max_tokens explains an
   *  empty/unparseable verdict (the 2026-08-09 GLM failure mode). */
  stopReason: string;
  judgeStopReason: string;
  /** The candidate's raw summary and the judge's raw reply, PERSISTED so a
   *  parse-failure is diagnosable from the results file and stored summaries
   *  can be re-judged offline (--rejudge) without re-paying candidate calls.
   *  The 21-18 run stored neither, which made exactly that impossible. */
  summary: string;
  judgeRaw: string;
  error?: string;
}

/**
 * Row validity + per-candidate aggregation — pure, so the arithmetic that
 * feeds `decideFastSlot` is testable (it lived inline in the runner before).
 *
 * A row is valid iff it errored nowhere: run error, judge parse-invalid,
 * served-model MISMATCH (positive substitution evidence; `unreported` does
 * not invalidate — see `checkServedModel`), or failed input sanity.
 *
 * The aggregate goes invalid when FEWER THAN HALF its rows are valid — the
 * replay.ts `decideVerdict` lesson, adapted: an outage is not a measurement,
 * but a minority of transient failures (the 412 bursts) must not zero an
 * otherwise-measured matrix. Means are computed over VALID rows only.
 */
export function isRowValid(r: Pick<BenchRow, 'error' | 'judgeInvalid' | 'served' | 'sanityOk'>): boolean {
  return r.error === undefined && !r.judgeInvalid && r.served !== 'mismatch' && r.sanityOk;
}

export interface BenchAggregate extends CandidateAggregate {
  validRuns: number;
  totalRuns: number;
  invalidReasons: string[];
}

export function aggregateBenchRows(rows: readonly BenchRow[]): BenchAggregate {
  const valid = rows.filter(isRowValid);
  const invalidReasons = [...new Set(rows.filter(r => !isRowValid(r)).map(r =>
    r.error !== undefined ? `error: ${r.error.slice(0, 80)}`
      : r.judgeInvalid ? `judge invalid (stop=${r.judgeStopReason || '?'})`
        : r.served === 'mismatch' ? `served mismatch: ${r.servedNote}`
          : `input sanity: ${r.sanityNote}`,
  ))];
  return {
    literalRecall: mean(valid.map(r => r.literalRecall)),
    judgeMean: mean(valid.map(r => r.judgeScore)),
    invalid: valid.length < Math.ceil(rows.length / 2) || rows.length === 0,
    validRuns: valid.length,
    totalRuns: rows.length,
    invalidReasons,
  };
}

export interface BenchMatrix {
  timestamp: string;
  referenceLabel: string;
  rows: BenchRow[];
  aggregates: Array<{ label: string; agg: BenchAggregate; verdict: FastSlotVerdict }>;
}

export function buildBenchMarkdown(m: BenchMatrix): string {
  const lines: string[] = [];
  lines.push('# FAST-slot compaction bench');
  lines.push('');
  lines.push(`- Timestamp: ${m.timestamp}`);
  lines.push(`- Reference: ${m.referenceLabel}`);
  lines.push(`- Decision rule: literal recall ≥ ${LITERAL_RECALL_BAR * 100}% AND judge within noise (max(ref std, ${MIN_JUDGE_NOISE})) of reference`);
  lines.push('');
  lines.push('| Candidate | Valid runs | Literal recall | Judge mean (/8) | Verdict | Why |');
  lines.push('|-----------|------------|----------------|-----------------|---------|-----|');
  for (const a of m.aggregates) {
    lines.push(`| ${a.label} | ${a.agg.validRuns}/${a.agg.totalRuns} | ${(a.agg.literalRecall * 100).toFixed(1)}% | ${a.agg.judgeMean.toFixed(2)} | **${a.verdict.verdict}** | ${a.verdict.reasons.join('; ')} |`);
    for (const reason of a.agg.invalidReasons) lines.push(`| | ↳ excluded | | | | ${reason} |`);
  }
  lines.push('');
  lines.push('## Per-run detail');
  lines.push('');
  lines.push('| Candidate | Transcript | Run | Recall | Judge | Judge model | Served | Sanity | Latency | tok in/out |');
  lines.push('|-----------|------------|-----|--------|-------|-------------|--------|--------|---------|------------|');
  for (const r of m.rows) {
    const served = r.served === 'verified' ? '✓' : r.served === 'unreported' ? '– unreported' : `✗ ${r.servedNote}`;
    const sanity = r.sanityOk ? '✓' : `✗ ${r.sanityNote}`;
    const judge = r.judgeInvalid ? `INVALID (stop=${r.judgeStopReason || '?'})` : String(r.judgeScore);
    lines.push(`| ${r.label} | ${r.transcriptId} | ${r.run} | ${(r.literalRecall * 100).toFixed(0)}% | ${judge} | ${r.judgeModel} | ${served} | ${sanity} | ${(r.latencyMs / 1000).toFixed(1)}s | ${r.inTok}/${r.outTok} |`);
    if (r.error) lines.push(`| | | | | | | ERROR: ${r.error} | | | |`);
    if (r.misses.length > 0) lines.push(`| | ↳ missed | | ${r.misses.map(x => `\`${x}\``).join(', ')} | | | | | | |`);
  }
  lines.push('');
  return lines.join('\n');
}
