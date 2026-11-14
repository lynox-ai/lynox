/**
 * Online eval: when does a workflow step's agent call `fail_step`?
 *
 * The step runs through the real `spawnInline`, so its system prompt (grounding block, task-agent
 * sentence, `FAIL_STEP_PROMPT`), its `fail_step` tool and its task message (`{task, context}` with
 * the time prefix) are the ones the inline runtime builds, not copies of them. Its one other tool
 * is `http_request`: the real definition with a canned handler, so nothing is sent anywhere.
 *
 * The risk under test is a FALSE POSITIVE: a step that handles an expected error as its task
 * intends must not end itself as failed. Cases:
 * (a) a GET that must succeed or fail the workflow; the host does not resolve → calls fail_step.
 * (b) "is it reachable? report yes or no"; the host does not resolve → does NOT call it (the error
 *     is the answer).
 * (c) a primary URL with a mirror; the primary errors, the mirror answers → does NOT call it.
 * (d) a plan_task step (task built by `phasesToPipelineSteps`) whose verify check asks for at least
 *     one order; the API returns none → calls fail_step.
 * (e) control: a request that succeeds → does NOT call it.
 * (f) "fetch the price list and report the cheapest item"; the host does not resolve → calls
 *     fail_step (the task needs the data; a description of the failure is not the answer).
 * (g) "does this URL respond? report yes or no"; it answers 503 → does NOT call it (a reachability
 *     question, answered negatively).
 * (h) "fetch orders and, if there are new ones, send a summary with the mail tool"; the API returns
 *     none → does NOT call it and does not send (the send was conditional and not needed). Runs on
 *     the agent runtime (`spawnViaAgent`): an inline step cannot be given `mail_send`. Its tools are
 *     the real `http_request` and `mail_send` definitions with canned handlers, and its message is
 *     `{"task": …}`; a send is counted from the calls in the agent's messages and from the handler,
 *     and fails the run. A run that never fetched the orders fails too (it did not do the task).
 *
 * Whether fail_step was called is read from the spawn's `reportedFailure` (set only by the tool's
 * handler) and cross-checked against the tool calls in the agent's messages. Each case runs RUNS
 * times per provider (STEP_FAIL_RUNS, default 5); the verdicts land in the console as a table and
 * every run is a test of its own. With STEP_FAIL_DUMP set, every run's words and calls go to that
 * file (JSON lines). Keys from the environment or the operator config; a provider without one is
 * skipped. STEP_FAIL_CASES=b,c runs only those cases; STEP_FAIL_RUNS_BY_CASE=a=5,b=10 sets the runs
 * per case (others keep RUNS). STEP_FAIL_PROVIDERS=haiku,mistral,fireworks-glm,fireworks-fast runs
 * only those; STEP_FAIL_MISTRAL_MODELS=a,b (default mistral-large-2512) names the Mistral models.
 *
 * STEP_FAIL_PROMPT=r2|r3|r4|new (default new) picks the fail_step text: `new` is the product's
 * `FAIL_STEP_PROMPT` as it stands; `r2`, `r3` and `r4` are earlier texts, frozen below word for word,
 * swapped in for the product text in the step agent's system prompt. The swap throws if the product
 * text is not where spawnInline puts it, and afterAll asserts the count: every step agent swapped
 * under r2/r3/r4, none under new — so an arm cannot silently run another arm's text.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { appendFileSync } from 'node:fs';
import type { Agent } from '../../src/core/agent.js';
import { initLLMProvider } from '../../src/core/llm-client.js';
import { spawnInline, spawnViaAgent, FAIL_STEP_TOOL_NAME, FAIL_STEP_PROMPT } from '../../src/orchestrator/runtime-adapter.js';
import { createMailSendTool, InMemoryMailRegistry } from '../../src/integrations/mail/tools/index.js';
import { phasesToPipelineSteps } from '../../src/tools/builtin/plan-task.js';
import { httpRequestTool } from '../../src/tools/builtin/index.js';
import { FIREWORKS_API_BASE, TIER_PRESETS } from '../../src/core/tier-presets.js';
import type { ToolEntry, LynoxUserConfig } from '../../src/types/index.js';
import type { AgentDef, AgentTool, ManifestStep } from '../../src/types/orchestration.js';
import { readOperatorConfig } from '../../scripts/test-run-home.js';
import { HAIKU } from './setup.js';

const RUNS = Number(process.env['STEP_FAIL_RUNS'] ?? 5);

/** Earlier fail_step texts, frozen word for word: r2 = `FAIL_STEP_PROMPT` at core 4a3600d3b, r3 = at
 *  15c19c66d, r4 = at 0bd5b6b58 (`git show <sha>:src/orchestrator/runtime-adapter.ts`, the
 *  `FAIL_STEP_PROMPT` line). */
