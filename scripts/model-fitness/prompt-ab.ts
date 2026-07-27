#!/usr/bin/env npx tsx
/**
 * Prompt-variant A/B on a CAPTURED raw body — the prompt-axis sibling of replay.ts.
 *
 * replay.ts holds the request fixed and swaps the MODEL (model fitness). This holds the
 * request fixed and swaps a slice of the USER MESSAGE (prompt fitness), so a prompt edit
 * can be measured the same faithful way: the real system blocks, the real ~50 tool schemas,
 * and the real ephemeral tail all stay exactly as production sent them.
 *
 * Why it has to be a captured body: a hand-assembled harness picks the tools it thinks matter,
 * and tool CHOICE is precisely what a scan-prompt edit changes. Measuring tool choice against
 * 3 hand-picked schemas instead of the real 51 is the same structural blindness that ceilinged
 * the mock set-bench (see replay.ts) — the reduced surface cannot show delegation to
 * spawn_agent, or any other tool the edit might push the model toward.
 *
 * Usage:  npx tsx scripts/model-fitness/prompt-ab.ts <raw-body.json> <variants.json> [--runs N] [--also-anthropic MODEL]
 * Keys:   ANTHROPIC_API_KEY / MISTRAL_API_KEY env, else ~/.lynox/config.json.
 *
 * variants.json: { "marker": {"from": "...", "to": "..."}, "variants": { "LABEL": "replacement text", ... } }
 *   `marker.from`/`marker.to` bound the slice of the last user message to replace (inclusive).
 *   A variant whose marker is not found is a hard error — a silent no-op A/B is worse than none.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createLLMClient } from '../../src/core/llm-client.js';

const MISTRAL_BASE = 'https://api.mistral.ai/v1';

interface RawBody {
  model: string; provider: string;
  system: unknown; messages: unknown; tools: unknown; maxTokens: number;
}
interface VariantSpec {
  marker: { from: string; to: string };
  variants: Record<string, string>;
}
interface ContentBlock { type: string; text?: string; name?: string; input?: unknown }
type MsgParam = { role: string; content: unknown };

/** Fetch-shaped tools — the ones a "read the user's site" prompt can pick between. */
const FETCH_TOOLS = new Set(['web_research', 'http_request']);

function loadKey(env: string, cfgKey: string): string {
  let cfg: Record<string, unknown> = {};
  try { cfg = JSON.parse(readFileSync(join(homedir(), '.lynox', 'config.json'), 'utf8')) as Record<string, unknown>; } catch { /* env only */ }
  return process.env[env] ?? (typeof cfg[cfgKey] === 'string' ? cfg[cfgKey] as string : '');
}

/** Replace the marker-bounded slice in the last user message that CONTAINS the
 *  marker (scanning from the end). Throws if no user message has it — a silent
 *  no-op would report an A/B that never varied anything. */
function applyVariant(messages: MsgParam[], spec: VariantSpec, replacement: string): MsgParam[] {
  const out = JSON.parse(JSON.stringify(messages)) as MsgParam[];
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (!m || m.role !== 'user') continue;
    const rewrite = (s: string): string | null => {
      const a = s.indexOf(spec.marker.from);
      if (a < 0) return null;
      const b = s.indexOf(spec.marker.to, a);
      if (b < 0) return null;
      return s.slice(0, a) + replacement + s.slice(b + spec.marker.to.length);
    };
    if (typeof m.content === 'string') {
      const r = rewrite(m.content);
      if (r !== null) { m.content = r; return out; }
    } else if (Array.isArray(m.content)) {
      for (const blk of m.content as ContentBlock[]) {
        if (blk.type === 'text' && typeof blk.text === 'string') {
          const r = rewrite(blk.text);
          if (r !== null) { blk.text = r; return out; }
        }
      }
    }
  }
  throw new Error(`marker not found in any user message: "${spec.marker.from.slice(0, 40)}…"`);
}

