/**
 * lynox model-fitness runner (v1, cheap).
 *
 *   MISTRAL_API_KEY=… ANTHROPIC_API_KEY=… npx tsx scripts/model-fitness/run.ts [--repeats N] [--only <capId,…>]
 *
 * Runs the capability suite (capabilities.ts) across the candidate models
 * (models.ts) and prints a FITNESS MATRIX (capability × model → pass-rate) plus
 * a per-tier "which model does which job" read. Only candidates whose provider
 * key is present are run. Deterministic assertions; NO LLM judge in v1.
 *
 * Cost: ~ (#capabilities × #candidates × repeats) short calls. Default repeats=2
 * over the 5-model fleet × 5 caps ≈ 50 calls ≈ a few cents.
 */
import { Agent } from '../../src/core/agent.js';
import { initLLMProvider } from '../../src/core/llm-client.js';
import { createToolContext } from '../../src/core/tool-context.js';
import { ALL_CANDIDATES } from './models.js';
import { CAPABILITIES } from './capabilities.js';
import type { Candidate, MakeAgent, MatrixCell, Tier } from './types.js';

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
}

const REPEATS = Math.max(1, parseInt(arg('--repeats', '2'), 10) || 2);
const ONLY = arg('--only', '').split(',').map((s) => s.trim()).filter(Boolean);

function keyFor(c: Candidate): string | undefined {
  return c.provider === 'anthropic' ? process.env['ANTHROPIC_API_KEY'] : process.env['MISTRAL_API_KEY'];
}

function makeAgentFactory(c: Candidate, apiKey: string): MakeAgent {
  return (opts) => new Agent({
    name: opts.name,
    model: c.id,
    provider: c.provider,
    apiKey,
    ...(c.apiBaseURL ? { apiBaseURL: c.apiBaseURL, openaiModelId: c.id } : {}),
    tools: opts.tools,
    maxIterations: opts.maxIterations ?? 3,
    toolContext: createToolContext({}),
    ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
    promptUser: async () => 'ok',
    promptSecret: async () => ({ status: 'canceled' as const }),
  });
}

async function main(): Promise<void> {
  const caps = ONLY.length ? CAPABILITIES.filter((c) => ONLY.includes(c.id)) : CAPABILITIES;
  const candidates = ALL_CANDIDATES.filter((c) => {
    if (!keyFor(c)) { process.stderr.write(`skip ${c.label} — no ${c.provider === 'anthropic' ? 'ANTHROPIC' : 'MISTRAL'}_API_KEY\n`); return false; }
    return true;
  });
  if (!candidates.length) { process.stderr.write('No candidates runnable (missing keys).\n'); process.exit(1); }

  const providersInit = new Set<string>();
  const cells: MatrixCell[] = [];

  for (const cand of candidates) {
    const apiKey = keyFor(cand)!;
    if (!providersInit.has(cand.provider)) { await initLLMProvider(cand.provider); providersInit.add(cand.provider); }
    const make = makeAgentFactory(cand, apiKey);
    for (const cap of caps) {
      let passes = 0, errors = 0, lastNote: string | undefined;
      for (let r = 0; r < REPEATS; r++) {
        try {
          const res = await cap.run(make);
          if (res.pass) passes++;
          lastNote = res.note;
          process.stdout.write(res.pass ? '✓' : '·');
        } catch (e) {
          errors++;
          lastNote = e instanceof Error ? e.message.slice(0, 60) : 'error';
          process.stdout.write('E');
        }
      }
      cells.push({ capabilityId: cap.id, candidateId: cand.id, passes, runs: REPEATS, errors, lastNote });
    }
    process.stdout.write(` ${cand.label}\n`);
  }

  // ── Fitness matrix ──
  const pad = (s: string, n: number) => s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
  const rate = (c: MatrixCell) => `${c.passes}/${c.runs}${c.errors ? `!${c.errors}` : ''}`;
  console.log('\n\n## lynox model-fitness matrix (v1)  ·  repeats=' + REPEATS);
  const header = pad('capability', 34) + candidates.map((c) => pad(c.label, 16)).join('');
  console.log('\n' + header);
  console.log('-'.repeat(header.length));
  for (const cap of caps) {
    let row = pad(cap.id, 34);
    for (const cand of candidates) {
      const cell = cells.find((x) => x.capabilityId === cap.id && x.candidateId === cand.id);
      row += pad(cell ? rate(cell) : '-', 16);
    }
    console.log(row);
  }

  // ── Per-tier "which model does which job" read ──
  console.log('\n## Tier fitness (a model is FIT for a tier only if it passes every capability that gates that tier)');
  const tiers: Tier[] = ['fast', 'balanced', 'deep'];
  for (const tier of tiers) {
    const gating = caps.filter((c) => c.tiers.includes(tier));
    const fit = candidates.filter((cand) => {
      if (cand.tierHint && cand.tierHint !== tier) return false; // only judge a model for its own tier here
      return gating.every((cap) => {
        const cell = cells.find((x) => x.capabilityId === cap.id && x.candidateId === cand.id);
        return cell && cell.passes === cell.runs && cell.errors === 0;
      });
    });
    console.log(`  ${pad(tier, 9)} gated by [${gating.map((g) => g.id).join(', ')}]  →  FIT: ${fit.map((f) => f.label).join(', ') || '(none of its tier passed all)'}`);
  }

  // JSON for machine consumption / a later report.
  console.log('\n<<JSON>>' + JSON.stringify({ repeats: REPEATS, cells }));
}

main().catch((e) => { process.stderr.write(String(e instanceof Error ? e.stack : e) + '\n'); process.exit(1); });
