/**
 * What a contained chat may call (`containment.ts › containedCallAllowed`), and how a chat that
 * reads what a contained chat produced is contained too: `containThreadFrom`, the readers of a
 * workflow run (`diagnose_workflow_run`, the "Fixen" chat context), the CLI briefing, the run's
 * `origin_thread_id` (history.db v64), and `run_workflow` without a run history.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { EngineDb } from './engine-db.js';
import { RunHistory } from './run-history.js';
import {
  Containment, CONTAINED_CALL_REFUSAL, CONTAINED_CDN_HOSTS, CONTAINED_OTHER_SERVICE_REFUSAL, CONTAINED_PLAN_REFUSAL, CONTAINED_READ_REFUSAL, CONTAINED_TOOLS, CONTAINED_WRITE_REFUSAL, containedCallAllowed, containedCallRefusal, containedThreads, containThreadFrom,
} from './containment.js';
import { createToolContext } from './tool-context.js';
import { CONTAINED_ORIGIN_CONTEXT, resolveChatContext } from './chat-context.js';
import { generateBriefing } from './project.js';
import { compose } from './data-boundary.js';
import { diagnoseWorkflowTool } from '../tools/builtin/diagnose-workflow.js';
import { runWorkflowTool } from '../tools/builtin/pipeline.js';
import type { IAgent } from '../types/index.js';

// A busy machine takes longer than the default 10 s to import and open these stores.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const SHOP = 'https://acme.myshopify.com/admin/api/2025-10/products.json';

describe('the calls a contained chat may make', () => {
  it('are exactly these names: a tool added later is refused until it is named here', () => {
    expect([...CONTAINED_TOOLS].sort()).toEqual([
      'archive_search', 'ask_user', 'bulk_status', 'http_request', 'memory_list', 'memory_recall',
      'recall', 'recall_tool_result', 'run_workflow', 'spawn_agent', 'suggest_follow_ups',
    ]);
    expect(Object.isFrozen(CONTAINED_TOOLS)).toBe(true);
    for (const name of ['write_file', 'memory_store', 'remember', 'mail_send', 'set_thread_context', 'data_store_insert', 'artifact_save', 'mcp__x__y', 'diagnose_workflow_run', 'memory_focus']) {
      expect(containedCallAllowed(name, {}), name).toBe(false);
    }
    for (const name of ['memory_recall', 'memory_list', 'recall', 'archive_search', 'recall_tool_result', 'suggest_follow_ups', 'ask_user', 'spawn_agent', 'run_workflow', 'bulk_status']) {
      expect(containedCallAllowed(name, {}), name).toBe(true);
    }
  });

  it('http_request only over https to a store host', () => {
    expect(containedCallAllowed('http_request', { url: SHOP })).toBe(true);
    expect(containedCallAllowed('http_request', { url: 'https://ACME.myshopify.com./admin' })).toBe(true);
    expect(containedCallAllowed('http_request', { url: 'https://api.example.com/x' })).toBe(false);
    expect(containedCallAllowed('http_request', { url: 'https://acme.myshopify.com.example.com/x' })).toBe(false);
    expect(containedCallAllowed('http_request', { url: 'http://acme.myshopify.com/admin' })).toBe(false);
    expect(containedCallAllowed('http_request', { url: 'not a url' })).toBe(false);
    expect(containedCallAllowed('http_request', { url: 42 })).toBe(false);
    expect(containedCallAllowed('http_request', {})).toBe(false);
    expect(containedCallAllowed('http_request', null)).toBe(false);
    // No CDN host is named until one is measured.
    expect([...CONTAINED_CDN_HOSTS]).toEqual([]);
    expect(containedCallAllowed('http_request', { url: 'https://cdn.shopify.com/s/files/x.png' })).toBe(false);
  });

  it('http_request to a store host only to read: each write a request names, GraphQL read only as a plain POST', () => {
    const refusal = (input: Record<string, unknown>): string | null => containedCallRefusal('http_request', { url: SHOP, ...input })?.reason ?? null;
    const GQL = 'https://acme.myshopify.com/admin/api/2025-10/graphql.json';
    const json = { 'Content-Type': 'application/json' };
    const query = JSON.stringify({ query: '{ shop { name } }' });
    expect(refusal({})).toBeNull();
    expect(refusal({ method: 'HEAD' })).toBeNull();
    expect(refusal({ url: GQL, method: 'POST', headers: json, body: query })).toBeNull();
    for (const [label, input] of [
      ['a REST POST', { method: 'POST', body: '{}' }],
      ['a REST POST whose body reads as a GraphQL query', { method: 'POST', headers: json, body: query }],
      ['a PUT', { method: 'PUT', body: '{}' }],
      ['a DELETE', { method: 'DELETE' }],
      ['an OPTIONS', { method: 'OPTIONS' }],
      ['not a method', { method: 'FROB' }],
      ['a GET overridden to DELETE', { headers: { 'X-HTTP-Method-Override': 'DELETE' } }],
      ['a GraphQL mutation', { url: GQL, method: 'POST', headers: json, body: JSON.stringify({ query: 'mutation { x }' }) }],
      ['a GraphQL query overridden to PUT', { url: GQL, method: 'POST', headers: { ...json, 'X-HTTP-Method-Override': 'PUT' }, body: query }],
      ['a GraphQL query sent as a PUT', { url: GQL, method: 'PUT', headers: json, body: query }],
      ['a GraphQL query sent as a GET overridden to POST', { url: GQL, method: 'GET', headers: { ...json, 'X-HTTP-Method-Override': 'POST' }, body: query }],
      ['a GraphQL query with a query string', { url: `${GQL}?query=x`, method: 'POST', headers: json, body: query }],
      ['a GraphQL body the check cannot read', { url: GQL, method: 'POST', headers: json, body: '[{"query":"{ shop { name } }"}]' }],
      ['a body that is not text', { method: 'POST', body: { a: 1 } }],
    ] as const) {
      expect(refusal(input as Record<string, unknown>), label).toBe('contained_write');
    }
    // A shape the tool does not take is not decided at dispatch: the schema refuses the first and
    // the last, and the tool refuses the second before it sends (http-store-containment.test.ts).
    for (const [label, input] of [
      ['a method that is not text', { method: 7 }],
      ['a header that is not text', { headers: { 'X-HTTP-Method-Override': 1 } }],
      ['headers as a string', { headers: '{"X-HTTP-Method-Override":"DELETE"}' }],
    ] as const) {
      expect(refusal(input as Record<string, unknown>), label).toBeNull();
    }
    // A host that is not the store's gets the answer for another service, under the same reason.
    expect(containedCallRefusal('http_request', { url: 'https://api.example.com/x', method: 'POST' })).toEqual({ reason: 'contained_call', text: CONTAINED_OTHER_SERVICE_REFUSAL });
    expect(containedCallRefusal('mail_send', {})).toEqual({ reason: 'contained_call', text: CONTAINED_CALL_REFUSAL });
    expect(containedCallRefusal('http_request', { url: SHOP, method: 'PUT' })).toEqual({ reason: 'contained_write', text: CONTAINED_WRITE_REFUSAL });
    expect(containedCallRefusal('memory_recall', {})).toBeNull();
  });

  it('no bulk_plan, not even for an http run on a store host: a run is planned in a chat that has not read the store', () => {
    expect(containedCallAllowed('bulk_plan', { target_system: 'http', target_host: 'acme.myshopify.com' })).toBe(false);
    expect(containedCallAllowed('bulk_plan', { target_system: 'http', target_host: 'acme.myshopify.com', source_list: { form: 'shopify', after: { title: 'x' } } })).toBe(false);
    expect(containedCallAllowed('bulk_plan', { target_system: 'workspace', target_host: 'acme.myshopify.com' })).toBe(false);
    expect(containedCallAllowed('bulk_plan', { target_system: 'data_store', target_host: 'acme.myshopify.com' })).toBe(false);
    expect(containedCallAllowed('bulk_plan', { target_system: 'http', target_host: 'shop.example.com' })).toBe(false);
    expect(containedCallAllowed('bulk_plan', { target_system: 'http', target_host: 'acme.myshopify.com:443' })).toBe(false);
    expect(containedCallAllowed('bulk_plan', { target_system: 'http', target_host: 7 })).toBe(false);
    expect(containedCallAllowed('bulk_plan', { target_system: 'http' })).toBe(false);
    // Its own reason and text: the run needs the store's data, so the general answer would point the wrong way.
    expect(containedCallRefusal('bulk_plan', { target_system: 'http', target_host: 'acme.myshopify.com' })).toEqual({ reason: 'contained_plan', text: CONTAINED_PLAN_REFUSAL });
    expect(CONTAINED_PLAN_REFUSAL).toContain('Plan in a new chat');
    expect(CONTAINED_WRITE_REFUSAL).toContain('Plan in a new chat');
    // The way, not a place: after a reload the button stands only above the input, and over the
    // API there is none, so the sentence says a new chat is where it goes on.
    for (const text of [CONTAINED_PLAN_REFUSAL, CONTAINED_WRITE_REFUSAL]) {
      expect(text).toMatch(/they plan the (change|run) in a new chat, which they open themselves/);
      expect(text).toContain('you cannot open it for them');
      expect(text).not.toMatch(/below|under your|above/i);
    }
  });

  it('a request to another service names the same button, and no place', () => {
    expect(CONTAINED_OTHER_SERVICE_REFUSAL).toContain('so it reaches no other service');
    expect(CONTAINED_OTHER_SERVICE_REFUSAL).toContain('they can open a chat where this works with "Plan in a new chat"');
    expect(CONTAINED_OTHER_SERVICE_REFUSAL).toContain('you cannot open it for them');
    // It holds for an engine that cannot read the state too, so it does not claim a read.
    expect(CONTAINED_OTHER_SERVICE_REFUSAL).toContain('or this engine cannot read whether it has');
    expect(CONTAINED_OTHER_SERVICE_REFUSAL).not.toMatch(/below|under your|above|in the bar/i);
  });

  it('only a request to another service gets that answer; a local tool or a store URL the chat does not send keeps the general one', () => {
    const other = { reason: 'contained_call', text: CONTAINED_OTHER_SERVICE_REFUSAL };
    const general = { reason: 'contained_call', text: CONTAINED_CALL_REFUSAL };
    expect(containedCallRefusal('http_request', { url: 'https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live', method: 'POST' })).toEqual(other);
    expect(containedCallRefusal('http_request', { url: 'http://api.example.com/x' })).toEqual(other);
    // Not another service: the store itself over plain http, a URL that does not parse, no URL, a tool.
    expect(containedCallRefusal('http_request', { url: 'http://acme.myshopify.com/admin/api/2025-10/products.json' })).toEqual(general);
    expect(containedCallRefusal('http_request', { url: 'not a url' })).toEqual(general);
    expect(containedCallRefusal('http_request', { url: 'ftp://files.example.com/x' })).toEqual(general);
    expect(containedCallRefusal('http_request', {})).toEqual(general);
    expect(containedCallRefusal('read_file', { path: 'notes.md' })).toEqual(general);
    expect(containedCallRefusal('memory_store', { content: 'x' })).toEqual(general);
    // The general answer claims nothing about another service, and it is not the other one.
    expect(CONTAINED_CALL_REFUSAL).not.toContain('another service');
    expect(CONTAINED_CALL_REFUSAL).not.toContain('other service');
    expect(CONTAINED_CALL_REFUSAL).toContain('Work that does not need the store\'s data belongs in a new chat.');
  });
});

/** A thread store over a map, whose update can be switched off to leave the flag unset. */
function fakeThreads(ids: string[]): { store: { getThread: (id: string) => { skip_extraction: number } | undefined; updateThread: (id: string, u: { skip_extraction?: boolean }) => void }; flags: Map<string, number>; frozen: { on: boolean } } {
  const flags = new Map(ids.map((id) => [id, 0]));
  const frozen = { on: false };
  return {
    flags, frozen,
    store: {
      getThread: (id) => (flags.has(id) ? { skip_extraction: flags.get(id)! } : undefined),
      updateThread: (id, u) => { if (!frozen.on && flags.has(id) && u.skip_extraction === true) flags.set(id, 1); },
    },
  };
}

