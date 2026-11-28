/**
 * Online eval (U-201): the owner replies "why?" in the escalation thread of a scheduled run whose
 * step failed without reporting it. The thread holds what `escalateToUser` seeds: the title as a
 * user turn and the body as the assistant's, built by `failedRunBody` (the worker's own function):
 * the step named in lynox's words, the error left out, and "you can ask here for the error". The
 * chat runs on the real web-chat system prompt with `diagnose_workflow_run` (the real handler on a
 * seeded RunHistory, where the error is) and `run_workflow` (a stub: a re-run is not the answer).
 * Nothing is sent anywhere.
 *
 * T1 pass (09.11.): diagnose first, no cause before it, never "no reason was given"
 * (`threadVerdict`). Without the error in the thread, a model that does not look guesses one.
 * ESCALATION_CHAT_RUNS (default 10) per provider, even runs German, odd English;
 * ESCALATION_CHAT_PROVIDERS=mistral,haiku; ESCALATION_CHAT_DUMP=<jsonl> for the raw blocks.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../../src/core/agent.js';
import { initLLMProvider } from '../../src/core/llm-client.js';
import { createToolContext } from '../../src/core/tool-context.js';
import { SYSTEM_PROMPT, PIPELINE_PROMPT_SUFFIX, WEB_UI_SYSTEM_PROMPT_SUFFIX, currentDateContext } from '../../src/core/prompts.js';
import { RunHistory } from '../../src/core/run-history.js';
import { EngineDb } from '../../src/core/engine-db.js';
import { WORKER_NOTICES } from '../../src/core/worker-notices.js';
import { failedRunBody } from '../../src/core/escalation-failure.js';
import { diagnoseWorkflowTool, runWorkflowTool } from '../../src/tools/builtin/index.js';
import type { IAgent, LynoxUserConfig, StreamEvent, ToolEntry } from '../../src/types/index.js';
import { HAIKU } from './setup.js';
import { threadControlFailures, threadVerdict, type Block } from './reported-failure-chat-grader.js';

const RUNS = Number(process.env['ESCALATION_CHAT_RUNS'] ?? 10);
const MISTRAL_MODEL = 'mistral-medium-2604';
if (MISTRAL_MODEL.endsWith('-latest')) throw new Error('no -latest Mistral tags');

const WORKFLOW_ID = 'wf-weekly';
const WORKFLOW_NAME = 'Wochenbericht';
const RUN_ID = 'run-9c2e01';
const ERROR = 'GET https://api.shop.example/orders answered HTTP 503 three times in a row; no orders could be fetched.';
const RERUN_STUB = 'Not run: this eval does not run workflows.';

let dir = '';
let history: RunHistory | undefined;
let engineDb: EngineDb | undefined;

function seed(h: RunHistory): void {
  h.insertPlannedPipeline({
    id: WORKFLOW_ID, name: WORKFLOW_NAME, goal: 'Wöchentliche Bestellübersicht',
    steps: [{ id: 'fetch', task: 'Hol die Bestellungen der letzten Woche' }, { id: 'summarize', task: 'Fasse sie zusammen', input_from: ['fetch'] }],
    reasoning: '', estimatedCost: 0, createdAt: '2026-11-01T00:00:00.000Z', template: true,
  }, null);
  h.insertPipelineRun({ id: RUN_ID, manifestName: WORKFLOW_NAME, status: 'failed', manifestJson: '{}', error: ERROR, workflowId: WORKFLOW_ID });
  h.insertPipelineStepResult({ pipelineRunId: RUN_ID, stepId: 'fetch', status: 'failed', error: ERROR, costUsd: 0.0009 });
}

/** The thread as `escalateToUser` seeds it, in the owner's language. */
function thread(lang: 'de' | 'en'): Array<{ role: 'user' | 'assistant'; content: Array<{ type: 'text'; text: string }> }> {
  const n = WORKER_NOTICES[lang];
  const body = failedRunBody(n, {
    title: WORKFLOW_NAME, status: 'failed', grantLines: [], ref: n.workflowRef(RUN_ID, WORKFLOW_ID),
    run: { error: ERROR, stepErrors: [{ stepId: 'fetch', error: ERROR }] },
  });
  if (body.includes('503')) throw new Error('the body carries the error: the eval would not measure U-201');
  return [
    { role: 'user', content: [{ type: 'text', text: `✗ ${WORKFLOW_NAME}` }] },
    { role: 'assistant', content: [{ type: 'text', text: body }] },
  ];
}

function tools(): ToolEntry[] {
  const ctx = createToolContext({} as LynoxUserConfig);
  ctx.runHistory = history!;
  const diagAgent = { name: 'eval', model: 'm', memory: null, tools: [], onStream: null, currentRunId: 'r', toolContext: ctx } as unknown as IAgent;
  return [
    { ...(diagnoseWorkflowTool as ToolEntry), handler: async (input: unknown) => diagnoseWorkflowTool.handler(input as { run_id: string }, diagAgent) } as ToolEntry,
    { ...(runWorkflowTool as ToolEntry), handler: async () => RERUN_STUB } as ToolEntry,
  ];
}