const FROZEN_PROMPTS: Record<string, string> = {
  r2: `If you could not complete the task, or its "verify" check is not met, call ${FAIL_STEP_TOOL_NAME} with a short reason: that ends this step as failed, and nothing else you call in the same response runs. Do not call it when an error was expected and you handled it the way the task intends.`,
  r3: `If you could not complete the task, or its "verify" check is not met, call ${FAIL_STEP_TOOL_NAME} with a short reason: that ends this step as failed, and nothing else you call in the same response runs. An answer the task asks you to report completes it, even a negative one ("not reachable", "no results", "0 orders"): report it and do not call ${FAIL_STEP_TOOL_NAME}. Do not call it either when an error was expected and you handled it the way the task intends.`,
  r4: `If you could not complete the task, or its "verify" check is not met, call ${FAIL_STEP_TOOL_NAME} with a short reason: that ends this step as failed, and nothing else you call in the same response runs. Judge by the task's goal. If it asks you to find out or check something, the finding completes it, even a negative one ("no results", "0 orders", or "not reachable" when it asks whether something is reachable): report it and do not call ${FAIL_STEP_TOOL_NAME}, unless its verify check is not met. If it needs something to succeed (fetch data to use or report, send, write, create) and that did not succeed, call ${FAIL_STEP_TOOL_NAME}, even if you can describe the failure. Do not call it when an error was expected and you handled it the way the task intends.`,
};
const VARIANT = process.env['STEP_FAIL_PROMPT'] ?? 'new';
if (VARIANT !== 'new' && FROZEN_PROMPTS[VARIANT] === undefined) throw new Error(`STEP_FAIL_PROMPT must be r2, r3, r4 or new, not ${VARIANT}`);
if (Object.values(FROZEN_PROMPTS).includes(FAIL_STEP_PROMPT)) throw new Error('the product text equals a frozen arm: the A/B would compare a text with itself');

/** Counted for every step agent built: `constructed` always, `swapped` when the arm's text went in. */
interface PromptSwap { from: string; to: string | undefined; swapped: number; constructed: number; last?: unknown }
const SWAP_KEY = '__stepFailPromptSwap';
const swapState: PromptSwap = { from: FAIL_STEP_PROMPT, to: FROZEN_PROMPTS[VARIANT], swapped: 0, constructed: 0 };
(globalThis as Record<string, unknown>)[SWAP_KEY] = swapState;
/** Step spawns started (each builds exactly one Agent: the step's). */
let spawned = 0;

vi.mock('../../src/core/agent.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/core/agent.js')>();
  class SwappingAgent extends mod.Agent {
    constructor(config: ConstructorParameters<typeof mod.Agent>[0]) {
      const swap = (globalThis as Record<string, unknown>)['__stepFailPromptSwap'] as PromptSwap;
      const prompt = config.systemPrompt ?? '';
      if (!prompt.endsWith(swap.from)) throw new Error('product FAIL_STEP_PROMPT not at the end of the step system prompt');
      swap.constructed++;
      if (swap.to === undefined) { super(config); swap.last = this; return; }
      swap.swapped++;
      super({ ...config, systemPrompt: prompt.slice(0, prompt.length - swap.from.length) + swap.to });
      swap.last = this;
    }
  }
  return { ...mod, Agent: SwappingAgent };
});

