// Regression: DATA-LOSS — assistant turns after a compaction (or a long-thread
// resume) were NEVER persisted, so they vanished on reload / mobile / export.
//
// Root cause (fixed 2026-06-06): both persist paths sliced the in-memory buffer
// against a disk-row COUNT floor (`getApiMessageCount`). That is correct ONLY
// while the buffer is a prefix-superset of disk. Compaction collapses the buffer
// to a synthetic summary (~2 messages) while disk keeps the full history (~70
// rows), so `buffer.length < floor` → the old code "shrink-skipped" and the new
// assistant turn was dropped. The fix tracks a persisted high-water-mark BY
// IDENTITY on the Agent (`getUnpersistedTail`/`markPersisted`) so the genuinely
// new tail is persisted regardless of the disk count — while a `_truncateHistory`
// front-drop (buffer becomes a SUFFIX of disk, tail already durable) still
// persists nothing new.
//
// This spec drives a REAL Agent (LLM stubbed) + a REAL ThreadStore through the
// exact persist wiring Session uses, reproducing the user scenario at the unit
// level. With the old count-floor logic the post-compaction assertion FAILS
// (assistant row absent); with the identity mark it PASSES.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type Database from 'better-sqlite3';

const mockProcess = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = { messages: { stream: vi.fn() } };
  }
  return { default: MockAnthropic };
});

vi.mock('./stream.js', () => ({
  StreamProcessor: vi.fn().mockImplementation(function (this: { process: typeof mockProcess }) {
    this.process = mockProcess;
  }),
}));

vi.mock('../tools/permission-guard.js', () => ({
  isDangerous: vi.fn().mockReturnValue(null),
}));

vi.mock('./observability.js', () => ({
  channels: {
    toolStart: { publish: vi.fn() },
    toolEnd: { publish: vi.fn() },
    contentTruncation: { hasSubscribers: false, publish: vi.fn() },
    securityFlagged: { hasSubscribers: false, publish: vi.fn() },
  },
  measureTool: vi.fn().mockReturnValue({ end: () => 0 }),
}));

import { Agent } from './agent.js';
import { ThreadStore } from './thread-store.js';
import { persistAgentMessages } from './eager-persist.js';

function freshDb(): Database.Database {
  const db = new BetterSqlite3(':memory:');
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      model_tier TEXT NOT NULL DEFAULT 'balanced',
      model_tier_source TEXT NOT NULL DEFAULT 'unknown',
      context_id TEXT NOT NULL DEFAULT '',
      message_count INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      summary TEXT,
      summary_up_to INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      is_favorite INTEGER NOT NULL DEFAULT 0,
      skip_extraction INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE thread_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content_json TEXT NOT NULL,
      usage_json TEXT,
      display_only INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function endTurnResponse(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

const THREAD = 't-compaction';

/** Wire a real Agent to a real ThreadStore exactly like Session does: on each
 *  stable turn boundary persist the agent's unpersisted tail (identity delta),
 *  advancing the mark on commit. Mirrors Session._persistMessages. */
function makeAgent(store: ThreadStore): Agent {
  const agent = new Agent({
    name: 'lynox',
    model: 'claude-sonnet-4-6',
    onMessageCheckpoint: () => {
      persistAgentMessages({
        threadStore: store,
        sessionId: THREAD,
        delta: agent.getUnpersistedTail(),
        onPersisted: (count) => agent.markPersisted(count),
      });
    },
  });
  return agent;
}

/** Extract plain text from persisted content — either a raw string (user turn)
 *  or the agent's `[{type:'text',text}]` block array (assistant turn). */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text: string } =>
        typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text')
      .map((b) => b.text)
      .join('');
  }
  return JSON.stringify(content);
}

/** Read back the persisted API rows in seq order — the reload/export view. */
function rolesOnDisk(store: ThreadStore): Array<{ role: string; text: string }> {
  return store.getMessages(THREAD, { limit: 10_000 }).map((r) => ({
    role: r.role,
    text: textOf(JSON.parse(r.content_json)),
  }));
}

