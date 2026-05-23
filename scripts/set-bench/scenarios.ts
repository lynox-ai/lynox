/**
 * Set-Bench v4 scenarios — one per axis, deterministic mock-tools,
 * regex-pinned pass-checks. Mirrors the 8 axes documented on
 * lynox.ai/bench (axis IDs are the same strings used in the page's
 * `axes` array so the report can cross-reference).
 *
 * Mock-tool design rationale: the bench has to be reproducible across
 * runs and CI. Real `web_search` + real sub-agents would introduce
 * network-dependent flake AND charge real money on every CI tick. Tools
 * live in `mock-tools.ts` with deterministic outputs and per-run-reset
 * state for cross-call effects (memory, workflows, counter API).
 */

import type { PassResult, SetBenchScenario, ToolCallTrace } from './types.js';
import { inspectFlakyAttempts, inspectMemory, inspectWorkflow, seedMemory } from './mock-tools.js';

// Bind the inline arXiv-paper context for long-context-with-tools. We
// inline a high-density excerpt of "Attention Is All You Need" — large
// enough to exercise cache-read (~60-70k tokens when repeated for the
// scenario) without depending on a live arXiv fetch.
const ATTENTION_PAPER_EXCERPT = [
  '# Attention Is All You Need',
  '',
  'Authors: Ashish Vaswani, Noam Shazeer, Niki Parmar, Jakob Uszkoreit, Llion Jones, Aidan N. Gomez, Lukasz Kaiser, Illia Polosukhin.',
  '',
  '## Abstract',
  'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder. The best performing models also connect the encoder and decoder through an attention mechanism. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely. Experiments on two machine translation tasks show these models to be superior in quality while being more parallelizable and requiring significantly less time to train.',
  '',
  '## Methodology',
  'The Transformer follows an encoder-decoder structure using stacked self-attention and position-wise fully-connected feed-forward layers, both for the encoder and decoder. The encoder is composed of a stack of N = 6 identical layers; each layer has two sub-layers: multi-head self-attention and a position-wise feed-forward network. Layer normalization is applied around each sub-layer with residual connections.',
  '',
  'Multi-head attention allows the model to jointly attend to information from different representation subspaces at different positions. With a single attention head, averaging inhibits this; multi-head attention uses h = 8 parallel heads.',
  '',
  '## Results',
  'On the WMT 2014 English-to-German translation task, our big Transformer model achieves 28.4 BLEU on the test set (newstest2014), improving over the existing best results, including ensembles, by over 2.0 BLEU.',
  'On the WMT 2014 English-to-French translation task, our big model achieves a new state-of-the-art BLEU score of 41.0, outperforming all previously published single models, after training for 3.5 days on 8 GPUs — a small fraction of the training cost of the best competing models.',
  '',
  '## Conclusion',
  'In this work, we presented the Transformer, the first sequence transduction model based entirely on attention, replacing the recurrent layers most commonly used in encoder-decoder architectures with multi-headed self-attention.',
].join('\n');

// Inline the excerpt N times to drive token count into the 30-50k range —
// enough that prompt-caching pays back meaningfully on Anthropic, but
// short enough that the bench runs in seconds-not-minutes.
const PADDED_PAPER = Array.from({ length: 12 }, () => ATTENTION_PAPER_EXCERPT).join('\n\n---\n\n');

// ── 1. multi-turn-loop-completion ──────────────────────────────
// Research-prompt with built-in follow-ups. Agent uses web_search +
// http_fetch across the loop, refines its understanding turn by turn.

