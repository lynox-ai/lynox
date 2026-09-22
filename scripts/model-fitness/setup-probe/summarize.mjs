#!/usr/bin/env node
/**
 * summarize — one table per results.jsonl: passes per label and flow, every safety
 * violation listed on its own (never folded into the pass rate), cost, duration, tokens.
 * Instrument errors are counted separately and are not runs of the model.
 *
 *   node scripts/model-fitness/setup-probe/summarize.mjs <out-dir>/results.jsonl [--label <l>] [--json]
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: opt, positionals } = parseArgs({ allowPositionals: true, options: { label: { type: 'string', multiple: true }, json: { type: 'boolean', default: false } } });
if (!positionals[0]) { console.error('usage: summarize.mjs <results.jsonl> [--label <l>]… [--json]'); process.exit(2); }

const rows = readFileSync(positionals[0], 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  .filter(r => !opt.label || opt.label.includes(r.label));

const groups = new Map();
for (const r of rows) {
  const k = `${r.label}\u0000${r.flow}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}

const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const out = [];
for (const [k, rs] of [...groups].sort()) {
  const [label, flow] = k.split('\u0000');
  const runs = rs.filter(r => !r.instrumentError);
  out.push({
    label, flow,
    runs: runs.length,
    pass: runs.filter(r => r.pass).length,
    runsWithSafety: runs.filter(r => r.safety.length > 0).length,
    safety: runs.flatMap(r => r.safety.map(s => `#${r.i}: ${s}`)),
    instrumentErrors: rs.length - runs.length,
    currency: runs[0]?.currency ?? null,
    costTotal: Number(runs.reduce((s, r) => s + r.cost, 0).toFixed(4)),
    costMedian: median(runs.map(r => r.cost)),
    durationMedianS: Math.round((median(runs.map(r => r.durationMs)) ?? 0) / 1000),
    tokensInMedian: median(runs.map(r => r.usage.tokensIn)),
    tokensOutMedian: median(runs.map(r => r.usage.tokensOut)),
    servedModel: runs[0]?.servedModel ?? null,
    image: runs[0]?.image ?? null,
  });
}

if (opt.json) { console.log(JSON.stringify(out, null, 1)); process.exit(0); }
for (const g of out) {
  console.log(`${g.label} · flow ${g.flow}: ${g.pass}/${g.runs} pass · ${g.runsWithSafety} run(s) with a safety violation · ${g.costTotal} ${g.currency} total, median ${g.costMedian} · median ${g.durationMedianS}s · median tokens in ${g.tokensInMedian} / out ${g.tokensOutMedian}${g.instrumentErrors ? ` · ${g.instrumentErrors} instrument error(s)` : ''}`);
  for (const s of g.safety) console.log(`    ! ${s}`);
}
