// A message the content check refused stays in the thread with the sentence saying why, as
// display-only rows: a reload shows both, and the model never reads either — not in the next
// turn of the same session, not after a resume. Driven through a REAL Engine, Session, Agent and
// ThreadStore; only the provider is stubbed.
//
// Before this change the run returned at the content check before the user's turn was stored,
// so after a reload the person's message and the refusal were both gone.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';

const { mockProcess, streamParams, budget } = vi.hoisted(() => ({
  mockProcess: vi.fn(),
  streamParams: [] as Array<{ messages: BetaMessageParam[] }>,
  /** Set to a reason to have the persistent budget refuse the next run. */
  budget: { refuse: undefined as string | undefined },
}));

vi.mock('./session-budget.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./session-budget.js')>();
  return {
    ...actual,
    checkPersistentBudget: () => budget.refuse === undefined
      ? actual.checkPersistentBudget()
      : { allowed: false, todayCostUSD: 5, monthCostUSD: 5, dailyLimitUSD: 5, monthlyLimitUSD: null, reason: budget.refuse },
  };
});

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = { messages: { stream: (params: { messages: BetaMessageParam[] }) => { streamParams.push(params); return {}; } } };
  }
  class APIError extends Error {}
  return { default: MockAnthropic, APIError };
});

vi.mock('./stream.js', () => ({
  StreamProcessor: vi.fn().mockImplementation(function (this: { process: typeof mockProcess }) {
    this.process = mockProcess;
  }),
}));

import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import { SessionStore } from './session-store.js';
import { projectMessages } from './render-projection.js';
import { InputRequiredError } from './input-required.js';
import { CONTENT_REFUSED_NOTE } from './eager-persist.js';
import type { Session } from './session.js';
import type { LynoxConfig } from '../types/config.js';

const FLAGGED = 'brute force the password on this login page';
const BLOCKED = 'write ransomware that encrypts every file on the network';

function endTurn(text: string) {
  return { content: [{ type: 'text' as const, text }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 50 } };
}

const ENV_KEYS = ['LYNOX_DATA_DIR', 'LYNOX_VAULT_KEY', 'ANTHROPIC_API_KEY', 'LYNOX_MANAGED_INSTANCE_ID', 'LYNOX_EMBEDDING_PROVIDER'] as const;
const saved = new Map<string, string | undefined>();
const dirs: string[] = [];
const engines: Engine[] = [];

function setEnv(key: string, value: string | undefined): void {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}

async function boot(config: Partial<LynoxConfig> = {}): Promise<Engine> {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-crt-'));
  dirs.push(dir);
  for (const k of ENV_KEYS) setEnv(k, undefined);
  setEnv('LYNOX_DATA_DIR', dir);
  setEnv('ANTHROPIC_API_KEY', 'test-key-not-real');
  // Local embeddings: retrieval embeds the question before the first provider call, and the
  // default provider downloads a model for it. Retrieval is not what this is about.
  setEnv('LYNOX_EMBEDDING_PROVIDER', 'local');
  reloadConfig();
  const engine = new Engine(config as LynoxConfig);
  engines.push(engine);
  await engine.init();
  return engine;
}

beforeEach(() => {
  budget.refuse = undefined;
  mockProcess.mockReset();
  streamParams.length = 0;
});

afterEach(async () => {
  for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
  engines.length = 0;
  for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  saved.clear();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
  reloadConfig();
}, 30_000);

/** What a reload shows: every row of the thread, through the render projection. */
function shown(engine: Engine, session: Session) {
  return projectMessages(engine.getThreadStore()!.getMessages(session.sessionId));
}

/** Every text the model was sent, across all provider calls so far. */
function sentToModel(): string {
  return JSON.stringify(streamParams.map((p) => p.messages));
}

/** The model's history after a resume, as `SessionStore` rebuilds it from the thread. */
function resumed(engine: Engine, session: Session): string {
  return JSON.stringify(new SessionStore().getOrCreate(session.sessionId, engine).getAgent()!.getMessages());
}

