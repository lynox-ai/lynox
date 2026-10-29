/**
 * 660a-3 K4 — what the end of a mandate's turn writes on its own, and under whom.
 *
 *  - E1 (durable knowledge): the recovery pass writes each fact under a `capture#durable` row of
 *    its own, before the write; a fact whose row cannot be written is not written, counted as
 *    `trail_unavailable`, and the facts after it go on (B6).
 *  - E2 (legacy extraction): `maybeUpdate` writes each namespace under a `capture#extract` row;
 *    settled one by one (B8/B8′), so a refused namespace costs only itself and is no error.
 *  - The actor is read once, at the end of the turn, and handed on as a value (B7 — synthetic:
 *    the session's drain runs before the next run sets the principal, so the switch below is
 *    made by hand between the end of the turn and the write).
 *  - B3: a `spawn_agent` child and a workflow step of a mandate end their turns as the mandate.
 *  - The owner leaves no row.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const sdk = vi.hoisted(() => ({ reply: null as null | (() => Promise<unknown>) }));
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = { messages: { stream: () => ({ finalMessage: () => (sdk.reply ? sdk.reply() : Promise.resolve({ content: [], usage: {} })) }) } };
  }
  class APIError extends Error {}
  return { default: MockAnthropic, APIError };
});
const mockProcess = vi.hoisted(() => vi.fn());
vi.mock('./stream.js', () => ({
  StreamProcessor: vi.fn().mockImplementation(function (this: { process: typeof mockProcess }) { this.process = mockProcess; }),
}));
vi.mock('../tools/permission-guard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tools/permission-guard.js')>()),
  isDangerous: vi.fn().mockReturnValue(null),
  isDangerousDetailed: vi.fn().mockReturnValue(null),
}));
vi.mock('./tier-resolver.js', async () => {
  const actual = await vi.importActual<typeof import('./tier-resolver.js')>('./tier-resolver.js');
  return { ...actual, resolveTierModel: () => ({ provider: 'anthropic', modelId: 'claude-haiku-4-5-20251001' }) };
});
const telemetry = vi.hoisted(() => ({ lines: [] as Array<Record<string, unknown>> }));
vi.mock('./capture-telemetry.js', async () => {
  const actual = await vi.importActual<typeof import('./capture-telemetry.js')>('./capture-telemetry.js');
  return { ...actual, appendCaptureTelemetry: vi.fn(async (_on: boolean, line: Record<string, unknown>) => { telemetry.lines.push(line); }) };
});
vi.mock('./metered-request.js', async () => {
  const actual = await vi.importActual<typeof import('./metered-request.js')>('./metered-request.js');
  return { ...actual, debitInRunHelperCost: vi.fn() };
});

import { testAuditLog, type TestAuditLog } from '../../tests/helpers/audit-log.js';
import { Agent } from './agent.js';
import { AuditLog } from './audit-log.js';
import { Memory } from './memory.js';
import { createToolContext } from './tool-context.js';
import { channels, type MemoryStoreMessage } from './observability.js';
import { CAPTURE_TOOL_NAME } from './capture-fallback.js';
import { OWNER_PRINCIPAL, type RequestPrincipal } from './request-principal.js';
import { spawnAgentTool } from '../tools/builtin/spawn.js';
import { spawnInline } from '../orchestrator/runtime-adapter.js';
import type { IAgent, LynoxUserConfig } from '../types/index.js';
import type { ManifestStep } from '../orchestrator/types.js';

const MANDATE: RequestPrincipal = { kind: 'mandate', email: 'setup@example.org', mandateId: 'M-1' };
const ANSWER = 'Habe die Offerte an Veltamare geschickt. Petra ist dort die Ansprechperson für Bestellungen.';
const QUESTION = 'schick die offerte an veltamare';
const uuid = (n: number): string => `abcd1234-0000-4000-8000-${String(n).padStart(12, '0')}`;

interface Internals {
  _captureAtTurnEnd(text: string): void;
  _pendingMemory: Array<Promise<unknown>>;
  client: unknown;
  messages: Array<{ role: string; content: unknown }>;
  toolContext: Record<string, unknown>;
}

/** A log whose `nth` attempt row (1-based) of `site` cannot be written; every other row can. */
function failingNth(log: TestAuditLog, site: string, nth: number): AuditLog {
  let seen = 0;
  const real = log.log;
  return new Proxy(real, {
    get(target, prop) {
      if (prop !== 'record') return Reflect.get(target, prop, target) as unknown;
      return (e: Parameters<AuditLog['record']>[0]) => {
        if (e.phase === 'attempt' && e.action.startsWith(`instance:${site}:`) && ++seen === nth) throw new Error('disk full');
        return real.record(e);
      };
    },
  });
}
const rowsOf = (log: TestAuditLog, site: string) => log.rows().filter(r => r.action.startsWith(`instance:${site}:`));

