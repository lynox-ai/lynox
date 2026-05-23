/**
 * Deterministic mock tools for set-bench v4. Each tool returns frozen
 * values so the pass-check regexes are stable across runs. State that
 * lives across multiple tool calls within a single run (memory store,
 * workflow registry, counter-API) lives in the runner — `resetMockState()`
 * is called once before every cell run, so state is per-cell-per-run
 * scoped, not per-process.
 */

import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';

// ── Per-run mutable state ──────────────────────────────────────
// Initialized via `resetMockState()` at the start of every cell run.
// WARNING: this is a module-level singleton. The runner calls `runCell`
// sequentially, so cells never contend for `state`. If runCell is ever
// parallelised (e.g. via `Promise.all`), state will leak across cells
// silently. Move to a per-call context object before that change.

interface MockState {
  /** key → value memory note store, used by memory_store / memory_recall. */
  memory: Map<string, string>;
  /** name → definition workflow store, used by workflow_create / workflow_run. */
  workflows: Map<string, string>;
  /** Counter of mock-API calls for the tool-chain-backtrack scenario. */
  flakyApiAttempts: number;
}

let state: MockState = newMockState();

function newMockState(): MockState {
  return { memory: new Map(), workflows: new Map(), flakyApiAttempts: 0 };
}

export function resetMockState(): void {
  state = newMockState();
}

// ── web_search ─────────────────────────────────────────────────
// Seeded results for the multi-turn-loop-completion axis. The agent
// is prompted to research "3 OSS LLM serving frameworks" and refine
// across turns. Results map specific known queries to deterministic
// hit lists with URLs the agent must cite verbatim.

const WEB_SEARCH_RESULTS: Record<string, readonly { title: string; url: string; snippet: string }[]> = {
  'oss llm serving frameworks': [
    {
      title: 'vLLM — A high-throughput and memory-efficient inference engine for LLMs',
      url: 'https://docs.vllm.ai/en/latest/',
      snippet: 'vLLM is a fast and easy-to-use library for LLM inference. Up to 24x higher throughput than HuggingFace Transformers.',
    },
    {
      title: 'TGI — Text Generation Inference by Hugging Face',
      url: 'https://huggingface.co/docs/text-generation-inference/index',
      snippet: 'Production-ready LLM serving with continuous batching, token streaming, tensor parallelism. ~14 tokens/sec on a single A10G.',
    },
    {
      title: 'SGLang — Structured Generation Language for LLMs',
      url: 'https://docs.sglang.ai/',
      snippet: 'SGLang is a fast serving framework for large language models and vision language models. Reports up to 5x throughput vs vLLM on llama-3 8B.',
    },
  ],
  'vllm throughput claims': [
    {
      title: 'vLLM Benchmarks',
      url: 'https://docs.vllm.ai/en/latest/performance/benchmarks.html',
      snippet: 'vLLM achieves up to 24x higher throughput than HuggingFace Transformers on llama-2-7B at batch size 64.',
    },
  ],
  'tgi throughput claims': [
    {
      title: 'TGI performance docs',
      url: 'https://huggingface.co/docs/text-generation-inference/conceptual/streaming',
      snippet: 'TGI delivers ~14 tokens/sec sustained on a single NVIDIA A10G with continuous batching.',
    },
  ],
  'sglang throughput claims': [
    {
      title: 'SGLang Benchmarks',
      url: 'https://lmsys.org/blog/2024-07-25-sglang-llama3/',
      snippet: 'SGLang reports up to 5x throughput vs vLLM on llama-3 8B with RadixAttention.',
    },
  ],
};

export const WEB_SEARCH_TOOL: BetaTool = {
  name: 'web_search',
  description: 'Search the web. Returns a list of {title, url, snippet} hits. Use lower-case queries; results are seeded for the bench harness so spelling matters.',
  input_schema: {
    type: 'object' as const,
    properties: { query: { type: 'string' as const } },
    required: ['query'],
  },
};

