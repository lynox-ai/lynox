// Regression: USER-VISIBLE EVICTION — the durable transcript (thread_messages)
// received the EVICTED marker form of a successfully saved artifact body, so
// reload, UI rendering and export showed `[evicted after successful save …]`
// where the artifact content used to be (measured on prod 2026-08-14: five
// marker rows in one thread, thread 015dcb91 seq 87/117/133/143/168).
//
// Root cause: eviction (F5) rewrites the agent buffer IN PLACE, and every persist
// path appends `getUnpersistedTail()` — so whenever the persist of a turn fails
// once (SQLITE_BUSY, crash window) and the retry fires on the NEXT turn, the
// tail it appends has already been rewritten to the marker. The D4 claim
// ("persisted thread history keeps the original bodies") only held for the
// never-fail flow. The fix: eviction hands the agent the original body, and the
// persist delta restores it — the model context stays evicted (that is the cost
// control), the durable transcript keeps the original (that is the UI promise).
//
// This spec drives a REAL Agent (LLM stubbed) + a REAL ThreadStore through the
// exact persist wiring Session uses. Against the pre-fix code the disk assertion
// FAILS (marker on disk); with the restore it PASSES.

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

const THREAD = 't-original-bodies';
const BIG_BODY = 'R'.repeat(4096); // > EVICTION_MIN_CHARS (2048)

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

/** The turn that produced a successful artifact_save — exactly the message
 *  shapes eviction decides on (tool_use with a big string content + a paired
 *  non-error tool_result starting `Saved artifact "`). */
function saveHistory() {
  return [
    { role: 'user' as const, content: 'write the report' },
    {
      role: 'assistant' as const,
      content: [
        {
          type: 'tool_use' as const,
          id: 'tu_report_1',
          name: 'artifact_save',
          input: { title: 'Report', content: BIG_BODY },
        },
      ],
    },
    {
      role: 'user' as const,
      content: [
        {
          type: 'tool_result' as const,
          tool_use_id: 'tu_report_1',
          content: 'Saved artifact "Report" to /files/report.md',
        },
      ],
    },
  ];
}

/** All assistant tool_use blocks persisted to disk, as the reload path sees them. */
function diskToolUseInputs(store: ThreadStore): string[] {
  return store.getMessages(THREAD, { limit: 10_000 })
    .filter((r) => r.role === 'assistant')
    .map((r) => JSON.parse(r.content_json))
    .filter((c): c is unknown[] => Array.isArray(c))
    .flatMap((c) => c)
    .filter((b) => b && b.type === 'tool_use' && b.name === 'artifact_save')
    .map((b) => (typeof b.input?.content === 'string' ? b.input.content : JSON.stringify(b.input)));
}

describe('persist keeps original artifact bodies (D4)', () => {
  let db: Database.Database;
  let store: ThreadStore;

  beforeEach(() => {
    vi.clearAllMocks();
    db = freshDb();
    store = new ThreadStore(db);
    store.createThread(THREAD);
  });

  it('a failed persist retried next turn writes the ORIGINAL body, not the marker', async () => {
    const agent = makeAgent(store);

    // 1) Rehydrate a history whose artifact_save already succeeded. This runs
    //    the F5 resume eviction: the BUFFER now carries the marker.
    agent.loadMessages(saveHistory());
    const buffered = agent.getMessages()[1];
    const bufferedContent = Array.isArray(buffered.content)
      ? buffered.content[0] as { input: { content: string } }
      : null;
    expect(bufferedContent?.input.content).toContain('[evicted after successful save');

    // 2) The prod state this regression is about: the persist that should have
    //    written these rows failed, so the persisted mark still sits BELOW
    //    them. Emulate exactly that (a failed checkpoint leaves the mark where
    //    it was; the retry happens on the next turn).
    (agent as { _persistedMark?: number })._persistedMark = 0;

    // 3) Next turn: send() re-evicts (idempotent), the loop runs, the
    //    checkpoint persists the tail — and the tail must be the ORIGINAL.
    mockProcess.mockResolvedValueOnce(endTurnResponse('done, saved as artifact'));
    await agent.send('thanks, continue');

    const persisted = diskToolUseInputs(store);
    expect(persisted).toHaveLength(1);
    // THE assertion: durable history keeps the original body (D4). Pre-fix
    // this receives the evicted marker string.
    expect(persisted[0]).toBe(BIG_BODY);
    expect(persisted[0]).not.toContain('[evicted after successful save');
  });

  it('the model context stays evicted while the disk copy is original', async () => {
    const agent = makeAgent(store);
    agent.loadMessages(saveHistory());
    (agent as { _persistedMark?: number })._persistedMark = 0;
    mockProcess.mockResolvedValueOnce(endTurnResponse('done'));
    await agent.send('thanks, continue');

    // Buffer (what the next wire call sends) carries the marker — the cost
    // control is NOT given up by persisting the original.
    const assistantBlocks = agent.getMessages()[1].content;
    const toolUse = (Array.isArray(assistantBlocks) ? assistantBlocks : [])[0] as
      | { input: { content: string } }
      | undefined;
    expect(toolUse?.input.content).toContain('[evicted after successful save');
    expect(diskToolUseInputs(store)[0]).toBe(BIG_BODY);
  });
});
