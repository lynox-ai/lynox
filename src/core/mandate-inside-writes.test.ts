/**
 * Every write site a mandate's tool call has inside the instance, driven through the
 * agent's real dispatch (`Agent._executeOneInner`), once per site and branch.
 *
 * Every object the handler is handed goes in DENY-BY-DEFAULT: any call that is not on the read
 * list of that object throws, unless the `attempt` row of the fixture's site (or of a site the
 * fixture names as opened before it, while that one's block runs) is already in the log.
 *  (a) a working log: the expected first change is made, and the attempt row of this site was in
 *      the log when it was;
 *  (b) a log that cannot write this site's rows: no change is made, and the result the model reads
 *      is the refusal text, whatever the handler made of the throw.
 * Past the handed objects, module mocks watch `mkdirSync` and `copyFileSync` of `node:fs` under
 * the file area, and `writeInPlace` of `tools/builtin/fs.ts`. `instance-write-sites.test.ts`
 * scans the handlers for direct writes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { auditLogSchema } from '../../tests/helpers/audit-log.js';

// ── module stand-ins (hoisted) ─────────────────────────────────────────────────────────────────

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic { beta = { messages: { stream: vi.fn() } }; }
  class APIError extends Error {
    status: number;
    constructor(status: number, _error: unknown, message: string | undefined) { super(message ?? 'api'); this.status = status; this.name = 'APIError'; }
  }
  return { default: MockAnthropic, APIError };
});

vi.mock('../tools/permission-guard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tools/permission-guard.js')>()),
  isDangerous: vi.fn().mockReturnValue(null),
  isDangerousDetailed: vi.fn().mockReturnValue(null),
}));

/** What the file-area stand-ins see: a write into the file area is a change like a store's. */
const fsWatch = vi.hoisted(() => ({
  area: null as string | null,
  /** Answers whether the attempt row of the fixture's site is in the log right now. */
  open: null as null | (() => { own: boolean; any: boolean }),
  calls: [] as Array<{ fn: string; own: boolean; any: boolean }>,
  violations: [] as string[],
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const watched = <F extends (...a: never[]) => unknown>(name: string, fn: F, target: (...a: Parameters<F>) => string): F => ((...args: Parameters<F>) => {
    const path = target(...args);
    if (fsWatch.open !== null && fsWatch.area !== null && (path === fsWatch.area || path.startsWith(`${fsWatch.area}/`))) {
      const o = fsWatch.open();
      fsWatch.calls.push({ fn: name, ...o });
      if (!o.any) { fsWatch.violations.push(`fs.${name}`); throw new Error(`deny-by-default: fs.${name} before the attempt row`); }
    }
    return fn(...args);
  }) as F;
  const mkdirSync = watched('mkdirSync', actual.mkdirSync as (p: string, o?: unknown) => unknown, (p) => String(p));
  const copyFileSync = watched('copyFileSync', actual.copyFileSync as (s: string, d: string, m?: number) => void, (_s, d) => String(d));
  return { ...actual, default: { ...actual, mkdirSync, copyFileSync }, mkdirSync, copyFileSync };
});

vi.mock('../tools/builtin/fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tools/builtin/fs.js')>();
  return {
    ...actual,
    writeInPlace: (...args: Parameters<typeof actual.writeInPlace>) => {
      if (fsWatch.open !== null) {
        const o = fsWatch.open();
        fsWatch.calls.push({ fn: 'writeInPlace', ...o });
        if (!o.any) { fsWatch.violations.push('fs.writeInPlace'); throw new Error('deny-by-default: writeInPlace before the attempt row'); }
      }
      return actual.writeInPlace(...args);
    },
  };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    // ffmpeg stands in: the output is the input's bytes.
    execFile: (_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, out: string, errOut: string) => void) => {
      fs.writeFileSync(args[args.length - 1]!, fs.readFileSync(args[args.indexOf('-i') + 1]!));
      cb(null, '', '');
      return {};
    },
  };
});

const capture = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('./process-capture.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./process-capture.js')>()),
  captureProcess: (...args: unknown[]) => capture.fn(...args),
}));

const { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { Agent } = await import('./agent.js');
const { AuditLog, INSTANCE_WRITE_UNRECORDED } = await import('./audit-log.js');
const { createToolContext } = await import('./tool-context.js');
const { INSTANCE_WRITE_SITES } = await import('./mandate-tool-lock.js');
const { setDataDir } = await import('./config.js');
const { EngineDb } = await import('./engine-db.js');
const { SubjectStore } = await import('./subject-store.js');
const { RunHistory } = await import('./run-history.js');
const { TaskManager } = await import('./task-manager.js');
const { ApiStore } = await import('./api-store.js');
const { setTenantWorkspace, clearTenantWorkspace, _resetCache: resetWorkspaceCache } = await import('./workspace.js');
const { closeWorkspaceBase } = await import('./workspace-rel.js');
const { toPortableWorkflow, buildFence, LYNOX_WORKFLOW_INFO_STRING } = await import('./workflow-portable.js');
const { _resetPipelineStore, storePipeline } = await import('../tools/builtin/pipeline.js');
const { rememberTool, memoryBlockEditTool, memoryRetireTool } = await import('../tools/builtin/knowledge.js');
const { memoryStoreTool, memoryDeleteTool, memoryUpdateTool, memoryPromoteTool } = await import('../tools/builtin/memory.js');
const { subjectsMergeTool } = await import('../tools/builtin/subjects-merge.js');
const { dataStoreCreateTool, dataStoreInsertTool, dataStoreDeleteTool, dataStoreDropTool } = await import('../tools/builtin/data-store.js');
const { contactsSaveTool } = await import('../tools/builtin/contacts.js');
const { artifactSaveTool, artifactDeleteTool, artifactRestoreTool } = await import('../tools/builtin/artifact.js');
const { mediaProcessTool } = await import('../tools/builtin/media-process.js');
const { setThreadContextTool } = await import('../tools/builtin/set-thread-context.js');
const { taskCreateTool, taskUpdateTool } = await import('../tools/builtin/task.js');
const { planTaskTool } = await import('../tools/builtin/plan-task.js');
const { saveWorkflowTool } = await import('../tools/builtin/process.js');
const { updateWorkflowTool } = await import('../tools/builtin/update-workflow.js');
const { importWorkflowTool } = await import('../tools/builtin/import-workflow.js');
const { apiSetupTool } = await import('../tools/builtin/api-setup.js');
type InstanceWriteSite = import('./mandate-tool-lock.js').InstanceWriteSite;
type ToolEntry = import('../types/index.js').ToolEntry;
type PlannedPipeline = import('../types/index.js').PlannedPipeline;
type ApiProfile = import('./api-store.js').ApiProfile;
type RequestPrincipal = import('./request-principal.js').RequestPrincipal;

const MANDATE: RequestPrincipal = { kind: 'mandate', email: 'setup@example.org', display: 'TEST-DISPLAY', mandateId: 'M-1' };
const TAG = 'mandate:setup@example.org';

// ── the harness ────────────────────────────────────────────────────────────────────────────────


interface Trail { db: Database.Database; log: InstanceType<typeof AuditLog> }
async function freshTrail(failSite: InstanceWriteSite | null): Promise<Trail> {
  const { default: Sqlite } = await import('better-sqlite3');
  const db = new Sqlite(':memory:');
  db.exec(auditLogSchema());
  // The (b) log: this site's rows cannot be written, any other site's can.
  if (failSite !== null) db.exec(`CREATE TRIGGER refuse BEFORE INSERT ON audit_log WHEN NEW.action LIKE 'instance:${failSite}:%' BEGIN SELECT RAISE(ABORT, 'disk full'); END;`);
  return { db, log: new AuditLog(db) };
}
const outcomeOf = (db: Database.Database, site: string): boolean =>
  db.prepare(`SELECT 1 FROM audit_log WHERE phase IN ('returned', 'failed') AND action LIKE ?`).get(`instance:${site}:%`) !== undefined;
const attemptOf = (db: Database.Database, site: string): boolean =>
  db.prepare(`SELECT 1 FROM audit_log WHERE phase = 'attempt' AND action LIKE ?`).get(`instance:${site}:%`) !== undefined;

interface Call { on: string; method: string; read: boolean; own: boolean; any: boolean }
interface GuardState { calls: Call[]; violations: string[]; open: () => { own: boolean; any: boolean } }

/** `obj` with every method that is not in `reads` refused until the site's attempt row is in. */
function guard<T extends object>(obj: T, on: string, reads: readonly string[], st: GuardState): T {
  const allowed = new Set(reads);
  return new Proxy(obj, {
    get(target, prop) {
      const v: unknown = Reflect.get(target, prop, target);
      if (typeof v !== 'function' || typeof prop !== 'string' || prop === 'constructor') return v;
      return (...args: unknown[]) => {
        const o = st.open();
        const read = allowed.has(prop);
        st.calls.push({ on, method: prop, read, ...o });
        if (!read && !o.any) {
          st.violations.push(`${on}.${prop}`);
          throw new Error(`deny-by-default: ${on}.${prop} before the attempt row`);
        }
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

interface Built {
  /** ToolContext fields: each one is handed in guarded with its read list. */
  ctx?: Record<string, { obj: object; reads: readonly string[] } | unknown>;
  /** Agent fields guarded the same way. */
  memory?: { obj: object; reads: readonly string[] };
  secretStore?: { obj: object; reads: readonly string[] };
  promptUser?: (q: unknown, o?: string[]) => Promise<string>;
  activeScopes?: Array<{ type: 'global' | 'context' | 'user'; id: string }>;
  currentThreadId?: string;
  userConfig?: Record<string, unknown>;
  /** The expected first change: `<object>.<method>` (`ctx.<field>`, `memory`, `secretStore`, `fs`). */
  spy: string;
  /** The target when it is known only once the fixture is built (an id the store minted). */
  target?: string;
  cleanup?: () => void;
}

interface Fixture {
  site: InstanceWriteSite;
  branch: string;
  tool: ToolEntry;
  input: Record<string, unknown>;
  /** Sites whose rows open before this one in the same call (memory_update#fallback after #exact). */
  before?: InstanceWriteSite[];
  /** The two rows this site leaves: `instance:<site>:<verb>` with this target, attempt then outcome. */
  row: { verb: string; target: string | RegExp };
  /**
   * What the outcome row adds: `wrote=` as the typed results prove it, `null` for none,
   * and whether it names a `created=` id. Every branch here writes, so `all` unless said.
   */
  wrote?: 'all' | 'part' | null;
  created?: boolean;
  /** What a set-hitting step names after the attempt's pairs: its count, then its ids (660a-2). */
  hit?: string[];
  build: () => Built | Promise<Built>;
}

const isGuarded = (v: unknown): v is { obj: object; reads: readonly string[] } =>
  typeof v === 'object' && v !== null && 'obj' in v && 'reads' in v && Array.isArray((v as { reads: unknown }).reads);

async function drive(f: Fixture, failing: boolean): Promise<{ result: { content: unknown; is_error?: boolean }; st: GuardState; trail: Trail; on: string; method: string; target: string | RegExp }> {
  const trail = await freshTrail(failing ? f.site : null);
  const st: GuardState = {
    calls: [], violations: [],
    // A site named in `before` allows changes only while its own block runs: between its attempt
    // row and its outcome row. Every change after that needs this site's row.
    open: () => {
      const own = attemptOf(trail.db, f.site);
      return { own, any: own || (f.before ?? []).some(s => attemptOf(trail.db, s) && !outcomeOf(trail.db, s)) };
    },
  };
  const b = await f.build();
  fsWatch.calls = []; fsWatch.violations = []; fsWatch.open = st.open;
  try {
    const toolContext = createToolContext((b.userConfig ?? {}) as never);
    for (const [k, v] of Object.entries(b.ctx ?? {})) {
      (toolContext as unknown as Record<string, unknown>)[k] = isGuarded(v) ? guard(v.obj, `ctx.${k}`, v.reads, st) : v;
    }
    toolContext.auditLog = trail.log;
    const agent = new Agent({
      name: 'test', model: 'claude-sonnet-4-6', tools: [f.tool], toolContext, principal: MANDATE, currentRunId: 'run-1',
      ...(b.memory ? { memory: guard(b.memory.obj, 'memory', b.memory.reads, st) as never } : {}),
      ...(b.secretStore ? { secretStore: guard(b.secretStore.obj, 'secretStore', b.secretStore.reads, st) as never } : {}),
      ...(b.promptUser ? { promptUser: b.promptUser as never } : {}),
      ...(b.activeScopes ? { activeScopes: b.activeScopes } : {}),
    });
    if (b.currentThreadId !== undefined) agent.currentThreadId = b.currentThreadId;
    const result = await (agent as unknown as { _executeOneInner(tc: unknown): Promise<{ content: unknown; is_error?: boolean }> })
      ._executeOneInner({ type: 'tool_use', id: 'tu_1', name: f.tool.definition.name, input: f.input });
    st.calls.push(...fsWatch.calls.map(c => ({ on: 'fs', method: c.fn, read: false, own: c.own, any: c.any })));
    st.violations.push(...fsWatch.violations);
    const cut = b.spy.lastIndexOf('.');
    return { result, st, trail, on: b.spy.slice(0, cut), method: b.spy.slice(cut + 1), target: b.target ?? f.row.target };
  } finally {
    fsWatch.open = null;
    b.cleanup?.();
  }
}

// ── shared builders ────────────────────────────────────────────────────────────────────────────

const dirs: string[] = [];
const closers: Array<() => void> = [];
const tmp = (p: string): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); dirs.push(d); return d; };

/** A fresh engine.db + subject store, closed after the test. */
function subjectStore(): InstanceType<typeof SubjectStore> {
  const engine = new EngineDb(join(tmp('lynox-iw-subj-'), 'engine.db'), '');
  closers.push(() => engine.close());
  return new SubjectStore(engine);
}

/** A real task manager over history.db + engine.db, as the worker loop has it. */
function taskManager(): { tm: InstanceType<typeof TaskManager>; history: InstanceType<typeof RunHistory> } {
  const d = tmp('lynox-iw-task-');
  const history = new RunHistory(join(d, 'history.db'));
  const engine = new EngineDb(join(d, 'engine.db'));
  history.setVerbGraph(engine);
  closers.push(() => { engine.close(); history.close(); });
  return { tm: new TaskManager(history), history };
}

const memoryMock = (over: Record<string, unknown>): object => ({
  load: vi.fn(async () => ''), loadScoped: vi.fn(async () => ''), append: vi.fn(async () => true), appendScoped: vi.fn(async () => true),
  delete: vi.fn(async () => 0), deleteScoped: vi.fn(async () => 0), update: vi.fn(async () => false), updateScoped: vi.fn(async () => false),
  render: vi.fn(() => ''), ...over,
});

const planFor = (over: Partial<PlannedPipeline> = {}): PlannedPipeline => ({
  id: 'wf-1', name: 'Monthly Report', goal: 'report',
  steps: [{ id: 'step-0', task: 'Fetch the data' }, { id: 'step-1', task: 'Write the report', input_from: ['step-0'] }],
  reasoning: '', estimatedCost: 0, createdAt: '2026-06-24T00:00:00.000Z', executed: false, executionMode: 'orchestrated',
  template: true, mode: 'autonomous', parameters: [], ...over,
});

const workflowHistory = (over: Record<string, unknown> = {}): object => ({
  insertPlannedPipeline: vi.fn(), insertProcess: vi.fn(),
  getPlannedPipeline: vi.fn(() => undefined), getTriggersByPipelineId: vi.fn(() => []),
  getAvgStepCostByModelTier: vi.fn(() => ({})), getRun: vi.fn(() => ({ id: 'run-1', session_id: 'thread-1' })),
  getSessionToolCalls: vi.fn(() => [
    { id: 'tc0', run_id: 'run-0', tool_name: 'http_request', input_json: '{}', output_json: '', duration_ms: 1, sequence_order: 0 },
  ]),
  getRunToolCalls: vi.fn(() => []),
  ...over,
});

const vault = (seed: Record<string, string> = {}): object => {
  const map: Record<string, string> = { ...seed };
  return {
    resolve: (n: string) => map[n] ?? null,
    extractSecretNames: () => [],
    resolveSecretRefs: (i: unknown) => i,
    maskSecrets: (s: string) => s,
    containsSecret: () => false,
    isEnvironmentSecret: () => false,
    listNames: () => Object.keys(map),
    set: (n: string, v: string) => { map[n] = v; },
    deleteSecret: (n: string) => delete map[n],
  };
};
const VAULT_READS = ['resolve', 'extractSecretNames', 'resolveSecretRefs', 'maskSecrets', 'containsSecret', 'isEnvironmentSecret', 'listNames'] as const;

const PROFILE: ApiProfile = {
  id: 'test-api', name: 'Test API', base_url: 'https://api.openai.com/v1', description: 'A test API.',
  auth: { type: 'bearer' }, rate_limit: { requests_per_minute: 60 },
  endpoints: [{ method: 'POST', path: '/search', description: 'Search items' }],
  guidelines: ['Always POST'], avoid: ['No GET for mutations'],
};
/** An API store with flat-JSON files under the data dir, seeded with the mandate's own profile. */
function apiStore(seed: ApiProfile | null): InstanceType<typeof ApiStore> {
  const store = new ApiStore();
  if (seed !== null) store.register({ ...seed, created_by: TAG });
  return store;
}
const API_READS = ['get', 'storedProfile', 'knownProfiles', 'saveRefusal', 'deleteRefusal', 'unreadableSourceOf', 'unreadableClearedByHand',
  'getProfiles', 'getAll', 'list', 'heldBackProfiles', 'hostOwners', 'profileForHost', 'isHeldBack', 'waitingConnections', 'heldBack'] as const;

// ── the fixtures: one per site and branch ───────────────────────────────────

const FIXTURES: Fixture[] = [
  // knowledge / memory
  { site: 'remember#create', branch: 'create', created: true, row: { verb: 'create', target: 'knowledge' }, tool: rememberTool as ToolEntry, input: { text: 'ACME renews in March', subject: 'ACME' },
    build: () => ({ ctx: { knowledgeStore: { obj: { write: vi.fn(() => ({ status: 'active', id: 'abcd1234-0000-4000-8000-000000000001' })) }, reads: [] } }, spy: 'ctx.knowledgeStore.write' }) },
  { site: 'memory_block_edit#change', branch: 'append', row: { verb: 'change', target: 'memory_block block=playbook' }, tool: memoryBlockEditTool as ToolEntry, input: { block: 'playbook', mode: 'append', new_text: 'Always cc finance.' },
    build: () => ({ ctx: { knowledgeStore: { obj: { editBlock: vi.fn() }, reads: [] } }, promptUser: async () => 'Apply', spy: 'ctx.knowledgeStore.editBlock' }) },
  { site: 'memory_retire#change', branch: 'retire', row: { verb: 'change', target: 'knowledge entry=abcd1234-0000' }, tool: memoryRetireTool as ToolEntry, input: { id: 'abcd1234' },
    build: () => ({
      ctx: { knowledgeStore: { obj: { findActiveByIdPrefix: vi.fn(() => ({ id: 'abcd1234-0000', sourceType: 'agent_inferred', text: 'old fact' })), retireEntry: vi.fn() }, reads: ['findActiveByIdPrefix'] } },
      promptUser: async () => 'Retire', spy: 'ctx.knowledgeStore.retireEntry',
    }) },
  { site: 'memory_store#create', branch: 'scoped', row: { verb: 'create', target: 'memory ns=knowledge scope=context' }, tool: memoryStoreTool as ToolEntry, input: { namespace: 'knowledge', content: 'x', scope: 'context:proj1' },
    build: () => ({ memory: { obj: memoryMock({}), reads: [] }, activeScopes: [{ type: 'context', id: 'proj1' }], spy: 'memory.appendScoped' }) },
  { site: 'memory_store#create', branch: 'unscoped', row: { verb: 'create', target: 'memory ns=knowledge' }, tool: memoryStoreTool as ToolEntry, input: { namespace: 'knowledge', content: 'x' },
    build: () => ({ memory: { obj: memoryMock({}), reads: [] }, spy: 'memory.append' }) },
  { site: 'memory_delete#delete', branch: 'delete', row: { verb: 'delete', target: 'memory ns=knowledge' }, tool: memoryDeleteTool as ToolEntry, input: { namespace: 'knowledge', pattern: 'old' },
    build: () => ({
      memory: { obj: memoryMock({ delete: vi.fn(async () => 1) }), reads: [] },
      ctx: { knowledgeLayer: { obj: { deactivateByPattern: vi.fn(async () => 1) }, reads: [] } }, spy: 'memory.delete',
    }) },
  // No flat line matched; the mirror held a row and deactivated it.
  { site: 'memory_delete#delete', branch: 'delete, only the mirror held it', wrote: 'part', row: { verb: 'delete', target: 'memory ns=knowledge' }, tool: memoryDeleteTool as ToolEntry, input: { namespace: 'knowledge', pattern: 'old' },
    build: () => ({
      memory: { obj: memoryMock({}), reads: [] },
      ctx: { knowledgeLayer: { obj: { deactivateByPattern: vi.fn(async () => 1) }, reads: [] } }, spy: 'memory.delete',
    }) },
  // The flat lines go, the mirror's reap throws and the handler answers it: a change, not all of it.
  { site: 'memory_delete#delete', branch: 'delete, the mirror throws', wrote: 'part', row: { verb: 'delete', target: 'memory ns=knowledge' }, tool: memoryDeleteTool as ToolEntry, input: { namespace: 'knowledge', pattern: 'old' },
    build: () => ({
      memory: { obj: memoryMock({ delete: vi.fn(async () => 1) }), reads: [] },
      ctx: { knowledgeLayer: { obj: { deactivateByPattern: vi.fn(async () => { throw new Error('mirror down'); }) }, reads: [] } }, spy: 'memory.delete',
    }) },
  { site: 'memory_update#exact', branch: 'exact', row: { verb: 'change', target: 'memory ns=knowledge' }, tool: memoryUpdateTool as ToolEntry, input: { namespace: 'knowledge', old_content: 'renews in March', new_content: 'renews in April' },
    build: () => ({ memory: { obj: memoryMock({ update: vi.fn(async () => true) }), reads: [] }, spy: 'memory.update' }) },
  { site: 'memory_update#fallback', branch: 'scoped', row: { verb: 'change', target: 'memory ns=knowledge scope=context' }, tool: memoryUpdateTool as ToolEntry, before: ['memory_update#exact'],
    input: { namespace: 'knowledge', old_content: 'ACME renews contract March', new_content: 'ACME renews contract April', scope: 'context:proj1' },
    build: () => ({
      memory: { obj: memoryMock({ loadScoped: vi.fn(async () => 'ACME renews contract in March') }), reads: ['loadScoped'] },
      activeScopes: [{ type: 'context', id: 'proj1' }], spy: 'memory.deleteScoped',
    }) },
  ...((): Fixture[] => {
    // Only one of the two marking steps proves a change; the new text was already there.
    const NEW = 'ACME renews contract April';
    const input = { namespace: 'knowledge', old_content: 'ACME renews contract March', new_content: NEW };
    const one = (scoped: boolean, step: 'delete' | 'append'): Fixture => ({
      site: 'memory_update#fallback', branch: `${scoped ? 'scoped' : 'unscoped'}, only the mark's ${step} proves a change`, wrote: 'part',
      row: { verb: 'change', target: scoped ? 'memory ns=knowledge scope=context' : 'memory ns=knowledge' }, tool: memoryUpdateTool as ToolEntry, before: ['memory_update#exact'],
      input: scoped ? { ...input, scope: 'context:proj1' } : input,
      build: () => ({
        memory: { obj: memoryMock({
          ...(scoped ? { loadScoped: vi.fn(async () => 'ACME renews contract in March') } : { load: vi.fn(async () => 'ACME renews contract in March') }),
          [scoped ? 'deleteScoped' : 'delete']: vi.fn(async () => (step === 'delete' ? 1 : 0)),
          [scoped ? 'appendScoped' : 'append']: vi.fn(async (_ns: string, text: string) => step === 'append' && text !== NEW),
        }), reads: [scoped ? 'loadScoped' : 'load'] },
        ...(scoped ? { activeScopes: [{ type: 'context', id: 'proj1' }] } : {}), spy: scoped ? 'memory.deleteScoped' : 'memory.delete',
      }),
    });
    return [one(true, 'delete'), one(true, 'append'), one(false, 'delete'), one(false, 'append')];
  })(),
  // The old line is marked superseded; the new text was already there.
  { site: 'memory_update#fallback', branch: 'scoped, the new text already held', wrote: 'part', row: { verb: 'change', target: 'memory ns=knowledge scope=context' }, tool: memoryUpdateTool as ToolEntry, before: ['memory_update#exact'],
    input: { namespace: 'knowledge', old_content: 'ACME renews contract March', new_content: 'ACME renews contract April', scope: 'context:proj1' },
    build: () => ({
      memory: { obj: memoryMock({
        loadScoped: vi.fn(async () => 'ACME renews contract in March'),
        deleteScoped: vi.fn(async () => 1),
        appendScoped: vi.fn(async (_ns: string, text: string) => text !== 'ACME renews contract April'),
      }), reads: ['loadScoped'] },
      activeScopes: [{ type: 'context', id: 'proj1' }], spy: 'memory.deleteScoped',
    }) },
  { site: 'memory_update#fallback', branch: 'unscoped', row: { verb: 'change', target: 'memory ns=knowledge' }, tool: memoryUpdateTool as ToolEntry, before: ['memory_update#exact'],
    input: { namespace: 'knowledge', old_content: 'ACME renews contract March', new_content: 'ACME renews contract April' },
    build: () => ({ memory: { obj: memoryMock({ load: vi.fn(async () => 'ACME renews contract in March') }), reads: ['load'] }, spy: 'memory.delete' }) },
  { site: 'memory_promote#move', branch: 'move', row: { verb: 'move', target: 'memory ns=methods from=user to=context' }, tool: memoryPromoteTool as ToolEntry,
    input: { namespace: 'methods', content_pattern: 'pattern B', from_scope: 'user:alex', to_scope: 'context:proj1' },
    build: () => ({
      memory: { obj: memoryMock({ loadScoped: vi.fn(async () => 'User pattern A\nUser pattern B'), deleteScoped: vi.fn(async () => 1) }), reads: ['loadScoped'] },
      activeScopes: [{ type: 'global', id: 'global' }, { type: 'context', id: 'proj1' }, { type: 'user', id: 'alex' }], spy: 'memory.appendScoped',
    }) },
  // Copied, but the source line was gone by the delete: one of the two main steps.
  { site: 'memory_promote#move', branch: 'move, the source line already gone', wrote: 'part', row: { verb: 'move', target: 'memory ns=methods from=user to=context' }, tool: memoryPromoteTool as ToolEntry,
    input: { namespace: 'methods', content_pattern: 'pattern B', from_scope: 'user:alex', to_scope: 'context:proj1' },
    build: () => ({
      memory: { obj: memoryMock({ loadScoped: vi.fn(async () => 'User pattern A\nUser pattern B') }), reads: ['loadScoped'] },
      activeScopes: [{ type: 'global', id: 'global' }, { type: 'context', id: 'proj1' }, { type: 'user', id: 'alex' }], spy: 'memory.appendScoped',
    }) },
  // Neither main step proves a write (the target held the line, the source line was gone); the
  // knowledge twin it retired does, and alone it cannot say `all`.
  { site: 'memory_promote#move', branch: 'move, only the knowledge twin retired', wrote: 'part', row: { verb: 'move', target: 'memory ns=methods from=user to=context' }, tool: memoryPromoteTool as ToolEntry,
    input: { namespace: 'methods', content_pattern: 'pattern B', from_scope: 'user:alex', to_scope: 'context:proj1' },
    build: () => ({
      memory: { obj: memoryMock({ loadScoped: vi.fn(async () => 'User pattern A\nUser pattern B'), appendScoped: vi.fn(async () => false) }), reads: ['loadScoped'] },
      ctx: { knowledgeLayer: { obj: { retireForMove: vi.fn(async () => ['abcd1234-0000-4000-8000-000000000002']) }, reads: [] } },
      activeScopes: [{ type: 'global', id: 'global' }, { type: 'context', id: 'proj1' }, { type: 'user', id: 'alex' }], spy: 'memory.appendScoped',
    }) },
  // Both main steps proved, but retiring the twin threw (its rows can be retired before the graph
  // mirror throws): a step that threw caps the row at part, as for a delete whose mirror throws.
  { site: 'memory_promote#move', branch: 'move, retiring the knowledge twin throws', wrote: 'part', row: { verb: 'move', target: 'memory ns=methods from=user to=context' }, tool: memoryPromoteTool as ToolEntry,
    input: { namespace: 'methods', content_pattern: 'pattern B', from_scope: 'user:alex', to_scope: 'context:proj1' },
    build: () => ({
      memory: { obj: memoryMock({ loadScoped: vi.fn(async () => 'User pattern A\nUser pattern B'), deleteScoped: vi.fn(async () => 1) }), reads: ['loadScoped'] },
      ctx: { knowledgeLayer: { obj: { retireForMove: vi.fn(async () => { throw new Error('mirror down'); }) }, reads: [] } },
      activeScopes: [{ type: 'global', id: 'global' }, { type: 'context', id: 'proj1' }, { type: 'user', id: 'alex' }], spy: 'memory.appendScoped',
    }) },
  // The same, but no twin was found: an empty list proves nothing, so the row says what 1a says.
  { site: 'memory_promote#move', branch: 'move, no knowledge twin found', wrote: null, row: { verb: 'move', target: 'memory ns=methods from=user to=context' }, tool: memoryPromoteTool as ToolEntry,
    input: { namespace: 'methods', content_pattern: 'pattern B', from_scope: 'user:alex', to_scope: 'context:proj1' },
    build: () => ({
      memory: { obj: memoryMock({ loadScoped: vi.fn(async () => 'User pattern A\nUser pattern B'), appendScoped: vi.fn(async () => false) }), reads: ['loadScoped'] },
      ctx: { knowledgeLayer: { obj: { retireForMove: vi.fn(async () => []) }, reads: [] } },
      activeScopes: [{ type: 'global', id: 'global' }, { type: 'context', id: 'proj1' }, { type: 'user', id: 'alex' }], spy: 'memory.appendScoped',
    }) },
  { site: 'subjects_merge#change', branch: 'merge', row: { verb: 'change', target: 'set in build' }, tool: subjectsMergeTool as ToolEntry, input: { duplicate: 'Ada', canonical: 'Dr. Ada Lovelace' },
    build: () => {
      setDataDir(tmp('lynox-iw-merge-'));
      const subjects = subjectStore();
      const dup = subjects.createSubject({ kind: 'person', name: 'Ada' });
      const canon = subjects.createSubject({ kind: 'person', name: 'Dr. Ada Lovelace' });
      return { target: `subjects duplicate=${dup} canonical=${canon}`, ctx: { subjectStore: { obj: subjects, reads: ['findCanonical', 'findByAlias'] } }, promptUser: async () => 'Merge', spy: 'ctx.subjectStore.executeMerge', cleanup: () => setDataDir(null) };
    } },

  // data store, contacts, artifacts, files, threads
  { site: 'data_store_create#create', branch: 'create', row: { verb: 'create', target: 'data_store' }, tool: dataStoreCreateTool as ToolEntry, input: { name: 'leads', columns: [{ name: 'email', type: 'string' }] },
    build: () => ({ ctx: { dataStore: { obj: { createCollection: vi.fn(() => ({ name: 'leads', columns: [{ name: 'email', type: 'string' }], scopeType: 'context', scopeId: '' })) }, reads: [] } }, spy: 'ctx.dataStore.createCollection' }) },
  { site: 'data_store_insert#save', branch: 'insert', row: { verb: 'save', target: 'data_store' }, tool: dataStoreInsertTool as ToolEntry, input: { collection: 'leads', records: [{ email: 'a@b.c' }] },
    build: () => ({ ctx: { dataStore: { obj: { insertRecords: vi.fn(() => ({ inserted: 1, updated: 0, errors: [] })) }, reads: [] } }, spy: 'ctx.dataStore.insertRecords' }) },
  { site: 'data_store_delete#delete', branch: 'delete', row: { verb: 'delete', target: 'data_store' }, tool: dataStoreDeleteTool as ToolEntry, input: { collection: 'leads', filter: { email: 'a@b.c' } },
    hit: ['records=2', 'id=7', 'id=9'],
    build: () => ({ ctx: { dataStore: { obj: { deleteRecordsReturningIds: vi.fn(() => ({ deleted: 2, ids: [7, 9] })) }, reads: [] } }, spy: 'ctx.dataStore.deleteRecordsReturningIds' }) },
  { site: 'data_store_drop#delete', branch: 'drop', row: { verb: 'delete', target: 'data_store' }, tool: dataStoreDropTool as ToolEntry, input: { collection: 'leads' },
    build: () => ({ ctx: { dataStore: { obj: { dropCollection: vi.fn(() => true) }, reads: [] } }, spy: 'ctx.dataStore.dropCollection' }) },
  { site: 'contacts_save#save', branch: 'save', row: { verb: 'save', target: 'contacts' }, tool: contactsSaveTool as ToolEntry, input: { name: 'Ada', email: 'ada@x.example' },
    build: () => ({ ctx: { crm: { obj: { upsertContact: vi.fn(() => ({ inserted: 1, updated: 0, errors: [] })) }, reads: [] } }, spy: 'ctx.crm.upsertContact' }) },
  { site: 'artifact_save#save', branch: 'create', created: true, row: { verb: 'create', target: 'artifacts' }, tool: artifactSaveTool as ToolEntry, input: { title: 'Pitch', content: '# x' },
    build: () => ({ ctx: { artifactStore: { obj: { save: vi.fn(() => ({ id: 'abcd1234', title: 'Pitch', version: 1 })), pathFor: () => '/files/abcd1234.md' }, reads: ['pathFor'] } }, spy: 'ctx.artifactStore.save' }) },
  { site: 'artifact_save#save', branch: 'update', row: { verb: 'save', target: 'artifacts artifact=abcd1234' }, tool: artifactSaveTool as ToolEntry, input: { title: 'Pitch', content: '# y', id: 'abcd1234' },
    build: () => ({ ctx: { artifactStore: { obj: { save: vi.fn(() => ({ id: 'abcd1234', title: 'Pitch', version: 2 })), pathFor: () => '/files/abcd1234.md' }, reads: ['pathFor'] } }, spy: 'ctx.artifactStore.save' }) },
  { site: 'artifact_delete#delete', branch: 'delete', row: { verb: 'delete', target: 'artifacts artifact=abcd1234' }, tool: artifactDeleteTool as ToolEntry, input: { id: 'abcd1234' },
    build: () => ({ ctx: { artifactStore: { obj: { delete: vi.fn(() => true) }, reads: [] } }, spy: 'ctx.artifactStore.delete' }) },
  { site: 'artifact_restore#change', branch: 'restore', row: { verb: 'change', target: 'artifacts artifact=abcd1234 version=1' }, tool: artifactRestoreTool as ToolEntry, input: { id: 'abcd1234', version: 1 },
    build: () => ({ ctx: { artifactStore: { obj: { restore: vi.fn(() => ({ id: 'abcd1234', title: 'Pitch', version: 3 })) }, reads: [] } }, spy: 'ctx.artifactStore.restore' }) },
  { site: 'media_process#anchored', branch: 'anchored', created: true, row: { verb: 'create', target: /^files file=media_\d+_[0-9a-f]{8}\.mp4$/ }, tool: mediaProcessTool as ToolEntry, input: { operation: 'transcode', input: 'a.mov', format: 'mp4' },
    build: () => {
      const ws = tmp('lynox-iw-media-ws-');
      writeFileSync(join(ws, 'a.mov'), Buffer.from([0, 1, 2, 3]));
      setTenantWorkspace(ws);
      fsWatch.area = ws;
      return { spy: 'fs.writeInPlace', cleanup: () => { closeWorkspaceBase(); clearTenantWorkspace(); fsWatch.area = null; } };
    } },
  { site: 'media_process#unanchored', branch: 'unanchored', created: true, row: { verb: 'create', target: /^files file=media_\d+_[0-9a-f]{8}\.mp4$/ }, tool: mediaProcessTool as ToolEntry, input: { operation: 'transcode', input: 'a.mov', format: 'mp4' },
    build: () => {
      // No workspace: the file area is the data dir's default workspace root.
      const data = tmp('lynox-iw-media-data-');
      const area = join(data, 'workspace');
      mkdirSync(area);
      writeFileSync(join(area, 'a.mov'), Buffer.from([0, 1, 2, 3]));
      const savedWs = process.env['LYNOX_WORKSPACE'];
      const savedRoot = process.env['LYNOX_WORKSPACE_ROOT'];
      delete process.env['LYNOX_WORKSPACE'];
      delete process.env['LYNOX_WORKSPACE_ROOT'];
      clearTenantWorkspace();
      resetWorkspaceCache();
      setDataDir(data);
      fsWatch.area = area;
      return {
        spy: 'fs.mkdirSync',
        cleanup: () => {
          setDataDir(null); fsWatch.area = null; resetWorkspaceCache();
          if (savedWs !== undefined) process.env['LYNOX_WORKSPACE'] = savedWs;
          if (savedRoot !== undefined) process.env['LYNOX_WORKSPACE_ROOT'] = savedRoot;
        },
      };
    } },
  { site: 'set_thread_context#clear', branch: 'clear', row: { verb: 'change', target: 'threads thread=thread-1' }, tool: setThreadContextTool as ToolEntry, input: { clear: true },
    build: () => ({ ctx: { threadStore: { obj: { updateThread: vi.fn(() => true) }, reads: [] }, subjectStore: { obj: {}, reads: [] } }, currentThreadId: 'thread-1', spy: 'ctx.threadStore.updateThread' }) },
  { site: 'set_thread_context#set', branch: 'with customer', row: { verb: 'change', target: 'threads thread=thread-1' }, tool: setThreadContextTool as ToolEntry, input: { project: 'Website', customer: 'ACME' },
    build: () => ({
      ctx: {
        threadStore: { obj: { updateThread: vi.fn(() => true) }, reads: [] },
        subjectStore: { obj: { findOrCreate: vi.fn(() => ({ id: 'org-1', ambiguous: false })), findOrCreateEngagement: vi.fn(() => ({ id: 'eng-1' })), getSubject: vi.fn(() => undefined) }, reads: ['getSubject'] },
      },
      currentThreadId: 'thread-1', spy: 'ctx.subjectStore.findOrCreate',
    }) },
  // The client and the project are new, the thread row is gone by the anchor write.
  { site: 'set_thread_context#set', branch: 'new client, the thread row gone', wrote: 'part', row: { verb: 'change', target: 'threads thread=thread-1' }, tool: setThreadContextTool as ToolEntry, input: { customer: 'ACME' },
    build: () => ({
      ctx: {
        threadStore: { obj: { updateThread: vi.fn(() => false) }, reads: [] },
        subjectStore: { obj: { findOrCreate: vi.fn(() => ({ id: 'org-1', ambiguous: false, created: true })), findOrCreateEngagement: vi.fn(), getSubject: vi.fn(() => undefined) }, reads: ['getSubject'] },
      },
      currentThreadId: 'thread-1', spy: 'ctx.subjectStore.findOrCreate',
    }) },
  { site: 'set_thread_context#set', branch: 'new project, the thread row gone', wrote: 'part', row: { verb: 'change', target: 'threads thread=thread-1' }, tool: setThreadContextTool as ToolEntry, input: { project: 'Website' },
    build: () => ({
      ctx: {
        threadStore: { obj: { updateThread: vi.fn(() => false) }, reads: [] },
        subjectStore: { obj: { findOrCreate: vi.fn(), findOrCreateEngagement: vi.fn(() => ({ id: 'eng-1', created: true })), getSubject: vi.fn(() => undefined) }, reads: ['getSubject'] },
      },
      currentThreadId: 'thread-1', spy: 'ctx.subjectStore.findOrCreateEngagement',
    }) },
  { site: 'set_thread_context#set', branch: 'project only', row: { verb: 'change', target: 'threads thread=thread-1' }, tool: setThreadContextTool as ToolEntry, input: { project: 'Website' },
    build: () => ({
      ctx: {
        threadStore: { obj: { updateThread: vi.fn(() => true) }, reads: [] },
        subjectStore: { obj: { findOrCreate: vi.fn(), findOrCreateEngagement: vi.fn(() => ({ id: 'eng-1' })), getSubject: vi.fn(() => undefined) }, reads: ['getSubject'] },
      },
      currentThreadId: 'thread-1', spy: 'ctx.subjectStore.findOrCreateEngagement',
    }) },

  // tasks and workflows
  { site: 'task_create#workflow', branch: 'workflow', created: true, row: { verb: 'create', target: 'tasks type=workflow' }, tool: taskCreateTool as ToolEntry, input: { title: 'Run X', workflow_id: 'wf-unknown' },
    build: () => { const { tm, history } = taskManager(); return { ctx: { taskManager: { obj: tm, reads: [] }, runHistory: { obj: history, reads: ['getPlannedPipeline'] } }, spy: 'ctx.taskManager.createPipelineTask' }; } },
  { site: 'task_create#scheduled', branch: 'scheduled', created: true, row: { verb: 'create', target: 'tasks type=scheduled' }, tool: taskCreateTool as ToolEntry, input: { title: 'Bericht', schedule: '0 9 * * 1' },
    build: () => { const { tm } = taskManager(); return { ctx: { taskManager: { obj: tm, reads: [] } }, spy: 'ctx.taskManager.createScheduled' }; } },
  { site: 'task_create#watch', branch: 'watch', created: true, row: { verb: 'create', target: 'tasks type=watch' }, tool: taskCreateTool as ToolEntry, input: { title: 'w', watch_url: 'https://example.org' },
    build: () => { const { tm } = taskManager(); return { ctx: { taskManager: { obj: tm, reads: [] } }, spy: 'ctx.taskManager.createWatch' }; } },
  { site: 'task_create#one-shot', branch: 'one-shot', created: true, row: { verb: 'create', target: 'tasks type=one-shot' }, tool: taskCreateTool as ToolEntry, input: { title: 'Daily notice', assignee: 'lynox', run_at: '2020-01-01T00:00:00.000Z' },
    build: () => { const { tm } = taskManager(); return { ctx: { taskManager: { obj: tm, reads: [] } }, spy: 'ctx.taskManager.create' }; } },
  { site: 'task_create#todo', branch: 'todo', created: true, row: { verb: 'create', target: 'tasks type=todo' }, tool: taskCreateTool as ToolEntry, input: { title: 'Call Ada' },
    build: () => { const { tm } = taskManager(); return { ctx: { taskManager: { obj: tm, reads: [] } }, spy: 'ctx.taskManager.create' }; } },
  ...((): Fixture[] => {
    let id = '';
    const seeded = (seed: (tm: InstanceType<typeof TaskManager>) => string, spy: string) => (): Built => {
      const { tm } = taskManager();
      id = seed(tm);
      // A trigger is named by its stored id; a to-do by nothing.
      return { ctx: { taskManager: { obj: tm, reads: ['getTrigger'] } }, spy, ...(tm.getTrigger(id) ? { target: `tasks task=${id}` } : {}) };
    };
    return [
      { site: 'task_update#change', branch: 'trigger', row: { verb: 'change', target: 'set in build' }, tool: taskUpdateTool as ToolEntry, get input() { return { task_id: id, title: 'Wochenbericht' }; },
        build: seeded((tm) => tm.createScheduled({ title: 'Bericht', scheduleCron: '0 9 * * 1' }).id, 'ctx.taskManager.markEditedBy') },
      // Only a field a trigger does not carry: the mark is written, the update changes nothing.
      { site: 'task_update#change', branch: 'trigger, only a field it does not take', wrote: 'part', row: { verb: 'change', target: 'set in build' }, tool: taskUpdateTool as ToolEntry, get input() { return { task_id: id, priority: 'high' }; },
        build: seeded((tm) => tm.createScheduled({ title: 'Bericht', scheduleCron: '0 9 * * 1' }).id, 'ctx.taskManager.markEditedBy') },
      { site: 'task_update#change', branch: 'to-do, complete', row: { verb: 'change', target: 'tasks' }, tool: taskUpdateTool as ToolEntry, get input() { return { task_id: id, status: 'completed' }; },
        build: seeded((tm) => tm.create({ title: 'Call', createdBy: TAG }).id, 'ctx.taskManager.complete') },
      { site: 'task_update#change', branch: 'to-do, update', row: { verb: 'change', target: 'tasks' }, tool: taskUpdateTool as ToolEntry, get input() { return { task_id: id, priority: 'high' }; },
        build: seeded((tm) => tm.create({ title: 'Call', createdBy: TAG }).id, 'ctx.taskManager.update') },
    ];
  })(),
  { site: 'plan_task#create', branch: 'auto-approved (no promptUser)', created: true, row: { verb: 'create', target: /^workflows workflow=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/ }, tool: planTaskTool as ToolEntry,
    input: { summary: 'Authored plan', phases: [{ name: 'Step one', steps: ['Do the thing'], tools: [] }] },
    build: () => ({ ctx: { runHistory: { obj: workflowHistory(), reads: ['getAvgStepCostByModelTier', 'getPlannedPipeline'] } }, spy: 'ctx.runHistory.insertPlannedPipeline' }) },
  { site: 'plan_task#create', branch: 'Proceed', created: true, row: { verb: 'create', target: /^workflows workflow=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/ }, tool: planTaskTool as ToolEntry,
    input: { summary: 'Authored plan', phases: [{ name: 'Step one', steps: ['Do the thing'], tools: [] }] },
    build: () => ({ ctx: { runHistory: { obj: workflowHistory(), reads: ['getAvgStepCostByModelTier', 'getPlannedPipeline'] } }, promptUser: async () => 'Proceed', spy: 'ctx.runHistory.insertPlannedPipeline' }) },
  { site: 'save_workflow#copy', branch: 'copy', created: true, row: { verb: 'create', target: /^workflows workflow=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} from=plan-789$/ }, tool: saveWorkflowTool as ToolEntry, input: { name: 'Saved Ad Report', workflow_id: 'plan-789' },
    build: () => {
      _resetPipelineStore();
      storePipeline('plan-789', planFor({ id: 'plan-789', template: false, executed: true }));
      return { ctx: { runHistory: { obj: workflowHistory(), reads: ['getPlannedPipeline'] } }, spy: 'ctx.runHistory.insertPlannedPipeline', cleanup: () => _resetPipelineStore() };
    } },
  { site: 'save_workflow#session', branch: 'session', created: true, row: { verb: 'create', target: /^workflows workflow=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/ }, tool: saveWorkflowTool as ToolEntry, input: { name: 'Test' },
    build: () => {
      capture.fn.mockReset();
      capture.fn.mockResolvedValue({
        id: 'proc-1', name: 'Test Process', description: 'A test process', sourceRunId: 'run-0',
        steps: [{ order: 0, tool: 'http_request', description: 'Fetch data', inputTemplate: { url: 'https://api.example.com' }, dependsOn: [] }],
        parameters: [], createdAt: '2026-03-21T12:00:00.000Z',
      });
      return {
        ctx: { runHistory: { obj: workflowHistory(), reads: ['getRun', 'getSessionToolCalls', 'getRunToolCalls', 'getAvgStepCostByModelTier'] } },
        userConfig: { api_key: 'test-key' }, currentThreadId: 'thread-1', spy: 'ctx.runHistory.insertPlannedPipeline', cleanup: () => _resetPipelineStore(),
      };
    } },
  { site: 'update_workflow_steps#change', branch: 'change', row: { verb: 'change', target: 'workflows workflow=wf-1' }, tool: updateWorkflowTool as ToolEntry,
    input: { workflow_id: 'wf-1', modifications: [{ action: 'update_task', step_id: 'step-1', value: 'Write it' }] },
    build: () => {
      _resetPipelineStore();
      const row = { id: 'wf-1', manifest_json: JSON.stringify(planFor()) };
      return {
        ctx: { runHistory: { obj: workflowHistory({ getPlannedPipeline: vi.fn(() => row) }), reads: ['getPlannedPipeline', 'getTriggersByPipelineId'] } },
        spy: 'ctx.runHistory.insertPlannedPipeline', cleanup: () => _resetPipelineStore(),
      };
    } },
  { site: 'import_workflow#create', branch: 'import', created: true, row: { verb: 'create', target: /^workflows workflow=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/ }, tool: importWorkflowTool as ToolEntry,
    get input() {
      const json = JSON.stringify(toPortableWorkflow(planFor({ id: 'wf_shared' })), null, 2);
      const fence = buildFence(json);
      return { block: `Here is a workflow to import:\n\n${fence}${LYNOX_WORKFLOW_INFO_STRING}\n${json}\n${fence}` };
    },
    build: () => { _resetPipelineStore(); return { ctx: { runHistory: { obj: workflowHistory(), reads: [] } }, spy: 'ctx.runHistory.insertPlannedPipeline', cleanup: () => _resetPipelineStore() }; } },

  // api_setup
  { site: 'api_setup#refine', branch: 'refine', row: { verb: 'change', target: 'api_profiles profile=test-api' }, tool: apiSetupTool as ToolEntry, input: { action: 'refine', id: 'test-api', refine: { addNotes: ['x'] } },
    build: () => { setDataDir(tmp('lynox-iw-api-')); return { ctx: { apiStore: { obj: apiStore(PROFILE), reads: API_READS } }, secretStore: { obj: vault(), reads: VAULT_READS }, spy: 'ctx.apiStore.save', cleanup: () => setDataDir(null) }; } },
  { site: 'api_setup#save', branch: 'update that empties token slots', row: { verb: 'change', target: 'api_profiles profile=test-api' }, tool: apiSetupTool as ToolEntry, input: { action: 'update', profile: PROFILE },
    build: () => {
      setDataDir(tmp('lynox-iw-api-'));
      // Stored as oauth2: its access and refresh slots were minted for the token endpoint, which
      // the update (bearer) drops, so they are emptied before the save.
      const stored: ApiProfile = { ...PROFILE, auth: { type: 'oauth2', oauth: { token_url: 'https://api.openai.com/oauth/token', authorize_url: 'https://api.openai.com/oauth/authorize', client_id_key: 'TEST_CID', client_secret_key: 'TEST_CSECRET' } } } as ApiProfile;
      return {
        ctx: { apiStore: { obj: apiStore(stored), reads: API_READS } },
        secretStore: { obj: vault({ TEST_API_ACCESS_TOKEN: 'a', TEST_API_REFRESH_TOKEN: 'r' }), reads: VAULT_READS },
        promptUser: async () => 'Allow', spy: 'secretStore.deleteSecret', cleanup: () => setDataDir(null),
      };
    } },
  // The vault keeps the value through the delete: nothing emptied, nothing saved, no change proven.
  { site: 'api_setup#save', branch: 'token slots that cannot be emptied', wrote: null, row: { verb: 'change', target: 'api_profiles profile=test-api' }, tool: apiSetupTool as ToolEntry, input: { action: 'update', profile: PROFILE },
    build: () => {
      setDataDir(tmp('lynox-iw-api-'));
      const stored: ApiProfile = { ...PROFILE, auth: { type: 'oauth2', oauth: { token_url: 'https://api.openai.com/oauth/token', authorize_url: 'https://api.openai.com/oauth/authorize', client_id_key: 'TEST_CID', client_secret_key: 'TEST_CSECRET' } } } as ApiProfile;
      const keeps = { ...vault({ TEST_API_ACCESS_TOKEN: 'a', TEST_API_REFRESH_TOKEN: 'r' }), deleteSecret: () => false };
      return {
        ctx: { apiStore: { obj: apiStore(stored), reads: API_READS } },
        secretStore: { obj: keeps, reads: VAULT_READS },
        promptUser: async () => 'Allow', spy: 'secretStore.deleteSecret', cleanup: () => setDataDir(null),
      };
    } },
  // A vault with no delete: nothing can be emptied, so nothing is proven, and the call refuses.
  { site: 'api_setup#save', branch: 'a vault without delete', wrote: null, row: { verb: 'change', target: 'api_profiles profile=test-api' }, tool: apiSetupTool as ToolEntry, input: { action: 'update', profile: PROFILE },
    build: () => {
      setDataDir(tmp('lynox-iw-api-'));
      const stored: ApiProfile = { ...PROFILE, auth: { type: 'oauth2', oauth: { token_url: 'https://api.openai.com/oauth/token', authorize_url: 'https://api.openai.com/oauth/authorize', client_id_key: 'TEST_CID', client_secret_key: 'TEST_CSECRET' } } } as ApiProfile;
      const { deleteSecret: _none, ...noDelete } = vault({ TEST_API_ACCESS_TOKEN: 'a', TEST_API_REFRESH_TOKEN: 'r' }) as Record<string, unknown>;
      return {
        ctx: { apiStore: { obj: apiStore(stored), reads: API_READS } },
        secretStore: { obj: noDelete, reads: VAULT_READS },
        promptUser: async () => 'Allow', spy: 'ctx.apiStore.saveRefusal', cleanup: () => setDataDir(null),
      };
    } },
  { site: 'api_setup#save', branch: 'empties token slots, then the save is refused', wrote: 'part', row: { verb: 'change', target: 'api_profiles profile=test-api' }, tool: apiSetupTool as ToolEntry, input: { action: 'update', profile: PROFILE },
    build: () => {
      setDataDir(tmp('lynox-iw-api-'));
      const stored: ApiProfile = { ...PROFILE, auth: { type: 'oauth2', oauth: { token_url: 'https://api.openai.com/oauth/token', authorize_url: 'https://api.openai.com/oauth/authorize', client_id_key: 'TEST_CID', client_secret_key: 'TEST_CSECRET' } } } as ApiProfile;
      const store = apiStore(stored);
      store.save = vi.fn(() => ({ ok: false as const, reason: 'Refused for the test.' }));
      return {
        ctx: { apiStore: { obj: store, reads: API_READS } },
        secretStore: { obj: vault({ TEST_API_ACCESS_TOKEN: 'a', TEST_API_REFRESH_TOKEN: 'r' }), reads: VAULT_READS },
        promptUser: async () => 'Allow', spy: 'secretStore.deleteSecret', cleanup: () => setDataDir(null),
      };
    } },
  { site: 'api_setup#save', branch: 'create, nothing to empty', row: { verb: 'create', target: 'api_profiles profile=test-api' }, tool: apiSetupTool as ToolEntry, input: { action: 'create', profile: PROFILE },
    build: () => { setDataDir(tmp('lynox-iw-api-')); return { ctx: { apiStore: { obj: apiStore(null), reads: API_READS } }, secretStore: { obj: vault(), reads: VAULT_READS }, spy: 'ctx.apiStore.save', cleanup: () => setDataDir(null) }; } },
  { site: 'api_setup#delete', branch: 'delete', row: { verb: 'delete', target: 'api_profiles profile=test-api' }, tool: apiSetupTool as ToolEntry, input: { action: 'delete', id: 'test-api' },
    build: () => { setDataDir(tmp('lynox-iw-api-')); return { ctx: { apiStore: { obj: apiStore(PROFILE), reads: API_READS } }, secretStore: { obj: vault(), reads: VAULT_READS }, promptUser: async () => 'Allow', spy: 'ctx.apiStore.remove', cleanup: () => setDataDir(null) }; } },
];

// ── the checks ─────────────────────────────────────────────────────────────────────────────────

afterEach(() => {
  for (const c of closers.splice(0)) { try { c(); } catch { /* closed */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
beforeEach(() => { _resetPipelineStore(); });

describe('every write site of a mandate\'s call writes its attempt row before its first change', () => {
  it('has a fixture for every site on INSTANCE_WRITE_SITES, and none for a site that is not', () => {
    expect([...new Set(FIXTURES.map(f => f.site))].sort()).toEqual([...INSTANCE_WRITE_SITES].sort());
  });

  describe.each(FIXTURES.map(f => [`${f.site} · ${f.branch}`, f] as const))('%s', (_label, f) => {
    it('(a) makes the expected first change with the site\'s attempt row already in the log, and no change before it', async () => {
      const { result, st, trail, on, method, target } = await drive(f, false);
      expect(st.violations, `a change before the attempt row; result: ${JSON.stringify(result.content)}`).toEqual([]);
      const first = st.calls.find(c => c.on === on && c.method === method);
      expect(first, `${on}.${method} was not called; result: ${JSON.stringify(result.content)}`).toBeDefined();
      expect(first!.own, `the attempt row of ${f.site} was not in the log when ${on}.${method} ran`).toBe(true);
      const rows = trail.db.prepare('SELECT * FROM audit_log WHERE action LIKE ? ORDER BY id').all(`instance:${f.site}:%`) as Array<Record<string, unknown>>;
      expect(rows.map(r => r['phase']), 'exactly the attempt and its outcome').toEqual(['attempt', 'returned']);
      for (const r of rows) {
        expect(r).toMatchObject({ action: `instance:${f.site}:${f.row.verb}`, actor_kind: 'mandate', actor_email: 'setup@example.org', mandate_id: 'M-1', run_id: 'run-1' });
      }
      const attemptTarget = String(rows[0]!['target']);
      if (typeof target === 'string') expect(attemptTarget).toBe(target); else expect(attemptTarget).toMatch(target);
      // The outcome: the attempt's target, led by what the results prove — or byte for byte the
      // attempt's when they prove nothing.
      const wrote = f.wrote === undefined ? 'all' : f.wrote;
      const outcomeTarget = String(rows[1]!['target']);
      const [store, ...rest] = attemptTarget.split(' ');
      if (wrote === null) {
        expect(outcomeTarget).toBe(attemptTarget);
      } else {
        const created = /^\S+ wrote=\S+ (created=\S+) /.exec(`${outcomeTarget} `)?.[1];
        expect(created !== undefined, `created= in ${outcomeTarget}`).toBe(f.created === true);
        expect(outcomeTarget).toBe([store, `wrote=${wrote}`, ...(created ? [created] : []), ...rest, ...(f.hit ?? [])].join(' '));
      }
      expect(rows[0]!['correlation_id']).toBe(rows[1]!['correlation_id']);
      const others = trail.db.prepare(`SELECT action FROM audit_log WHERE action LIKE 'instance:%' AND action NOT LIKE ?`).all(`instance:${f.site}:%`) as Array<{ action: string }>;
      expect(others.map(r => r.action.split(':')[1]).filter(s => !(f.before ?? []).includes(s as InstanceWriteSite)), 'rows of a site this call does not name').toEqual([]);
    });

    it('(b) with a log that cannot take the row, makes no change and answers with the refusal text', async () => {
      const { result, st, on, method } = await drive(f, true);
      expect(st.violations, 'a change before the attempt row').toEqual([]);
      expect(st.calls.filter(c => c.on === on && c.method === method), `${on}.${method} ran though its row could not be written`).toEqual([]);
      expect(result.is_error).toBe(true);
      expect(result.content).toBe(INSTANCE_WRITE_UNRECORDED);
    });
  });
});

describe('a block that throws after a proven change', () => {
  it('save_workflow from the session: the workflow is saved, the lineage write throws: failed, wrote=part, created=', async () => {
    const base = FIXTURES.find(f => f.site === 'save_workflow#session')!;
    const f: Fixture = {
      ...base,
      build: async () => {
        const built = await base.build();
        const history = (built.ctx as Record<string, { obj: Record<string, unknown> }>)['runHistory']!.obj;
        history['insertProcess'] = vi.fn(() => { throw new Error('history.db is read-only'); });
        return built;
      },
    };
    const { result, trail } = await drive(f, false);
    expect(JSON.stringify(result.content)).toContain('history.db is read-only');
    const rows = trail.db.prepare('SELECT phase, target FROM audit_log WHERE action LIKE ? ORDER BY id').all('instance:save_workflow#session:%') as Array<{ phase: string; target: string }>;
    expect(rows.map(r => r.phase)).toEqual(['attempt', 'failed']);
    expect(rows[1]!.target).toMatch(/^workflows wrote=part created=[0-9a-f-]{36} workflow=[0-9a-f-]{36}$/);
  });
});

describe('memory_focus is withheld from a mandate, kept for the owner', () => {
  async function focusAgent(principal: RequestPrincipal | undefined): Promise<{ agent: InstanceType<typeof Agent>; set: ReturnType<typeof vi.fn> }> {
    const { memoryFocusTool: tool } = await import('../tools/builtin/knowledge.js');
    const set = vi.fn();
    const toolContext = createToolContext({} as never);
    (toolContext as unknown as Record<string, unknown>)['knowledgeStore'] = { setFocusOverride: set };
    toolContext.auditLog = (await freshTrail(null)).log;
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', tools: [tool as ToolEntry], toolContext, ...(principal ? { principal } : {}) });
    return { agent, set };
  }
  const call = (agent: InstanceType<typeof Agent>): Promise<{ content: unknown; is_error?: boolean }> =>
    (agent as unknown as { _executeOneInner(tc: unknown): Promise<{ content: unknown; is_error?: boolean }> })
      ._executeOneInner({ type: 'tool_use', id: 'tu_f', name: 'memory_focus', input: {} });

  it('is not offered to a mandate\'s turn, and an injected call is refused before its handler', async () => {
    const { agent, set } = await focusAgent(MANDATE);
    expect(agent.getAvailableTools().map(t => t.definition.name)).not.toContain('memory_focus');
    const r = await call(agent);
    expect(r.is_error).toBe(true);
    expect(String(r.content)).toContain('Tool not available in this session: memory_focus');
    expect(set).not.toHaveBeenCalled();
  });

  it('control: the owner is offered it and its call runs', async () => {
    const { agent, set } = await focusAgent(undefined);
    expect(agent.getAvailableTools().map(t => t.definition.name)).toContain('memory_focus');
    const r = await call(agent);
    expect(r.is_error).toBeUndefined();
    expect(set).toHaveBeenCalledWith(null);
  });
});

describe('the refusal reaches the model whatever the handler made of it', () => {
  it('a handler whose catch turns the refusal into its own text: alone it says its text, through the dispatch the refusal', async () => {
    const trail = await freshTrail('data_store_drop#delete');
    const drop = vi.fn(() => true);
    const toolContext = createToolContext({} as never);
    (toolContext as unknown as Record<string, unknown>)['dataStore'] = { dropCollection: drop };
    toolContext.auditLog = trail.log;
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', tools: [dataStoreDropTool as ToolEntry], toolContext, principal: MANDATE });
    // Called alone, outside a call's slot: the handler's catch answers in its own words.
    const alone = await (dataStoreDropTool as ToolEntry).handler({ collection: 'leads' } as never, agent);
    expect(alone).toBe(`Error dropping collection: ${INSTANCE_WRITE_UNRECORDED}`);
    const r = await (agent as unknown as { _executeOneInner(tc: unknown): Promise<{ content: unknown; is_error?: boolean }> })
      ._executeOneInner({ type: 'tool_use', id: 'tu_d', name: 'data_store_drop', input: { collection: 'leads' } });
    expect(r).toMatchObject({ is_error: true, content: INSTANCE_WRITE_UNRECORDED });
    expect(drop).not.toHaveBeenCalled();
  });

  it('a mandate whose session has no log at all is refused the same', async () => {
    const drop = vi.fn(() => true);
    const toolContext = createToolContext({} as never);
    (toolContext as unknown as Record<string, unknown>)['dataStore'] = { dropCollection: drop };
    toolContext.auditLog = null;
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', tools: [dataStoreDropTool as ToolEntry], toolContext, principal: MANDATE });
    const r = await (agent as unknown as { _executeOneInner(tc: unknown): Promise<{ content: unknown; is_error?: boolean }> })
      ._executeOneInner({ type: 'tool_use', id: 'tu_d', name: 'data_store_drop', input: { collection: 'leads' } });
    expect(r).toMatchObject({ is_error: true, content: INSTANCE_WRITE_UNRECORDED });
    expect(drop).not.toHaveBeenCalled();
  });

  it('control: the owner\'s call writes no row and runs, whatever the log', async () => {
    const trail = await freshTrail('data_store_drop#delete');
    const drop = vi.fn(() => true);
    const toolContext = createToolContext({} as never);
    (toolContext as unknown as Record<string, unknown>)['dataStore'] = { dropCollection: drop };
    toolContext.auditLog = trail.log;
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', tools: [dataStoreDropTool as ToolEntry], toolContext });
    const r = await (agent as unknown as { _executeOneInner(tc: unknown): Promise<{ content: unknown; is_error?: boolean }> })
      ._executeOneInner({ type: 'tool_use', id: 'tu_d', name: 'data_store_drop', input: { collection: 'leads' } });
    expect(r.is_error).toBeUndefined();
    expect(drop).toHaveBeenCalledTimes(1);
    expect(trail.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get()).toEqual({ n: 0 });
  });
});

describe('the dispatch\'s catch answers with the refusal, not with what the handler threw after it', () => {
  it('a handler that throws an error of its own after its write was refused', async () => {
    const { withInstanceWrite } = await import('./instance-trail.js');
    const write = vi.fn();
    const tool: ToolEntry = {
      definition: { name: 'contacts_save', description: 'stand-in', input_schema: { type: 'object' as const, properties: {}, additionalProperties: true } },
      handler: async (_input: unknown, agent: unknown) => {
        try {
          withInstanceWrite(agent as never, { site: 'contacts_save#save', kind: 'save', store: 'contacts' }, write);
        } catch {
          throw new Error('contacts_save failed for a reason of its own');
        }
        return 'saved';
      },
    } as ToolEntry;
    const toolContext = createToolContext({} as never);
    toolContext.auditLog = (await freshTrail('contacts_save#save')).log;
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', tools: [tool], toolContext, principal: MANDATE });
    const r = await (agent as unknown as { _executeOneInner(tc: unknown): Promise<{ content: unknown; is_error?: boolean }> })
      ._executeOneInner({ type: 'tool_use', id: 'tu_c', name: 'contacts_save', input: {} });
    expect(r).toMatchObject({ is_error: true, content: INSTANCE_WRITE_UNRECORDED });
    expect(write).not.toHaveBeenCalled();
  });
});

// The refusal replaces what the handler threw, but not the two causes that say more: a stop of
// the run (its own sentence) and a question nobody can answer (it ends the run). Order in the
// dispatch's catch: stop, needs-input, refusal. The refusal alone: the witness just above.
describe('a refused write that also met a stop or an unanswerable question', () => {
  async function refusedThen(thenThrow: () => never, stopped: boolean): Promise<{ result: unknown; thrown: unknown; streamed: string[] }> {
    const { withInstanceWrite } = await import('./instance-trail.js');
    const tool: ToolEntry = {
      definition: { name: 'contacts_save', description: 'stand-in', input_schema: { type: 'object' as const, properties: {}, additionalProperties: true } },
      handler: async (_input: unknown, agent: unknown) => {
        try { withInstanceWrite(agent as never, { site: 'contacts_save#save', kind: 'save', store: 'contacts' }, () => undefined); } catch { /* refused */ }
        thenThrow();
      },
    } as ToolEntry;
    const toolContext = createToolContext({} as never);
    toolContext.auditLog = (await freshTrail('contacts_save#save')).log;
    const streamed: string[] = [];
    const agent = new Agent({
      name: 'test', model: 'claude-sonnet-4-6', tools: [tool], toolContext, principal: MANDATE,
      onStream: (async (e: { type: string; result?: string }) => { if (e.type === 'tool_result') streamed.push(String(e.result)); }) as never,
    });
    if (stopped) {
      const c = new AbortController();
      c.abort();
      (agent as unknown as { abortController: AbortController }).abortController = c;
    }
    let result: unknown; let thrown: unknown;
    try {
      result = await (agent as unknown as { _executeOneInner(tc: unknown): Promise<unknown> })._executeOneInner({ type: 'tool_use', id: 'tu_s', name: 'contacts_save', input: {} });
    } catch (err) { thrown = err; }
    return { result, thrown, streamed };
  }

  it('a stopped run answers with the stop\'s sentence, not the refusal', async () => {
    const { toolStoppedMessage } = await import('./agent.js');
    const { result } = await refusedThen(() => { throw new DOMException('This operation was aborted', 'AbortError'); }, true);
    expect(result).toMatchObject({ is_error: true });
    expect(String((result as { content: unknown }).content)).toContain(toolStoppedMessage('contacts_save'));
    expect(String((result as { content: unknown }).content)).not.toContain(INSTANCE_WRITE_UNRECORDED);
  });

  it('a question nobody can answer ends the run with its own message, not the refusal', async () => {
    const { InputRequiredError } = await import('./input-required.js');
    const { thrown, streamed } = await refusedThen(() => { throw new InputRequiredError('Which list?'); }, false);
    expect(thrown).toBeInstanceOf(InputRequiredError);
    expect(streamed).toHaveLength(1);
    expect(streamed[0]).toContain('Which list?');
    expect(streamed[0]).not.toContain(INSTANCE_WRITE_UNRECORDED);
  });
});

describe('a memory row names a namespace only from the fixed list', () => {
  // The dispatch rejects a namespace outside the schema's enum before the handler runs; the
  // handler's own mapping is what holds for a caller that does not go through it.
  it('records a namespace that is not on the list as `other`', async () => {
    const { runInCallSlot } = await import('./call-connection.js');
    const { instanceTrailFor } = await import('./instance-trail.js');
    const trail = await freshTrail(null);
    const toolContext = createToolContext({} as never);
    toolContext.auditLog = trail.log;
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', tools: [memoryStoreTool as ToolEntry], toolContext, principal: MANDATE, currentRunId: 'run-1', memory: memoryMock({}) as never });
    await runInCallSlot({ instanceTrail: instanceTrailFor(agent, 'memory_store') }, () =>
      (memoryStoreTool as ToolEntry).handler({ namespace: 'Mueller GmbH', content: 'x' }, agent));
    const rows = trail.db.prepare(`SELECT target FROM audit_log WHERE action LIKE 'instance:memory_store#create:%'`).all() as Array<{ target: string }>;
    expect(rows.map(r => r.target)).toEqual(['memory ns=other', 'memory wrote=all ns=other']);
  });
});
