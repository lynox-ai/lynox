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
// The proactive-deep axis tests the REAL shipped guidance, imported (not copied)
// so tuning the guidance in prompts.ts automatically re-tests here — no drift.
// It also embeds the REAL base system prompt + grounding block, because the axis
// measures instruction-adherence UNDER REALISTIC LOAD: with a short isolated
// preamble every model (even ministral-3b) trivially escalates — the axis
// ceilings and contradicts staging (where ministral-14b stays inline). Burying
// the guidance at the end of the full ~real prompt reproduces the staging
// condition so the discriminator is valid. See main-model-requirements.md.
import { proactiveDeepGuidance, SYSTEM_PROMPT, GROUNDING_PROMPT_BLOCK } from '../../src/core/prompts.js';

// Preamble for the ceiling-free reasoning axes. Unlike the default harness
// preamble (which bans narration to keep structured-output axes clean), this
// REQUIRES step-by-step work — otherwise a strict instruction-follower
// suppresses chain-of-thought and fails arithmetic it could otherwise do,
// confounding capability with narration-obedience. The final-line format is
// still enforced by each scenario's deterministic passCheck.
const REASONING_PREAMBLE = [
  'You are a careful reasoning agent in a benchmark. Think step by step and',
  'show your full intermediate work — do NOT skip steps or answer from',
  'intuition. Accuracy matters far more than brevity. After your reasoning,',
  'end your reply with exactly the single final line the instructions specify.',
].join(' ');

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
    // Strip trailing prose-punctuation so a sentence-ending URL doesn't
    // report as fabricated when it's actually in the tool trace.
    const citedUrls = (finalText.match(/https?:\/\/[^\s)]+/g) ?? [])
      .map((u) => u.replace(/[.,;:!?]+$/, ''));
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
    // Anchored dot + word boundary so "18X4" or "184" don't pass.
    if (!/TEMP_C:\s*18\.4\b/.test(finalText)) {
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
    const bleu = parseFloat(a3[1]!);
    if (!Number.isFinite(bleu) || Math.abs(bleu - 28.4) > 0.01) {
      return { pass: false, reason: `A3 BLEU: ${a3[1]} (want 28.4)` };
    }

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
    // Word-boundary "1" so "11" / "2026-05-25" / "Monday" alone don't pass.
    if (!/\b1\b/.test(persisted)) return { pass: false, reason: `stored value "${persisted}" missing the literal "1"` };
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
    // Require ordered "1.", "2.", "3." headers — not just three [123].
    // (Without ordering, "1.\n1.\n1." would pass since [123] is OR.)
    if (!/^\s*1\.\s+/m.test(finalText)) return { pass: false, reason: 'missing "1." item' };
    if (!/^\s*2\.\s+/m.test(finalText)) return { pass: false, reason: 'missing "2." item' };
    if (!/^\s*3\.\s+/m.test(finalText)) return { pass: false, reason: 'missing "3." item' };
    // Seed values from mock-tools.ts CSV_FIXTURES. Drop single/double-digit
    // tokens (they trivially appear in any prose) — keep only tokens that
    // unambiguously identify the seed (≥3 chars, decimal, or 4+ digit int).
    const seedNumbers = [
      '49500', '3200', '8100', '720',           // keywords.csv monthly_searches
      '12.40', '4.80', '2.30', '1.10',           // keywords.csv cpc_usd
      '4200', '4850', '5310', '5790',            // mrr.csv mrr_usd
      '3.2', '2.8', '4.1', '2.6',                // mrr.csv churn_pct (decimals, distinctive)
    ];
    // Strip thousands-separator commas before matching (the model
    // legitimately writes "49,500 monthly searches" but the seed value
    // is "49500"). Then use a number-boundary regex so "8" doesn't fire
    // on every random "8" in the strategy.
    const cleanText = finalText.replace(/(\d),(\d)/g, '$1$2');
    const cited = seedNumbers.filter((n) => {
      const escaped = n.replace(/\./g, '\\.');
      return new RegExp(`(^|[^\\d.])${escaped}(?![\\d.])`).test(cleanText);
    });
    if (cited.length < 3) {
      return { pass: false, reason: `only ${cited.length} seed numbers cited (need ≥3)` };
    }
    return { pass: true };
  },
  maxIterations: 8,
  timeoutMs: 120_000,
};