export function handleWebSearch(input: unknown): string {
  if (typeof input !== 'object' || input === null) return 'ERROR: bad input';
  const query = String((input as { query?: unknown }).query ?? '').trim().toLowerCase();
  if (!query) return 'ERROR: query is required';

  // Look for an exact match first, then a substring match against seeded keys.
  const exact = WEB_SEARCH_RESULTS[query];
  if (exact) return JSON.stringify(exact);
  for (const [key, hits] of Object.entries(WEB_SEARCH_RESULTS)) {
    if (query.includes(key) || key.includes(query)) return JSON.stringify(hits);
  }
  return JSON.stringify([]);
}

// ── http_fetch ──────────────────────────────────────────────────
// Generic mock HTTP fetcher. Used by multi-turn-loop scenarios and by
// the workflow-composition axis (Open-Meteo simulation).

const HTTP_FIXTURES: Record<string, string> = {
  'https://api.open-meteo.com/v1/forecast?latitude=47.37&longitude=8.55&current=temperature_2m,weather_code&timezone=auto':
    JSON.stringify({
      latitude: 47.37,
      longitude: 8.55,
      current: {
        time: '2026-05-24T12:00',
        temperature_2m: 18.4,
        weather_code: 3,
      },
      current_units: { temperature_2m: '°C', weather_code: 'wmo code' },
    }),
};

export const HTTP_FETCH_TOOL: BetaTool = {
  name: 'http_fetch',
  description: 'GET a URL. Returns the response body as a string. Use for fetching weather APIs, JSON endpoints, etc.',
  input_schema: {
    type: 'object' as const,
    properties: { url: { type: 'string' as const } },
    required: ['url'],
  },
};

export function handleHttpFetch(input: unknown): string {
  if (typeof input !== 'object' || input === null) return 'ERROR: bad input';
  const url = String((input as { url?: unknown }).url ?? '').trim();
  if (!url) return 'ERROR: url is required';
  const fixture = HTTP_FIXTURES[url];
  if (fixture) return fixture;
  // Fuzzy match on substring — agent may pass query params in different order.
  for (const [key, body] of Object.entries(HTTP_FIXTURES)) {
    const keyHost = key.split('?')[0];
    const urlHost = url.split('?')[0];
    if (keyHost && urlHost && keyHost === urlHost) return body;
  }
  return `ERROR: no fixture for "${url}". Seeded URLs: ${Object.keys(HTTP_FIXTURES).join(', ')}`;
}

// ── spawn_agent ────────────────────────────────────────────────
// Used by sub-agent-spawn-orchestration. Each call returns a canned
// child response based on the task description. The agent has to call
// spawn_agent 3 times to satisfy the pass-check.

const SUB_AGENT_RESPONSES: Record<string, string> = {
  authors: 'The paper "Attention Is All You Need" was authored by Ashish Vaswani, Noam Shazeer, Niki Parmar, Jakob Uszkoreit, Llion Jones, Aidan N. Gomez, Lukasz Kaiser, and Illia Polosukhin (Google Brain / Google Research / U. Toronto, 2017).',
  methodology: 'The paper introduces the Transformer, a sequence-transduction architecture based solely on attention mechanisms — dispensing with recurrence and convolutions entirely. The encoder-decoder structure uses 6 stacked self-attention + position-wise feed-forward layers each.',
  results: 'The Transformer achieves 28.4 BLEU on WMT 2014 English-to-German translation, improving over the previous best ensemble by 2.0 BLEU. On English-to-French, the single-model big-Transformer scores 41.0 BLEU after 3.5 days of training on 8 GPUs.',
};

export const SPAWN_AGENT_TOOL: BetaTool = {
  name: 'spawn_agent',
  description: 'Spawn a sub-agent for a focused research task. Returns the sub-agent\'s final answer. Use this to parallelise research: spawn 3 sub-agents, each handles one sub-question.',
  input_schema: {
    type: 'object' as const,
    properties: {
      task: { type: 'string' as const, description: 'One specific question or task for the sub-agent.' },
      topic: { type: 'string' as const, description: 'Short topic tag (authors / methodology / results).' },
    },
    required: ['task'],
  },
};