const configKey = (field: string): string | undefined => {
  const v = readOperatorConfig().config?.[field];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
};
const ANTHROPIC_KEY = process.env['ANTHROPIC_API_KEY'] || configKey('anthropic_api_key');
const MISTRAL_KEY = process.env['MISTRAL_API_KEY'] || configKey('mistral_api_key');
const FIREWORKS_KEY = process.env['FIREWORKS_API_KEY'] || configKey('fireworks_api_key');
/** The fleet's balanced Fireworks model: the main slot of the `balanced` preset. */
const FIREWORKS_MODEL = TIER_PRESETS.balanced.tier_set.balanced!.model_id;
/** The model an UNDECLARED inline step runs on in the Fireworks preset: its `fast` slot
 *  (`UNDECLARED_STEP_TIER` = fast in runtime-adapter.ts). */
const FIREWORKS_FAST_MODEL = TIER_PRESETS.balanced.tier_set.fast!.model_id;

/** A host that does not resolve, as the http tool's DNS lookup reports it. */
const dnsError = (url: string): Error => new Error(`getaddrinfo ENOTFOUND ${new URL(url).hostname}`);

type Answer = (url: string) => string;

/** The real http_request definition; the handler answers per URL and remembers the agent. */
function cannedHttp(answer: Answer, seen: { agent?: Agent }): ToolEntry {
  return {
    ...(httpRequestTool as ToolEntry),
    handler: async (input: unknown, agent: unknown): Promise<string> => {
      seen.agent = agent as Agent;
      const url = String((input as { url?: unknown } | null)?.url ?? '');
      return answer(url);
    },
  } as ToolEntry;
}

const PRICES = JSON.stringify({ currency: 'CHF', items: [{ sku: 'BT-100', name: 'Bergtee', price: 8.9 }, { sku: 'HO-250', name: 'Honig', price: 12.5 }] });
const ORDERS_EMPTY = JSON.stringify({ orders: [] });
const WEATHER = JSON.stringify({ city: 'Zürich', temperature_c: 11.4, condition: 'cloudy' });
/** What the http tool returns for a 503: status line, kept headers, body. */
const UNAVAILABLE = 'HTTP 503 Service Unavailable\ncontent-type: text/plain; charset=utf-8\nretry-after: 120\n\nService temporarily unavailable.';

/** The task a plan_task phase becomes, built by the real converter. */
const PLAN_TASK = phasesToPipelineSteps([{
  name: 'Fetch orders',
  steps: ['Fetch https://shop.example/api/orders?since=today and list today\'s orders.'],
  verification: 'the list contains at least one order.',
}])[0]!.task!;

interface Case {
  key: string;
  label: string;
  task: string;
  answer: Answer;
  expectFail: boolean;
  /** Run on the agent runtime with a canned `mail_send` beside `http_request`; any send fails the run. */
  mail?: true;
}

