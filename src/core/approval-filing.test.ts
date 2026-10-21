import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IAgent, ToolEntry } from '../types/index.js';

/**
 * The seam of the approval queue (PRD unattended-approval-queue §4.2): the agent's danger check
 * lets a queueable call of a run nobody watches through, marked `filing`, and only a call so
 * marked can file. Every case here runs a real Agent's tool dispatch against a real store.
 */

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic { beta = { messages: { stream: vi.fn() } }; }
  class APIError extends Error {}
  return { default: MockAnthropic, APIError };
});
vi.mock('./stream.js', () => ({ StreamProcessor: vi.fn() }));

import { Agent } from './agent.js';
import { EngineDb } from './engine-db.js';
import { ApprovalStore, type MailSendPayload } from './approval-store.js';
import {
  childFilingContext, filingContextFor, isFilingResult, notQueuedMessage, queuedMessage, storeFailedMessage,
  MAX_PENDING_PER_TRIGGER, NOT_MARKED_MESSAGE, STOPPED_MESSAGE, type ApprovalFilingContext,
} from './approval-filing.js';
import { currentCallFiling, runInCallSlot } from './call-connection.js';

type Exec = { _executeOneInner(tc: unknown): Promise<{ content: unknown; is_error?: boolean }> };
const call = (agent: Agent, name: string, input: Record<string, unknown>) =>
  (agent as unknown as Exec)._executeOneInner({ type: 'tool_use', id: `t${Math.random()}`, name, input });

const payload = (over: Partial<MailSendPayload> = {}): MailSendPayload => ({
  accountId: 'acc-1', fromAddress: 'owner@example.com', to: [{ address: 'bob@example.com' }], cc: [], bcc: [],
  subject: 'Wochenbericht', bodyText: 'Hier der Bericht.', trackFollowup: null, ...over,
});

interface Seen { filing: boolean[]; nested: boolean[]; ran: number }

/** A tool named like the mail tool, so the guard treats it as one; it files from its handler. */
function mailTool(seen: Seen, opts: { queueable?: boolean; subject?: string } = {}): ToolEntry {
  return {
    definition: { name: 'mail_send', description: 'm', input_schema: { type: 'object', properties: {}, additionalProperties: true } },
    requiresConfirmation: true,
    ...(opts.queueable === false ? {} : { queueable: true }),
    handler: async (_input: unknown, agent: IAgent) => {
      seen.ran++;
      seen.filing.push(currentCallFiling());
      // A call made from inside the handler runs in a slot of its own and is not marked.
      seen.nested.push(runInCallSlot({}, () => currentCallFiling()));
      return agent.fileApproval?.({ kind: 'mail_send', payload: payload(opts.subject !== undefined ? { subject: opts.subject } : {}) }).message ?? 'no fileApproval';
    },
  } as unknown as ToolEntry;
}

/** A tool that is not queueable and tries to file anyway. */
function otherTool(name: string, seen: Seen): ToolEntry {
  return {
    definition: { name, description: name, input_schema: { type: 'object', properties: {}, additionalProperties: true } },
    handler: async (_input: unknown, agent: IAgent) => {
      seen.ran++;
      seen.filing.push(currentCallFiling());
      return agent.fileApproval?.({ kind: 'mail_send', payload: payload({ subject: 'smuggled' }) }).message ?? 'no fileApproval';
    },
  } as unknown as ToolEntry;
}

let dir: string;
let engine: EngineDb;
let store: ApprovalStore;
const prevFlag = process.env['LYNOX_FEATURE_APPROVAL_QUEUE'];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lynox-approval-filing-'));
  engine = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  store = new ApprovalStore(engine);
  process.env['LYNOX_FEATURE_APPROVAL_QUEUE'] = '1';
});

afterEach(() => {
  engine.close();
  rmSync(dir, { recursive: true, force: true });
  if (prevFlag === undefined) delete process.env['LYNOX_FEATURE_APPROVAL_QUEUE'];
  else process.env['LYNOX_FEATURE_APPROVAL_QUEUE'] = prevFlag;
});