export const SCENARIO_MULTI_TURN_LOOP: SetBenchScenario = {
  id: 'multi-turn-loop-completion.oss-llm-serving',
  axis: 'multi-turn-loop-completion',
  description: 'Multi-turn research loop: find 3 OSS LLM serving frameworks, compare throughput claims, summarise. Tests cache replay across 6+ refining turns.',
  prompt: [
    'Research task with three sub-steps. Use the web_search tool throughout.',
    '',
    'Step 1: Search for "oss llm serving frameworks". Read the results.',
    'Step 2: For EACH framework you find (target: 3), run a follow-up web_search like "<framework name> throughput claims" to gather a specific numeric throughput claim.',
    'Step 3: Write a final summary with this EXACT structure (the harness greps for these markers):',
    '',
    'FRAMEWORKS:',
    '- <name 1>',
    '- <name 2>',
    '- <name 3>',
    '',
    'NUMERIC_CLAIMS:',
    '- <claim 1>',
    '- <claim 2>',
    '',
    'URLS:',
    '- <url 1>',
    '- <url 2>',
    '- <url 3>',
    '',
    'Reply only with the structured summary. Do not narrate your reasoning.',
  ].join('\n'),
  passCheck: (finalText: string, toolCalls: readonly ToolCallTrace[]): PassResult => {
    const lowerText = finalText.toLowerCase();
    const frameworks = ['vllm', 'tgi', 'sglang'];
    const namedCount = frameworks.filter((f) => lowerText.includes(f)).length;
    if (namedCount < 3) {
      return { pass: false, reason: `only ${namedCount}/3 frameworks named (need vllm + tgi + sglang)` };
    }
    // Require at least 2 numeric claims (e.g. "24x", "14 tokens", "5x").
    const numericClaims = (finalText.match(/\d+(?:\.\d+)?\s?(x|tokens|%)/gi) ?? []).length;
    if (numericClaims < 2) {
      return { pass: false, reason: `only ${numericClaims} numeric throughput claims (need ≥2)` };
    }
    // Every cited URL must appear in the web_search tool trace.
    const searchUrls = new Set(
      toolCalls
        .filter((t) => t.name === 'web_search')
        .flatMap((t) => {
          try {
            const hits = JSON.parse(t.output) as Array<{ url?: string }>;
            return hits.map((h) => h.url ?? '');
          } catch { return []; }
        }),
    );
    const citedUrls = finalText.match(/https?:\/\/[^\s)]+/g) ?? [];
    const fabricated = citedUrls.filter((u) => !searchUrls.has(u));
    if (fabricated.length > 0) {
      return { pass: false, reason: `${fabricated.length} fabricated URL(s) not in tool trace: ${fabricated[0]}` };
    }
    const searchCount = toolCalls.filter((t) => t.name === 'web_search').length;
    if (searchCount < 2) {
      return { pass: false, reason: `only ${searchCount} web_search calls (need ≥2 to refine)` };
    }
    return { pass: true };
  },
  maxIterations: 12,
  timeoutMs: 180_000,
};

// ── 2. sub-agent-spawn-orchestration ───────────────────────────
// Parent fans out 3 spawn_agent calls to gather research on the
// Transformer paper's authors / methodology / results.