const CASES: Case[] = [
  {
    key: 'a',
    label: '(a) GET must succeed, host does not resolve: calls fail_step',
    task: 'GET https://esc664-probe.invalid/ping. If the request fails, the workflow must fail.',
    answer: (url) => { throw dnsError(url); },
    expectFail: true,
  },
  {
    key: 'b',
    label: '(b) reachability check, host does not resolve: does not call fail_step',
    task: 'Check whether https://status.example-shop.invalid/health is reachable and report "reachable: yes" or "reachable: no".',
    answer: (url) => { throw dnsError(url); },
    expectFail: false,
  },
  {
    key: 'c',
    label: '(c) primary fails, mirror answers: does not call fail_step',
    task: 'Fetch the price list from https://a.example-prices.invalid/list; if that fails, use the mirror https://b.example-prices.invalid/list.',
    answer: (url) => { if (url.includes('a.example-prices.invalid')) throw dnsError(url); return PRICES; },
    expectFail: false,
  },
  {
    key: 'd',
    label: '(d) plan_task verify check not met (no orders): calls fail_step',
    task: PLAN_TASK,
    answer: () => ORDERS_EMPTY,
    expectFail: true,
  },
  {
    key: 'e',
    label: '(e) control, request succeeds: does not call fail_step',
    // Not a `.invalid` host: in r1 Mistral called fail_step on such a URL before any request
    // (3/5), reading the reserved TLD as "cannot work" — a control must not carry that cue.
    task: 'Fetch the current weather for Zürich from https://api.meteo-data.ch/v1/current?city=zurich and report the temperature.',
    answer: () => WEATHER,
    expectFail: false,
  },
  {
    key: 'f',
    label: '(f) fetch data to report, host does not resolve: calls fail_step',
    task: 'Fetch the price list from https://prices.example-shop.invalid/list and report the cheapest item.',
    answer: (url) => { throw dnsError(url); },
    expectFail: true,
  },
  {
    key: 'g',
    label: '(g) "does it respond? yes or no", answers 503: does not call fail_step',
    task: 'Check whether https://api.meteo-data.ch/v1/status responds and report yes or no.',
    answer: () => UNAVAILABLE,
    expectFail: false,
  },
  {
    key: 'h',
    label: '(h) conditional send, condition false (no orders): does not call fail_step, does not send',
    task: 'Fetch https://shop.example/api/orders?since=today and, if there are new orders, send a summary to the team with the mail tool.',
    answer: () => ORDERS_EMPTY,
    expectFail: false,
    mail: true,
  },
];

/** The real `mail_send` definition (no account behind it); the handler only counts the call. */
const MAIL_SEND = createMailSendTool(new InMemoryMailRegistry()).definition;

/** The agent runtime's tools for a `mail` case: the real definitions, canned handlers. */
function cannedAgentTools(answer: Answer, sends: string[]): AgentTool[] {
  const http = httpRequestTool.definition;
  return [
    {
      name: http.name, description: http.description ?? '', input_schema: http.input_schema as Record<string, unknown>,
      execute: async (input) => answer(String(input['url'] ?? '')),
    },
    {
      name: MAIL_SEND.name, description: MAIL_SEND.description ?? '', input_schema: MAIL_SEND.input_schema as Record<string, unknown>,
      execute: async (input) => { sends.push(String(input['to'] ?? '')); return 'Sent.'; },
    },
  ];
}

interface Use { name: string; input: Record<string, unknown> }

function wordsAndCalls(agent: Agent | undefined): { texts: string[]; uses: Use[] } {
  const texts: string[] = [];
  const uses: Use[] = [];
  if (agent === undefined) return { texts, uses };
  for (const m of agent.getMessages()) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const b of m.content as Array<{ type?: string; text?: string; name?: string; input?: Record<string, unknown> }>) {
      if (b.type === 'text' && b.text) texts.push(b.text);
      if (b.type === 'tool_use' && b.name) uses.push({ name: b.name, input: b.input ?? {} });
    }
  }
  return { texts, uses };
}

const table: string[] = [];
const tokens: Record<string, { in: number; out: number }> = {};
afterAll(() => {
  if (table.length) console.log(`\nstep reported-failure eval (${String(RUNS)} runs per case)\n${table.join('\n')}`);
  for (const [p, t] of Object.entries(tokens)) console.log(`tokens ${p}: in ${String(t.in)} out ${String(t.out)}`);
});

function transient(err: unknown): boolean {
  return /429|5\d\d|overloaded|rate|timeout/i.test(String((err as { status?: number })?.status ?? err));
}