export function handleSpawnAgent(input: unknown): string {
  if (typeof input !== 'object' || input === null) return 'ERROR: bad input';
  const o = input as { task?: unknown; topic?: unknown };
  const task = String(o.task ?? '').toLowerCase();
  const topic = String(o.topic ?? '').toLowerCase();

  // Match topic first, then fall back to substring match against task text.
  for (const key of Object.keys(SUB_AGENT_RESPONSES)) {
    if (topic.includes(key) || task.includes(key)) {
      return SUB_AGENT_RESPONSES[key]!;
    }
  }
  return 'Sub-agent could not identify the requested topic. Seeded topics: authors, methodology, results.';
}

// ── memory_store / memory_recall ───────────────────────────────
// Used by memory-grounded-reasoning + cron-task-cold-start. State lives
// across calls within a single run (the harness resets per cell run).

export const MEMORY_STORE_TOOL: BetaTool = {
  name: 'memory_store',
  description: 'Store a memory note. Persistent across thread switches and engine restarts.',
  input_schema: {
    type: 'object' as const,
    properties: {
      key: { type: 'string' as const, description: 'Short key identifying the note (e.g. "acme_db", "todays_weather").' },
      value: { type: 'string' as const, description: 'The note content.' },
    },
    required: ['key', 'value'],
  },
};

export function handleMemoryStore(input: unknown): string {
  if (typeof input !== 'object' || input === null) return 'ERROR: bad input';
  const o = input as { key?: unknown; value?: unknown };
  const key = String(o.key ?? '').trim();
  const value = String(o.value ?? '').trim();
  if (!key) return 'ERROR: key is required';
  if (!value) return 'ERROR: value is required';
  state.memory.set(key, value);
  return `Stored memory note "${key}".`;
}

export const MEMORY_RECALL_TOOL: BetaTool = {
  name: 'memory_recall',
  description: 'Retrieve a memory note by key. Returns the stored value or NOT_FOUND.',
  input_schema: {
    type: 'object' as const,
    properties: {
      key: { type: 'string' as const, description: 'The key of the note to retrieve.' },
    },
    required: ['key'],
  },
};

export function handleMemoryRecall(input: unknown): string {
  if (typeof input !== 'object' || input === null) return 'ERROR: bad input';
  const key = String((input as { key?: unknown }).key ?? '').trim();
  if (!key) return 'ERROR: key is required';
  const value = state.memory.get(key);
  return value ?? 'NOT_FOUND';
}

// Seed a memory entry before the run starts (used by memory-grounded-reasoning
// to simulate "thread A already stored X" for thread B to recall).
export function seedMemory(key: string, value: string): void {
  state.memory.set(key, value);
}

// ── workflow_create / workflow_run ─────────────────────────────
// Used by workflow-composition. State across calls: the agent builds,
// saves, then runs a workflow with a known name.

export const WORKFLOW_CREATE_TOOL: BetaTool = {
  name: 'workflow_create',
  description: 'Save a workflow definition under a chosen name. The definition is a free-text description of the steps the workflow should perform; the run-time interprets it. Returns OK on success.',
  input_schema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string' as const, description: 'The workflow\'s unique name.' },
      definition: { type: 'string' as const, description: 'Free-text description of the steps the workflow performs.' },
    },
    required: ['name', 'definition'],
  },
};

export function handleWorkflowCreate(input: unknown): string {
  if (typeof input !== 'object' || input === null) return 'ERROR: bad input';
  const o = input as { name?: unknown; definition?: unknown };
  const name = String(o.name ?? '').trim();
  const def = String(o.definition ?? '').trim();
  if (!name) return 'ERROR: name is required';
  if (!def) return 'ERROR: definition is required';
  state.workflows.set(name, def);
  return `Workflow "${name}" saved.`;
}