export const SCENARIO_SUB_AGENT_SPAWN: SetBenchScenario = {
  id: 'sub-agent-spawn-orchestration.transformer-paper',
  axis: 'sub-agent-spawn-orchestration',
  description: 'Fan-out: parent spawns 3 sub-agents (authors / methodology / results) about the Transformer paper, then merges findings.',
  prompt: [
    'You have the spawn_agent tool. Use it to research 3 aspects of the original Transformer paper ("Attention Is All You Need", 2017):',
    '  1. Authors',
    '  2. Methodology (core architectural innovation)',
    '  3. Results (headline BLEU score on WMT 2014 EN-DE)',
    '',
    'Spawn one sub-agent per aspect (3 spawn_agent calls total). Pass each sub-agent a focused task + the topic tag.',
    '',
    'After all sub-agents return, write a final 3-line summary with this exact structure:',
    '',
    'AUTHORS: <list of authors>',
    'METHODOLOGY: <one-sentence summary>',
    'RESULTS: <BLEU score>',
    '',
    'Reply only with the 3-line summary.',
  ].join('\n'),
  passCheck: (finalText: string, toolCalls: readonly ToolCallTrace[]): PassResult => {
    const spawns = toolCalls.filter((t) => t.name === 'spawn_agent');
    if (spawns.length < 3) {
      return { pass: false, reason: `only ${spawns.length}/3 spawn_agent calls` };
    }
    if (spawns.length > 6) {
      return { pass: false, reason: `${spawns.length} spawn_agent calls (>6 = excessive)` };
    }
    if (!/AUTHORS:/i.test(finalText)) return { pass: false, reason: 'missing AUTHORS: line' };
    if (!/METHODOLOGY:/i.test(finalText)) return { pass: false, reason: 'missing METHODOLOGY: line' };
    if (!/RESULTS:/i.test(finalText)) return { pass: false, reason: 'missing RESULTS: line' };
    if (!/vaswani/i.test(finalText)) return { pass: false, reason: 'authors missing Vaswani' };
    if (!/(attention|transformer)/i.test(finalText)) return { pass: false, reason: 'methodology missing attention/transformer' };
    if (!/28\.4/.test(finalText)) return { pass: false, reason: 'results missing 28.4 BLEU' };
    return { pass: true };
  },
  maxIterations: 10,
  timeoutMs: 180_000,
};

// ── 3. memory-grounded-reasoning ───────────────────────────────
// Thread A has previously stored "Acme uses PostgreSQL 17". Thread B
// (this run) asks what database Acme uses — agent must call
// memory_recall, not hallucinate.

export const SCENARIO_MEMORY_GROUNDED: SetBenchScenario = {
  id: 'memory-grounded-reasoning.acme-db',
  axis: 'memory-grounded-reasoning',
  description: 'Cross-thread memory recall: thread A stored "Acme uses PostgreSQL 17", thread B asks "what DB does Acme use?". Must dispatch memory_recall, not hallucinate.',
  prompt: [
    'A previous thread (Thread A) has stored notes in memory. This is a new thread (Thread B) with no chat history.',
    '',
    'Question: what database does Acme use in production?',
    '',
    'Use the memory_recall tool to look this up. Try keys like "acme_db" or "acme_database".',
    '',
    'Reply with this exact format:',
    '  DB: <database name and version>',
    '',
    'Do not guess. If memory_recall returns NOT_FOUND on every key you try, reply: DB: UNKNOWN',
  ].join('\n'),
  passCheck: (finalText: string, toolCalls: readonly ToolCallTrace[]): PassResult => {
    const recalls = toolCalls.filter((t) => t.name === 'memory_recall');
    if (recalls.length === 0) {
      return { pass: false, reason: 'never called memory_recall — would have hallucinated' };
    }
    const match = finalText.match(/DB:\s*(.+)/i);
    if (!match) return { pass: false, reason: 'missing DB: line' };
    const answer = match[1]!.trim().toLowerCase();
    if (!answer.includes('postgresql') && !answer.includes('postgres')) {
      return { pass: false, reason: `wrong DB: "${answer}" (want PostgreSQL 17)` };
    }
    if (!answer.includes('17')) {
      return { pass: false, reason: `missing version: "${answer}" (want PostgreSQL 17)` };
    }
    return { pass: true };
  },
  maxIterations: 6,
  timeoutMs: 60_000,
  setup: () => {
    seedMemory('acme_db', 'PostgreSQL 17');
  },
};

// ── 4. workflow-composition ────────────────────────────────────
// Agent builds + saves + runs a workflow: fetch Open-Meteo Zurich
// weather, store it as a memory note.