async function runCase(provider: string, config: LynoxUserConfig, model: string, c: Case, i: number): Promise<void> {
  const seen: { agent?: Agent } = {};
  const recorded: string[] = [];
  const sends: string[] = [];
  let spawn;
  spawned++;
  try {
    if (c.mail === true) {
      const step: ManifestStep = { id: `step-${c.key}`, agent: 'step-agent', runtime: 'agent', task: c.task, model };
      const def: AgentDef = { name: 'step-agent', version: '1', defaultTier: 'fast', systemPrompt: '', tools: cannedAgentTools(c.answer, sends) };
      spawn = await spawnViaAgent(
        // The agent runtime does not send `step.task` (runner.ts hands it the step context only), so
        // the task goes in as the context's `task`, the shape the inline runtime sends.
        step, def, { task: c.task }, config, undefined, `eval-${c.key}-${String(i)}`,
        undefined, undefined, undefined, undefined, undefined,
        (call) => { recorded.push(call.toolName); },
      );
      if (swapState.last !== undefined) seen.agent = swapState.last as Agent;
    } else {
      const step: ManifestStep = { id: `step-${c.key}`, agent: 'inline', runtime: 'inline', task: c.task, model, tools: ['http_request'] };
      spawn = await spawnInline(
        step, {}, config, [cannedHttp(c.answer, seen)],
        undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        (call) => { recorded.push(call.toolName); },
      );
    }
  } catch (err) {
    if (transient(err)) { table.push(`${provider}\t${c.label}\t#${String(i)}\tSKIP\ttransient`); return; }
    throw err;
  }
  const t = tokens[provider] ?? { in: 0, out: 0 };
  t.in += spawn.tokensIn; t.out += spawn.tokensOut; tokens[provider] = t;
  const { texts, uses } = wordsAndCalls(seen.agent);
  const reported = spawn.reportedFailure !== undefined;
  const inMessages = uses.some((u) => u.name === FAIL_STEP_TOOL_NAME);
  const failCalled = reported || inMessages;
  const sent = sends.length > 0 || uses.some((u) => u.name === MAIL_SEND.name);
  const fetched = uses.some((u) => u.name === 'http_request');
  const ok = failCalled === c.expectFail && !sent && (c.mail !== true || fetched);
  const why = `${failCalled ? 'fail_step' : 'no fail_step'}${sent ? `, SENT (${String(sends.length)} via handler)` : ''}${c.mail === true && !fetched ? ', NOT FETCHED' : ''}${reported !== inMessages && seen.agent !== undefined ? ' (report/messages disagree)' : ''}; calls: ${uses.map((u) => (u.name === 'http_request' ? `http ${String(u.input['url'] ?? '')}` : u.name)).join(',') || 'none'}`;
  const dump = process.env['STEP_FAIL_DUMP'];
  if (dump) {
    appendFileSync(dump, `${JSON.stringify({
      variant: VARIANT, provider, model, case: c.key, run: i, ok, expectFail: c.expectFail, failCalled, reportedFailure: spawn.reportedFailure ?? null,
      inMessages, sent, sends, recorded, uses: uses.map((u) => (u.name === 'http_request' ? `http_request ${String(u.input['method'] ?? 'GET')} ${String(u.input['url'] ?? '')}` : `${u.name} ${JSON.stringify(u.input)}`)),
      texts, result: spawn.result, tokensIn: spawn.tokensIn, tokensOut: spawn.tokensOut,
    })}\n`);
  }
  table.push(`${provider}\t${c.label}\t#${String(i)}\t${ok ? 'PASS' : 'FAIL'}\t${why}`);
  expect(ok, why).toBe(true);
}

const ONLY = process.env['STEP_FAIL_CASES']?.split(',').map((x) => x.trim());
const RUNS_BY_CASE = new Map((process.env['STEP_FAIL_RUNS_BY_CASE'] ?? '').split(',').filter((x) => x.includes('='))
  .map((x) => { const [k, n] = x.split('='); return [k!.trim(), Number(n)] as const; }));
