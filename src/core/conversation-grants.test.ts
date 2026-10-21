import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolEntry } from '../types/index.js';
import { ConversationGrants, UNKNOWN_GRANT, type ConversationGrantSink } from './conversation-grants.js';
import { RunHistory, HISTORY_KEPT_ON_ERASURE } from './run-history.js';
import { ThreadStore } from './thread-store.js';
import { wrapUntrustedData } from './data-boundary.js';
import { noteCallConnection, noteNetworkContact } from './call-connection.js';

// === Mocks (the agent's model client, as agent.test.ts does) ===

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = { messages: { stream: vi.fn() } };
  }
  class APIError extends Error {
    status: number;
    constructor(status: number, message?: string) { super(message); this.status = status; }
  }
  return { default: MockAnthropic, APIError };
});

const mockProcess = vi.fn();
vi.mock('./stream.js', () => ({
  StreamProcessor: vi.fn().mockImplementation(function (this: { process: typeof mockProcess }) {
    this.process = mockProcess;
  }),
}));

vi.mock('../tools/permission-guard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tools/permission-guard.js')>()),
  isDangerous: vi.fn().mockReturnValue(null),
  isDangerousDetailed: vi.fn().mockReturnValue(null),
}));

import { Agent } from './agent.js';

function endTurn(text: string) {
  return { content: [{ type: 'text' as const, text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
}
function toolUse(tools: Array<{ id: string; name: string; input?: unknown }>) {
  return {
    content: tools.map(t => ({ type: 'tool_use' as const, id: t.id, name: t.name, input: t.input ?? {} })),
    stop_reason: 'tool_use',
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}
function makeTool(name: string, handler: ToolEntry['handler']): ToolEntry {
  return {
    definition: { name, description: `Test tool ${name}`, input_schema: { type: 'object' as const, properties: {}, additionalProperties: true } },
    handler,
  };
}

/** A sink that remembers what reached it, in order. */
function memorySink(): ConversationGrantSink & { rows: Array<[string, string]> } {
  const rows: Array<[string, string]> = [];
  return {
    rows,
    insertConversationGrant: (threadId, grantId) => { if (!rows.some(([t, g]) => t === threadId && g === grantId)) rows.push([threadId, grantId]); },
    getConversationGrants: (threadId) => rows.filter(([t]) => t === threadId).map(([, g]) => g),
  };
}

let dir: string;
beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'conv-grants-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ConversationGrants', () => {
  it('writes a new member through before add returns, and a repeat writes nothing', () => {
    const sink = memorySink();
    const set = ConversationGrants.forThread('t1', sink);
    set.add('g1');
    expect(sink.rows).toEqual([['t1', 'g1']]);
    set.add('g1');
    expect(sink.rows).toEqual([['t1', 'g1']]);
    expect(set.members()).toEqual(['g1']);
  });

  it('keeps a member whose write failed', () => {
    const set = ConversationGrants.forThread('t1', {
      insertConversationGrant: () => { throw new Error('FOREIGN KEY constraint failed'); },
      getConversationGrants: () => [],
    });
    set.add('g1');
    expect(set.has('g1')).toBe(true);
  });

  it('starts a thread with its recorded members, and with unknown when they cannot be read', () => {
    const sink = memorySink();
    sink.insertConversationGrant('t1', 'g1');
    expect(ConversationGrants.forThread('t1', sink).members()).toEqual(['g1']);
    const unreadable = ConversationGrants.forThread('t1', {
      insertConversationGrant: () => {},
      getConversationGrants: () => { throw new Error('SQLITE_BUSY'); },
    });
    expect(unreadable.members()).toEqual([UNKNOWN_GRANT]);
  });

  it('renews as a new object of the same thread that keeps every member, a failed write included', () => {
    let failing = true;
    const sink = memorySink();
    const flaky: ConversationGrantSink = {
      insertConversationGrant: (t, g) => { if (failing) throw new Error('busy'); sink.insertConversationGrant(t, g); },
      getConversationGrants: (t) => sink.getConversationGrants(t),
    };
    const old = ConversationGrants.forThread('t1', flaky);
    old.add('only-in-memory');
    failing = false;
    old.add('recorded');
    const next = old.renewed();
    expect(next).not.toBe(old);
    expect(next.threadId).toBe('t1');
    expect(new Set(next.members())).toEqual(new Set(['only-in-memory', 'recorded']));
    // The old object stays usable for whoever still holds it, under the same thread.
    old.add('late');
    expect(sink.rows).toContainEqual(['t1', 'late']);
  });

  it('a detached set writes nowhere', () => {
    const set = ConversationGrants.detached();
    set.add('g1');
    expect(set.threadId).toBeUndefined();
    expect(set.members()).toEqual(['g1']);
  });
});

describe('history.db conversation_grants (v67)', () => {
  it('fills unknown for every thread that already had messages, and nothing for an empty one', () => {
    const path = join(dir, 'h.db');
    const before = new RunHistory(path);
    const store = new ThreadStore(before.getDb());
    store.createThread('with-messages');
    store.appendMessages('with-messages', [{ role: 'user', content: 'hi' }], 0);
    store.createThread('empty');
    // Back to v66: the table did not exist yet.
    before.getDb().exec('DROP TABLE conversation_grants; DELETE FROM schema_version WHERE version > 66; ALTER TABLE pending_prompts DROP COLUMN answered_mandate_id; ALTER TABLE pending_prompts DROP COLUMN answered_by; ALTER TABLE run_tool_calls DROP COLUMN is_error; ALTER TABLE run_tool_calls DROP COLUMN contract_state; ALTER TABLE run_tool_calls DROP COLUMN contract_grant_id; ALTER TABLE run_tool_calls DROP COLUMN lift_grant_id; ALTER TABLE run_tool_calls DROP COLUMN lift_entry; ALTER TABLE run_tool_calls DROP COLUMN filing; ALTER TABLE run_tool_calls DROP COLUMN approval_id;');
    before.close();
    const after = new RunHistory(path);
    expect(after.getConversationGrants('with-messages')).toEqual([UNKNOWN_GRANT]);
    expect(after.getConversationGrants('empty')).toEqual([]);
    expect((after.getDb().prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }).v).toBe(69);
    after.close();
  });

  it('migrating again from an older version keeps one row per member', () => {
    const path = join(dir, 'h.db');
    const h = new RunHistory(path);
    const store = new ThreadStore(h.getDb());
    store.createThread('t');
    store.appendMessages('t', [{ role: 'user', content: 'hi' }], 0);
    h.getDb().exec('DELETE FROM schema_version WHERE version > 66; ALTER TABLE pending_prompts DROP COLUMN answered_mandate_id; ALTER TABLE pending_prompts DROP COLUMN answered_by; ALTER TABLE run_tool_calls DROP COLUMN is_error; ALTER TABLE run_tool_calls DROP COLUMN contract_state; ALTER TABLE run_tool_calls DROP COLUMN contract_grant_id; ALTER TABLE run_tool_calls DROP COLUMN lift_grant_id; ALTER TABLE run_tool_calls DROP COLUMN lift_entry; ALTER TABLE run_tool_calls DROP COLUMN filing; ALTER TABLE run_tool_calls DROP COLUMN approval_id;');
    h.close();
    const again = new RunHistory(path);
    again.getDb().exec('DELETE FROM schema_version WHERE version > 66; ALTER TABLE pending_prompts DROP COLUMN answered_mandate_id; ALTER TABLE pending_prompts DROP COLUMN answered_by; ALTER TABLE run_tool_calls DROP COLUMN is_error; ALTER TABLE run_tool_calls DROP COLUMN contract_state; ALTER TABLE run_tool_calls DROP COLUMN contract_grant_id; ALTER TABLE run_tool_calls DROP COLUMN lift_grant_id; ALTER TABLE run_tool_calls DROP COLUMN lift_entry; ALTER TABLE run_tool_calls DROP COLUMN filing; ALTER TABLE run_tool_calls DROP COLUMN approval_id;');
    again.close();
    const third = new RunHistory(path);
    expect(third.getConversationGrants('t')).toEqual([UNKNOWN_GRANT]);
    third.close();
  });

  it('deleteThread and deleteAllThreads each take the thread\'s rows', () => {
    const h = new RunHistory(join(dir, 'h.db'));
    const store = new ThreadStore(h.getDb());
    for (const id of ['a', 'b', 'c']) {
      store.createThread(id);
      h.insertConversationGrant(id, `g-${id}`);
    }
    store.deleteThread('a');
    expect(h.getConversationGrants('a')).toEqual([]);
    expect(h.getConversationGrants('b')).toEqual(['g-b']);
    store.deleteAllThreads();
    const left = h.getDb().prepare('SELECT COUNT(*) n FROM conversation_grants').get() as { n: number };
    expect(left.n).toBe(0);
    h.close();
  });

  it('refuses a row for a thread that does not exist', () => {
    const h = new RunHistory(join(dir, 'h.db'));
    expect(() => h.insertConversationGrant('no-such-thread', 'g')).toThrow(/FOREIGN KEY/);
    h.close();
  });

  it('is not kept by the full erasure', () => {
    expect(HISTORY_KEPT_ON_ERASURE.has('conversation_grants')).toBe(false);
    // Witness that the table exists under that name, so the line above is about a real table.
    const h = new RunHistory(join(dir, 'h.db'));
    const t = h.getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversation_grants'").get();
    expect(t).toBeDefined();
    h.close();
  });
});

describe('the agent adds what a call took in', () => {
  async function run(tools: ToolEntry[], calls: Array<{ id: string; name: string }>, opts?: { root?: boolean }) {
    const set = ConversationGrants.detached();
    mockProcess.mockResolvedValueOnce(toolUse(calls)).mockResolvedValueOnce(endTurn('done'));
    const agent = new Agent({ name: 't', model: 'claude-sonnet-4-6', tools, conversationGrants: set, conversationRoot: opts?.root });
    await agent.send('go');
    return set.members();
  }
  const connection = (grantId: string | null) => ({ id: 'shop', createdAt: '2026-01-01 00:00:00', grantId });

  it('an http_request that reached the network adds its grant', async () => {
    const http = makeTool('http_request', async () => { noteCallConnection(connection('g-shop')); noteNetworkContact(); return 'ok'; });
    expect(await run([http], [{ id: 'h', name: 'http_request' }])).toEqual(['g-shop']);
  });

  it('an http_request refused before sending adds nothing, even with a resolved grant', async () => {
    const http = makeTool('http_request', async () => { noteCallConnection(connection('g-shop')); throw new Error('Blocked: refused'); });
    expect(await run([http], [{ id: 'h', name: 'http_request' }])).toEqual([]);
  });

  it('an http_request that reached the network without a grant adds unknown', async () => {
    const http = makeTool('http_request', async () => { noteCallConnection(connection(null)); noteNetworkContact(); return 'ok'; });
    expect(await run([http], [{ id: 'h', name: 'http_request' }])).toEqual([UNKNOWN_GRANT]);
  });

  it('a failed http_request after the network was reached keeps its grant', async () => {
    const http = makeTool('http_request', async () => { noteCallConnection(connection('g-shop')); noteNetworkContact(); throw new Error('upstream 500'); });
    expect(await run([http], [{ id: 'h', name: 'http_request' }])).toEqual(['g-shop']);
  });

  it('a direct-ingest tool adds unknown, on success and on failure', async () => {
    const bash = makeTool('bash', async () => 'curl output');
    expect(await run([bash], [{ id: 'b', name: 'bash' }])).toEqual([UNKNOWN_GRANT]);
    const failing = makeTool('bash', async () => { throw new Error('exit 1: server said no'); });
    expect(await run([failing], [{ id: 'b', name: 'bash' }])).toEqual([UNKNOWN_GRANT]);
  });

  it('a read-back of stored data adds nothing', async () => {
    const query = makeTool('data_store_query', async () => wrapUntrustedData('row', 'data_store'));
    expect(await run([query], [{ id: 'q', name: 'data_store_query' }])).toEqual([]);
  });

  it('an unlisted tool adds unknown when its result carries the untrusted marker, and nothing otherwise', async () => {
    const wrapped = makeTool('calendar_lookup', async () => wrapUntrustedData('invite text', 'calendar'));
    expect(await run([wrapped], [{ id: 'c', name: 'calendar_lookup' }])).toEqual([UNKNOWN_GRANT]);
    const plain = makeTool('calendar_lookup', async () => 'no external text');
    expect(await run([plain], [{ id: 'c', name: 'calendar_lookup' }])).toEqual([]);
  });

  it('a sub-agent\'s fetch leaves its grant and, from the wrapped answer, unknown', async () => {
    // The child adds to the root's set itself (it holds the same object); its answer comes back
    // wrapped, and the root's seat adds `unknown` for it: the child may have read what no seat
    // of its own saw (a provider-side search, a tool nobody lists). Mixed, so the owner decides.
    const spawn = makeTool('spawn_agent', async (_input, agent) => {
      agent.conversationGrants?.add('g-shop');
      return wrapUntrustedData('child answer', 'sub_agent:x');
    });
    expect(await run([spawn], [{ id: 's', name: 'spawn_agent' }])).toEqual(['g-shop', UNKNOWN_GRANT]);
  });

  it('records a member before the result that carries it is checkpointed', async () => {
    const h = new RunHistory(join(dir, 'h.db'));
    new ThreadStore(h.getDb()).createThread('t1');
    const set = ConversationGrants.forThread('t1', h);
    const seenAtCheckpoint: string[][] = [];
    const http = makeTool('http_request', async () => { noteCallConnection(connection('g-shop')); noteNetworkContact(); return 'ok'; });
    mockProcess.mockResolvedValueOnce(toolUse([{ id: 'h', name: 'http_request' }])).mockResolvedValueOnce(endTurn('done'));
    const agent = new Agent({
      name: 't', model: 'claude-sonnet-4-6', tools: [http], conversationGrants: set,
      // The persist point: a Session writes the new messages here. What history.db holds then
      // is what a crash right after this write leaves.
      onMessageCheckpoint: () => {
        const hasResult = agent.getMessages().some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result'));
        if (hasResult) seenAtCheckpoint.push(h.getConversationGrants('t1'));
      },
    });
    await agent.send('go');
    expect(seenAtCheckpoint.length).toBeGreaterThan(0);
    expect(seenAtCheckpoint[0]).toEqual(['g-shop']);
    h.close();
  });
});

describe('user turns', () => {
  const upload = (): string => wrapUntrustedData('text of an uploaded file', 'upload:doc.pdf');

  it('a conversation\'s own agent adds unknown for an upload; a step or sub-agent does not', async () => {
    for (const root of [true, false]) {
      const set = ConversationGrants.detached();
      mockProcess.mockResolvedValueOnce(endTurn('ok'));
      const agent = new Agent({ name: 't', model: 'claude-sonnet-4-6', tools: [], conversationGrants: set, conversationRoot: root });
      await agent.send(upload());
      expect(set.members()).toEqual(root ? [UNKNOWN_GRANT] : []);
    }
  });

  it('a resume adds unknown for an upload in a user turn, but not for a wrapped tool result', () => {
    const withUpload = ConversationGrants.detached();
    const a = new Agent({ name: 't', model: 'claude-sonnet-4-6', tools: [], conversationGrants: withUpload, conversationRoot: true });
    a.loadMessages([{ role: 'user', content: upload() }, { role: 'assistant', content: 'ok' }]);
    expect(withUpload.members()).toEqual([UNKNOWN_GRANT]);

    const withToolResult = ConversationGrants.detached();
    const b = new Agent({ name: 't', model: 'claude-sonnet-4-6', tools: [], conversationGrants: withToolResult, conversationRoot: true });
    b.loadMessages([
      { role: 'user', content: 'fetch it' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'h', name: 'http_request', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'h', content: wrapUntrustedData('body', 'http_response') }] },
    ]);
    expect(withToolResult.members()).toEqual([]);
  });

  it('reset replaces the set with one of the same thread, and the old one keeps working', () => {
    const sink = memorySink();
    const set = ConversationGrants.forThread('t1', sink);
    set.add('g1');
    const agent = new Agent({ name: 't', model: 'claude-sonnet-4-6', tools: [], conversationGrants: set, conversationRoot: true });
    agent.reset();
    expect(agent.conversationGrants).not.toBe(set);
    expect(agent.conversationGrants?.members()).toEqual(['g1']);
    set.add('g2');
    expect(sink.getConversationGrants('t1')).toEqual(['g1', 'g2']);
  });
});