export const WORKFLOW_RUN_TOOL: BetaTool = {
  name: 'workflow_run',
  description: 'Execute a previously-saved workflow by name. Returns the workflow\'s aggregated tool-call results.',
  input_schema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string' as const, description: 'Name of the workflow to run.' },
    },
    required: ['name'],
  },
};

export function handleWorkflowRun(input: unknown): string {
  if (typeof input !== 'object' || input === null) return 'ERROR: bad input';
  const name = String((input as { name?: unknown }).name ?? '').trim();
  if (!name) return 'ERROR: name is required';
  const def = state.workflows.get(name);
  if (def === undefined) return `ERROR: workflow "${name}" not found. Create it first with workflow_create.`;
  // Simulate the workflow's run-time: extract any http_fetch URL mentioned
  // and return a canned weather payload + memory write confirmation. This
  // is sufficient for the pass-check (we verify the workflow definition
  // mentioned the right ingredients).
  if (def.toLowerCase().includes('open-meteo') || def.toLowerCase().includes('weather')) {
    return JSON.stringify({
      ranSteps: ['http_fetch open-meteo', 'memory_store weather note'],
      result: { temperature_2m: 18.4, weather_code: 3, location: 'Zurich' },
      memoryWritten: 'todays_weather',
    });
  }
  return `Workflow "${name}" ran. Definition: ${def.slice(0, 200)}`;
}

// ── flaky_api ──────────────────────────────────────────────────
// Used by tool-chain-with-backtrack. Returns 500 the first 2 calls,
// 200 on the 3rd. Agent must retry + backoff + persist.

export const FLAKY_API_TOOL: BetaTool = {
  name: 'flaky_api',
  description: 'Call a billing-summary API. Known to fail intermittently — be ready to retry. Returns the billing summary on success.',
  input_schema: {
    type: 'object' as const,
    properties: {
      endpoint: { type: 'string' as const, description: 'The endpoint name (e.g. "billing").' },
    },
    required: ['endpoint'],
  },
};

export function handleFlakyApi(input: unknown): string {
  if (typeof input !== 'object' || input === null) return 'ERROR: bad input';
  state.flakyApiAttempts++;
  if (state.flakyApiAttempts < 3) {
    return `ERROR 500: upstream service temporarily unavailable. Attempt ${state.flakyApiAttempts}/3.`;
  }
  return JSON.stringify({
    period: '2026-05',
    total_usd: 1247.50,
    invoices: 8,
    status: 'paid',
  });
}

// ── read_paper_section ─────────────────────────────────────────
// Used by long-context-with-tools. The harness pre-injects an arXiv
// paper as `inlineContext` on the scenario, so the agent can answer
// from the system context directly — this tool is here for cases where
// the agent prefers to call out for a specific section.

const ATTENTION_PAPER_SECTIONS: Record<string, string> = {
  authors: 'Ashish Vaswani, Noam Shazeer, Niki Parmar, Jakob Uszkoreit, Llion Jones, Aidan N. Gomez, Lukasz Kaiser, Illia Polosukhin.',
  abstract: 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely.',
  methodology: 'The Transformer follows an encoder-decoder structure using stacked self-attention and position-wise fully-connected feed-forward layers, both for the encoder and decoder. The encoder has 6 identical layers; each has multi-head self-attention + a position-wise feed-forward network.',
  results: 'On the WMT 2014 English-to-German translation task, our big Transformer model achieves 28.4 BLEU, improving over the existing best results by 2.0 BLEU. The single-model big Transformer also achieves a new state-of-the-art 41.0 BLEU on WMT 2014 English-to-French.',
};

export const READ_PAPER_SECTION_TOOL: BetaTool = {
  name: 'read_paper_section',
  description: 'Return a named section of the paper currently in context. Sections: authors, abstract, methodology, results.',
  input_schema: {
    type: 'object' as const,
    properties: {
      section: { type: 'string' as const, description: 'One of: authors, abstract, methodology, results.' },
    },
    required: ['section'],
  },
};