// ── 9. hard-deductive-reasoning ────────────────────────────────
// Pure reasoning, NO tools. A 6-runner finishing-order puzzle with 7
// entangled constraints that admit exactly ONE valid ordering
// (A-F-C-B-D-E, hand-verified: every other ordering violates ≥1 clue).
// Weak models slip on the immediately-before chains + the not-first/last
// constraint; deep models hold the whole constraint set. The pass-rate
// spread here is the discriminator the other 8 axes lack.

export const SCENARIO_HARD_DEDUCTIVE: SetBenchScenario = {
  id: 'hard-deductive-reasoning.six-runner-order',
  axis: 'hard-deductive-reasoning',
  description: 'Constraint-satisfaction: deduce the unique finishing order of 6 runners from 7 entangled clues. Verifiable single answer; no tools.',
  prompt: [
    'Logic puzzle. Six runners — A, B, C, D, E, F — finished a race in distinct positions 1st through 6th. Deduce the exact finishing order from these clues:',
    '',
    '  1. F finished immediately before C (F is exactly one place ahead of C).',
    '  2. A finished somewhere before D.',
    '  3. B finished neither first nor last.',
    '  4. E finished last.',
    '  5. D finished immediately after B (D is exactly one place behind B).',
    '  6. A finished first.',
    '  7. C finished somewhere before B.',
    '',
    'Exactly one ordering satisfies all seven clues. Work through it step by step,',
    'then end your reply with EXACTLY one final line in this form (1st place first):',
    '',
    'ORDER: X-X-X-X-X-X',
    '',
    'where each X is a runner letter. The harness greps only that final ORDER line.',
  ].join('\n'),
  passCheck: (finalText: string): PassResult => {
    // LAST match, not first: with chain-of-thought permitted the model may
    // write intermediate "ORDER:" candidates while reasoning; the final line
    // is the answer. Grabbing the first match would catch a discarded guess.
    const matches = [...finalText.matchAll(/ORDER:\s*([A-Fa-f](?:\s*-\s*[A-Fa-f]){5})/g)];
    if (matches.length === 0) return { pass: false, reason: 'no ORDER: X-X-X-X-X-X line found' };
    const normalized = matches[matches.length - 1]![1]!.replace(/\s+/g, '').toUpperCase();
    if (normalized !== 'A-F-C-B-D-E') {
      return { pass: false, reason: `wrong order ${normalized} (correct: A-F-C-B-D-E)` };
    }
    return { pass: true };
  },
  systemPreambleOverride: REASONING_PREAMBLE,
  noTools: true,
  maxIterations: 4,
  timeoutMs: 90_000,
};

// ── 10. multi-hop-quant-chain ──────────────────────────────────
// Pure reasoning, NO tools. A 6-step dependent arithmetic chain where any
// intermediate slip propagates to a wrong final number (hand-verified
// 240 → 160 → 200 → 150 → 132 → 264 → 174). The "25% of the CURRENT total"
// and "double THEN ship" ordering are the trap steps weak models botch.

export const SCENARIO_MULTI_HOP_QUANT: SetBenchScenario = {
  id: 'multi-hop-quant-chain.widget-inventory',
  axis: 'multi-hop-quant-chain',
  description: 'Six-step dependent arithmetic chain with order-sensitive trap steps. Single verifiable integer answer; no tools.',
  prompt: [
    'Inventory word problem. Track the widget count carefully through each step — each step operates on the result of the previous one.',
    '',
    'A workshop starts the week with 240 widgets.',
    '  - Monday: it ships 1/3 of the widgets it has.',
    '  - Tuesday: it produces 40 new widgets, then ships 25% of the total it has at that moment.',
    '  - Wednesday: 18 widgets are found defective and scrapped.',
    '  - Thursday: a partner shipment DOUBLES the current stock, and then the workshop ships exactly 90 widgets.',
    '',
    'How many widgets remain at the end of Thursday? Work through it step by step,',
    'then end your reply with EXACTLY one final line in this form:',
    '',
    'REMAINING: <integer>',
    '',
    'The harness greps only that final REMAINING line.',
  ].join('\n'),
  passCheck: (finalText: string): PassResult => {
    // LAST match, not first: chain-of-thought writes intermediate
    // "Remaining: N" step labels (240 at the start, etc.); the final line is
    // the answer. Grabbing the first match caught the starting value 240 and
    // failed every model that actually showed its work.
    const matches = [...finalText.matchAll(/REMAINING:\s*(-?\d+)/gi)];
    if (matches.length === 0) return { pass: false, reason: 'no REMAINING: <integer> line found' };
    const value = parseInt(matches[matches.length - 1]![1]!, 10);
    if (value !== 174) {
      return { pass: false, reason: `got ${value} (correct: 174)` };
    }
    return { pass: true };
  },
  systemPreambleOverride: REASONING_PREAMBLE,
  noTools: true,
  maxIterations: 4,
  timeoutMs: 90_000,
};

