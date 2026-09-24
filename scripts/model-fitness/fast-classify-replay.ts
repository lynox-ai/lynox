#!/usr/bin/env npx tsx
/**
 * FAST-slot inbox-classification replay runner (P3 design, 2026-07).
 *
 * Replays CAPTURED tier=fast classification request bodies (wire-capture RAW-sink
 * format — see `RawWireBody` in `src/core/wire-capture.ts` and `RawBody` in
 * `./replay.ts`) against the fast-slot candidates, and scores each candidate's
 * reply against the KNOWN correct classification from a labels file. The reply is
 * parsed through the REAL production parser (`parseClassifierResponse` from
 * `src/integrations/inbox/classifier/schema.ts`) — same fail-closed semantics,
 * same fence-stripping, so the measurement includes the model's ability to obey
 * the JSON contract, exactly as production experiences it.
 *
 * This script is the RUNNER; the measurement itself happens later, once captures
 * exist. How to pull captures (the `/tmp/wire-sink-raw-on`-style gate) is in
 * `./README.md`.
 *
 * Usage:
 *   npx tsx scripts/model-fitness/fast-classify-replay.ts --captures <dir> --labels <labels.json> [--runs N] [--only <label>]
 *
 * Labels file: { "entries": [ { "file": "raw-….json", "expected": "requires_user" }, … ] }
 * Keys: ANTHROPIC_API_KEY / MISTRAL_API_KEY / FIREWORKS_API_KEY env, else ~/.lynox/config.json.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLLMClient } from '../../src/core/llm-client.js';
import { parseClassifierResponse } from '../../src/integrations/inbox/classifier/schema.js';
import { FAST_CANDIDATES } from './fast-bench.js';
import { isDirectInvocation } from './replay.js';
import {
  aggregateClassify, decideClassifySlot, parseLabelsFile, scoreClassification,
  type ClassifyAggregate, type ClassifyRunScore,
} from './fast-bench-lib.js';

/** The raw-sink body shape this runner replays (subset it needs). */
interface RawBody {
  model: string; provider: string;
  system: unknown; messages: unknown; tools: unknown; maxTokens: number;
}

interface ContentBlock { type: string; text?: string }

function loadKeys(): Record<'anthropic' | 'mistral' | 'fireworks', string> {
  let cfg: Record<string, unknown> = {};
  try { cfg = JSON.parse(readFileSync(join(homedir(), '.lynox', 'config.json'), 'utf8')) as Record<string, unknown>; } catch { /* env only */ }
  const pick = (env: string, cfgKey: string): string => process.env[env] ?? (typeof cfg[cfgKey] === 'string' ? cfg[cfgKey] as string : '');
  return {
    anthropic: pick('ANTHROPIC_API_KEY', 'anthropic_api_key'),
    mistral: pick('MISTRAL_API_KEY', 'mistral_api_key'),
    fireworks: pick('FIREWORKS_API_KEY', 'fireworks_api_key'),
  };
}

