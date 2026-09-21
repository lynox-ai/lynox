#!/usr/bin/env node
/**
 * caching-probe — does an OpenAI-compatible endpoint cache a repeated prompt prefix?
 *
 * An agent resends its whole context on every step, so prefix caching decides a large
 * share of the running cost. Three questions, answered separately:
 *
 *   technically cached   is a repeated long prefix served measurably faster?
 *   reported in usage    does the usage object carry any cache field with a value > 0?
 *   billed cheaper       (not answered here — compare the provider's billing record for
 *                        the day against `promptTokensSent` below once it has settled)
 *
 * Design: N pairs. Each pair gets its own prefix (700 paragraphs, ~30k-40k tokens) that starts with a
 * random line, so no first call can profit from an earlier one; the identical request
 * is then sent twice more. The decision rule is fixed here, before measuring:
 * "technically cached" iff the median first-token time of the repeats is at most half
 * the median of the first calls AND at least N-1 of the valid pairs repeat faster than
 * they started (a pair with a failed call is not valid; at least two must be).
 *
 *   node scripts/model-fitness/setup-probe/caching-probe.mjs --base-url https://<host>/v1 \
 *     --model <id> --key-file <path> --out <dir> [--pairs 6] [--paragraphs 700]
 */
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWire, median, cacheFields, prefixParagraph } from './wire.mjs';

const { values: opt } = parseArgs({
  options: {
    'base-url': { type: 'string' }, model: { type: 'string' }, 'key-file': { type: 'string' }, out: { type: 'string' },
    pairs: { type: 'string', default: '6' }, paragraphs: { type: 'string', default: '700' },
  },
});
for (const k of ['base-url', 'model', 'key-file', 'out']) if (!opt[k]) { console.error(`missing --${k}`); process.exit(2); }
const OUT = join(opt.out, `caching-${opt.model.replace(/[^A-Za-z0-9._-]/g, '_')}`);
mkdirSync(OUT, { recursive: true });
const chat = createWire({ base: opt['base-url'].replace(/\/$/, ''), model: opt.model, key: readFileSync(opt['key-file'], 'utf8').trim(), out: OUT, maxTokens: 64 });

const body = Array.from({ length: Number(opt.paragraphs) }, (_, i) => prefixParagraph(i)).join('');

const pairs = [];
let promptTokensSent = 0;
for (let i = 0; i < Number(opt.pairs); i++) {
  const system = `Vorgang ${randomUUID()}\n\n${body}`;
  const messages = [{ role: 'system', content: system }, { role: 'user', content: 'Antworte nur mit dem Wort: ok' }];
  const calls = [];
  for (const label of ['first', 'repeat1', 'repeat2']) {
    const r = await chat(messages, null, `pair${i + 1}-${label}`);
    promptTokensSent += r.usage?.prompt_tokens ?? 0;
    calls.push({ label, ok: r.ok, ttft: r.ttft, promptTokens: r.usage?.prompt_tokens ?? null, usage: r.usage, cacheFields: cacheFields(r.usage) });
    await new Promise(res => setTimeout(res, 800));
  }
  pairs.push(calls);
  console.log(`pair ${i + 1}: first=${Math.round(calls[0].ttft)}ms repeats=${Math.round(calls[1].ttft)},${Math.round(calls[2].ttft)}ms prompt_tokens=${calls[0].promptTokens}`);
}

// A pair with a failed call (non-200, no first token) says nothing about caching and is
// left out — `Math.min(null, x)` is 0 and would count it as a fast repeat.
const valid = pairs.filter(p => p.every(c => c.ok && typeof c.ttft === 'number'));
const firsts = valid.map(p => p[0].ttft);
const repeats = valid.flatMap(p => [p[1].ttft, p[2].ttft]);
const fasterPairs = valid.filter(p => Math.min(p[1].ttft, p[2].ttft) < p[0].ttft).length;
const technicallyCached = valid.length >= 2 && median(repeats) <= 0.5 * median(firsts) && fasterPairs >= valid.length - 1;
const reportedInUsage = pairs.some(p => p.some(c => Object.values(c.cacheFields).some(v => typeof v === 'number' && v > 0)));
const report = {
  model: opt.model, at: new Date().toISOString(),
  medianFirstMs: median(firsts), medianRepeatMs: median(repeats), fasterPairs, pairs: pairs.length, validPairs: valid.length,
  technicallyCached, reportedInUsage, promptTokensSent,
  rawUsageExample: pairs[0]?.[1]?.usage ?? null,
  detail: pairs,
};
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 1));
console.log(`technically cached: ${technicallyCached} (median first ${Math.round(report.medianFirstMs)}ms, repeats ${Math.round(report.medianRepeatMs)}ms, ${fasterPairs}/${valid.length} valid pairs faster)`);
console.log(`reported in usage: ${reportedInUsage}; prompt tokens sent: ${promptTokensSent}`);