// Preamble for the open-ended judge-scored axes: produce a full analysis
// (no "final line only" ban). Depth/specificity is the thing being measured.
const ANALYSIS_PREAMBLE = [
  'You are an expert analyst answering a hard, open-ended question that has no',
  'single correct answer. Produce a thorough, well-structured analysis.',
  'Specificity, depth, weighing the real trade-offs, and reasoning about',
  'second-order and downstream effects matter far more than length or hedging.',
  'Where a recommendation is asked for, commit to one and justify it.',
].join(' ');

// Stringent, full-range judge rubrics. The generic rubric clusters every
// answer at 4.5–5.0; these force calibration with explicit per-band anchors
// and an instruction to be stingy, so quality actually separates tiers.
const STRATEGY_RUBRIC = [
  'You are a stringent senior strategy evaluator scoring a business analysis 1–5.',
  'BE CALIBRATED AND USE THE FULL RANGE. Reserve 5 for genuinely exceptional',
  'answers; do NOT cluster scores at the top. Judge on: depth (non-obvious',
  'insight vs generic advice), trade-off rigor (weighing real tensions, not',
  'just listing options), second-order reasoning (downstream/dynamic effects),',
  'decisiveness with justification, and whether it identifies what to investigate',
  'first (e.g. the root cause of the churn trend).',
  '',
  'Anchors:',
  '5 = exceptional: sharp non-obvious insight, rigorous trade-off reasoning,',
  '    addresses second-order effects, decisive and well-justified.',
  '4 = strong: solid with real analysis and some depth, minor gaps.',
  '3 = competent but generic: correct-but-surface, lists more than it analyses.',
  '2 = weak: vague, platitudes, misses the key tensions or the runway/churn',
  '    constraint.',
  '1 = poor: irrelevant, shallow, internally inconsistent, or wrong.',
  '',
  'Respond with ONLY a single-line JSON object, no prose, no code fence:',
  '{"score": <1-5 integer>, "reason": "<=20 word rationale>"}',
].join('\n');

const DESIGN_RUBRIC = [
  'You are a stringent principal-engineer evaluator scoring a system-design',
  'answer 1–5. BE CALIBRATED AND USE THE FULL RANGE. Reserve 5 for genuinely',
  'exceptional answers; do NOT cluster at the top. Judge on: correct grasp of',
  'the conflict-resolution trade-offs (CRDT vs OT vs last-write-wins and WHY),',
  'handling of concurrent edits AND deletions (tombstones), causality/ordering,',
  'the storage/bandwidth implications of the chosen approach, and identification',
  'of the real failure modes with concrete mitigations.',
  '',
  'Anchors:',
  '5 = exceptional: correct deep trade-off reasoning, handles deletion/causality',
  '    edge cases, honest about storage/bandwidth cost, names real failure modes.',
  '4 = strong: sound choice with real justification, minor omissions.',
  '3 = competent but generic: names the options but shallow on why / edge cases.',
  '2 = weak: hand-wavy, misses deletions or causality, no cost awareness.',
  '1 = poor: incorrect, irrelevant, or ignores the offline-merge core problem.',
  '',
  'Respond with ONLY a single-line JSON object, no prose, no code fence:',
  '{"score": <1-5 integer>, "reason": "<=20 word rationale>"}',
].join('\n');