let dir: string;
let engineDb: EngineDb;
let containment: Containment;
let history: RunHistory;
const rowsOf = (threadId: string): { kind: string; connection_id: string }[] =>
  engineDb.getDb().prepare("SELECT kind, connection_id FROM contained WHERE container_kind = 'thread' AND container_id = ? ORDER BY connection_id").all(threadId) as never;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lynox-contained-reads-'));
  engineDb = new EngineDb(join(dir, 'engine.db'), '');
  containment = new Containment(engineDb.getDb());
  history = new RunHistory(join(dir, 'history.db'));
  history.setVerbGraph(engineDb);
});
afterEach(() => {
  history.close();
  engineDb.close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('containThreadFrom', () => {
  it('copies every connection of the source onto the reader and sets its flag', () => {
    containment.contain({ kind: 'thread', id: 'src' }, { kind: 'api', connectionId: 'shop-a' });
    containment.contain({ kind: 'thread', id: 'src' }, { kind: 'api', connectionId: 'shop-b' });
    const t = fakeThreads(['reader']);
    containThreadFrom({ containment, threadStore: t.store }, 'src', 'reader');
    expect(rowsOf('reader')).toEqual([{ kind: 'api', connection_id: 'shop-a' }, { kind: 'api', connection_id: 'shop-b' }]);
    expect(t.flags.get('reader')).toBe(1);
    // A second read keeps the rows as they are.
    containThreadFrom({ containment, threadStore: t.store }, 'src', 'reader');
    expect(rowsOf('reader')).toHaveLength(2);
  });

  it('throws when the flag does not read back, there is no thread store, no store, no reader, or nothing to copy', () => {
    containment.contain({ kind: 'thread', id: 'src' }, { kind: 'api', connectionId: 'shop-a' });
    const t = fakeThreads(['reader']);
    t.frozen.on = true;
    expect(() => containThreadFrom({ containment, threadStore: t.store }, 'src', 'reader')).toThrow(/did not hold/);
    // A reader without a thread row: the UPDATE changes nothing and the read-back sees it.
    expect(() => containThreadFrom({ containment, threadStore: fakeThreads([]).store }, 'src', 'ghost')).toThrow(/did not hold/);
    expect(() => containThreadFrom({ containment, threadStore: null }, 'src', 'reader')).toThrow(/no thread store/);
    expect(() => containThreadFrom({ containment: null, threadStore: t.store }, 'src', 'reader')).toThrow(/no containment store/);
    expect(() => containThreadFrom({ containment, threadStore: t.store }, 'src', undefined)).toThrow(/no thread/);
    expect(() => containThreadFrom({ containment, threadStore: fakeThreads(['r2']).store }, 'not-contained', 'r2')).toThrow(/no containment row/);
  });
});

/** A run started from a chat, as the runner records it. */
function seedRun(id: string, origin: string | undefined): void {
  history.insertPipelineRun({ id, manifestName: 'Report', status: 'failed', manifestJson: '{}', error: 'boom', ...(origin !== undefined ? { originThreadId: origin } : {}) });
  history.insertPipelineStepResult({ pipelineRunId: id, stepId: 's0', status: 'failed', error: 'secret store detail', costUsd: 0 });
}

function readerAgent(threads: ReturnType<typeof fakeThreads>['store'] | null, thread: { current?: string; origin?: string }): IAgent {
  const toolContext = createToolContext({});
  toolContext.runHistory = history;
  toolContext.containment = containment;
  toolContext.threadStore = threads as never;
  return { toolContext, currentThreadId: thread.current, originThreadId: thread.origin } as unknown as IAgent;
}

describe('diagnose_workflow_run on a run a contained chat started', () => {
  beforeEach(() => {
    containment.contain({ kind: 'thread', id: 'chat-shop' }, { kind: 'api', connectionId: 'shop-a' });
  });

  it('contains the reading chat before it answers, a spawned child\'s chat included', async () => {
    seedRun('run-c', 'chat-shop');
    const t = fakeThreads(['reader', 'parent']);
    const out = await diagnoseWorkflowTool.handler({ run_id: 'run-c' }, readerAgent(t.store, { current: 'reader' }));
    expect(out).toContain('secret store detail');
    expect(containment.isContained({ threadId: 'reader' })).toBe(true);
    expect(t.flags.get('reader')).toBe(1);
    await diagnoseWorkflowTool.handler({ run_id: 'run-c' }, readerAgent(t.store, { origin: 'parent' }));
    expect(containment.isContained({ threadId: 'parent' })).toBe(true);
  });

  it('refuses, showing nothing, when the reader cannot be contained or has no thread', async () => {
    seedRun('run-c', 'chat-shop');
    const t = fakeThreads(['reader']);
    t.frozen.on = true;
    for (const agent of [readerAgent(t.store, { current: 'reader' }), readerAgent(null, { current: 'reader' }), readerAgent(fakeThreads([]).store, {})]) {
      const out = await diagnoseWorkflowTool.handler({ run_id: 'run-c' }, agent);
      expect(out).toBe(`Error: ${CONTAINED_READ_REFUSAL}`);
    }
  });

  it('a run from an uncontained chat, or from no chat, contains nothing (control)', async () => {
    seedRun('run-free', 'chat-other');
    seedRun('run-none', undefined);
    const t = fakeThreads(['reader']);
    for (const id of ['run-free', 'run-none']) {
      expect(await diagnoseWorkflowTool.handler({ run_id: id }, readerAgent(t.store, { current: 'reader' }))).toContain('secret store detail');
    }
    expect(containment.isContained({ threadId: 'reader' })).toBe(false);
    expect(t.flags.get('reader')).toBe(0);
  });
});

describe('the "Fixen" chat context on a run a contained chat started', () => {
  beforeEach(() => {
    containment.contain({ kind: 'thread', id: 'chat-shop' }, { kind: 'api', connectionId: 'shop-a' });
  });

  it('contains the session\'s chat before the context is loaded', () => {
    seedRun('run-c', 'chat-shop');
    const t = fakeThreads(['session-1']);
    const out = resolveChatContext(history, { kind: 'run', id: 'run-c' }, null, { threadId: 'session-1', containment, threadStore: t.store })!;
    expect(out).toContain('secret store detail');
    expect(containment.isContained({ threadId: 'session-1' })).toBe(true);
    expect(t.flags.get('session-1')).toBe(1);
    // It points at no tool the contained chat may not call.
    expect(out).toContain('it can only read and explain this run here');
    expect(out).not.toContain('diagnose_workflow_run');
    expect(out).not.toContain('update_workflow_steps');
  });

  it('loads only the refusal when the chat cannot be contained, or no reader is given', () => {
    seedRun('run-c', 'chat-shop');
    const t = fakeThreads(['session-1']);
    t.frozen.on = true;
    const refused = `[Loaded workflow run — id: run-c]\n${CONTAINED_READ_REFUSAL}`;
    expect(resolveChatContext(history, { kind: 'run', id: 'run-c' }, null, { threadId: 'session-1', containment, threadStore: t.store })).toBe(refused);
    expect(resolveChatContext(history, { kind: 'run', id: 'run-c' }, null, { threadId: undefined, containment, threadStore: t.store })).toBe(refused);
    // Without a reader the record is not at hand: refused on a provisioned instance.
    vi.stubEnv('LYNOX_BILLING_TIER', 'managed');
    expect(resolveChatContext(history, { kind: 'run', id: 'run-c' })).toBe(refused);
  });

  it('a run from an uncontained chat contains nothing (control)', () => {
    seedRun('run-free', 'chat-other');
    const t = fakeThreads(['session-1']);
    const out = resolveChatContext(history, { kind: 'run', id: 'run-free' }, null, { threadId: 'session-1', containment, threadStore: t.store })!;
    expect(out).toContain('secret store detail');
    expect(out).toContain('Diagnose with diagnose_workflow_run (run_id "run-free")');
    expect(out).not.toContain('only read and explain');
    expect(containment.isContained({ threadId: 'session-1' })).toBe(false);
  });
});

describe('the CLI briefing', () => {
  const brief = (c: Containment | null): string => {
    const f = generateBriefing('/proj', history, c);
    return f ? compose([f]) : '';
  };
  beforeEach(() => {
    history.insertRun({ sessionId: 'chat-shop', taskText: 'list the store orders', modelTier: 'balanced', modelId: 'm', contextId: '/proj' });
    history.insertRun({ sessionId: 'chat-free', taskText: 'tidy the readme', modelTier: 'balanced', modelId: 'm', contextId: '/proj' });
  });

  it('skips the runs of a contained chat and keeps the others', () => {
    containment.contain({ kind: 'thread', id: 'chat-shop' }, { kind: 'api', connectionId: 'shop-a' });
    const out = brief(containment);
    expect(out).toContain('tidy the readme');
    expect(out).not.toContain('list the store orders');
  });

  it('keeps every run when no chat is contained (control)', () => {
    const out = brief(containment);
    expect(out).toContain('tidy the readme');
    expect(out).toContain('list the store orders');
  });

  it('without a store: everything on a provisioned instance is skipped, nothing elsewhere', () => {
    history.insertRun({ taskText: 'a run of no chat', modelTier: 'balanced', modelId: 'm', contextId: '/proj' });
    expect(brief(null)).toContain('list the store orders');
    expect(brief(null)).toContain('a run of no chat');
    vi.stubEnv('LYNOX_BILLING_TIER', 'managed');
    expect(brief(null)).toBe('');
  });
});

describe('pipeline_runs.origin_thread_id (history.db v64)', () => {
  const columns = (db: Database.Database): { name: string; notnull: number; dflt_value: unknown }[] =>
    db.prepare('PRAGMA table_info(pipeline_runs)').all() as never;

  it('exists on a fresh database, nullable and without a default', () => {
    const col = columns(history.getDb()).find((c) => c.name === 'origin_thread_id');
    expect(col).toMatchObject({ notnull: 0, dflt_value: null });
    expect((history.getDb().prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }).v).toBe(69);
    seedRun('run-none', undefined);
    seedRun('run-chat', 'chat-1');
    expect(history.getPipelineRunOrigin('run-none')).toBeNull();
    expect(history.getPipelineRunOrigin('run-chat')).toBe('chat-1');
    expect(history.getPipelineRunOrigin('ghost')).toBeUndefined();
    // The run read the API sends is unchanged.
    expect(history.getPipelineRun('run-chat')).not.toHaveProperty('origin_thread_id');
  });

  it('is added to a database upgraded from v63, which keeps its rows', () => {
    const path = join(dir, 'old.db');
    const before = new RunHistory(path);
    before.insertPipelineRun({ id: 'old-run', manifestName: 'x', status: 'completed', manifestJson: '{}' });
    before.getDb().exec('DELETE FROM schema_version WHERE version >= 64; ALTER TABLE pipeline_runs DROP COLUMN origin_thread_id; DROP INDEX IF EXISTS idx_run_tool_calls_connection_grant; ALTER TABLE run_tool_calls DROP COLUMN tool_use_id; ALTER TABLE run_tool_calls DROP COLUMN grant_id; ALTER TABLE pending_prompts DROP COLUMN answered_mandate_id; ALTER TABLE pending_prompts DROP COLUMN answered_by; ALTER TABLE run_tool_calls DROP COLUMN is_error; ALTER TABLE run_tool_calls DROP COLUMN contract_state; ALTER TABLE run_tool_calls DROP COLUMN contract_grant_id; ALTER TABLE run_tool_calls DROP COLUMN lift_grant_id; ALTER TABLE run_tool_calls DROP COLUMN lift_entry; ALTER TABLE run_tool_calls DROP COLUMN filing; ALTER TABLE run_tool_calls DROP COLUMN approval_id;');
    expect(columns(before.getDb()).map((c) => c.name)).not.toContain('origin_thread_id');
    before.close();
    const after = new RunHistory(path);
    try {
      expect((after.getDb().prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }).v).toBe(69);
      expect(after.getPipelineRunOrigin('old-run')).toBeNull();
      after.insertPipelineRun({ id: 'new-run', manifestName: 'x', status: 'running', manifestJson: '{}', originThreadId: 'chat-2' });
      expect(after.getPipelineRunOrigin('new-run')).toBe('chat-2');
    } finally { after.close(); }
  });
});

