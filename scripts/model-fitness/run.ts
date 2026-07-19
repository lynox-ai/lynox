/**
 * lynox model-fitness runner (v1, cheap).
 *
 *   MISTRAL_API_KEY=… ANTHROPIC_API_KEY=… npx tsx scripts/model-fitness/run.ts [--repeats N] [--only <capId,…>] [--candidate <label-substr>] [--scenarios]
 *
 * Runs the capability suite (capabilities.ts) across the candidate models
 * (models.ts) and prints a FITNESS MATRIX (capability × model → pass-rate) plus
 * a per-tier "which model does which job" read. Only candidates whose provider
 * key is present are run. Deterministic assertions; NO LLM judge in v1.
 *
 * `--scenarios` swaps the cheap single-capability probes for the MULTI-STEP
 * scenario substrate (scenarios.ts — τ-bench triad: task + simulated user +
 * state assertion). Costlier (each case is a full tool-loop + maybe a sim-user
 * turn), so it's an explicit opt-in, not part of the default pass.
 *
 * Cost: ~ (#capabilities × #candidates × repeats) short calls. Default repeats=2
 * over the 7 candidates × 11 caps ≈ 150 calls ≈ a few cents. Use --candidate to
 * re-run one model cheaply. --scenarios runs heavier; pair it with --repeats 1.
 */
import { Agent } from '../../src/core/agent.js';
import { initLLMProvider } from '../../src/core/llm-client.js';
import { createToolContext } from '../../src/core/tool-context.js';
import { ALL_CANDIDATES, contextWindowOf, costOf, MIN_CONTEXT_WINDOW } from './models.js';
import { CAPABILITIES } from './capabilities.js';
import { SCENARIOS } from './scenarios.js';
import type { Candidate, Capability, CaseResult, MakeAgent, MatrixCell, Tier } from './types.js';

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
}

const REPEATS = Math.max(1, parseInt(arg('--repeats', '2'), 10) || 2);
const ONLY = arg('--only', '').split(',').map((s) => s.trim()).filter(Boolean);
const CANDIDATE = arg('--candidate', '').toLowerCase(); // label substring, for cheap targeted re-runs
const PROVIDER = arg('--provider', '').toLowerCase(); // 'anthropic' | 'openai' — chunk a run by provider to dodge the duration KILL (Mistral 429-backoffs + judge latency compound over a full 8-candidate run)
const SCENARIO_MODE = process.argv.includes('--scenarios');
const SUITE = SCENARIO_MODE ? SCENARIOS : CAPABILITIES;

/** Run a case, retrying ONLY on a rate-limit (429) with exponential backoff —
 *  Mistral's tier limits are shallow (fb_mistral_stable_tag), and a 429 is an
 *  infra artifact, NOT a capability failure; without this it pollutes the matrix
 *  (a rate-limited model reads as unfit). Real errors still surface immediately. */
async function runWithRetry(cap: Capability, make: MakeAgent): Promise<CaseResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try { return await cap.run(make); }
    catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!/429|rate.?limit|too many requests/i.test(msg)) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); // 1s, 2s, 4s, 8s
    }
  }
  throw lastErr;
}

function keyFor(c: Candidate): string | undefined {
  const env = c.keyEnv ?? (c.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'MISTRAL_API_KEY');
  return process.env[env];
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
    promptUser: opts.promptUser ?? (async () => 'ok'),
    promptSecret: async () => 'canceled' as const,
  });
}

