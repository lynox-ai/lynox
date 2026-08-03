#!/usr/bin/env node
/**
 * Capture fitness — does the model record a durable fact when one is present?
 *
 * WHY THIS EXISTS. `DEF-dk-capture-observability` measured a 1/29 fire rate on the canary and
 * read it as "capture is dead". It could not be: its denominator counts every turn that ended,
 * so it cannot tell "capture is broken" from "most turns have nothing to record". This runner
 * fixes the denominator by LABELLING the opportunity — each case declares whether a durable
 * fact is present — so the number means something.
 *
 * WHY IT DRIVES A LIVE ENGINE rather than assembling an Agent itself: a hand-built harness
 * assembles the prompt and tool set differently from the product, and then measures its own
 * assembly. The whole finding this runner exists to check is model-vs-surface, so the surface
 * has to be the real one (see `fb_realworld_harness`).
 *
 * PROVIDER IS THE POINT. Switch the engine's config between runs; the result is a per-shape
 * capture rate per model. A model that fires only on S1-dictated captures nothing in practice —
 * operators do not say "for the record".
 *
 * Usage:
 *   1. Start an engine on a SCRATCH data dir (never ~/.lynox):
 *        LYNOX_DATA_DIR=/tmp/scratch LYNOX_DURABLE_MEMORY_ENABLED=true LYNOX_HTTP_PORT=3199 \
 *          node --import tsx src/index.ts --http-api
 *   2. node tests/eval/capture-fitness-runner.mjs --data-dir /tmp/scratch --label "mistral-medium-2604"
 *
 * Reads the outcome from the engine's OWN capture-telemetry sink, not from the SSE stream: the
 * sink is what production reports, so the eval and the field metric are the same number.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []),
);
const DATA_DIR = args['data-dir'];
const LABEL = args['label'] ?? 'unlabelled';
const BASE = args['base'] ?? 'http://127.0.0.1:3199';
const REPEATS = Number(args['repeats'] ?? 1);
if (!DATA_DIR) { console.error('need --data-dir (the engine\'s LYNOX_DATA_DIR)'); process.exit(2); }

const fx = JSON.parse(readFileSync(join(HERE, 'capture-fitness-fixtures.json'), 'utf8'));
const SOURCE = join(DATA_DIR, fx.sourceFile);
if (!existsSync(SOURCE)) {
  writeFileSync(SOURCE,
    'Branchenticker 14. Juli — Wettbewerber Nordwind AG hat Version 5.2 veroeffentlicht.\n' +
    'Laut Mitteilung wurde die Preisliste zum 1. August angehoben. Analysten erwarten\n' +
    'weitere Konsolidierung im Markt. Quelle: fiktives Branchenportal.\n');
}

const sinkPath = join(DATA_DIR, 'capture-telemetry.jsonl');
const sinkLines = () => (existsSync(sinkPath) ? readFileSync(sinkPath, 'utf8').trim().split('\n').filter(Boolean) : []);

async function runOne(text) {
  const before = sinkLines().length;
  const s = await fetch(`${BASE}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }).then(r => r.json());
  const res = await fetch(`${BASE}/api/sessions/${s.sessionId}/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: text }),
  });
  // Drain the SSE stream so the turn completes before we read the sink.
  const reader = res.body.getReader();
  for (;;) { const { done } = await reader.read(); if (done) break; }
  await new Promise(r => setTimeout(r, 1200));   // the sink append is fire-and-forget
  const fresh = sinkLines().slice(before).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return {
    eligible: fresh.some(e => e.event === 'capture_eligible'),
    remembered: fresh.some(e => e.event === 'remember_invoked'),
  };
}

const rows = [];
for (const shape of fx.shapes) {
  for (let rep = 0; rep < REPEATS; rep++) {
    for (const [i, tpl] of shape.cases.entries()) {
      const text = tpl.replaceAll('{FILE}', SOURCE);
      let r;
      try { r = await runOne(text); } catch (e) { r = { error: String(e).slice(0, 80) }; }
      const ok = r.error ? null : (shape.expect === 'capture' ? r.remembered : !r.remembered);
      rows.push({ shape: shape.id, case: i, expect: shape.expect, ...r, ok });
      process.stdout.write(`  ${shape.id} #${i}${REPEATS > 1 ? `.${rep}` : ''}  ${r.error ? 'ERR ' + r.error : (ok ? 'OK ' : 'MISS') + (r.remembered ? ' (remembered)' : ' (silent)')}\n`);
    }
  }
}

console.log(`\n=== capture fitness · ${LABEL} ===`);
let capT = 0, capH = 0, negT = 0, negOk = 0;
for (const shape of fx.shapes) {
  const mine = rows.filter(r => r.shape === shape.id && r.error === undefined);
  const hit = mine.filter(r => r.ok).length;
  if (shape.expect === 'capture') { capT += mine.length; capH += hit; } else { negT += mine.length; negOk += hit; }
  console.log(`  ${shape.id.padEnd(18)} ${String(hit).padStart(2)}/${mine.length}  (${shape.expect})`);
}
console.log(`  ${'—'.repeat(34)}`);
console.log(`  capture on opportunity   ${capH}/${capT}`);
console.log(`  silence on non-opportunity ${negOk}/${negT}`);
console.log('\n  n per cell is small by design — this is a FITNESS signal, not a rate.');
console.log('  Quote it as "x of y cases", never as a percentage.');