async function classifyOnce(
  c: (typeof FAST_CANDIDATES)[number],
  body: RawBody,
  key: string,
): Promise<{ text: string; ms: number; error?: string }> {
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
      ...(Array.isArray(body.tools) && body.tools.length > 0 ? { tools: body.tools } : {}),
    } as never);
    const final = await Promise.race([
      stream.finalMessage(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout 60s')), 60_000)),
    ]);
    const text = ((final.content ?? []) as ContentBlock[]).filter(b => b.type === 'text').map(b => b.text ?? '').join('\n');
    return { text, ms: Date.now() - started };
  } catch (err) {
    return { text: '', ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const capIdx = argv.indexOf('--captures');
  const labIdx = argv.indexOf('--labels');
  const capturesDir = capIdx >= 0 ? argv[capIdx + 1] : undefined;
  const labelsPath = labIdx >= 0 ? argv[labIdx + 1] : undefined;
  const runs = Number(argv[argv.indexOf('--runs') + 1]) || 1;
  const onlyIdx = argv.indexOf('--only');
  const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : undefined;
  if (!capturesDir || !labelsPath) {
    console.error('usage: fast-classify-replay.ts --captures <dir> --labels <labels.json> [--runs N] [--only <label>]');
    process.exit(1);
  }

  const labels = parseLabelsFile(JSON.parse(readFileSync(labelsPath, 'utf8')));
  if (labels.length === 0) { console.error('labels file has no entries'); process.exit(1); }
  const bodies = labels.map(l => ({
    label: l,
    body: JSON.parse(readFileSync(join(capturesDir, l.file), 'utf8')) as RawBody,
  }));
  console.log(`\nReplaying ${bodies.length} captured classification bodies × ${runs} run(s) per candidate.`);
  console.log(`Captured models seen: ${[...new Set(bodies.map(b => b.body.model))].join(', ')}\n`);

  const keys = loadKeys();
  const reference = FAST_CANDIDATES.find(c => c.reference)!;
  let candidates = only ? FAST_CANDIDATES.filter(c => c.label.toLowerCase().includes(only.toLowerCase())) : FAST_CANDIDATES;
  if (!candidates.some(c => c.reference)) candidates = [reference, ...candidates];

  const perCandidate: Array<{ label: string; agg: ClassifyAggregate; rows: Array<ClassifyRunScore & { file: string; bucket: string; error?: string }> }> = [];
  for (const c of candidates) {
    const key = keys[c.keyName];
    if (!key) { console.log(`${c.label.padEnd(30)} SKIP — no ${c.keyName} key`); continue; }
    const rows: Array<ClassifyRunScore & { file: string; bucket: string; error?: string }> = [];
    for (const { label, body } of bodies) {
      for (let i = 0; i < runs; i++) {
        const r = await classifyOnce(c, body, key);
        // An errored call is scored through the SAME fail-closed path production
        // takes (empty text → json_parse_error → requires_user): an outage
        // surfaces as fail-closed rate, never as silent accuracy.
        const verdict = parseClassifierResponse(r.text);
        const score = scoreClassification(verdict, label.expected);
        rows.push({ ...score, file: label.file, bucket: verdict.bucket, ...(r.error ? { error: r.error } : {}) });
      }
    }
    const agg = aggregateClassify(rows);
    perCandidate.push({ label: c.label, agg, rows });
    console.log(`${c.label.padEnd(30)} accuracy ${(agg.accuracy * 100).toFixed(1)}%  missed_requires_user ${agg.missedRequiresUser}  fail_closed ${(agg.failClosedRate * 100).toFixed(0)}%`);
    const errs = [...new Set(rows.filter(r => r.error).map(r => r.error))];
    if (errs.length) console.log(`    errors: ${errs.join(' | ')}`);
  }

  const ref = perCandidate.find(p => p.label === reference.label);
  if (!ref) { console.error('\n✗ Reference (haiku-4.5) did not run — no verdicts quotable.'); process.exit(1); }

  const lines: string[] = [];
  lines.push('# FAST-slot classification replay');
  lines.push('');
  lines.push(`- Timestamp: ${new Date().toISOString()}`);
  lines.push(`- Bodies: ${bodies.length} · runs per candidate: ${runs} · reference: ${reference.label}`);
  lines.push('- Decision rule: 0 missed requires_user AND accuracy within noise of reference');
  lines.push('');
  lines.push('| Candidate | Accuracy | missed requires_user | fail-closed | Verdict | Why |');
  lines.push('|-----------|----------|----------------------|-------------|---------|-----|');
  const verdicts = perCandidate.map(p => ({ ...p, verdict: decideClassifySlot(p.agg, ref.agg) }));
  for (const p of verdicts) {
    lines.push(`| ${p.label} | ${(p.agg.accuracy * 100).toFixed(1)}% | ${p.agg.missedRequiresUser} | ${(p.agg.failClosedRate * 100).toFixed(0)}% | **${p.verdict.verdict}** | ${p.verdict.reasons.join('; ')} |`);
  }
  lines.push('');
  const md = lines.join('\n');
  const outDir = join(dirname(fileURLToPath(import.meta.url)), 'results');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(join(outDir, `fast-classify-${stamp}.md`), md);
  writeFileSync(join(outDir, `fast-classify-${stamp}.json`), JSON.stringify(verdicts, null, 2));
  console.log(`\n${md}`);
  console.log(`Written to ${outDir}/fast-classify-${stamp}.{md,json}`);
}

if (isDirectInvocation(import.meta.url, process.argv[1])) void main();