async function main(): Promise<void> {
  const caps = ONLY.length ? SUITE.filter((c) => ONLY.includes(c.id)) : SUITE;
  const candidates = ALL_CANDIDATES.filter((c) => {
    if (CANDIDATE && !c.label.toLowerCase().includes(CANDIDATE)) return false;
    if (PROVIDER && c.provider !== PROVIDER) return false;
    if (!keyFor(c)) { process.stderr.write(`skip ${c.label} — no ${c.keyEnv ?? (c.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'MISTRAL_API_KEY')}\n`); return false; }
    return true;
  });
  if (!candidates.length) { process.stderr.write('No candidates runnable (missing keys).\n'); process.exit(1); }

  const providersInit = new Set<string>();
  // The multi-step scenarios drive their simulated user through a fixed Haiku
  // (Anthropic) call — so a MISTRAL candidate's scenario still needs the
  // Anthropic provider initialised, not just its own. Init it up front in
  // scenario mode whenever the key is present (harmless if unused).
  if (SCENARIO_MODE && process.env['ANTHROPIC_API_KEY']) { await initLLMProvider('anthropic'); providersInit.add('anthropic'); }
  const cells: MatrixCell[] = [];

  for (const cand of candidates) {
    const apiKey = keyFor(cand)!;
    if (!providersInit.has(cand.provider)) { await initLLMProvider(cand.provider); providersInit.add(cand.provider); }
    const make = makeAgentFactory(cand, apiKey);
    for (const cap of caps) {
      let passes = 0, errors = 0, lastNote: string | undefined;
      for (let r = 0; r < REPEATS; r++) {
        try {
          const res = await runWithRetry(cap, make);
          if (res.pass) passes++;
          lastNote = res.note;
          process.stdout.write(res.pass ? '✓' : '·');
        } catch (e) {
          errors++;
          lastNote = e instanceof Error ? e.message.slice(0, 60) : 'error';
          process.stdout.write('E');
        }
      }
      cells.push({ capabilityId: cap.id, candidateId: cand.id, passes, runs: REPEATS, errors, ...(lastNote !== undefined ? { lastNote } : {}) });
    }
    process.stdout.write(` ${cand.label}\n`);
  }

  // ── Fitness matrix ──
  const pad = (s: string, n: number) => s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
  const rate = (c: MatrixCell) => `${c.passes}/${c.runs}${c.errors ? `!${c.errors}` : ''}`;
  console.log('\n\n## lynox model-fitness matrix (v1)  ·  ' + (SCENARIO_MODE ? 'MULTI-STEP scenarios' : 'capability probes') + '  ·  repeats=' + REPEATS);
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

  // ── Structural gate: context window (free, no API — read from the registry) ──
  const ctxFit = (id: string): boolean => (contextWindowOf(id) ?? 0) >= MIN_CONTEXT_WINDOW;
  console.log(`\n## Context-window gate (≥ ${(MIN_CONTEXT_WINDOW / 1000)}k — lynox large-context jobs; tool results are 74-96% of context)`);
  for (const cand of candidates) {
    const cw = contextWindowOf(cand.id);
    const k = cw === undefined ? '??' : `${Math.round(cw / 1000)}k`;
    console.log(`  ${pad(cand.label, 16)} ${pad(k, 8)} ${ctxFit(cand.id) ? '✓' : '✗ UNFIT (< floor)'}`);
  }

  // ── Composition grid: which models are FIT for each tier's gates (EVERY
  //    context-clearing candidate is judged against EVERY tier, so any model set
  //    can be read off — a `*` marks the model whose proposed/current role IS
  //    this tier). Fitness is a floor, not a ranking: cost + output quality
  //    (which the deterministic asserts can't see) still pick among the fit. ──
  console.log('\n## Tier fitness grid (FIT = clears the context gate AND passes every capability gating that tier)');
  console.log('   The harness measures the FIT FLOOR + cost + context; it does NOT rank output QUALITY (deterministic');
  console.log('   asserts are blind to it) — use an LLM-judge (deferred) or the public leaderboards to pick among the fit.');
  console.log('   Per-tier priority (how to weigh the fit set): fast = cheap+fast · balanced = QUALITY then cost (main chat) · deep = QUALITY, cost-tolerant.');
  const tiers: Tier[] = ['fast', 'balanced', 'deep'];
  const PRIORITY: Record<Tier, string> = { fast: 'cheap+fast', balanced: 'quality>cost', deep: 'quality' };
  const price = (id: string): number => costOf(id)?.input ?? Infinity;
  for (const tier of tiers) {
    const gating = caps.filter((c) => c.tiers.includes(tier));
    const fit = candidates.filter((cand) => {
      if (!ctxFit(cand.id)) return false; // structural gate first — a small window can't hold the job
      return gating.every((cap) => {
        const cell = cells.find((x) => x.capabilityId === cap.id && x.candidateId === cand.id);
        return cell && cell.passes === cell.runs && cell.errors === 0;
      });
    });
    // Listed cheapest-first as a stable order + a cost signal — NOT a ranking:
    // for balanced/deep, quality (which the asserts can't see) decides among these.
    const ranked = [...fit].sort((a, b) => price(a.id) - price(b.id)).map((f) => {
      const c = costOf(f.id);
      const cw = contextWindowOf(f.id);
      const cost = c ? `$${c.input}/${c.output}` : '$?';
      const k = cw === undefined ? '' : ` ${Math.round(cw / 1000)}k`;
      return `${f.label}${f.tierHint === tier ? '*' : ''} (${cost}${k})`;
    });
    console.log(`  ${pad(`${tier} [${PRIORITY[tier]}]`, 24)} →  FIT: ${ranked.join('  ·  ') || '(none passed all)'}`);
  }

  // JSON for machine consumption / a later report.
  console.log('\n<<JSON>>' + JSON.stringify({ repeats: REPEATS, cells }));
}

main().catch((e) => { process.stderr.write(String(e instanceof Error ? e.stack : e) + '\n'); process.exit(1); });