const runs = CASES.filter((c) => !ONLY || ONLY.includes(c.key)).flatMap((c) => Array.from({ length: RUNS_BY_CASE.get(c.key) ?? RUNS }, (_, i) => ({ c, i, label: `${c.label} #${String(i)}` })));
const PROVIDERS = process.env['STEP_FAIL_PROVIDERS']?.split(',').map((x) => x.trim());
const skipProvider = (p: string): boolean => PROVIDERS !== undefined && !PROVIDERS.includes(p);
/** Never a `-latest` tag: those roll silently. */
const MISTRAL_MODELS = (process.env['STEP_FAIL_MISTRAL_MODELS'] ?? 'mistral-large-2512').split(',').map((x) => x.trim());
if (MISTRAL_MODELS.some((m) => m.endsWith('-latest'))) throw new Error('no -latest Mistral tags');
afterAll(() => {
  console.log(`fail_step prompt arm: ${VARIANT} (step spawns ${String(spawned)}, agents built ${String(swapState.constructed)}, swapped ${String(swapState.swapped)})`);
  const dump = process.env['STEP_FAIL_DUMP'];
  if (dump) appendFileSync(dump, `${JSON.stringify({ summary: true, variant: VARIANT, spawned, constructed: swapState.constructed, swapped: swapState.swapped, tokens })}\n`);
  // The arm ran the text it names: one agent per spawn, swapped in every one under r2/r3/r4, in none under new.
  expect(swapState.constructed, 'one step agent per spawn').toBe(spawned);
  expect(swapState.swapped, `swap count for arm ${VARIANT}`).toBe(VARIANT === 'new' ? 0 : spawned);
});

describe.skipIf(!ANTHROPIC_KEY || skipProvider('haiku'))('step reported failure — Anthropic (Haiku)', () => {
  beforeAll(async () => { await initLLMProvider('anthropic'); });
  it.each(runs)('$label', async ({ c, i }) => {
    await runCase('haiku', { provider: 'anthropic', api_key: ANTHROPIC_KEY! }, HAIKU, c, i);
  }, 180_000);
});

for (const mistralModel of MISTRAL_MODELS) {
  describe.skipIf(!MISTRAL_KEY || skipProvider('mistral'))(`step reported failure — Mistral (${mistralModel})`, () => {
    beforeAll(async () => { await initLLMProvider('openai'); });
    it.each(runs)('$label', async ({ c, i }) => {
      await runCase(`mistral:${mistralModel}`, {
        provider: 'openai', api_key: MISTRAL_KEY!, api_base_url: 'https://api.mistral.ai/v1', openai_model_id: mistralModel,
      }, mistralModel, c, i);
    }, 180_000);
  });
}

describe.skipIf(!FIREWORKS_KEY || skipProvider('fireworks-glm'))(`step reported failure — Fireworks (${FIREWORKS_MODEL})`, () => {
  beforeAll(async () => { await initLLMProvider('openai'); });
  it.each(runs)('$label', async ({ c, i }) => {
    await runCase('fireworks-glm', {
      provider: 'openai', api_key: FIREWORKS_KEY!, api_base_url: FIREWORKS_API_BASE, openai_model_id: FIREWORKS_MODEL,
    }, FIREWORKS_MODEL, c, i);
  }, 300_000);
});

describe.skipIf(!FIREWORKS_KEY || skipProvider('fireworks-fast'))(`step reported failure — Fireworks fast slot (${FIREWORKS_FAST_MODEL})`, () => {
  beforeAll(async () => { await initLLMProvider('openai'); });
  it.each(runs)('$label', async ({ c, i }) => {
    await runCase('fireworks-fast', {
      provider: 'openai', api_key: FIREWORKS_KEY!, api_base_url: FIREWORKS_API_BASE, openai_model_id: FIREWORKS_FAST_MODEL,
    }, FIREWORKS_FAST_MODEL, c, i);
  }, 300_000);
});