describe('persist after compaction (data-loss regression)', () => {
  let db: Database.Database;
  let store: ThreadStore;

  beforeEach(() => {
    vi.clearAllMocks();
    db = freshDb();
    store = new ThreadStore(db);
    store.createThread(THREAD);
  });

  it('persists the assistant turn appended AFTER a compaction reset+loadMessages', async () => {
    const agent = makeAgent(store);

    // 1) Build a real history of completed turns; each is checkpoint-persisted.
    mockProcess.mockResolvedValueOnce(endTurnResponse('reply-1'));
    await agent.send('user-1');
    mockProcess.mockResolvedValueOnce(endTurnResponse('reply-2'));
    await agent.send('user-2');

    const beforeCompactRows = store.getApiMessageCount(THREAD);
    expect(beforeCompactRows).toBe(4); // u1,a1,u2,a2 all durable

    // 2) Force the compaction transition: buffer collapses to a synthetic
    //    summary while disk KEEPS the full pre-compaction history. This is the
    //    invariant break — buffer.length (2) << disk floor (4+).
    agent.reset();
    agent.loadMessages([
      { role: 'user', content: '[Conversation summarized to free context.]' },
      { role: 'assistant', content: 'Summary: discussed u1/u2; next step pending.' },
    ]);
    expect(agent.getMessages()).toHaveLength(2);

    // 3) New user+assistant turn AFTER the summary. (Session writes the user
    //    turn durably first; emulate that, then mark it pre-persisted.)
    store.appendMessages(
      THREAD,
      [{ role: 'user', content: 'continue please' }],
      store.getNextSeq(THREAD),
      { message_count: store.getMessageCount(THREAD) + 1 },
    );
    mockProcess.mockResolvedValueOnce(endTurnResponse('here is the continuation'));
    await agent.send('continue please', { userMessagePrePersisted: true });

    // 4) The assistant reply MUST be on disk now — this is what was lost.
    const disk = rolesOnDisk(store);
    const assistantTexts = disk.filter((r) => r.role === 'assistant').map((r) => r.text);
    expect(assistantTexts).toContain('here is the continuation');

    // The pre-compaction history is preserved (not deleted by compaction) and
    // the new turns sort after it via MAX(seq)+1.
    expect(disk.map((r) => r.text)).toEqual([
      'user-1',
      'reply-1',
      'user-2',
      'reply-2',
      'continue please',
      'here is the continuation',
    ]);
    // Exactly one copy of the durably-pre-written user turn (no duplicate).
    expect(disk.filter((r) => r.text === 'continue please')).toHaveLength(1);
  });

  it('persists NOTHING new after a _truncateHistory front-drop (suffix already on disk)', async () => {
    const agent = makeAgent(store);

    mockProcess.mockResolvedValueOnce(endTurnResponse('a1'));
    await agent.send('u1');
    mockProcess.mockResolvedValueOnce(endTurnResponse('a2'));
    await agent.send('u2');

    const rowsBefore = store.getApiMessageCount(THREAD);
    const snapshotBefore = rolesOnDisk(store);
    expect(rowsBefore).toBe(4);

    // Simulate _truncateHistory front-dropping old, already-persisted history:
    // the agent buffer becomes a SUFFIX of disk. Reload from disk (apiOnly) is
    // what resume does; the tail is wholly already durable.
    const tail = store
      .getMessages(THREAD, { limit: 10_000 })
      .slice(-2)
      .map((r) => ({ role: r.role as 'user' | 'assistant', content: JSON.parse(r.content_json) as string }));
    agent.loadMessages(tail);

    // A bare checkpoint with no new turn must persist nothing (delta empty).
    persistAgentMessages({
      threadStore: store,
      sessionId: THREAD,
      delta: agent.getUnpersistedTail(),
      onPersisted: (count) => agent.markPersisted(count),
    });

    expect(store.getApiMessageCount(THREAD)).toBe(rowsBefore); // no new rows
    expect(rolesOnDisk(store)).toEqual(snapshotBefore); // no re-persist / no dupes
  });

  it('persists new turns on a long-thread resume (buffer = summary + recent < disk)', async () => {
    // Seed a long thread directly on disk (simulating >80 prior rows).
    const seeded: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (let i = 0; i < 40; i++) {
      seeded.push({ role: 'user', content: `q${i}` });
      seeded.push({ role: 'assistant', content: `a${i}` });
    }
    store.appendMessages(THREAD, seeded, store.getNextSeq(THREAD), {
      message_count: seeded.length,
    });
    const diskFloor = store.getApiMessageCount(THREAD);
    expect(diskFloor).toBe(80);

    // Resume loads only summary + recent (≈ 42) — buffer << disk floor.
    const agent = makeAgent(store);
    agent.loadMessages([
      { role: 'user', content: '[Resumed — summary of earlier messages.]' },
      { role: 'assistant', content: 'Summary of q0..q39.' },
      ...seeded.slice(-2),
    ]);

    // New turn after resume.
    store.appendMessages(
      THREAD,
      [{ role: 'user', content: 'new question after resume' }],
      store.getNextSeq(THREAD),
      { message_count: store.getMessageCount(THREAD) + 1 },
    );
    mockProcess.mockResolvedValueOnce(endTurnResponse('answer after resume'));
    await agent.send('new question after resume', { userMessagePrePersisted: true });

    const disk = rolesOnDisk(store);
    expect(disk.filter((r) => r.role === 'assistant').map((r) => r.text)).toContain('answer after resume');
    expect(disk.filter((r) => r.text === 'new question after resume')).toHaveLength(1);
  });
});
