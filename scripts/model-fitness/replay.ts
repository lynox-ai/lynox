#!/usr/bin/env npx tsx
/**
 * Wire-replay model-fitness runner (WS2).
 *
 * Replays a CAPTURED raw agent-level request (from the wire-capture raw sink — the FULL
 * unredacted system + messages incl. the ephemeral tail + tool schemas) against a set of
 * candidate models, each through its OWN provider client, and scores escalate-vs-inline.
 * This is the Session-FAITHFUL eval: it sends the exact request production sent, not a
 * synthetic mock (the mock set-bench ceilinged because it omitted the tail).
 *
 * Usage:  npx tsx scripts/model-fitness/replay.ts <raw-body.json> [--runs N]
 * Keys:   ANTHROPIC_API_KEY / MISTRAL_API_KEY / OPENROUTER_API_KEY env, else ~/.lynox/config.json.
 * Cost:   a few cheap turns per candidate.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLLMClient } from '../../src/core/llm-client.js';

const MISTRAL_BASE = 'https://api.mistral.ai/v1';
const FIREWORKS_BASE = 'https://api.fireworks.ai/inference/v1';

interface Candidate {
  label: string;
  provider: 'anthropic' | 'openai';
  modelId: string;
  apiBaseURL?: string;
  keyName: 'anthropic' | 'mistral' | 'fireworks';
  expect: 'inline' | 'escalate';
}

// The main-slot candidates for the balanced/main floor (R1/R3), measured through their REAL
// prod providers (anthropic / mistral). ministral-14b is the known-fail control — the replay
// must reproduce it (inline) or the eval is not faithful. Fireworks-class open-weights are NOT
// listed here: OpenRouter is a different host/version/quant than prod's Fireworks glm-5p2, which
// would reintroduce exactly the fidelity gap this eval exists to kill — measure those through
// the real qa-managed engine (tier_set swap) or with a real Fireworks key.
// Exported so the suite can pin every Fireworks candidate id against MODEL_CAPABILITIES —
// a typo'd id here would otherwise fail only at replay time, against the live endpoint.
export const CANDIDATES: Candidate[] = [
  { label: 'ministral-14b (control)', provider: 'openai', modelId: 'ministral-14b-2512', apiBaseURL: MISTRAL_BASE, keyName: 'mistral', expect: 'inline' },
  { label: 'mistral-medium', provider: 'openai', modelId: 'mistral-medium-2604', apiBaseURL: MISTRAL_BASE, keyName: 'mistral', expect: 'escalate' },
  { label: 'haiku-4.5', provider: 'anthropic', modelId: 'claude-haiku-4-5-20251001', keyName: 'anthropic', expect: 'escalate' },
  // Fireworks glm-5p2 = the exact prod deep-slot model, via the REAL Fireworks endpoint (local
  // dev key) — the faithful prod path, not an OpenRouter proxy.
  { label: 'glm-5p2 (fireworks)', provider: 'openai', modelId: 'accounts/fireworks/models/glm-5p2', apiBaseURL: FIREWORKS_BASE, keyName: 'fireworks', expect: 'escalate' },
  // Kimi K3 (Moonshot, 2.8T MoE, 1M ctx) — new main/deep candidate on the same real Fireworks
  // endpoint. `expect: 'escalate'` is the HYPOTHESIS this replay has to confirm, not a result.
  { label: 'kimi-k3 (fireworks)', provider: 'openai', modelId: 'accounts/fireworks/models/kimi-k3', apiBaseURL: FIREWORKS_BASE, keyName: 'fireworks', expect: 'escalate' },
  // The 2026-08-09 picker-candidate wave (core #1162) — every entry the per-tier picker now
  // offers must be measurable HERE before a preset may pin it (tier-presets.test.ts guard).
  // All `expect: 'escalate'` = the same floor hypothesis as above, decided per body via --expect.
  { label: 'deepseek-v4-flash (fireworks)', provider: 'openai', modelId: 'accounts/fireworks/models/deepseek-v4-flash', apiBaseURL: FIREWORKS_BASE, keyName: 'fireworks', expect: 'escalate' },
  { label: 'qwen3.7-plus (fireworks)', provider: 'openai', modelId: 'accounts/fireworks/models/qwen3p7-plus', apiBaseURL: FIREWORKS_BASE, keyName: 'fireworks', expect: 'escalate' },
  { label: 'gpt-oss-120b (fireworks)', provider: 'openai', modelId: 'accounts/fireworks/models/gpt-oss-120b', apiBaseURL: FIREWORKS_BASE, keyName: 'fireworks', expect: 'escalate' },
  { label: 'kimi-k2.6 (fireworks)', provider: 'openai', modelId: 'accounts/fireworks/models/kimi-k2p6', apiBaseURL: FIREWORKS_BASE, keyName: 'fireworks', expect: 'escalate' },
  { label: 'kimi-k2.7-code (fireworks)', provider: 'openai', modelId: 'accounts/fireworks/models/kimi-k2p7-code', apiBaseURL: FIREWORKS_BASE, keyName: 'fireworks', expect: 'escalate' },
  { label: 'minimax-m3 (fireworks)', provider: 'openai', modelId: 'accounts/fireworks/models/minimax-m3', apiBaseURL: FIREWORKS_BASE, keyName: 'fireworks', expect: 'escalate' },
];

interface RawBody {
  model: string; provider: string;
  system: unknown; messages: unknown; tools: unknown; maxTokens: number;
}

interface ContentBlock { type: string; text?: string; name?: string; input?: unknown }

function loadKeys(): Record<Candidate['keyName'], string> {
  let cfg: Record<string, unknown> = {};
  try { cfg = JSON.parse(readFileSync(join(homedir(), '.lynox', 'config.json'), 'utf8')) as Record<string, unknown>; } catch { /* env only */ }
  const pick = (env: string, cfgKey: string): string => process.env[env] ?? (typeof cfg[cfgKey] === 'string' ? cfg[cfgKey] as string : '');
  return {
    anthropic: pick('ANTHROPIC_API_KEY', 'anthropic_api_key'),
    mistral: pick('MISTRAL_API_KEY', 'mistral_api_key'),
    fireworks: pick('FIREWORKS_API_KEY', 'fireworks_api_key'),
  };
}