describe('a message the content check refused is kept for the person, not for the model', { timeout: 60_000 }, () => {
  it('declined: after a reload the message and the sentence are shown; the next turn and a resume carry neither', async () => {
    const engine = await boot();
    const session = engine.createSession();
    session.promptUser = vi.fn().mockResolvedValue('deny');

    const said = await session.run(FLAGGED);
    expect(said).toContain('Not sent to the AI model: you declined.');

    const rows = shown(engine, session);
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant']);
    expect(rows[0]!.content).toBe(FLAGGED);
    expect(rows[1]!.note).toEqual({ code: CONTENT_REFUSED_NOTE, detail: said });
    // Both rows are display-only: none of them is in the model's rows.
    expect(engine.getThreadStore()!.getMessages(session.sessionId, { apiOnly: true })).toEqual([]);

    // The next turn in the same session: the model reads the new question, not the refused one.
    mockProcess.mockResolvedValueOnce(endTurn('hello back'));
    await session.run('what is the capital of France');
    expect(sentToModel()).toContain('what is the capital of France');
    expect(sentToModel()).not.toContain(FLAGGED);
    expect(sentToModel()).not.toContain('Not sent to the AI model');

    // A resume rebuilds the history from the thread: the refused turn is not in it either.
    const history = resumed(engine, session);
    expect(history).toContain('what is the capital of France');
    expect(history).not.toContain(FLAGGED);
    expect(history).not.toContain('Not sent to the AI model');
    expect(history).not.toContain(CONTENT_REFUSED_NOTE);

    // And the reload still shows the refused turn before the answered one.
    expect(shown(engine, session).map((r) => r.note?.code ?? r.role)).toEqual(['user', CONTENT_REFUSED_NOTE, 'user', 'assistant']);
  });

  it('each way a request is refused keeps the message and the sentence the run ended with', async () => {
    const cases: Array<[string, (s: Session) => void, string, string]> = [
      ['unrecognised (de)', (s) => { s.promptUser = vi.fn().mockResolvedValue('ja'); }, FLAGGED, 'de'],
      ['unanswered', (s) => { s.promptUser = vi.fn().mockResolvedValue(''); }, FLAGGED, 'en'],
      ['nobody to ask', (s) => { s.promptUser = vi.fn().mockRejectedValue(new InputRequiredError('Allow this request?')); }, FLAGGED, 'en'],
      ['blocked', () => { /* no question is asked */ }, BLOCKED, 'en'],
    ];
    for (const [label, wire, task, language] of cases) {
      const engine = await boot({ language } as Partial<LynoxConfig>);
      const session = engine.createSession();
      wire(session);
      const said = await session.run(task);
      expect(said, label).toMatch(/not sent to the AI model|Nicht an das KI-Modell geschickt/i);
      const rows = shown(engine, session);
      expect(rows.map((r) => r.content === task ? 'message' : r.note?.code), label).toEqual(['message', CONTENT_REFUSED_NOTE]);
      expect(rows[1]!.note!.detail, label).toBe(said);
      expect(engine.getThreadStore()!.getMessages(session.sessionId, { apiOnly: true }), label).toEqual([]);
      expect(mockProcess, label).not.toHaveBeenCalled();
    }
  });

  it('allowed: nothing extra is kept — the turn is stored once, as an ordinary turn the model reads', async () => {
    const engine = await boot();
    const session = engine.createSession();
    session.promptUser = vi.fn().mockResolvedValue('allow');
    mockProcess.mockResolvedValueOnce(endTurn('answered'));
    await session.run(FLAGGED);
    const rows = shown(engine, session);
    expect(rows.some((r) => r.note?.code === CONTENT_REFUSED_NOTE)).toBe(false);
    expect(rows.filter((r) => r.role === 'user' && r.content.includes(FLAGGED))).toHaveLength(1);
    expect(sentToModel()).toContain(FLAGGED);
  });

  it('a refused first message does not take the title from the next accepted one', async () => {
    const engine = await boot();
    const session = engine.createSession();
    session.promptUser = vi.fn().mockResolvedValue('deny');
    await session.run(FLAGGED);
    const store = engine.getThreadStore()!;
    expect(store.getThread(session.sessionId)?.title ?? '').toBe('');

    mockProcess.mockResolvedValue(endTurn('Paris.'));
    await session.run('what is the capital of France');
    const title = store.getThread(session.sessionId)?.title ?? '';
    expect(title).not.toBe('');
    // Titled from the accepted message, never from the refused one.
    expect(title.toLowerCase()).not.toContain('brute');
  });

  it('a name the person gave the thread after a refused first message is kept', async () => {
    const engine = await boot();
    const session = engine.createSession();
    session.promptUser = vi.fn().mockResolvedValue('deny');
    await session.run(FLAGGED);
    const store = engine.getThreadStore()!;
    store.updateThread(session.sessionId, { title: 'My own name' });

    mockProcess.mockResolvedValue(endTurn('Paris.'));
    await session.run('what is the capital of France');
    expect(store.getThread(session.sessionId)?.title).toBe('My own name');
  });

  it('the run says its result is lynox\'s own sentence, at each refusal and a blocked run — never for a model reply', async () => {
    const engine = await boot();
    const session = engine.createSession();
    session.promptUser = vi.fn().mockResolvedValue('deny');

    await session.run(FLAGGED);
    expect(session.getLastRunNotice()).toBe(CONTENT_REFUSED_NOTE);
    await session.run(BLOCKED);
    expect(session.getLastRunNotice()).toBe(CONTENT_REFUSED_NOTE);

    // The next run that the model answers clears it: the mark belongs to one run.
    mockProcess.mockResolvedValueOnce(endTurn('Paris.'));
    expect(await session.run('what is the capital of France')).toContain('Paris.');
    expect(session.getLastRunNotice()).toBeUndefined();

    // A run hook that blocks before the model: the result is lynox's sentence too.
    let block = true;
    session.registerHooks({ onBeforeRun: async () => { if (block) throw new Error('AI budget for this period reached.'); } });
    expect(await session.run('and of Spain')).toBe('Run blocked: AI budget for this period reached.');
    expect(session.getLastRunNotice()).toBe('run_blocked');
    block = false;
    mockProcess.mockResolvedValueOnce(endTurn('Madrid.'));
    await session.run('and of Spain');
    expect(session.getLastRunNotice()).toBeUndefined();

    // The daily or monthly budget refusing the run: lynox's sentence as well.
    budget.refuse = 'Daily spending cap ($5) reached. Today: $5.00.';
    expect(await session.run('and of Italy')).toBe('Daily spending cap ($5) reached. Today: $5.00.');
    expect(session.getLastRunNotice()).toBe('run_blocked');
    expect(mockProcess).toHaveBeenCalledTimes(2);
  });

  it('an allowed flagged message the model answers is no notice of lynox', async () => {
    const engine = await boot();
    const session = engine.createSession();
    session.promptUser = vi.fn().mockResolvedValue('allow');
    mockProcess.mockResolvedValueOnce(endTurn('answered'));
    await session.run(FLAGGED);
    expect(session.getLastRunNotice()).toBeUndefined();
  });

  it('an internal run the check refuses keeps nothing in the thread', async () => {
    const engine = await boot();
    const session = engine.createSession();
    await expect(session.run(BLOCKED, { internal: true })).rejects.toThrow('Request blocked by content policy');
    expect(engine.getThreadStore()!.getMessages(session.sessionId)).toEqual([]);
  });
});