async function runOnce(
  body: RawBody, messages: MsgParam[],
  cand: { provider: 'anthropic' | 'openai'; modelId: string; apiBaseURL?: string; key: string },
): Promise<{ calls: Array<{ name: string; input: Record<string, unknown> }>; ms: number; error?: string }> {
  const started = Date.now();
  try {
    const client = createLLMClient({
      provider: cand.provider,
      apiKey: cand.key,
      ...(cand.apiBaseURL ? { apiBaseURL: cand.apiBaseURL } : {}),
      ...(cand.provider === 'openai' ? { openaiModelId: cand.modelId } : {}),
    });
    const stream = client.beta.messages.stream({
      model: cand.modelId,
      max_tokens: body.maxTokens,
      system: body.system,
      messages,
      tools: body.tools,
    } as never);
    const final = await Promise.race([
      stream.finalMessage(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout 180s')), 180_000)),
    ]);
    const calls = ((final.content ?? []) as ContentBlock[])
      .filter(b => b.type === 'tool_use')
      .map(b => ({ name: b.name ?? '?', input: (b.input ?? {}) as Record<string, unknown> }));
    return { calls, ms: Date.now() - started };
  } catch (err) {
    return { calls: [], ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  }
}

function urlOf(input: Record<string, unknown>): string {
  return typeof input['url'] === 'string' ? input['url'].replace(/\/+$/, '') : '';
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // Skip the token AFTER a value-taking flag, or `--runs 5 body.json spec.json`
  // would take "5" as the body path and fail with a confusing ENOENT.
  const VALUE_FLAGS = new Set(['--runs', '--also-anthropic']);
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (VALUE_FLAGS.has(a)) { i++; continue; }
    if (a.startsWith('--')) continue;
    positional.push(a);
  }
  const bodyPath = positional[0];
  const specPath = positional[1];
  if (!bodyPath || !specPath) {
    console.error('usage: prompt-ab.ts <raw-body.json> <variants.json> [--runs N] [--also-anthropic MODEL]');
    process.exit(1);
  }
  const runs = Number(argv[argv.indexOf('--runs') + 1]) || 5;
  const alsoIdx = argv.indexOf('--also-anthropic');
  const alsoAnthropic = alsoIdx >= 0 ? argv[alsoIdx + 1] : undefined;

  const body = JSON.parse(readFileSync(bodyPath, 'utf8')) as RawBody;
  const spec = JSON.parse(readFileSync(specPath, 'utf8')) as VariantSpec;
  const baseMessages = body.messages as MsgParam[];

  const candidates: Array<{ label: string; provider: 'anthropic' | 'openai'; modelId: string; apiBaseURL?: string; key: string }> = [];
  if (body.provider === 'openai') {
    candidates.push({ label: body.model, provider: 'openai', modelId: body.model, apiBaseURL: MISTRAL_BASE, key: loadKey('MISTRAL_API_KEY', 'mistral_api_key') });
  } else {
    candidates.push({ label: body.model, provider: 'anthropic', modelId: body.model, key: loadKey('ANTHROPIC_API_KEY', 'anthropic_api_key') });
  }
  if (alsoAnthropic) {
    candidates.push({ label: alsoAnthropic, provider: 'anthropic', modelId: alsoAnthropic, key: loadKey('ANTHROPIC_API_KEY', 'anthropic_api_key') });
  }

  console.log(`body      : ${bodyPath}`);
  console.log(`captured  : ${(body.tools as unknown[]).length} tools, ` +
    `${Math.round(JSON.stringify(body.tools).length / 4)} tok schemas, ` +
    `${Math.round(JSON.stringify(body.system).length / 4)} tok system`);
  console.log(`variants  : ${Object.keys(spec.variants).join(', ')}   runs=${runs}\n`);

  for (const cand of candidates) {
    if (!cand.key) { console.log(`## ${cand.label}: SKIP (no key)\n`); continue; }
    console.log(`## ${cand.label}`);
    for (const [label, text] of Object.entries(spec.variants)) {
      const messages = applyVariant(baseMessages, spec, text);
      let dbl = 0, fetchTotal = 0, ok = 0, rawFetch = 0;
      const shapes: string[] = [];
      for (let i = 0; i < runs; i++) {
        const { calls, error } = await runOnce(body, messages, cand);
        if (error) { console.log(`   ${label} #${i + 1}: ERROR ${error}`); continue; }
        ok++;
        const fetches = calls.filter(c => FETCH_TOOLS.has(c.name));
        fetchTotal += fetches.length;
        // The COST event, independent of same-url pairing: http_request returns raw
        // markup, web_research returns extracted text. Any http_request against a page
        // is the expensive path, whether or not a web_research call shares its url.
        if (calls.some(c => c.name === 'http_request')) rawFetch++;
        // The defect: two DIFFERENT fetch tools aimed at the SAME url.
        const byUrl = new Map<string, Set<string>>();
        for (const f of fetches) {
          const u = urlOf(f.input);
          if (!byUrl.has(u)) byUrl.set(u, new Set());
          byUrl.get(u)!.add(f.name);
        }
        const isDbl = [...byUrl.values()].some(s => s.size > 1);
        if (isDbl) dbl++;
        shapes.push(calls.map(c => c.name).join('+') || '(none)');
      }
      const pct = ok ? Math.round((dbl / ok) * 100) : 0;
      const rawPct = ok ? Math.round((rawFetch / ok) * 100) : 0;
      console.log(`   ${label.padEnd(5)} n=${ok}  same-url double-fetch ${dbl}/${ok} (${pct}%)  ` +
        `http_request used ${rawFetch}/${ok} (${rawPct}%)  ` +
        `fetch-calls/run ${ok ? (fetchTotal / ok).toFixed(1) : '-'}`);
      const counts = new Map<string, number>();
      for (const s of shapes) counts.set(s, (counts.get(s) ?? 0) + 1);
      for (const [s, c] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`         ${c}x ${s}`);
      }
    }
    console.log();
  }
}

void main();