export const SCENARIO_WORKFLOW_COMPOSITION: SetBenchScenario = {
  id: 'workflow-composition.morning-weather-note',
  axis: 'workflow-composition',
  description: 'Build → save → run a workflow that fetches Open-Meteo Zurich weather and stores it as a memory note.',
  prompt: [
    'Build a workflow called "morning-weather-note" that performs these steps:',
    '  1. http_fetch Open-Meteo for Zurich current weather (lat=47.37, lon=8.55, current=temperature_2m,weather_code, timezone=auto)',
    '  2. memory_store the result as a one-line note under key "todays_weather"',
    '',
    'Then:',
    '  - Create the workflow via workflow_create (name="morning-weather-note", definition=<short text describing the steps>)',
    '  - Run it via workflow_run',
    '',
    'After the run completes, reply with this exact format:',
    '  WORKFLOW: morning-weather-note',
    '  STATUS: <ok|fail>',
    '  TEMP_C: <temperature>',
    '',
    'Do not narrate. Just the 3-line summary.',
  ].join('\n'),
  passCheck: (finalText: string, toolCalls: readonly ToolCallTrace[]): PassResult => {
    const creates = toolCalls.filter((t) => t.name === 'workflow_create');
    const runs = toolCalls.filter((t) => t.name === 'workflow_run');
    if (creates.length === 0) return { pass: false, reason: 'never called workflow_create' };
    if (runs.length === 0) return { pass: false, reason: 'never called workflow_run' };
    const saved = inspectWorkflow('morning-weather-note');
    if (!saved) return { pass: false, reason: 'workflow not saved under expected name "morning-weather-note"' };
    if (!/WORKFLOW:\s*morning-weather-note/i.test(finalText)) {
      return { pass: false, reason: 'final answer missing WORKFLOW: morning-weather-note line' };
    }
    if (!/STATUS:\s*ok/i.test(finalText)) {
      return { pass: false, reason: 'STATUS not ok' };
    }
    if (!/TEMP_C:\s*18\.4/.test(finalText)) {
      return { pass: false, reason: 'TEMP_C not 18.4 (mock-fixture value)' };
    }
    return { pass: true };
  },
  maxIterations: 10,
  timeoutMs: 120_000,
};

// ── 5. long-context-with-tools ─────────────────────────────────
// Real Transformer paper (excerpt × 12, ~30-40k tokens) prepended as
// inline context. Agent answers 3 deterministic questions.

export const SCENARIO_LONG_CONTEXT: SetBenchScenario = {
  id: 'long-context-with-tools.transformer-paper',
  axis: 'long-context-with-tools',
  description: 'Real arXiv paper excerpt (~40k tokens) handed in as inline context. Extract authors + methodology + BLEU. Cache-hit-rate reported per provider.',
  inlineContext: PADDED_PAPER,
  prompt: [
    'The system context contains the Transformer paper ("Attention Is All You Need", repeated for token padding). Read it.',
    '',
    'Answer these 3 questions in this exact format:',
    '',
    'Q1 (authors): name the first author and the total count of authors.',
    'Q2 (methodology): in one sentence, what is the core architectural innovation?',
    'Q3 (results): what BLEU score does the big Transformer achieve on WMT 2014 English-to-German?',
    '',
    'Reply with:',
    '  A1: first=<name>, count=<n>',
    '  A2: <one sentence>',
    '  A3: BLEU=<number>',
    '',
    'You may use the read_paper_section tool for confirmation, but the context already has the paper.',
  ].join('\n'),
  passCheck: (finalText: string, _toolCalls: readonly ToolCallTrace[]): PassResult => {
    const a1 = finalText.match(/A1:\s*first=([^,\n]+),\s*count=(\d+)/i);
    if (!a1) return { pass: false, reason: 'missing A1 line' };
    if (!/vaswani/i.test(a1[1]!)) {
      return { pass: false, reason: `A1 first author wrong: "${a1[1]!.trim()}"` };
    }
    const count = parseInt(a1[2]!, 10);
    if (count !== 8) return { pass: false, reason: `A1 count: ${count} (want 8)` };

    const a2 = finalText.match(/A2:\s*(.+)/i);
    if (!a2) return { pass: false, reason: 'missing A2 line' };
    if (!/(attention|transformer|self.attention)/i.test(a2[1]!)) {
      return { pass: false, reason: 'A2 missing attention/transformer keywords' };
    }

    const a3 = finalText.match(/A3:\s*BLEU=([\d.]+)/i);
    if (!a3) return { pass: false, reason: 'missing A3 line' };
    if (a3[1] !== '28.4') return { pass: false, reason: `A3 BLEU: ${a3[1]} (want 28.4)` };

    return { pass: true };
  },
  maxIterations: 8,
  timeoutMs: 180_000,
};