describe('run_workflow without a run history', () => {
  const agentIn = (thread: string, withHistory: boolean): IAgent => {
    const toolContext = createToolContext({});
    toolContext.containment = containment;
    if (withHistory) toolContext.runHistory = history;
    return { toolContext, currentThreadId: thread, getAvailableTools: () => [] } as unknown as IAgent;
  };

  it('is refused in a contained chat before anything runs, and goes on elsewhere (control)', async () => {
    containment.contain({ kind: 'thread', id: 'chat-shop' }, { kind: 'api', connectionId: 'shop-a' });
    const steps = [{ id: 's', task: 't' }];
    expect(await runWorkflowTool.handler({ steps }, agentIn('chat-shop', false))).toMatch(/^Error: Not run: this chat has read data through a store connection/);
    // Past the check, to the next refusal: no tools to give the steps.
    expect(await runWorkflowTool.handler({ steps }, agentIn('chat-free', false))).toBe('Error: No parent tools available for inline pipeline steps.');
    expect(await runWorkflowTool.handler({ steps }, agentIn('chat-shop', true))).toBe('Error: No parent tools available for inline pipeline steps.');
  });
});

describe('the contained threads among many, in one read (the thread list)', () => {
  it('names exactly the contained threads, not a bulk run of the same id', () => {
    containment.contain({ kind: 'thread', id: 't-a' }, { kind: 'api', connectionId: 'shop-acme' });
    containment.contain({ kind: 'thread', id: 't-a' }, { kind: 'api', connectionId: 'shop-other' });
    containment.contain({ kind: 'bulk_run', id: 't-b' }, { kind: 'api', connectionId: 'shop-acme' });
    expect([...containment.containedThreadIds(['t-a', 't-b', 't-c'])].sort()).toEqual(['t-a']);
    expect([...containedThreads(containment, ['t-a', 't-c'])]).toEqual(['t-a']);
    expect(containment.containedThreadIds([]).size).toBe(0);
  });

  it('is fail-closed like `isContained`: an empty id, or a read that throws, counts as contained', () => {
    expect([...containment.containedThreadIds(['', 't-c'])]).toEqual(['']);
    const broken = new Containment({ prepare: () => { throw new Error('disk I/O error'); } } as never);
    expect([...broken.containedThreadIds(['t-a', 't-c'])].sort()).toEqual(['t-a', 't-c']);
  });

  it('without a store: every thread on a provisioned instance, none elsewhere', () => {
    expect(containedThreads(null, ['t-a']).size).toBe(0);
    vi.stubEnv('LYNOX_BILLING_TIER', 'managed');
    expect([...containedThreads(null, ['t-a', 't-c'])].sort()).toEqual(['t-a', 't-c']);
  });
});

