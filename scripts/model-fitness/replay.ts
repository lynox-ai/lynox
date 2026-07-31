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
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
const CANDIDATES: Candidate[] = [
  { label: 'ministral-14b (control)', provider: 'openai', modelId: 'ministral-14b-2512', apiBaseURL: MISTRAL_BASE, keyName: 'mistral', expect: 'inline' },
  { label: 'mistral-medium', provider: 'openai', modelId: 'mistral-medium-2604', apiBaseURL: MISTRAL_BASE, keyName: 'mistral', expect: 'escalate' },
  { label: 'haiku-4.5', provider: 'anthropic', modelId: 'claude-haiku-4-5-20251001', keyName: 'anthropic', expect: 'escalate' },
  // Fireworks glm-5p2 = the exact prod deep-slot model, via the REAL Fireworks endpoint (local
  // dev key) — the faithful prod path, not an OpenRouter proxy.
  { label: 'glm-5p2 (fireworks)', provider: 'openai', modelId: 'accounts/fireworks/models/glm-5p2', apiBaseURL: FIREWORKS_BASE, keyName: 'fireworks', expect: 'escalate' },
  // Kimi K3 (Moonshot, 2.8T MoE, 1M ctx) — new main/deep candidate on the same real Fireworks
  // endpoint. `expect: 'escalate'` is the HYPOTHESIS this replay has to confirm, not a result.
  { label: 'kimi-k3 (fireworks)', provider: 'openai', modelId: 'accounts/fireworks/models/kimi-k3', apiBaseURL: FIREWORKS_BASE, keyName: 'fireworks', expect: 'escalate' },
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
  const specsOf = (b: ContentBlock): Array<{ model?: string }> => {
    const input = b.input as { agents?: unknown } | undefined;
    return Array.isArray(input?.agents) ? input.agents as Array<{ model?: string }> : [];
  };
  return {
    deep: spawns.some(b => specsOf(b).some(a => a.model === 'deep')),
    delegated: spawns.length > 0,
    tools,
  };
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
    // ERRORs leave the DENOMINATOR — they used to stay in it, so a provider outage scored as
    // "0/3 escalated → inline" and printed a ✓ against expect=inline. An outage is not a result.
    const valid = results.filter(r => r.how !== 'ERROR');
    const escalated = valid.filter(r => r.how === 'spawn_agent{deep}' || r.how === 'judge:offer').length;
    const hows = [...new Set(results.map(r => r.how))].join(',');
    const avgMs = Math.round(results.reduce((s, r) => s + r.ms, 0) / results.length);
    const tooManyErrors = errs.length * 3 > runs; // >1/3 failed → not a measurement
    const verdict = tooManyErrors || valid.length === 0
      ? 'INVALID'
      : (escalated >= Math.ceil(valid.length / 2) ? 'ESCALATE' : 'inline');
    const match = verdict === 'INVALID'
      ? `— ${errs.length}/${runs} errored, no verdict`
      : ((verdict === 'ESCALATE' ? 'escalate' : 'inline') === expect ? '✓' : '✗ MISMATCH');
    if (c.label.startsWith('ministral-14b')) controlVerdict = verdict;
    console.log(`  ${c.label.padEnd(26)} ${verdict.padEnd(9)} ${escalated}/${valid.length}  [${hows}]  ${avgMs}ms  expect=${expect} ${match}`);
    if (errs.length) console.log(`      errors: ${[...new Set(errs.map(e => e.error))].join(' | ')}`);
    // The tool calls are WHY a verdict is what it is: an 'inline' with spawn_agent in this list
    // means "delegated, but not deep-tagged" — a different finding than "answered it itself".
    const toolsSeen = [...new Set(results.flatMap(r => r.tools))];
    const avg = (f: (r: typeof results[number]) => number): number => Math.round(results.reduce((s, r) => s + f(r), 0) / results.length);
    console.log(`      ↳ tools: ${toolsSeen.length ? toolsSeen.join(', ') : '(none)'}  ·  avg tok in/out: ${avg(r => r.inTok)}/${avg(r => r.outTok)}`);
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

// Run only when invoked as a CLI, so the detector can be imported and tested offline.
// Deliberately fail-OPEN: if argv[1] is missing or unresolvable we still run, because a guard
// that silently stops the script from executing is the worse failure of the two.
let invokedDirectly = true;
try { if (process.argv[1]) invokedDirectly = import.meta.url === pathToFileURL(process.argv[1]).href; } catch { /* run */ }
if (invokedDirectly) void main();
