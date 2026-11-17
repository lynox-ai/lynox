// Who wrote a thread message (`thread_messages.author`, v73). Driven through a REAL Engine,
// Session, Agent and ThreadStore; only the provider is stubbed.
//
// The column records the person behind a typed turn. A turn a trigger started is recorded
// with the trigger's own tag, never as the owner's, even when the owner set the trigger up:
// nobody typed it. Every row the engine writes itself, and every row from before the column,
// is NULL, and NULL is unknown.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const { mockProcess } = vi.hoisted(() => ({ mockProcess: vi.fn() }));

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = { messages: { stream: () => ({}) } };
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
import { RunHistory } from './run-history.js';
import { ThreadStore } from './thread-store.js';
import { OWNER_PRINCIPAL, runAuthorTag, workflowAuthorTag, type RequestPrincipal } from './request-principal.js';
import type { LynoxConfig } from '../types/config.js';

const ENV_KEYS = ['LYNOX_DATA_DIR', 'LYNOX_VAULT_KEY', 'ANTHROPIC_API_KEY', 'LYNOX_MANAGED_INSTANCE_ID', 'LYNOX_EMBEDDING_PROVIDER'] as const;
const saved = new Map<string, string | undefined>();
const dirs: string[] = [];
const engines: Engine[] = [];

const MANDATE: RequestPrincipal = { kind: 'mandate', email: 'helper@example.invalid', mandateId: 'm-1' };

function setEnv(key: string, value: string | undefined): void {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-author-'));
  dirs.push(dir);
  return dir;
}

async function boot(): Promise<Engine> {
  const dir = tmp();
  for (const k of ENV_KEYS) setEnv(k, undefined);
  setEnv('LYNOX_DATA_DIR', dir);
  setEnv('ANTHROPIC_API_KEY', 'test-key-not-real');
  setEnv('LYNOX_EMBEDDING_PROVIDER', 'local');
  reloadConfig();
  const engine = new Engine({} as LynoxConfig);
  engines.push(engine);
  await engine.init();
  return engine;
}

function endTurn(text: string) {
  return { content: [{ type: 'text' as const, text }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 50 } };
}

/** Each row of the thread as role + author, in order. */
function authors(engine: Engine, threadId: string): Array<[string, string | null]> {
  return engine.getThreadStore()!.getMessages(threadId).map((r) => [r.role, r.author]);
}

beforeEach(() => {
  mockProcess.mockReset();
  mockProcess.mockResolvedValue(endTurn('done'));
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

describe('runAuthorTag', () => {
  it('is the principal tag for a typed turn', () => {
    expect(runAuthorTag(OWNER_PRINCIPAL)).toBe('owner');
    expect(runAuthorTag(OWNER_PRINCIPAL, {})).toBe('owner');
    expect(runAuthorTag(MANDATE)).toBe('mandate:helper@example.invalid');
  });

  it('is the trigger tag for a trigger run, the owner\'s own trigger included', () => {
    expect(runAuthorTag(OWNER_PRINCIPAL, { triggerOrigin: 'cron', triggerId: 't-1' })).toBe('trigger:t-1');
    expect(runAuthorTag(OWNER_PRINCIPAL, { triggerId: 't-1' })).toBe('trigger:t-1');
    expect(runAuthorTag(OWNER_PRINCIPAL, { triggerOrigin: 'cron' })).toBe('trigger:unknown');
  });

  it('never makes a workflow step the owner', () => {
    expect(workflowAuthorTag('run-1')).toBe('workflow:run-1');
    expect(workflowAuthorTag(undefined)).toBe('workflow:unknown');
  });
});

describe('ThreadStore records the author it is given', () => {
  it('writes the author on every message of the call, and NULL when none is given', () => {
    const history = new RunHistory(join(tmp(), 'history.db'));
    try {
      const store = new ThreadStore(history.getDb());
      store.createThread('th');
      store.appendMessages('th', [{ role: 'user', content: 'typed' }], 0, undefined, 'owner');
      store.appendMessages('th', [{ role: 'assistant', content: 'reply' }, { role: 'user', content: 'tool result' }], 1);
      expect(store.getMessages('th').map((r) => r.author)).toEqual(['owner', null, null]);
    } finally {
      history.close();
    }
  });
});

describe('migration v73', () => {
  it('adds a NULL author to every message from before it', () => {
    const path = join(tmp(), 'history.db');
    const history = new RunHistory(path);
    const store = new ThreadStore(history.getDb());
    store.createThread('th');
    store.appendMessages('th', [{ role: 'user', content: 'old' }], 0, undefined, 'owner');
    history.close();
    // Back to v72: the column gone, as on a store written before it existed.
    const raw = new Database(path);
    raw.exec('ALTER TABLE thread_messages DROP COLUMN author; DELETE FROM schema_version WHERE version = 73;');
    raw.close();

    const upgraded = new RunHistory(path);
    try {
      expect((upgraded.getDb().prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }).v).toBe(73);
      expect(new ThreadStore(upgraded.getDb()).getMessages('th').map((r) => r.author)).toEqual([null]);
    } finally {
      upgraded.close();
    }
  });
});

describe('a run records who typed its turn', { timeout: 60_000 }, () => {
  it('the owner\'s chat turn is the owner\'s; the reply is not anyone\'s', async () => {
    const engine = await boot();
    const session = engine.createSession();
    await session.run('send it to anna@firma.ch', { principal: OWNER_PRINCIPAL });
    expect(authors(engine, session.sessionId)).toEqual([['user', 'owner'], ['assistant', null]]);
  });

  it('a mandate\'s turn carries the mandate\'s tag', async () => {
    const engine = await boot();
    const session = engine.createSession({ principal: MANDATE });
    await session.run('hello', { principal: MANDATE });
    expect(authors(engine, session.sessionId)[0]).toEqual(['user', 'mandate:helper@example.invalid']);
  });

  it('the owner\'s own trigger, continuing in the owner\'s thread, never writes an owner turn', async () => {
    const engine = await boot();
    const session = engine.createSession();
    await session.run('typed by the owner', { principal: OWNER_PRINCIPAL });
    await session.run('scheduled task text', { triggerOrigin: 'cron', triggerId: 'trg-7', principal: OWNER_PRINCIPAL });
    const rows = authors(engine, session.sessionId);
    expect(rows.filter(([role]) => role === 'user')).toEqual([['user', 'owner'], ['user', 'trigger:trg-7']]);
  });

  it('the next typed turn after a trigger run is the owner\'s again', async () => {
    const engine = await boot();
    const session = engine.createSession();
    await session.run('scheduled', { triggerOrigin: 'cron', triggerId: 'trg-8', principal: OWNER_PRINCIPAL });
    await session.run('typed', { principal: OWNER_PRINCIPAL });
    expect(authors(engine, session.sessionId).filter(([role]) => role === 'user')).toEqual([['user', 'trigger:trg-8'], ['user', 'owner']]);
  });
});