describe('a chat opened from a contained one (contained-origin)', () => {
  it('reads a fixed text and nothing of the old chat, and stays uncontained', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-origin-'));
    const engineDb = new EngineDb(join(dir, 'engine.db'), '');
    try {
      const containment = new Containment(engineDb.getDb());
      containment.contain({ kind: 'thread', id: 'old-chat' }, { kind: 'api', connectionId: 'shop-a' });
      // Every store this kind could read throws: the text comes from none of them.
      const boom = new Proxy({}, { get: () => { throw new Error('read'); } });
      const threads = fakeThreads(['new-chat']);
      const out = resolveChatContext(boom as never, { kind: 'contained-origin', id: 'old-chat' }, boom as never,
        { threadId: 'new-chat', containment, threadStore: threads.store as never });
      expect(out).toBe(CONTAINED_ORIGIN_CONTEXT);
      expect(out).not.toContain('old-chat');
      expect(containment.isContained({ threadId: 'new-chat' })).toBe(false);
      expect(threads.flags.get('new-chat')).toBe(0);
      // The control: the run kind on the same reader does read through the stores.
      expect(() => resolveChatContext(boom as never, { kind: 'run', id: 'r1' }, boom as never,
        { threadId: 'new-chat', containment, threadStore: threads.store as never })).toThrow('read');
    } finally {
      engineDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
