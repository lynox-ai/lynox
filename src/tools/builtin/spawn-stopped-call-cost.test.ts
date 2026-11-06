// A spawned child whose own main-model call is ended mid-stream — by the parent's stop, by the
// child's own guard on a tool call written out as text, or by the per-call stream timeout.
// Driven through a REAL Engine, Session, parent Agent, `spawn_agent` tool, child Agent and
// RunHistory; only the provider's event stream is stubbed.
//
// What each number is:
//  - the child's run row `cost_usd`: what the cost lines read (history, thread totals, the
//    parent's `spawnCostUsd`, the daily and monthly sums). It carries the stopped call's
//    estimate, like the main run's row does.
//  - the tenant debit (`onAfterRun`, through the engine as metered host): the child's own
//    finished calls only, never the estimate.
//  - the session counter (`sessionCounters.costUSD`): the session cap. The spawn's reservation
//    stands for the child there, so the child's stopped call adds nothing on top of it once
//    the child has settled.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';

interface Script { events: Array<Record<string, unknown>>; yielded: number; hang?: boolean }

const { calls, scripts, onCall } = vi.hoisted(() => ({
  calls: [] as Array<{ params: { messages: BetaMessageParam[] } }>,
  scripts: [] as Script[],
  onCall: { fn: null as (() => void) | null },
}));

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = {
      messages: {
        stream: (params: { messages: BetaMessageParam[] }, opts?: { signal?: AbortSignal }) => ({
          // Helper calls of a run read the whole message at once; only agent calls stream.
          finalMessage: async () => ({ content: [{ type: 'text', text: '' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }),
          [Symbol.asyncIterator]() {
            calls.push({ params });
            onCall.fn?.();
            const script = scripts.shift();
            if (!script) throw new Error('no scripted reply left');
            return {
              next: async () => {
                if (script.yielded < script.events.length) return { done: false, value: script.events[script.yielded++] };
                if (!script.hang) return { done: true, value: undefined };
                return new Promise((_res, rej) => {
                  const fail = (): void => { rej(new Error('Request was aborted.')); };
                  if (opts?.signal?.aborted) fail(); else opts?.signal?.addEventListener('abort', fail, { once: true });
                });
              },
              return: async () => ({ done: true, value: undefined }),
            };
          },
        }),
      },
    };
  }
  class APIError extends Error {}
  return { default: MockAnthropic, APIError };
});

import { Agent, RunAbortedError } from '../../core/agent.js';
import { Engine } from '../../core/engine.js';
import { reloadConfig } from '../../core/config.js';
import { calculateCost } from '../../core/pricing.js';
import type { Session } from '../../core/session.js';
import type { RunRecord } from '../../core/run-history.js';
import type { LynoxConfig } from '../../types/config.js';
import type { ToolEntry } from '../../types/index.js';

const usage = { input_tokens: 100, output_tokens: 0, cache_creation: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, inference_geo: null, iterations: null, server_tool_use: null, service_tier: null, speed: null };

function script(events: Array<Record<string, unknown>>, hang = false): Script {
  const s: Script = { events, yielded: 0, ...(hang ? { hang } : {}) };
  scripts.push(s);
  return s;
}