const SYSTEM = `${SYSTEM_PROMPT}${PIPELINE_PROMPT_SUFFIX}${WEB_UI_SYSTEM_PROMPT_SUFFIX}${currentDateContext()}`;
const ASK_WHY = { de: 'warum?', en: 'why?' };

function blocksOf(agent: Agent, from: number): Block[] {
  const out: Block[] = [];
  agent.getMessages().slice(from).forEach((m) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return;
    for (const b of m.content as Array<{ type?: string; text?: string; name?: string; input?: Record<string, unknown> }>) {
      if (b.type === 'text' && b.text) out.push({ kind: 'text', text: b.text, name: '', input: {}, turn: 1 });
      if (b.type === 'tool_use' && b.name) out.push({ kind: 'tool', text: '', name: b.name, input: b.input ?? {}, turn: 1 });
    }
  });
  return out;
}

const table: string[] = [];
const usage: Record<string, { in: number; out: number }> = {};
beforeAll(() => {
  const broken = threadControlFailures();
  if (broken.length > 0) throw new Error(`grader controls failed: ${broken.join('; ')}`);
  dir = mkdtempSync(join(tmpdir(), 'u201-'));
  history = new RunHistory(join(dir, 'h.db'));
  engineDb = new EngineDb(join(dir, 'engine.db'));
  history.setVerbGraph(engineDb);
  seed(history);
});
afterAll(() => {
  if (table.length) console.log(`\nescalation-failure chat eval\n${table.join('\n')}`);
  console.log(`tokens: ${JSON.stringify(usage)}`);
  const dump = process.env['ESCALATION_CHAT_DUMP'];
  if (dump) appendFileSync(dump, `${JSON.stringify({ summary: true, usage })}\n`);
  try { engineDb?.close(); } catch { /* closed */ }
  history?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function transient(err: unknown): boolean {
  return /429|5\d\d|overloaded|rate|timeout/i.test(String((err as { status?: number })?.status ?? err));
}

type Make = (onStream: (e: StreamEvent) => Promise<void>) => Agent;

async function runOne(provider: string, make: Make, i: number): Promise<void> {
  const lang = i % 2 === 0 ? 'de' : 'en';
  const u = usage[provider] ?? { in: 0, out: 0 };
  usage[provider] = u;
  const agent = make(async (e: StreamEvent) => {
    if (e.type !== 'turn_end') return;
    u.in += e.usage.input_tokens ?? 0; u.out += e.usage.output_tokens ?? 0;
  });
  agent.loadMessages(thread(lang));
  const from = agent.getMessages().length;
  try {
    await agent.send(ASK_WHY[lang]);
  } catch (err) {
    if (transient(err)) { table.push(`${provider}\tT1\t#${String(i)}\tSKIP\ttransient`); return; }
    throw err;
  }
  const blocks = blocksOf(agent, from);
  const v = threadVerdict(blocks);
  const dump = process.env['ESCALATION_CHAT_DUMP'];
  if (dump) {
    appendFileSync(dump, `${JSON.stringify({
      provider, case: 'T1', run: i, lang, ok: v.ok, why: v.why,
      blocks: blocks.map((b) => (b.kind === 'text' ? { text: b.text } : { tool: b.name, input: b.input })),
    })}\n`);
  }
  table.push(`${provider}\tT1\t#${String(i)}\t${lang}\t${v.ok ? 'PASS' : 'FAIL'}\t${v.why}`);
  expect(v.ok, v.why).toBe(true);
}

const runs = Array.from({ length: RUNS }, (_, i) => ({ i, label: `T1 why? in the escalation thread -> diagnose first #${String(i)}` }));
const PROVIDERS = process.env['ESCALATION_CHAT_PROVIDERS']?.split(',').map((x) => x.trim());
const skipProvider = (p: string): boolean => PROVIDERS !== undefined && !PROVIDERS.includes(p);
const base = { maxIterations: 6, systemPrompt: SYSTEM, promptUser: async () => 'ok' };

const MISTRAL_KEY = process.env['MISTRAL_API_KEY'];
describe.skipIf(!MISTRAL_KEY || skipProvider('mistral'))(`escalation failure in chat — Mistral (${MISTRAL_MODEL})`, () => {
  beforeAll(async () => { await initLLMProvider('openai'); });
  it.each(runs)('$label', async ({ i }) => {
    await runOne('mistral', (onStream) => new Agent({
      ...base, tools: tools(), onStream, name: 'u201-mistral', model: MISTRAL_MODEL, provider: 'openai', apiKey: MISTRAL_KEY!,
      apiBaseURL: 'https://api.mistral.ai/v1', openaiModelId: MISTRAL_MODEL, toolContext: createToolContext({}),
    }), i);
  }, 180_000);
});

const ANTHROPIC_KEY = process.env['ANTHROPIC_API_KEY'];
describe.skipIf(!ANTHROPIC_KEY || skipProvider('haiku'))('escalation failure in chat — Anthropic (Haiku)', () => {
  beforeAll(async () => { await initLLMProvider('anthropic'); });
  it.each(runs)('$label', async ({ i }) => {
    await runOne('haiku', (onStream) => new Agent({
      ...base, tools: tools(), onStream, name: 'u201-haiku', model: HAIKU, apiKey: ANTHROPIC_KEY!, provider: 'anthropic', toolContext: createToolContext({}),
    }), i);
  }, 180_000);
});