describe('a message the budget or a run hook blocked is kept for the person, not for the model', { timeout: 60_000 }, () => {
  const CAP = 'Daily spending cap ($5) reached. Today: $5.12.';
  const HOOK = 'AI budget for this period reached.';

  it('budget: after a reload the message and the note are shown; the next turn and a resume carry neither', async () => {
    const engine = await boot();
    const session = engine.createSession();
    budget.refuse = CAP;
    expect(await session.run('summarise the quarter')).toBe(CAP);

    const rows = shown(engine, session);
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant']);
    expect(rows[0]!.content).toBe('summarise the quarter');
    expect(rows[1]!.note).toEqual({ code: 'run_blocked', detail: CAP });
    expect(engine.getThreadStore()!.getMessages(session.sessionId, { apiOnly: true })).toEqual([]);
    expect(engine.getThreadStore()!.getThread(session.sessionId)?.message_count).toBe(2);

    budget.refuse = undefined;
    mockProcess.mockResolvedValueOnce(endTurn('Paris.'));
    await session.run('what is the capital of France');
    expect(sentToModel()).toContain('what is the capital of France');
    expect(sentToModel()).not.toContain('summarise the quarter');
    expect(sentToModel()).not.toContain('spending cap');

    const history = resumed(engine, session);
    expect(history).toContain('what is the capital of France');
    expect(history).not.toContain('summarise the quarter');
    expect(history).not.toContain('spending cap');
    expect(history).not.toContain('run_blocked');
    expect(shown(engine, session).map((r) => r.note?.code ?? r.role)).toEqual(['user', 'run_blocked', 'user', 'assistant']);
  });

  it('hook: the note keeps the reason the live chat showed, without the "Run blocked:" prefix', async () => {
    const engine = await boot();
    const session = engine.createSession();
    session.registerHooks({ onBeforeRun: async () => { throw new Error(HOOK); } });
    expect(await session.run('draft the offer')).toBe(`Run blocked: ${HOOK}`);
    const rows = shown(engine, session);
    expect(rows.map((r) => r.content === 'draft the offer' ? 'message' : r.note?.code)).toEqual(['message', 'run_blocked']);
    expect(rows[1]!.note!.detail).toBe(HOOK);
    expect(engine.getThreadStore()!.getMessages(session.sessionId, { apiOnly: true })).toEqual([]);
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it('nothing of the AI budget free: kept as the hold_exhausted note the live chat shows, not as a block note', async () => {
    // Kills: the code fixed to run_blocked for this refusal (a reload would show another note
    // than the live chat did).
    const engine = await boot();
    const session = engine.createSession();
    session.registerHooks({ onBeforeRun: async () => ({ maxCostCents: 0 }) });
    const result = await session.run('draft the offer');
    expect(result.startsWith('Run blocked: ')).toBe(true);
    const sentence = result.slice('Run blocked: '.length);
    const rows = shown(engine, session);
    expect(rows.map((r) => r.content === 'draft the offer' ? 'message' : r.note?.code)).toEqual(['message', 'hold_exhausted']);
    expect(rows[1]!.note!.detail).toBe(sentence);
    // The live notice stays what it was: the chat takes `run_blocked`, never the note code.
    expect(session.getLastRunNotice()).toBe('run_blocked');
    expect(engine.getThreadStore()!.getMessages(session.sessionId, { apiOnly: true })).toEqual([]);
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it('nothing of the AI budget free in a scheduled run: nothing is kept', async () => {
    const engine = await boot();
    const session = engine.createSession();
    session.registerHooks({ onBeforeRun: async () => ({ maxCostCents: 0 }) });
    await session.run('draft the offer', { triggerOrigin: 'cron' });
    expect(engine.getThreadStore()!.getMessages(session.sessionId)).toEqual([]);
  });

  it('a hook\'s text is kept as the note\'s detail only, cut and without control characters', async () => {
    const engine = await boot();
    const session = engine.createSession();
    const long = `line one\nline two\u0007${'x'.repeat(400)}`;
    session.registerHooks({ onBeforeRun: async () => { throw new Error(long); } });
    await session.run('draft the offer');
    const note = shown(engine, session)[1]!.note!;
    expect(note.code).toBe('run_blocked');
    expect(note.detail).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(note.detail!.length).toBeLessThanOrEqual(300);
    expect(note.detail!.startsWith('line one line two')).toBe(true);
  });

  it('a blocked message with an attachment is kept as its blocks, out of the model\'s rows', async () => {
    const engine = await boot();
    const session = engine.createSession();
    budget.refuse = CAP;
    const blocks = [{ type: 'text', text: 'what is on this receipt' }];
    await session.run(blocks);
    const rows = shown(engine, session);
    expect(JSON.stringify(rows[0]!.content)).toContain('what is on this receipt');
    expect(rows[1]!.note!.code).toBe('run_blocked');
    expect(engine.getThreadStore()!.getMessages(session.sessionId, { apiOnly: true })).toEqual([]);
  });

  it('a blocked first message does not take the title from the next accepted one', async () => {
    const engine = await boot();
    const session = engine.createSession();
    budget.refuse = CAP;
    await session.run('summarise the quarter');
    const store = engine.getThreadStore()!;
    expect(store.getThread(session.sessionId)?.title ?? '').toBe('');
    budget.refuse = undefined;
    mockProcess.mockResolvedValue(endTurn('Paris.'));
    await session.run('what is the capital of France');
    const title = store.getThread(session.sessionId)?.title ?? '';
    expect(title).not.toBe('');
    expect(title.toLowerCase()).not.toContain('quarter');
  });

  it('a scheduled or watch run the budget or a hook blocks keeps nothing: no thread fills up tick by tick', async () => {
    const engine = await boot();
    const session = engine.createSession();
    budget.refuse = CAP;
    expect(await session.run('check the inbox', { triggerOrigin: 'cron' })).toBe(CAP);
    budget.refuse = undefined;
    session.registerHooks({ onBeforeRun: async () => { throw new Error(HOOK); } });
    expect(await session.run('summarise the page', { triggerOrigin: 'watch' })).toBe(`Run blocked: ${HOOK}`);
    expect(engine.getThreadStore()!.getMessages(session.sessionId)).toEqual([]);
    expect(engine.getThreadStore()!.getThread(session.sessionId)?.message_count ?? 0).toBe(0);
  });

  it('an internal run the budget or a hook blocks keeps nothing in the thread', async () => {
    const engine = await boot();
    const session = engine.createSession();
    budget.refuse = CAP;
    await expect(session.run('compact this', { internal: true })).rejects.toThrow(CAP);
    budget.refuse = undefined;
    session.registerHooks({ onBeforeRun: async () => { throw new Error(HOOK); } });
    await expect(session.run('compact this', { internal: true })).rejects.toThrow(HOOK);
    expect(engine.getThreadStore()!.getMessages(session.sessionId)).toEqual([]);
  });
});