function spawnReply(): Script {
  return script([
    { type: 'message_start', message: { usage: { ...usage } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_spawn', name: 'spawn_agent', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ agents: [{ name: 'researcher', task: 'look up the order list' }] }) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ]);
}

function textReply(text: string, step = text.length): Script {
  const deltas: Array<Record<string, unknown>> = [];
  for (let o = 0; o < text.length; o += step) deltas.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(o, o + step) } });
  return script([
    { type: 'message_start', message: { usage: { ...usage } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...deltas,
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 30 } },
    { type: 'message_stop' },
  ]);
}

/** A child reply that answers and then stalls until its call is ended. */
function stallingReply(): Script {
  return script([
    { type: 'message_start', message: { usage: { ...usage } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Here is the first part of the list' } },
  ], true);
}

/** A tool the child can call, so its first call finishes and a second one follows. */
const lookupTool: ToolEntry = {
  definition: { name: 'lookup_orders', description: 'Look up orders', input_schema: { type: 'object' as const, properties: {} } },
  handler: () => Promise.resolve('3 orders'),
};

function lookupReply(): Script {
  return script([
    { type: 'message_start', message: { usage: { ...usage } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_lookup', name: 'lookup_orders', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ]);
}

const COPY = 'Sending it now:\n{"url": "https://shop.example.com/api/orders", "method": "POST", "body": "{\\"sku\\": \\"A-17\\"}"}\n';

const ENV_KEYS = ['LYNOX_DATA_DIR', 'LYNOX_VAULT_KEY', 'ANTHROPIC_API_KEY', 'LYNOX_MANAGED_INSTANCE_ID', 'LYNOX_EMBEDDING_PROVIDER'] as const;
const saved = new Map<string, string | undefined>();
const dirs: string[] = [];
const engines: Engine[] = [];
type Statics = { STREAM_TIMEOUT_MS: number };
const statics = Agent as unknown as Statics;
const DEFAULT_TIMEOUT_MS = statics.STREAM_TIMEOUT_MS;

function setEnv(key: string, value: string | undefined): void {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}

async function boot(): Promise<{ engine: Engine; session: Session; debits: Array<{ runId: string; usd: number }> }> {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-spawn-stop-'));
  dirs.push(dir);
  for (const k of ENV_KEYS) setEnv(k, undefined);
  setEnv('LYNOX_DATA_DIR', dir);
  setEnv('ANTHROPIC_API_KEY', 'test-key-not-real');
  setEnv('LYNOX_EMBEDDING_PROVIDER', 'local');
  reloadConfig();
  const engine = new Engine({} as LynoxConfig);
  engines.push(engine);
  await engine.init();
  engine.registerTool(lookupTool);
  // Every tenant debit passes `onAfterRun`: the run's own (the session) and a child's (through
  // the engine as metered host, under a fresh id).
  const debits: Array<{ runId: string; usd: number }> = [];
  engine.registerHooks({ onAfterRun: (runId: string, usd: number) => { debits.push({ runId, usd }); } });
  return { engine, session: engine.createSession(), debits };
}

afterEach(async () => {
  statics.STREAM_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
  onCall.fn = null;
  calls.length = 0;
  scripts.length = 0;
  for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
  engines.length = 0;
  for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  saved.clear();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
  reloadConfig();
}, 30_000);

type ChildInside = Agent & { costGuard: { capOnlyUSD: number }; sessionCounters: { costUSD: number } };

/**
 * Watches the second agent call (the child's first): the child agent itself, taken from the
 * session's abort scope, and the session counter at that instant, which is the spawn's
 * reservation (nothing else has booked onto the counter by then).
 */
function watchChild(session: Session): { child: () => ChildInside; reservation: () => number } {
  let child: ChildInside | undefined;
  let reservation = Number.NaN;
  onCall.fn = () => {
    if (calls.length !== 2) return;
    const main = session.getAgent()!;
    child = [...main.abortScope.members].find((m) => m !== main) as ChildInside | undefined;
    reservation = main.sessionCounters.costUSD;
  };
  return { child: () => { expect(child, 'the child agent was seen').toBeDefined(); return child!; }, reservation: () => reservation };
}

function rows(engine: Engine, session: Session): { parent: RunRecord; child: RunRecord } {
  const all = engine.getRunHistory()!.getRunsBySession(session.sessionId);
  const child = all.find((r) => r.spawn_parent_id);
  const parent = all.find((r) => !r.spawn_parent_id);
  expect(child, 'the child has a run row').toBeDefined();
  expect(parent, 'the parent has a run row').toBeDefined();
  return { parent: parent!, child: child! };
}

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 10));
}

/** The parent's own finished calls: the spawn call, plus the closing reply when there is one. */
function parentOwnCost(model: string, closing: boolean): number {
  return calculateCost(model, { input_tokens: closing ? 200 : 100, output_tokens: closing ? 50 : 20 });
}

/** A child reply that reaches its `message_delta` (so `turn_end` is handed on) and then stalls until its call is ended. */
function stallingAfterTurnEnd(): Script {
  return script([
    { type: 'message_start', message: { usage: { ...usage } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Here is the whole list' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 30 } },
  ], true);
}

describe('a spawned child whose own call is ended mid-stream', { timeout: 60_000 }, () => {
  it('stopped after its turn_end: the child row still carries the estimate, as a child\'s stream does not count turn_end usage', async () => {
    const { engine, session, debits } = await boot();
    const seen = watchChild(session);
    spawnReply();
    const childCall = stallingAfterTurnEnd();
    const turn = session.run('find the order list');
    await waitFor(() => childCall.yielded === childCall.events.length);
    const child = seen.child();
    session.abort();
    const err = await turn.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunAbortedError);

    const estimate = child.getHelperCostUsd();
    expect(child.costGuard.capOnlyUSD).toBeGreaterThan(0);
    // The call's turn_end went out, but nothing counted its usage for the child: the estimate
    // is the only place the call shows up, so it stays on the child's line.
    expect(estimate).toBeGreaterThan(0);
    expect(estimate).toBeLessThan(child.costGuard.capOnlyUSD);
    const { parent, child: childRow } = rows(engine, session);
    expect(childRow.cost_usd).toBeCloseTo(estimate, 12);
    expect(debits.filter((d) => d.runId !== parent.id)).toEqual([]);
  });

  it('stopped by the parent: the child row carries the estimate, the debit does not, the session cap holds only the reservation', async () => {
    const { engine, session, debits } = await boot();
    const seen = watchChild(session);
    spawnReply();
    const childCall = stallingReply();
    const turn = session.run('find the order list');
    await waitFor(() => childCall.yielded === childCall.events.length);
    const child = seen.child();
    const counters = child.sessionCounters;
    const reservation = seen.reservation();
    expect(reservation, 'the spawn reserved its estimate on the session counter').toBeGreaterThan(0);
    session.abort();
    const err = await turn.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunAbortedError);

    const bound = child.costGuard.capOnlyUSD;
    const estimate = child.getHelperCostUsd();
    expect(bound, "the child's stopped call was booked").toBeGreaterThan(0);
    expect(estimate).toBeGreaterThan(0);
    expect(estimate).toBeLessThan(bound);

    const { parent, child: childRow } = rows(engine, session);
    expect(childRow.status).toBe('aborted');
    // The child finished no call, so its own cost is 0 and its row is the estimate.
    expect(childRow.cost_usd).toBeCloseTo(estimate, 12);
    // The parent row is the parent's own call; the child's dollars are in the child row only.
    expect(parent.cost_usd).toBeCloseTo(parentOwnCost(parent.model_id, false), 12);
    // Nothing of the estimate reaches a debit: the parent's run is debited its own call, the
    // child (no finished call) nothing.
    expect(debits.filter((d) => d.runId === parent.id).map((d) => d.usd)).toEqual([parentOwnCost(parent.model_id, false)]);
    expect(debits.filter((d) => d.runId !== parent.id)).toEqual([]);
    // The session cap: the reservation stands for the child, the bound is not added on top.
    expect(counters.costUSD).toBeCloseTo(reservation, 12);
  });

  it("stopped by its own guard: same split, and the parent's display plus its children counts each dollar once", async () => {
    const { engine, session, debits } = await boot();
    const seen = watchChild(session);
    spawnReply();
    textReply(COPY.repeat(5), 9);
    textReply('The researcher could not finish.');
    await session.run('find the order list');
    const child = seen.child();
    const reservation = seen.reservation();
    const bound = child.costGuard.capOnlyUSD;
    const estimate = child.getHelperCostUsd();
    expect(bound).toBeGreaterThan(0);
    expect(estimate).toBeGreaterThan(0);

    const { parent, child: childRow } = rows(engine, session);
    expect(childRow.status).toBe('aborted');
    expect(childRow.stop_reason).toBe('tool_call_imitation');
    expect(childRow.cost_usd).toBeCloseTo(estimate, 12);
    const own = parentOwnCost(parent.model_id, true);
    expect(parent.cost_usd).toBeCloseTo(own, 12);
    // What the footer reads: the parent's display and its children, side by side. Their sum
    // holds the parent's calls once and the child's estimate once.
    const usageLine = session.getLastRunUsage();
    expect(usageLine?.costUsd).toBeCloseTo(own, 12);
    expect(usageLine?.spawnCostUsd).toBeCloseTo(estimate, 12);
    expect((usageLine?.costUsd ?? 0) + (usageLine?.spawnCostUsd ?? 0)).toBeCloseTo(own + estimate, 12);
    // The status bar's daily cost sums the rows: parent own + child (own 0 here) + E, each once.
    expect(engine.getRunHistory()!.getCostByDay(1)[0]?.cost_usd).toBeCloseTo(own + estimate, 12);
    expect(debits.filter((d) => d.runId === parent.id).map((d) => d.usd)).toEqual([own]);
    expect(debits.filter((d) => d.runId !== parent.id)).toEqual([]);
    expect(child.sessionCounters.costUSD).toBeCloseTo(reservation, 12);
  });

  it('ended by the stream timeout: the child row carries the estimate, the session cap holds only the reservation', async () => {
    const { engine, session, debits } = await boot();
    statics.STREAM_TIMEOUT_MS = 300;
    const seen = watchChild(session);
    spawnReply();
    stallingReply();
    textReply('The researcher timed out.');
    await session.run('find the order list');
    const child = seen.child();
    const reservation = seen.reservation();
    const bound = child.costGuard.capOnlyUSD;
    const estimate = child.getHelperCostUsd();
    expect(bound).toBeGreaterThan(0);
    expect(estimate).toBeGreaterThan(0);

    const { parent, child: childRow } = rows(engine, session);
    expect(childRow.status).toBe('failed');
    expect(childRow.cost_usd).toBeCloseTo(estimate, 12);
    const own = parentOwnCost(parent.model_id, true);
    expect(parent.cost_usd).toBeCloseTo(own, 12);
    expect(debits.filter((d) => d.runId === parent.id).map((d) => d.usd)).toEqual([own]);
    expect(debits.filter((d) => d.runId !== parent.id)).toEqual([]);
    expect(child.sessionCounters.costUSD).toBeCloseTo(reservation, 12);
  });

  it('stopped after a finished call: the child row is its own spend plus the estimate, the debit its own spend only', async () => {
    const { engine, session, debits } = await boot();
    const seen = watchChild(session);
    spawnReply();
    lookupReply();
    const ended = stallingReply();
    const turn = session.run('find the order list');
    await waitFor(() => ended.yielded === ended.events.length);
    const child = seen.child();
    const reservation = seen.reservation();
    session.abort();
    const err = await turn.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunAbortedError);

    const own = child.getCostSnapshot()?.ownCostUSD ?? 0;
    const estimate = child.getHelperCostUsd();
    const { parent, child: childRow } = rows(engine, session);
    // The finished call is the child's own spend, priced from its tokens.
    expect(own).toBeCloseTo(calculateCost(childRow.model_id, { input_tokens: 100, output_tokens: 20 }), 12);
    expect(own).toBeGreaterThan(0);
    expect(estimate).toBeGreaterThan(0);
    expect(child.costGuard.capOnlyUSD).toBeGreaterThan(0);
    expect(childRow.status).toBe('aborted');
    // Both terms, added: not the larger of the two, not either alone.
    expect(childRow.cost_usd).toBeCloseTo(own + estimate, 12);
    const parentOwn = parentOwnCost(parent.model_id, false);
    expect(parent.cost_usd).toBeCloseTo(parentOwn, 12);
    // The status bar's daily cost sums the rows: each of parent own, child own and E once.
    expect(engine.getRunHistory()!.getCostByDay(1)[0]?.cost_usd).toBeCloseTo(parentOwn + own + estimate, 12);
    // The debit: the parent's own call and the child's own finished call, no estimate.
    expect(debits.filter((d) => d.runId === parent.id).map((d) => d.usd)).toEqual([parentOwn]);
    const childDebits = debits.filter((d) => d.runId !== parent.id).map((d) => d.usd);
    expect(childDebits).toHaveLength(1);
    expect(childDebits[0]).toBeCloseTo(own, 12);
    expect(child.sessionCounters.costUSD).toBeCloseTo(reservation, 12);
  });
});

describe('the bounds an agent took back off the session counter are per run', { timeout: 30_000 }, () => {
  it('a finished run after a stopped one reports none', async () => {
    const counters = { costUSD: 0, spawnCount: 0, spawnCostUSD: 0 } as unknown as import('../../types/agent.js').SessionCounters;
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', costGuard: { maxBudgetUSD: 100 }, sessionCounters: counters });
    const ended = stallingReply();
    const first = agent.send('list everything');
    await waitFor(() => ended.yielded === ended.events.length);
    agent.abort();
    expect(await first.catch((e: unknown) => e)).toBeInstanceOf(RunAbortedError);
    const booked = agent.getStoppedCallSessionCostUsd();
    expect(booked, 'the stopped call put its bound on the counter').toBeGreaterThan(0);
    expect(counters.costUSD).toBeCloseTo(booked, 12);

    textReply('All done.');
    await agent.send('and now finish');
    expect(agent.getStoppedCallSessionCostUsd(), 'the second run ended no call').toBe(0);
  });
});