// Shared sanity gate for judge-scored axes: a real attempt is non-trivial in
// length. The quality SCORE (not pass/fail) is the discriminator.
// Gate kept deliberately low: it only catches empties / refusals / one-liners.
// A terse-but-present answer should be SCORED by the judge (which penalises
// shallowness), not gate-failed — gate-failing it would drop the quality signal.
const analysisGate = (finalText: string): PassResult =>
  finalText.trim().length >= 120
    ? { pass: true }
    : { pass: false, reason: `answer too short (${finalText.trim().length} chars) — no real attempt` };

// ── 11. deep-strategy-tradeoff (open-ended, judge-scored) ──────

export const SCENARIO_DEEP_STRATEGY: SetBenchScenario = {
  id: 'deep-strategy-tradeoff.saas-churn-runway',
  axis: 'deep-strategy-tradeoff',
  description: 'Open-ended strategy: weigh three growth paths for a churning SaaS under a runway constraint. No single right answer; graded on analytical depth.',
  prompt: [
    'A B2B SaaS company has $45k MRR, 14 months of runway, and a team of 6.',
    'Net revenue churn has crept from 2% to 5% per month over the last two quarters.',
    'Three options are on the table:',
    '',
    '  (A) Move upmarket — pursue larger enterprise accounts with higher ACV and',
    '      lower churn, but a 6–9 month sales cycle and heavy implementation needs.',
    '  (B) Double down on self-serve PLG — cut friction, improve onboarding and',
    '      activation, keep ACV low but scale volume.',
    '  (C) Add a professional-services arm — bespoke implementations for existing',
    '      accounts to reduce churn and lift revenue per account now.',
    '',
    'Analyse the trade-offs given the runway constraint and the churn trend, reason',
    'about the second-order effects of each path, and recommend a concrete course',
    'of action — including what you would investigate FIRST before committing.',
  ].join('\n'),
  passCheck: analysisGate,
  systemPreambleOverride: ANALYSIS_PREAMBLE,
  judgeRubric: STRATEGY_RUBRIC,
  noTools: true,
  maxTokens: 4096,
  maxIterations: 3,
  timeoutMs: 120_000,
};

// ── 12. deep-ambiguous-design (open-ended, judge-scored) ───────

export const SCENARIO_DEEP_DESIGN: SetBenchScenario = {
  id: 'deep-ambiguous-design.offline-first-sync',
  axis: 'deep-ambiguous-design',
  description: 'Open-ended system design: offline-first collaborative note sync. No single right answer; graded on trade-off depth + edge-case handling.',
  prompt: [
    'Design the data model and synchronization strategy for an offline-first,',
    'collaborative note-taking app. Multiple devices edit the same notes while',
    'offline and later reconnect to sync. In your design, address:',
    '',
    '  - The conflict-resolution approach (e.g. CRDT vs operational transform vs',
    '    last-write-wins) and WHY you chose it.',
    '  - How you handle concurrent edits AND concurrent deletions.',
    '  - Causality / ordering of edits across devices.',
    '  - The storage and bandwidth trade-offs of your chosen approach.',
    '  - The main failure modes and how your design handles them.',
  ].join('\n'),
  passCheck: analysisGate,
  systemPreambleOverride: ANALYSIS_PREAMBLE,
  judgeRubric: DESIGN_RUBRIC,
  noTools: true,
  maxTokens: 4096,
  maxIterations: 3,
  timeoutMs: 120_000,
};

// ── 13. proactive-deep-escalation ──────────────────────────────
// Delegation-judgment / instruction-adherence. The model is the balanced main
// chat, gets the REAL proactive-deep guidance in its system prompt + a clearly
// deep-worthy task, and is NOT told to spawn. It passes iff it ACTS on the
// guidance: spawns a `spawn_agent{model:"deep"}` sub-agent (CLEAR path) OR offers
// to run it on the deep tier (BORDERLINE path). Grinding the analysis out inline
// on the balanced model = fail. Measured on staging: mistral-medium escalates,
// ministral-14b stays inline on identical guidance. See main-model requirements.

