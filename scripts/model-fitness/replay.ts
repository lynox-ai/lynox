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

/** Unambiguous signal: a spawn_agent tool call targeting the deep tier. */
function hasDeepSpawn(content: ContentBlock[]): { yes: boolean; tools: string[] } {
  const toolUses = content.filter(b => b.type === 'tool_use');
  const tools = toolUses.map(b => b.name ?? '?');
  const yes = toolUses.some(b => b.name === 'spawn_agent' && JSON.stringify(b.input ?? {}).toLowerCase().includes('deep'));
  return { yes, tools };
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

async function replayOne(c: Candidate, body: RawBody, key: string, judgeKey: string): Promise<{ how: string; tools: string[]; ms: number; text: string; error?: string }> {
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
    const spawn = hasDeepSpawn(content);
    let how: string;
    if (spawn.yes) how = 'spawn_agent{deep}';
    else if (await judgeSpokenEscalation(text, judgeKey)) how = 'judge:offer';
    else how = 'inline';
    return { how, tools: spawn.tools, ms: Date.now() - started, text };
  } catch (err) {
    return { how: 'ERROR', tools: [], ms: Date.now() - started, text: '', error: err instanceof Error ? err.message : String(err) };
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const bodyPath = argv.find(a => !a.startsWith('--'));
  const runs = Number(argv[argv.indexOf('--runs') + 1]) || 3;
  if (!bodyPath) { console.error('usage: replay.ts <raw-body.json> [--runs N]'); process.exit(1); }

  const onlyIdx = argv.indexOf('--only');
  const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : undefined;
  const body = JSON.parse(readFileSync(bodyPath, 'utf8')) as RawBody;
  const keys = loadKeys();
  const candidates = only ? CANDIDATES.filter(c => c.label.toLowerCase().includes(only.toLowerCase())) : CANDIDATES;
  const sysText = (body.system as Array<{ text?: string }> | undefined)?.map(b => b.text ?? '').join('\n') ?? '';
  console.log(`\nReplaying: ${bodyPath}`);
  console.log(`Captured from: model=${body.model} provider=${body.provider} · tools=${(body.tools as unknown[]).length} · proactive-deep guidance=${/proactive/i.test(sysText) ? 'PRESENT' : 'ABSENT'}`);
  console.log(`Runs per candidate: ${runs}\n`);

  for (const c of candidates) {
    const key = keys[c.keyName];
    if (!key) { console.log(`  ${c.label.padEnd(26)} SKIP — no ${c.keyName} key`); continue; }
    const results = [] as Array<Awaited<ReturnType<typeof replayOne>>>;
    for (let i = 0; i < runs; i++) results.push(await replayOne(c, body, key, keys.anthropic));
    const escalated = results.filter(r => r.how === 'spawn_agent{deep}' || r.how === 'judge:offer').length;
    const errs = results.filter(r => r.how === 'ERROR');
    const hows = [...new Set(results.map(r => r.how))].join(',');
    const avgMs = Math.round(results.reduce((s, r) => s + r.ms, 0) / results.length);
    const verdict = escalated >= Math.ceil(runs / 2) ? 'ESCALATE' : 'inline';
    const match = (verdict === 'ESCALATE' ? 'escalate' : 'inline') === c.expect ? '✓' : '✗ MISMATCH';
    console.log(`  ${c.label.padEnd(26)} ${verdict.padEnd(9)} ${escalated}/${runs}  [${hows}]  ${avgMs}ms  expect=${c.expect} ${match}`);
    if (errs.length) console.log(`      errors: ${[...new Set(errs.map(e => e.error))].join(' | ')}`);
    const snip = (results.find(r => r.text)?.text ?? '').replace(/\s+/g, ' ').slice(0, 320);
    console.log(`      ↳ response head: ${JSON.stringify(snip)}`);
  }
  console.log('\nAcceptance gate: the replay is trusted ONLY if ministral-14b reproduces "inline" (the staging ground truth).\n');
}

void main();