/**
 * Escalation signal, read from the FIELD that carries it: `agents[].model === 'deep'`
 * (the tier enum in spawn_agent's input_schema, `src/tools/builtin/spawn.ts`).
 *
 * It used to be a substring search for 'deep' over the whole stringified input. `name`,
 * `task`, `context` and `system_prompt` are free text, so that scored BOTH ways wrong: a
 * "do a deep dive" task on a `model:'balanced'` spawn counted as an escalation, and a real
 * delegation that never said the word counted as inline. Delegation-without-deep is now its
 * own category rather than being folded into "answered it itself" — a different finding.
 */
export function classifySpawn(content: ContentBlock[]): { deep: boolean; delegated: boolean; tools: string[] } {
  const toolUses = content.filter(b => b.type === 'tool_use');
  const tools = toolUses.map(b => b.name ?? '?');
  const spawns = toolUses.filter(b => b.name === 'spawn_agent');
  // `input` is model-controlled: narrow it, never cast it. A cast let `agents: [null]`
  // through and threw inside `.some()`, which surfaced as a run-level ERROR.
  const specsOf = (b: ContentBlock): unknown[] => {
    const input = b.input as { agents?: unknown } | undefined;
    return Array.isArray(input?.agents) ? input.agents : [];
  };
  const isDeep = (a: unknown): boolean =>
    typeof a === 'object' && a !== null && (a as { model?: unknown }).model === 'deep';
  return {
    deep: spawns.some(b => specsOf(b).some(isDeep)),
    delegated: spawns.length > 0,
    tools,
  };
}

/**
 * The verdict for one candidate. Pure and exported so `tests/model-fitness-replay.test.ts`
 * can drive it: this arithmetic decides which model gets a production slot, and it used to
 * live inline in a script that nothing typechecks and nothing tests.
 *
 * The escalation bar is computed against `runs`, NOT against the surviving runs. Scoring it
 * against the survivors let a single transient failure flip the verdict: with runs=3,
 * ['esc','inline','ERROR'] reached ESCALATE (bar dropped to 1) while the error-free
 * ['esc','inline','inline'] stayed inline (bar 2) — the same one real escalation.
 */
export function decideVerdict(hows: string[], runs: number): {
  verdict: 'ESCALATE' | 'inline' | 'INVALID'; escalated: number; valid: number; errors: number;
} {
  const errors = hows.filter(h => h === 'ERROR').length;
  const valid = hows.length - errors;
  const escalated = hows.filter(h => h === 'spawn_agent{deep}' || h === 'judge:offer').length;
  // >1/3 errored, or nothing survived → an outage is not a measurement.
  if (errors * 3 > runs || valid === 0) return { verdict: 'INVALID', escalated, valid, errors };
  return { verdict: escalated >= Math.ceil(runs / 2) ? 'ESCALATE' : 'inline', escalated, valid, errors };
}

/**
 * Fuzzy signal: did the assistant OFFER/DECIDE to delegate to a deeper sub-agent/model instead
 * of answering? A regex can't tell "I'll do the deep analysis myself, in phases" (INLINE) from
 * "I propose running this on the Deep tier — shall I?" (ESCALATE) — both mention depth. So judge
 * it with a cheap Haiku call (the "LLM-judge only where fuzzy" rule).
 */