// Reproduces the staging condition: the REAL base system prompt (which already
// carries the delegation section, grounding, tool guidance, etc. — the "noise"
// the proactive-deep instruction must survive) + the grounding block, with the
// REAL guidance appended LAST, exactly as session.ts assembles it. The full
// prompt does not ban narration, so the BORDERLINE spoken-offer path stays
// observable. deepSlotProvider:'openai' → the cheap "escalate freely" variant
// (the flip we default-gate for cheap deeps). A one-line note names the
// spawn_agent `model` field so the escalation is expressible against the mock
// tool. Length + competing instructions here are the POINT — a compact preamble
// ceilings the axis (see the import note + main-model-requirements.md).
const PROACTIVE_DEEP_PREAMBLE = [
  SYSTEM_PROMPT,
  GROUNDING_PROMPT_BLOCK,
  'Note: your `spawn_agent` tool takes a `model` field — "fast", "balanced", or "deep" — selecting the sub-agent\'s capability tier.',
  proactiveDeepGuidance({ proactiveDeep: true, proactiveDeepAnthropic: false, deepSlotProvider: 'openai' }).trim(),
].join('\n\n');

/**
 * Deterministic pass-check for the proactive-deep axis. PASS iff the model
 * escalated: a `spawn_agent` call carrying `model:"deep"` (CLEAR), or a spoken
 * offer to run it on the deep tier (BORDERLINE). Grinding it out inline = FAIL.
 * Exported so the offline unit test can validate the MEASUREMENT against
 * synthetic traces before any model is ever called.
 */
export function proactiveDeepPassCheck(
  finalText: string,
  toolCalls: readonly ToolCallTrace[],
): PassResult {
  const spawnedDeep = toolCalls.some((t) => {
    if (t.name !== 'spawn_agent') return false;
    const m = (t.input as { model?: unknown } | null)?.model;
    return typeof m === 'string' && /^\s*deep\s*$/i.test(m);
  });
  if (spawnedDeep) return { pass: true, reason: 'CLEAR: spawned a deep sub-agent (model:"deep")' };

  // BORDERLINE: a spoken offer to escalate. Require BOTH a deep-tier mention AND
  // an offer/intent marker (or a turn that ends on a question) so a descriptive
  // mention inside an inline answer does not false-positive.
  const mentionsDeep = /\bdeep[-\s]?(tier|model)\b/i.test(finalText);
  // Precise offer OPENERS — these appear in a spoken offer but not in a
  // declarative inline analysis, so they don't false-positive on a model that
  // merely echoes the guidance's "deep tier" wording while grinding on inline.
  const offersIntent = /\b(want me to|shall i|shall we|should i|would you like|do you want)\b/i.test(finalText);
  const endsOnQuestion = /\?\s*$/.test(finalText.trim());
  if (mentionsDeep && (offersIntent || endsOnQuestion)) {
    return { pass: true, reason: 'BORDERLINE: offered to run it on the deep tier' };
  }
  return { pass: false, reason: 'answered inline — no deep escalation (no spawn, no offer)' };
}

export const SCENARIO_PROACTIVE_DEEP: SetBenchScenario = {
  id: 'proactive-deep-escalation.outbox-vs-kafka',
  axis: 'proactive-deep-escalation',
  description:
    'Instruction-adherence / delegation judgment: with the real proactive-deep guidance in the system prompt and NO spawn instruction, does the main model escalate a clearly deep-worthy analysis (spawn model:"deep" OR offer the deep tier) rather than grind it out inline?',
  prompt: [
    'I need to decide the event-processing backbone for a small product. Give me a rigorous',
    'trade-off analysis of a PostgreSQL outbox with LISTEN/NOTIFY versus a Kafka log — compare',
    'ordering guarantees, exactly-once vs at-least-once, backpressure, failure recovery, and the',
    'operational burden for a 2-person team, then commit to a well-justified recommendation.',
    'This is a hard, multi-step analysis.',
  ].join('\n'),
  passCheck: proactiveDeepPassCheck,
  systemPreambleOverride: PROACTIVE_DEEP_PREAMBLE,
  // Enough loop room for: escalate → mock deep result → final synthesis. The
  // borderline (offer) path ends in a single turn.
  maxIterations: 4,
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
  SCENARIO_HARD_DEDUCTIVE,
  SCENARIO_MULTI_HOP_QUANT,
  SCENARIO_DEEP_STRATEGY,
  SCENARIO_DEEP_DESIGN,
  SCENARIO_PROACTIVE_DEEP,
];