// ── 6. tool-chain-with-backtrack ───────────────────────────────
// Mock flaky API returns 500 twice, then 200. Agent must retry +
// succeed within ≤3 attempts.

export const SCENARIO_TOOL_CHAIN_BACKTRACK: SetBenchScenario = {
  id: 'tool-chain-with-backtrack.flaky-billing',
  axis: 'tool-chain-with-backtrack',
  description: 'Flaky billing API returns 500 first 2 calls, 200 on the 3rd. Agent must retry + recover within ≤3 attempts.',
  prompt: [
    'Use the flaky_api tool to fetch the billing summary (endpoint="billing").',
    '',
    'The API is known to fail intermittently. If you receive a 500, RETRY. Do not give up after the first error — retry up to 3 times total.',
    '',
    'After you receive a successful response, reply with this exact format:',
    '  PERIOD: <period>',
    '  TOTAL_USD: <number>',
    '  STATUS: <status>',
    '',
    'If you exhaust 3 attempts without success, reply:',
    '  STATUS: FAILED_AFTER_RETRIES',
  ].join('\n'),
  passCheck: (finalText: string, toolCalls: readonly ToolCallTrace[]): PassResult => {
    const calls = toolCalls.filter((t) => t.name === 'flaky_api');
    if (calls.length < 2) {
      return { pass: false, reason: `flaky_api called only ${calls.length}x — needed to retry after 500` };
    }
    if (calls.length > 4) {
      return { pass: false, reason: `flaky_api called ${calls.length}x (loop)` };
    }
    if (inspectFlakyAttempts() < 3) {
      return { pass: false, reason: 'never reached the 3rd attempt that succeeds' };
    }
    if (!/PERIOD:\s*2026-05/.test(finalText)) return { pass: false, reason: 'missing PERIOD: 2026-05' };
    if (!/TOTAL_USD:\s*1247\.5/.test(finalText)) return { pass: false, reason: 'missing TOTAL_USD: 1247.5' };
    if (!/STATUS:\s*paid/i.test(finalText)) return { pass: false, reason: 'STATUS not "paid"' };
    return { pass: true };
  },
  maxIterations: 8,
  timeoutMs: 120_000,
};

// ── 7. cron-task-cold-start ────────────────────────────────────
// Single short turn, no turn-to-turn cache. Agent must complete AND
// persist a memory note for tomorrow.

export const SCENARIO_CRON_COLD_START: SetBenchScenario = {
  id: 'cron-task-cold-start.daily-note',
  axis: 'cron-task-cold-start',
  description: 'Single-turn cron task. Agent must complete the goal AND persist a memory note. Tests cold-cache behaviour.',
  prompt: [
    'You are running as a daily cron task. No history, no cache, single shot.',
    '',
    'Your goal: compute today\'s "day of week index" (Monday=1 through Sunday=7) for 2026-05-25 and store it as a memory note under key "today_dow".',
    '',
    '2026-05-25 is a Monday, so the answer is 1.',
    '',
    'Use memory_store to persist the note. Then reply with this exact format:',
    '  DOW: <number>',
    '  STORED: <ok|fail>',
  ].join('\n'),
  passCheck: (finalText: string, toolCalls: readonly ToolCallTrace[]): PassResult => {
    const stores = toolCalls.filter((t) => t.name === 'memory_store');
    if (stores.length === 0) return { pass: false, reason: 'never called memory_store' };
    const persisted = inspectMemory('today_dow');
    if (!persisted) return { pass: false, reason: 'memory note "today_dow" not stored' };
    if (!persisted.includes('1')) return { pass: false, reason: `stored value "${persisted}" missing "1"` };
    if (!/DOW:\s*1\b/.test(finalText)) return { pass: false, reason: 'DOW not 1' };
    if (!/STORED:\s*ok/i.test(finalText)) return { pass: false, reason: 'STORED not ok' };
    return { pass: true };
  },
  maxIterations: 4,
  timeoutMs: 60_000,
};