export function handleReadPaperSection(input: unknown): string {
  if (typeof input !== 'object' || input === null) return 'ERROR: bad input';
  const section = String((input as { section?: unknown }).section ?? '').trim().toLowerCase();
  if (!section) return 'ERROR: section is required';
  const text = ATTENTION_PAPER_SECTIONS[section];
  if (!text) return `ERROR: unknown section "${section}". Available: authors, abstract, methodology, results.`;
  return text;
}

// ── read_csv ───────────────────────────────────────────────────
// Used by real-world-grounded-strategy. Two seeded CSVs the agent
// must read + reason against.

const CSV_FIXTURES: Record<string, string> = {
  'keywords.csv': [
    'keyword,monthly_searches,competition,cpc_usd',
    'project management software,49500,high,12.40',
    'open source crm,3200,medium,4.80',
    'ai agent framework,8100,low,2.30',
    'self hosted business automation,720,low,1.10',
  ].join('\n'),
  'mrr.csv': [
    'month,mrr_usd,churn_pct,new_customers',
    '2026-01,4200,3.2,7',
    '2026-02,4850,2.8,9',
    '2026-03,5310,4.1,8',
    '2026-04,5790,2.6,11',
  ].join('\n'),
};

export const READ_CSV_TOOL: BetaTool = {
  name: 'read_csv',
  description: 'Read a CSV file by name. Returns the raw CSV content. Available: keywords.csv, mrr.csv.',
  input_schema: {
    type: 'object' as const,
    properties: {
      filename: { type: 'string' as const, description: 'CSV filename — one of keywords.csv, mrr.csv.' },
    },
    required: ['filename'],
  },
};

export function handleReadCsv(input: unknown): string {
  if (typeof input !== 'object' || input === null) return 'ERROR: bad input';
  const filename = String((input as { filename?: unknown }).filename ?? '').trim().toLowerCase();
  if (!filename) return 'ERROR: filename is required';
  const csv = CSV_FIXTURES[filename];
  if (!csv) return `ERROR: unknown file "${filename}". Available: ${Object.keys(CSV_FIXTURES).join(', ')}.`;
  return csv;
}

// ── dispatcher ─────────────────────────────────────────────────

export function dispatchMockTool(toolName: string, input: unknown): string | null {
  switch (toolName) {
    case 'web_search': return handleWebSearch(input);
    case 'http_fetch': return handleHttpFetch(input);
    case 'spawn_agent': return handleSpawnAgent(input);
    case 'memory_store': return handleMemoryStore(input);
    case 'memory_recall': return handleMemoryRecall(input);
    case 'workflow_create': return handleWorkflowCreate(input);
    case 'workflow_run': return handleWorkflowRun(input);
    case 'flaky_api': return handleFlakyApi(input);
    case 'read_paper_section': return handleReadPaperSection(input);
    case 'read_csv': return handleReadCsv(input);
    default: return null;
  }
}

export const SET_BENCH_TOOLS: readonly BetaTool[] = [
  WEB_SEARCH_TOOL,
  HTTP_FETCH_TOOL,
  SPAWN_AGENT_TOOL,
  MEMORY_STORE_TOOL,
  MEMORY_RECALL_TOOL,
  WORKFLOW_CREATE_TOOL,
  WORKFLOW_RUN_TOOL,
  FLAKY_API_TOOL,
  READ_PAPER_SECTION_TOOL,
  READ_CSV_TOOL,
];

// Re-exported public state inspectors for the runner / pass-checks that
// need to verify side effects (e.g. did the agent persist memory?).
export const inspectMemory = (key: string): string | undefined => state.memory.get(key);
export const inspectWorkflow = (name: string): string | undefined => state.workflows.get(name);
export const inspectFlakyAttempts = (): number => state.flakyApiAttempts;