async function judgeSpokenEscalation(text: string, judgeKey: string): Promise<boolean> {
  if (!text.trim() || !judgeKey) return false;
  const client = createLLMClient({ provider: 'anthropic', apiKey: judgeKey });
  const prompt = `An AI assistant was given a complex, deep-worthy task. It could either ANSWER/START the task itself (inline), or ESCALATE by offering or deciding to hand it to a deeper sub-agent/model instead of doing it. Classify ONLY the response below.\n\nRESPONSE:\n"""\n${text.slice(0, 2000)}\n"""\n\nReply with exactly ONE word: ESCALATE if it offers or decides to delegate the task to a deeper agent/model instead of doing it itself; INLINE if it starts answering / doing the task itself (even if it talks about depth, phases, parallelizing, or thoroughness).`;
  const stream = client.beta.messages.stream({ model: 'claude-haiku-4-5-20251001', max_tokens: 8, messages: [{ role: 'user', content: prompt }] } as never);
  const final = await stream.finalMessage();
  const out = ((final.content ?? []) as ContentBlock[]).filter(b => b.type === 'text').map(b => b.text ?? '').join('').toUpperCase();
  return out.includes('ESCALATE');
}

async function replayOne(c: Candidate, body: RawBody, key: string, judgeKey: string): Promise<{ how: string; tools: string[]; ms: number; text: string; inTok: number; outTok: number; error?: string }> {
  const started = Date.now();
  try {
    const client = createLLMClient({
      provider: c.provider,
      apiKey: key,
      ...(c.apiBaseURL ? { apiBaseURL: c.apiBaseURL } : {}),
      ...(c.provider === 'openai' ? { openaiModelId: c.modelId } : {}),
    });
    const stream = client.beta.messages.stream({
      model: c.modelId,
      max_tokens: body.maxTokens,
      system: body.system,
      messages: body.messages,
      tools: body.tools,
    } as never);
    const final = await Promise.race([
      stream.finalMessage(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout 120s')), 120_000)),
    ]);
    const content = (final.content ?? []) as ContentBlock[];
    const text = content.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n');
    const spawn = classifySpawn(content);
    const u = (final as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
    let how: string;
    if (spawn.deep) how = 'spawn_agent{deep}';
    else if (await judgeSpokenEscalation(text, judgeKey)) how = 'judge:offer';
    else if (spawn.delegated) how = 'spawn_agent{not-deep}';
    else how = 'inline';
    return { how, tools: spawn.tools, ms: Date.now() - started, text, inTok: u?.input_tokens ?? 0, outTok: u?.output_tokens ?? 0 };
  } catch (err) {
    return { how: 'ERROR', tools: [], ms: Date.now() - started, text: '', inTok: 0, outTok: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const bodyPath = argv.find(a => !a.startsWith('--'));
  const runs = Number(argv[argv.indexOf('--runs') + 1]) || 3;
  if (!bodyPath) { console.error('usage: replay.ts <raw-body.json> [--runs N]'); process.exit(1); }

  const onlyIdx = argv.indexOf('--only');
  const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : undefined;
  // `expect` lives on the CANDIDATE, but escalate-vs-inline is a property of the BODY: on a
  // trivial capture (body-c-inline, "what time zone is Zurich in") 'inline' is the CORRECT
  // answer for every candidate, and the per-candidate expectation would flag it as MISMATCH —
  // reporting a correct measurement as an instrument failure. --expect overrides per run.
  const expIdx = argv.indexOf('--expect');
  const bodyExpect = expIdx >= 0 ? argv[expIdx + 1] : undefined;
  if (bodyExpect && bodyExpect !== 'escalate' && bodyExpect !== 'inline') {
    console.error(`--expect must be 'escalate' or 'inline', got ${JSON.stringify(bodyExpect)}`); process.exit(1);
  }
  const noGate = argv.includes('--no-gate');
  const body = JSON.parse(readFileSync(bodyPath, 'utf8')) as RawBody;
  const keys = loadKeys();
  const candidates = only ? CANDIDATES.filter(c => c.label.toLowerCase().includes(only.toLowerCase())) : CANDIDATES;
  const sysText = (body.system as Array<{ text?: string }> | undefined)?.map(b => b.text ?? '').join('\n') ?? '';
  console.log(`\nReplaying: ${bodyPath}`);
  console.log(`Captured from: model=${body.model} provider=${body.provider} · tools=${(body.tools as unknown[]).length} · proactive-deep guidance=${/proactive/i.test(sysText) ? 'PRESENT' : 'ABSENT'}`);
  console.log(`Runs per candidate: ${runs}${bodyExpect ? ` · body expectation: ${bodyExpect} (overrides per-candidate)` : ''}\n`);

  /** Gate bookkeeping: the control's verdict decides whether this run may be quoted at all. */
  let controlVerdict: string | undefined;
  let controlSeen = false;

  for (const c of candidates) {
    const expect = bodyExpect ?? c.expect;
    if (c.label.startsWith('ministral-14b')) controlSeen = true;
    const key = keys[c.keyName];
    if (!key) { console.log(`  ${c.label.padEnd(26)} SKIP — no ${c.keyName} key`); continue; }
    const results = [] as Array<Awaited<ReturnType<typeof replayOne>>>;
    for (let i = 0; i < runs; i++) results.push(await replayOne(c, body, key, keys.anthropic));
    const errs = results.filter(r => r.how === 'ERROR');
    const { verdict, escalated, valid } = decideVerdict(results.map(r => r.how), runs);
    const hows = [...new Set(results.map(r => r.how))].join(',');
    const avgMs = Math.round(results.reduce((s, r) => s + r.ms, 0) / results.length);
    const match = verdict === 'INVALID'
      ? `— ${errs.length}/${runs} errored, no verdict`
      : ((verdict === 'ESCALATE' ? 'escalate' : 'inline') === expect ? '✓' : '✗ MISMATCH');
    if (c.label.startsWith('ministral-14b')) controlVerdict = verdict;
    console.log(`  ${c.label.padEnd(26)} ${verdict.padEnd(9)} ${escalated}/${runs} (${valid} valid)  [${hows}]  ${avgMs}ms  expect=${expect} ${match}`);
    if (errs.length) console.log(`      errors: ${[...new Set(errs.map(e => e.error))].join(' | ')}`);
    // Which tools were called across the runs — an escalation that is not deep-tagged shows up
    // here as spawn_agent next to a `spawn_agent{not-deep}` verdict. Tool names are
    // model-controlled, so they are quoted rather than written raw to the terminal.
    const toolsSeen = [...new Set(results.flatMap(r => r.tools))];
    // Input tokens are reported per-run: providers that cache the prompt report near-zero on
    // repeats, so a mean across runs understates a cold call several-fold.
    const perRunIn = results.map(r => r.inTok).join('/');
    const avgOut = Math.round(results.reduce((s, r) => s + r.outTok, 0) / results.length);
    console.log(`      ↳ tools: ${toolsSeen.length ? JSON.stringify(toolsSeen.join(', ')) : '(none)'}  ·  tok in per run: ${perRunIn}  ·  avg out: ${avgOut}`);
    const snip = (results.find(r => r.text)?.text ?? '').replace(/\s+/g, ' ').slice(0, 320);
    console.log(`      ↳ response head: ${JSON.stringify(snip)}`);
  }
  // The acceptance gate used to be this sentence, printed unconditionally: it never read the
  // control's row, never noticed --only had filtered the control out, and the script exited 0
  // either way. A gate nobody can fail is a caption. It now decides the exit code.
  const gateApplies = (bodyExpect ?? 'escalate') === 'escalate';
  if (noGate) {
    console.log('\n⚠ Acceptance gate SKIPPED (--no-gate) — calibration probe, NOT a quotable measurement.\n');
  } else if (!gateApplies) {
    console.log('\nAcceptance gate n/a: on an inline-expected body, ministral-14b answering inline proves nothing about fidelity.\n');
  } else if (!controlSeen) {
    console.error('\n✗ GATE NOT EVALUATED: the ministral-14b control was filtered out by --only. A run without its control is not a measurement.\n  → re-run without --only, or pass --no-gate to declare this a calibration probe.\n');
    process.exit(1);
  } else if (controlVerdict === undefined) {
    console.error('\n✗ GATE NOT EVALUATED: the ministral-14b control was SKIPPED (missing mistral key).\n');
    process.exit(1);
  } else if (controlVerdict !== 'inline') {
    console.error(`\n✗ GATE FAILED: ministral-14b returned ${controlVerdict}, expected inline (the staging ground truth).\n  The replay did not reproduce the known-fail control — do NOT quote any number from this run.\n`);
    process.exit(1);
  } else {
    console.log('\n✓ Gate PASSED: ministral-14b reproduced "inline" (the staging ground truth).\n');
  }
}

/**
 * Is this module the process entry point, rather than an import?
 *
 * Both sides are realpath-resolved, because comparing `import.meta.url` against a raw
 * `argv[1]` compares UNEQUAL whenever the two spell the same file differently — a symlink is
 * enough — and `main()` then never runs while the process still exits 0. A script that
 * silently does nothing is the worst outcome available here, so every uncertain case runs:
 * no entry, or either side unresolvable, returns true.
 *
 * Resolution failure must NOT fall back to comparing the raw strings. An earlier version did
 * exactly that, which reintroduced the silent-no-op for a deleted or relocated argv[1].
 */
export function isDirectInvocation(moduleUrl: string, entry: string | undefined): boolean {
  if (!entry) return true;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entry);
  } catch {
    return true;
  }
}

if (isDirectInvocation(import.meta.url, process.argv[1])) void main();