let stderr: ReturnType<typeof vi.spyOn>;
const stderrText = (): string => stderr.mock.calls.map(c => String(c[0])).join('');
beforeEach(() => {
  telemetry.lines = [];
  sdk.reply = null;
  mockProcess.mockReset();
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => { stderr.mockRestore(); });

// ── E1: the durable recovery pass ──────────────────────────────────────────────────────────────

function factsReply(texts: string[]): () => Promise<unknown> {
  return async () => ({
    content: [{ type: 'tool_use', id: 'c1', name: CAPTURE_TOOL_NAME, input: { facts: texts.map(text => ({ text, subject: 'Veltamare', source: 'user_stated' })) } }],
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

/** An agent at the end of a turn on a durable-knowledge instance, with the recovery pass on. */
function dkAgent(principal: RequestPrincipal, auditLog: AuditLog): { agent: Agent; inner: Agent & Internals; write: ReturnType<typeof vi.fn> } {
  let n = 0;
  const write = vi.fn(() => ({ id: uuid(++n), status: 'active' }));
  const toolContext = createToolContext({} as never);
  toolContext.auditLog = auditLog;
  const agent = new Agent({
    name: 'test', model: 'claude-sonnet-4-6', principal, currentRunId: 'run-1', toolContext, durableMemoryEnabled: true,
    memory: { maybeUpdate: vi.fn() } as never,
  });
  const inner = agent as unknown as Agent & Internals;
  inner.toolContext['knowledgeStore'] = { write };
  inner.client = { beta: { messages: { stream: () => ({ finalMessage: () => sdk.reply!() }) } } };
  inner.messages = [
    { role: 'user', content: [{ type: 'text', text: QUESTION }] },
    { role: 'assistant', content: [{ type: 'text', text: ANSWER }] },
  ];
  agent.captureFallback = true;
  return { agent, inner, write };
}

describe('E1: each recovered fact under its own capture#durable row', () => {
  it('a mandate\'s turn end: one row per fact, before the write, under the mandate, auto=1', async () => {
    const log = testAuditLog();
    sdk.reply = factsReply(['Petra Meier ist bei Veltamare die Ansprechperson für Bestellungen.']);
    const { inner, write } = dkAgent(MANDATE, log.log);
    write.mockImplementation(() => {
      expect(rowsOf(log, 'capture#durable').map(r => r.phase)).toEqual(['attempt']);
      return { id: uuid(1), status: 'active' };
    });
    inner._captureAtTurnEnd(ANSWER);
    await Promise.all(inner._pendingMemory);
    expect(write).toHaveBeenCalledTimes(1);
    const rows = rowsOf(log, 'capture#durable');
    expect(rows.map(r => [r.phase, r.actor_kind, r.actor_email, r.run_id])).toEqual([
      ['attempt', 'mandate', 'setup@example.org', 'run-1'], ['returned', 'mandate', 'setup@example.org', 'run-1'],
    ]);
    expect(rows.map(r => r.target)).toEqual(['knowledge auto=1', `knowledge wrote=all created=${uuid(1)} auto=1`]);
  });

  it('the owner: the fact is written, no row', async () => {
    const log = testAuditLog();
    sdk.reply = factsReply(['Petra Meier ist bei Veltamare die Ansprechperson für Bestellungen.']);
    const { inner, write } = dkAgent(OWNER_PRINCIPAL, log.log);
    inner._captureAtTurnEnd(ANSWER);
    await Promise.all(inner._pendingMemory);
    expect(write).toHaveBeenCalledTimes(1);
    expect(log.rows()).toEqual([]);
  });

  it('fail-closed: a log that refuses the row → no write, counted as trail_unavailable', async () => {
    const log = testAuditLog();
    sdk.reply = factsReply(['Petra Meier ist bei Veltamare die Ansprechperson für Bestellungen.']);
    const { inner, write } = dkAgent(MANDATE, failingNth(log, 'capture#durable', 1));
    inner._captureAtTurnEnd(ANSWER);
    await Promise.all(inner._pendingMemory);
    expect(write).not.toHaveBeenCalled();
    expect(telemetry.lines.filter(l => l['event'] === 'capture_suppressed').map(l => l['reason'])).toEqual(['trail_unavailable']);
  });

  it('B6: three facts, the log refuses the second row → facts 1 and 3 written, 2 not, one trail_unavailable', async () => {
    const log = testAuditLog();
    const facts = [
      'Petra Meier ist bei Veltamare die Ansprechperson für Bestellungen.',
      'Veltamare bestellt quartalsweise im ersten Monat des Quartals.',
      'Rechnungen an Veltamare gehen an die Buchhaltung in Basel.',
    ];
    sdk.reply = factsReply(facts);
    const { inner, write } = dkAgent(MANDATE, failingNth(log, 'capture#durable', 2));
    inner._captureAtTurnEnd(ANSWER);
    await Promise.all(inner._pendingMemory);
    expect(write.mock.calls.map(c => (c[0] as { text: string }).text)).toEqual([facts[0], facts[2]]);
    expect(telemetry.lines.filter(l => l['event'] === 'capture_suppressed').map(l => l['reason'])).toEqual(['trail_unavailable']);
    expect(rowsOf(log, 'capture#durable').map(r => r.phase)).toEqual(['attempt', 'returned', 'attempt', 'returned']);
    expect(stderrText()).not.toContain('[lynox:capture-fallback]');
  });

  it('B7 (synthetic): the principal switched between the end of the turn and the write — the row names the mandate', async () => {
    const log = testAuditLog();
    sdk.reply = factsReply(['Petra Meier ist bei Veltamare die Ansprechperson für Bestellungen.']);
    const { agent, inner, write } = dkAgent(MANDATE, log.log);
    inner._captureAtTurnEnd(ANSWER);
    // By hand: in the session the drain runs before the next run sets this.
    agent.principal = OWNER_PRINCIPAL;
    agent.currentRunId = 'run-2';
    await Promise.all(inner._pendingMemory);
    expect(write).toHaveBeenCalledTimes(1);
    expect(rowsOf(log, 'capture#durable').map(r => [r.actor_kind, r.run_id])).toEqual([['mandate', 'run-1'], ['mandate', 'run-1']]);
  });
});

// ── E2: the legacy extraction, one row per namespace ───────────────────────────────────────────

describe('E2: maybeUpdate writes each namespace under its own capture#extract row', () => {
  const dirs: string[] = [];
  let published: MemoryStoreMessage[] = [];
  let extraction: Array<{ status: string }> = [];
  const onStore = (m: unknown): void => { published.push(m as MemoryStoreMessage); };
  const onExtraction = (m: unknown): void => { extraction.push(m as { status: string }); };
  beforeEach(() => {
    published = []; extraction = [];
    channels.memoryStore.subscribe(onStore);
    channels.memoryExtraction.subscribe(onExtraction);
    sdk.reply = async () => ({ content: [{ type: 'text', text: '{"knowledge": "Veltamare orders quarterly in the first month.", "methods": "Offers go out as PDF with a two-week validity."}' }] });
  });
  afterEach(() => {
    channels.memoryStore.unsubscribe(onStore);
    channels.memoryExtraction.unsubscribe(onExtraction);
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const memory = (): Memory => { const d = mkdtempSync(join(tmpdir(), 'lynox-660a3-mem-')); dirs.push(d); return new Memory(d); };
  const LONG = `${ANSWER} ${'Details zur Bestellung folgen. '.repeat(12)}`;

  it('two namespaces → two rows under the mandate, each publish naming its own row', async () => {
    const log = testAuditLog();
    const mem = memory();
    await mem.maybeUpdate(LONG, 1, 't-1', 'run-1', undefined, { principal: MANDATE, runId: 'run-1' }, log.log);
    const rows = rowsOf(log, 'capture#extract');
    expect(rows.map(r => [r.phase, r.actor_kind, r.target?.replace(/ wrote=all/, '')])).toEqual([
      ['attempt', 'mandate', 'memory ns=knowledge auto=1'], ['attempt', 'mandate', 'memory ns=methods auto=1'],
      ['returned', 'mandate', 'memory ns=knowledge auto=1'], ['returned', 'mandate', 'memory ns=methods auto=1'],
    ]);
    expect(published.map(p => [p.namespace, p.actor?.principal.kind, p.trail?.site])).toEqual([['knowledge', 'mandate', 'capture#extract'], ['methods', 'mandate', 'capture#extract']]);
    const attempts = rows.filter(r => r.phase === 'attempt').map(r => r.correlation_id);
    expect(published.map(p => p.trail?.correlationId)).toEqual(attempts);
    expect(await mem.load('knowledge')).toContain('Veltamare orders quarterly');
    expect(extraction).toEqual([{ status: 'success', entries: 2 }]);
  });

  it('B8: the second namespace\'s row refused → the first written and published, the second not, no error', async () => {
    const log = testAuditLog();
    const mem = memory();
    await mem.maybeUpdate(LONG, 1, 't-1', 'run-1', undefined, { principal: MANDATE, runId: 'run-1' }, failingNth(log, 'capture#extract', 2));
    expect(await mem.load('knowledge')).toContain('Veltamare orders quarterly');
    expect(await mem.load('methods') ?? '').not.toContain('two-week validity');
    expect(published.map(p => p.namespace)).toEqual(['knowledge']);
    expect(extraction).toEqual([{ status: 'success', entries: 1 }]);
    expect(stderrText()).toContain('[lynox:trail] auto extraction for methods refused: its row could not be written');
  });

  it('B8′: a real failure of one namespace still reports an error, and the other lands; both said', async () => {
    const log = testAuditLog();
    const mem = memory();
    const append = mem.append.bind(mem);
    vi.spyOn(mem, 'append').mockImplementation(async (ns, text) => {
      if (ns === 'methods') throw new Error('disk gone');
      return append(ns, text);
    });
    await mem.maybeUpdate(LONG, 1, 't-1', 'run-1', undefined, { principal: MANDATE, runId: 'run-1' }, log.log);
    expect(await mem.load('knowledge')).toContain('Veltamare orders quarterly');
    expect(extraction.map(e => e.status)).toEqual(['error']);
    expect(stderrText()).toContain('[lynox:memory] auto extraction for methods failed: disk gone');
  });

  it('the owner: written and published, no row', async () => {
    const log = testAuditLog();
    const mem = memory();
    await mem.maybeUpdate(LONG, 1, 't-1', 'run-1', undefined, { principal: OWNER_PRINCIPAL, runId: 'run-1' }, log.log);
    expect(log.rows()).toEqual([]);
    expect(published.map(p => [p.namespace, p.actor?.principal.kind, p.trail])).toEqual([['knowledge', 'owner', undefined], ['methods', 'owner', undefined]]);
  });

  it('the agent hands its turn\'s actor and log to maybeUpdate, held as a value (B7, synthetic)', async () => {
    const log = testAuditLog();
    const mem = memory();
    const toolContext = createToolContext({} as never);
    toolContext.auditLog = log.log;
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', principal: MANDATE, currentRunId: 'run-1', toolContext, memory: mem });
    const inner = agent as unknown as Agent & Internals;
    inner._captureAtTurnEnd(LONG);
    agent.principal = OWNER_PRINCIPAL;
    await Promise.all(inner._pendingMemory);
    expect(rowsOf(log, 'capture#extract').map(r => r.actor_kind)).toEqual(['mandate', 'mandate', 'mandate', 'mandate']);
  });
});

// ── B3: a child and a step of a mandate end their turns as the mandate ────────────────────────

const endTurn = (text: string): unknown => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } });

describe('B3: a mandate\'s spawn_agent child and workflow step reach the end of their turn as the mandate', () => {
  it('a spawn_agent child: the extraction at its turn end is handed the mandate', async () => {
    const maybeUpdate = vi.fn(async () => {});
    const memory = {
      load: vi.fn(), append: vi.fn(), delete: vi.fn(async () => 0), update: vi.fn(async () => false), render: vi.fn(() => ''),
      hasContent: vi.fn(() => false), loadAll: vi.fn(), maybeUpdate, appendScoped: vi.fn(), loadScoped: vi.fn(),
      deleteScoped: vi.fn(async () => 0), updateScoped: vi.fn(async () => false),
    };
    const parent = new Agent({ name: 'parent', model: 'claude-sonnet-4-6', principal: MANDATE, currentRunId: 'run-p', memory: memory as never, toolContext: createToolContext({ api_key: 'test-key' } as never) });
    mockProcess.mockResolvedValue(endTurn(`${ANSWER} Der Bericht ist fertig und liegt im Ordner.`));
    await spawnAgentTool.handler({ agents: [{ name: 'child', task: 'Analyze the offer' }] }, parent as unknown as IAgent);
    expect(maybeUpdate).toHaveBeenCalled();
    const actors = maybeUpdate.mock.calls.map(c => (c as unknown[])[5] as { principal: RequestPrincipal } | undefined);
    expect(actors.map(a => a?.principal)).toContainEqual(MANDATE);
    expect(actors.every(a => a?.principal.kind === 'mandate')).toBe(true);
  });

  it('a workflow step: the step agent\'s extraction at its turn end is handed the mandate', async () => {
    const maybeUpdate = vi.fn(async () => {});
    const memory = {
      load: vi.fn(), append: vi.fn(), delete: vi.fn(async () => 0), update: vi.fn(async () => false), render: vi.fn(() => ''),
      hasContent: vi.fn(() => false), loadAll: vi.fn(), maybeUpdate, appendScoped: vi.fn(), loadScoped: vi.fn(),
      deleteScoped: vi.fn(async () => 0), updateScoped: vi.fn(async () => false),
    };
    mockProcess.mockResolvedValue(endTurn(`${ANSWER} Die Zusammenfassung des Schritts ist fertig.`));
    const step: ManifestStep = { id: 'collect', agent: 'collect', runtime: 'inline', task: 'summarise', role: 'collector' };
    const config = { api_key: 'test-key' } as unknown as LynoxUserConfig;
    // The parent's memory in its place (9th), the run's principal in its own (17th).
    await spawnInline(step, {}, config, [], undefined, undefined, undefined, undefined, memory as never, undefined, undefined, undefined, undefined, undefined, undefined, undefined, MANDATE);
    expect(maybeUpdate).toHaveBeenCalledTimes(1);
    expect(((maybeUpdate.mock.calls[0] as unknown[])[5] as { principal: RequestPrincipal }).principal).toEqual(MANDATE);
  });
});