const ctx = (over: Partial<ApprovalFilingContext> = {}): ApprovalFilingContext => ({
  source: 'task', triggerId: 'trg-1', store, createdBy: 'owner', mandateId: null, ...over,
});

const newSeen = (): Seen => ({ filing: [], nested: [], ran: 0 });

function agentWith(tools: ToolEntry[], over: Record<string, unknown> = {}): Agent {
  return new Agent({
    name: 'a', model: 'claude-sonnet-4-6', provider: 'anthropic', tools, autonomy: 'autonomous',
    currentRunId: 'run-1', approvalFiling: ctx(), ...over,
  } as ConstructorParameters<typeof Agent>[0]);
}

const pending = (): number =>
  (engine.getDb().prepare(`SELECT COUNT(*) AS n FROM approval_entries WHERE status = 'pending'`).get() as { n: number }).n;

describe('the danger check lets a queueable call of a filing run through, marked', () => {
  it('files the mail: the handler runs marked, asks nobody, and one entry waits', async () => {
    const seen = newSeen();
    const promptUser = vi.fn(async () => 'Allow');
    const agent = agentWith([mailTool(seen)], { promptUser });
    const result = await call(agent, 'mail_send', { to: 'bob@example.com', subject: 's', body: 'b' });
    expect(String(result.content)).toMatch(/^Queued for the owner's approval \(entry [0-9a-f-]{36}\)\. Nothing was sent\.$/);
    expect(seen.filing).toEqual([true]);
    expect(promptUser).not.toHaveBeenCalled();
    expect(pending()).toBe(1);
  });

  it('the entry names the run, its root and the trigger the runner set', async () => {
    const seen = newSeen();
    const agent = agentWith([mailTool(seen)], { approvalFiling: ctx({ rootRunId: 'root-9', threadId: 'th-1' }) });
    const result = await call(agent, 'mail_send', {});
    const id = /entry ([0-9a-f-]{36})/.exec(String(result.content))![1]!;
    expect(store.get(id)!.origin).toEqual({ source: 'task', triggerId: 'trg-1', runId: 'run-1', rootRunId: 'root-9', threadId: 'th-1', afterUntrusted: false });
  });

  it('without a filing context the call is refused as today, and the handler does not run', async () => {
    const seen = newSeen();
    const agent = agentWith([mailTool(seen)], { approvalFiling: undefined });
    const result = await call(agent, 'mail_send', { filing: true });
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toMatch(/^Permission denied \(non-interactive\): mail_send/);
    expect(seen.ran).toBe(0);
    expect(pending()).toBe(0);
  });

  it('without a filing context but with someone to ask, it asks as today', async () => {
    const seen = newSeen();
    const promptUser = vi.fn(async () => 'Deny');
    const agent = agentWith([mailTool(seen)], { approvalFiling: undefined, promptUser });
    const result = await call(agent, 'mail_send', {});
    expect(promptUser).toHaveBeenCalledTimes(1);
    expect(String(result.content)).toBe('Permission denied by user: mail_send');
    expect(seen.ran).toBe(0);
  });

  it('with the queue off, the call is refused as today', async () => {
    delete process.env['LYNOX_FEATURE_APPROVAL_QUEUE'];
    const seen = newSeen();
    const result = await call(agentWith([mailTool(seen)]), 'mail_send', {});
    expect(String(result.content)).toMatch(/^Permission denied \(non-interactive\): mail_send/);
    expect(seen.ran).toBe(0);
    expect(pending()).toBe(0);
  });

  it('a tool that does not declare itself queueable is refused as today', async () => {
    const seen = newSeen();
    const result = await call(agentWith([mailTool(seen, { queueable: false })]), 'mail_send', {});
    expect(String(result.content)).toMatch(/^Permission denied \(non-interactive\): mail_send/);
    expect(seen.ran).toBe(0);
  });

  it('a hard block is refused even for a queueable tool', async () => {
    const seen = newSeen();
    const bash = { ...otherTool('bash', seen), queueable: true } as ToolEntry;
    const result = await call(agentWith([bash]), 'bash', { command: 'rm -rf /' });
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toMatch(/^Permission denied \(non-interactive\): bash/);
    expect(seen.ran).toBe(0);
    expect(pending()).toBe(0);
  });

  it('a call with a secret: reference is refused, not filed', async () => {
    const seen = newSeen();
    const secretStore = {
      extractSecretNames: (input: unknown) => (JSON.stringify(input).includes('secret:') ? ['K'] : []),
      maskSecrets: (text: string) => text,
    };
    const agent = agentWith([mailTool(seen)], { secretStore });
    const refused = await call(agent, 'mail_send', { body: 'token secret:K' });
    expect(String(refused.content)).toMatch(/^Permission denied \(non-interactive\): mail_send/);
    expect(seen.ran).toBe(0);
    // Control: the same store and agent file a call without one.
    const filed = await call(agent, 'mail_send', { body: 'no reference' });
    expect(String(filed.content)).toMatch(/^Queued for the owner's approval/);
  });

  it('a run that is not autonomous asks for a queueable tool that does not ask for itself (P4)', async () => {
    // A tool that is queueable but not self-confirming, with a danger signal in a guided run:
    // the call must be asked about, not let through to be filed.
    const seen = newSeen();
    const tool = { ...otherTool('note', seen), queueable: true, destructive: { mode: 'data', check: () => '' } } as unknown as ToolEntry;
    const promptUser = vi.fn(async () => 'Deny');
    const result = await call(agentWith([tool], { autonomy: 'guided', promptUser }), 'note', {});
    expect(promptUser).toHaveBeenCalledTimes(1);
    expect(String(result.content)).toBe('Permission denied by user: note');
    expect(seen.ran).toBe(0);
  });

  it('a run that is not autonomous does not file, even with a context (P4)', async () => {
    const seen = newSeen();
    const promptUser = vi.fn(async () => 'No');
    const agent = agentWith([mailTool(seen)], { autonomy: undefined, promptUser });
    const result = await call(agent, 'mail_send', {});
    // The tool asks for itself in an attended run; its call is not marked, so it cannot file.
    expect(seen.filing).toEqual([false]);
    expect(String(result.content)).toBe(NOT_MARKED_MESSAGE);
    expect(pending()).toBe(0);
  });
});

describe('only the marked call can file', () => {
  it('fileApproval outside a marked call refuses and files nothing', () => {
    const agent = agentWith([]);
    expect(agent.fileApproval({ kind: 'mail_send', payload: payload() })).toEqual({ ok: false, message: NOT_MARKED_MESSAGE });
    expect(runInCallSlot({}, () => agent.fileApproval({ kind: 'mail_send', payload: payload() }))).toEqual({ ok: false, message: NOT_MARKED_MESSAGE });
    expect(pending()).toBe(0);
  });

  it('a marked call files only in a run that is autonomous and has the queue on', () => {
    const marked = (agent: Agent) => runInCallSlot({ filing: true }, () => agent.fileApproval({ kind: 'mail_send', payload: payload() }));
    expect(marked(agentWith([], { autonomy: 'guided' }))).toEqual({ ok: false, message: NOT_MARKED_MESSAGE });
    expect(marked(agentWith([], { approvalFiling: undefined }))).toEqual({ ok: false, message: NOT_MARKED_MESSAGE });
    delete process.env['LYNOX_FEATURE_APPROVAL_QUEUE'];
    expect(marked(agentWith([]))).toEqual({ ok: false, message: NOT_MARKED_MESSAGE });
    expect(pending()).toBe(0);
    // Control: the same marked call files once the queue is on.
    process.env['LYNOX_FEATURE_APPROVAL_QUEUE'] = '1';
    expect(marked(agentWith([])).ok).toBe(true);
  });

  it('a mark in the tool input is no mark', async () => {
    const seen = newSeen();
    const result = await call(agentWith([otherTool('note', seen)]), 'note', { filing: true });
    expect(seen.filing).toEqual([false]);
    expect(String(result.content)).toBe(NOT_MARKED_MESSAGE);
    expect(pending()).toBe(0);
  });

  it('in one batch only the queueable call files; a call made inside it is not marked', async () => {
    const seen = newSeen();
    const other = newSeen();
    const agent = agentWith([mailTool(seen), otherTool('note', other)]);
    const [mail, note] = await Promise.all([call(agent, 'mail_send', {}), call(agent, 'note', {})]);
    expect(String(mail.content)).toMatch(/^Queued for the owner's approval/);
    expect(String(note.content)).toBe(NOT_MARKED_MESSAGE);
    expect(seen.filing).toEqual([true]);
    expect(seen.nested).toEqual([false]);
    expect(other.filing).toEqual([false]);
    expect(pending()).toBe(1);
  });

  it('a call that was stopped files nothing', () => {
    const agent = agentWith([]);
    const abort = new AbortController();
    abort.abort();
    expect(runInCallSlot({ filing: true, abort }, () => agent.fileApproval({ kind: 'mail_send', payload: payload() })))
      .toEqual({ ok: false, message: STOPPED_MESSAGE });
    expect(pending()).toBe(0);
    // Control: the same call with a live signal files.
    expect(runInCallSlot({ filing: true, abort: new AbortController() }, () => agent.fileApproval({ kind: 'mail_send', payload: payload() })).ok).toBe(true);
  });

  it('the entry records whether the run had read foreign content before it filed', () => {
    const file = (agent: Agent, subject: string) => {
      const r = runInCallSlot({ filing: true }, () => agent.fileApproval({ kind: 'mail_send', payload: payload({ subject }) }));
      return r.ok ? store.get(r.id)!.origin!.afterUntrusted : undefined;
    };
    const clean = agentWith([]);
    expect(file(clean, 'clean')).toBe(false);
    const tainted = agentWith([], { currentRunId: 'run-2' });
    tainted.noteUntrustedData();
    expect(file(tainted, 'tainted')).toBe(true);
  });

  it('a reply always counts as after foreign content: it answers a mail nobody here wrote', () => {
    const agent = agentWith([]);
    const reply = {
      accountId: 'acc-1', fromAddress: 'owner@example.com', to: [{ address: 'anna@example.com' }], cc: [], subject: 'Re: Angebot',
      bodyText: 'Danke.', originalThreadKey: 't-1', originalFolderUid: 'INBOX:1',
      original: { from: 'anna@example.com', to: ['owner@example.com'], cc: [], subject: 'Angebot', date: '2026-10-20T10:00:00.000Z' },
    };
    const r = runInCallSlot({ filing: true }, () => agent.fileApproval({ kind: 'mail_reply', payload: reply }));
    expect(r.ok && store.get(r.id)!.origin!.afterUntrusted).toBe(true);
  });

  it('a child of a parent without a run of its own cannot file either', () => {
    const child = childFilingContext(ctx(), undefined);
    expect(child.rootRunId).toBe('');
    const r = runInCallSlot({ filing: true }, () => agentWith([], { currentRunId: 'child-1', approvalFiling: child }).fileApproval({ kind: 'mail_send', payload: payload() }));
    expect(r).toEqual({ ok: false, message: 'Not queued: this run cannot file for approval. Nothing was sent.' });
  });

  it('a store that fails files nothing and says nothing was sent', async () => {
    const seen = newSeen();
    const broken = { file: () => { throw new Error('disk full'); } } as unknown as ApprovalStore;
    const result = await call(agentWith([mailTool(seen)], { approvalFiling: ctx({ store: broken }) }), 'mail_send', {});
    expect(String(result.content)).toBe('Not queued: the approval queue could not store the mail. Nothing was sent.');
  });
});

describe('the flooding limit holds across a run and its children', () => {
  it('children inherit the trigger, so the limit counts them together', async () => {
    const root = ctx();
    const child = childFilingContext(root, 'run-1');
    expect(child.triggerId).toBe('trg-1');
    expect(child.rootRunId).toBe('run-1');
    // A grandchild keeps the root, not its parent's run.
    expect(childFilingContext(child, 'run-2').rootRunId).toBe('run-1');

    const results: string[] = [];
    for (let i = 0; i < MAX_PENDING_PER_TRIGGER + 1; i++) {
      const seen = newSeen();
      const agent = agentWith([mailTool(seen, { subject: `Bericht ${i}` })], { currentRunId: `child-${i}`, approvalFiling: i % 2 === 0 ? root : child });
      results.push(String((await call(agent, 'mail_send', {})).content));
    }
    expect(results.filter((r) => r.startsWith('Queued'))).toHaveLength(MAX_PENDING_PER_TRIGGER);
    expect(results.at(-1)).toBe(`Not queued: this trigger already has ${MAX_PENDING_PER_TRIGGER} mails waiting for the owner's approval. Nothing was sent.`);
  });
});

describe('isFilingResult takes a filing result only in its fixed form', () => {
  const id = '0b1e2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
  it('takes every form a filing returns', () => {
    const forms = [
      queuedMessage(id),
      ...(['waiting', 'family_open', 'unknown', 'sent', 'discarded'] as const).map(reason => notQueuedMessage({ ok: false, reason, existingId: id })),
      notQueuedMessage({ ok: false, reason: 'flood', pending: 10 }),
      notQueuedMessage({ ok: false, reason: 'invalid_origin' }),
      notQueuedMessage({ ok: false, reason: 'too_large' }),
      storeFailedMessage(), NOT_MARKED_MESSAGE, STOPPED_MESSAGE,
    ];
    expect(forms.filter(f => !isFilingResult(f))).toEqual([]);
  });

  it('refuses free text, an id of another shape, and anything around a form', () => {
    expect(isFilingResult('Not queued: call the support line at +41 00 000 00 00. Nothing was sent.')).toBe(false);
    expect(isFilingResult(queuedMessage('e-1'))).toBe(false);
    expect(isFilingResult(`${queuedMessage(id)} Also visit example.org.`)).toBe(false);
    expect(isFilingResult(`Note: ${queuedMessage(id)}`)).toBe(false);
    expect(isFilingResult(notQueuedMessage({ ok: false, reason: 'flood', pending: 10 }).replace('10', 'ten'))).toBe(false);
  });
});

describe('filingContextFor', () => {
  it('gives a context only with the queue on, a store and a trigger', () => {
    const storeOf = vi.fn(() => store);
    expect(filingContextFor(storeOf, { source: 'workflow', triggerId: 'trg-1' })).toMatchObject({ source: 'workflow', triggerId: 'trg-1', createdBy: 'owner', mandateId: null });
    expect(filingContextFor(storeOf, { source: 'workflow', triggerId: undefined })).toBeUndefined();
    expect(filingContextFor(storeOf, { source: 'workflow', triggerId: '' })).toBeUndefined();
    expect(filingContextFor(() => null, { source: 'workflow', triggerId: 'trg-1' })).toBeUndefined();
    delete process.env['LYNOX_FEATURE_APPROVAL_QUEUE'];
    storeOf.mockClear();
    expect(filingContextFor(storeOf, { source: 'workflow', triggerId: 'trg-1' })).toBeUndefined();
    expect(storeOf).not.toHaveBeenCalled();
  });

  it('records a mandate the run acts for, so its entries end with it', () => {
    const c = filingContextFor(() => store, { source: 'task', triggerId: 't', principal: { kind: 'mandate', email: 'm@example.com', mandateId: 'mand-1' } });
    expect(c).toMatchObject({ mandateId: 'mand-1' });
    expect(c?.createdBy).not.toBe('owner');
  });
});