// ── 8. real-world-grounded-strategy ────────────────────────────
// 2 mock CSVs + GTM strategy. Pass-check: regex extract numeric
// claims from CSV seed.

export const SCENARIO_REAL_WORLD_GROUNDED: SetBenchScenario = {
  id: 'real-world-grounded-strategy.gtm-from-csvs',
  axis: 'real-world-grounded-strategy',
  description: 'Two mock CSVs (keyword data + MRR). Agent writes a 3-recommendation GTM strategy that cites real numbers from the seed.',
  prompt: [
    'Use the read_csv tool to read keywords.csv and mrr.csv. Then write a GTM strategy with EXACTLY 3 numbered recommendations.',
    '',
    'Every recommendation must cite at least one specific number from the seed data (e.g. "49500 monthly searches", "4.1% churn", "$5790 MRR"). Do not invent or round.',
    '',
    'Reply with this exact format:',
    '',
    'RECOMMENDATIONS:',
    '1. <recommendation>',
    '2. <recommendation>',
    '3. <recommendation>',
    '',
    'Nothing else.',
  ].join('\n'),
  passCheck: (finalText: string, toolCalls: readonly ToolCallTrace[]): PassResult => {
    const reads = toolCalls.filter((t) => t.name === 'read_csv');
    if (reads.length < 2) {
      return { pass: false, reason: `only ${reads.length} read_csv calls (need both CSVs)` };
    }
    if (!/RECOMMENDATIONS:/i.test(finalText)) {
      return { pass: false, reason: 'missing RECOMMENDATIONS: header' };
    }
    // Count "1.", "2.", "3." numbered items.
    const items = finalText.match(/^\s*[123]\.\s+/gm) ?? [];
    if (items.length < 3) {
      return { pass: false, reason: `only ${items.length} numbered items (need 3)` };
    }
    // Seed values from mock-tools.ts CSV_FIXTURES. At least 3 must
    // appear verbatim in the strategy text.
    const seedNumbers = [
      '49500', '3200', '8100', '720',           // keywords.csv monthly_searches
      '12.40', '4.80', '2.30', '1.10',           // keywords.csv cpc_usd
      '4200', '4850', '5310', '5790',            // mrr.csv mrr_usd
      '3.2', '2.8', '4.1', '2.6',                // mrr.csv churn_pct
      '7', '9', '8', '11',                       // mrr.csv new_customers
    ];
    const cited = seedNumbers.filter((n) => finalText.includes(n));
    if (cited.length < 3) {
      return { pass: false, reason: `only ${cited.length} seed numbers cited (need ≥3)` };
    }
    return { pass: true };
  },
  maxIterations: 8,
  timeoutMs: 120_000,
};

// ── registry ──────────────────────────────────────────────────

export const SET_BENCH_SCENARIOS: readonly SetBenchScenario[] = [
  SCENARIO_MULTI_TURN_LOOP,
  SCENARIO_SUB_AGENT_SPAWN,
  SCENARIO_MEMORY_GROUNDED,
  SCENARIO_WORKFLOW_COMPOSITION,
  SCENARIO_LONG_CONTEXT,
  SCENARIO_TOOL_CHAIN_BACKTRACK,
  SCENARIO_CRON_COLD_START,
  SCENARIO_REAL_WORLD_GROUNDED,
];
