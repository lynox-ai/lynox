import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import type { ToolEntry, PromptMeta } from '../types/index.js';

/**
 * A hard block (`DangerSignal.hardBlock`) is refused in a run nobody watches instead of being
 * queued for approval. The rule that decides it marks it; the agent asks with `meta.blocked`;
 * whatever stores the question says who reads it (`PromptStore.insertQuestion`). The actions
 * that ask for an OK carry `[BLOCKED` too and stay askable.
 */

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic { beta = { messages: { stream: vi.fn() } }; }
  class APIError extends Error {}
  return { default: MockAnthropic, APIError };
});
vi.mock('./stream.js', () => ({ StreamProcessor: vi.fn() }));

import { Agent } from './agent.js';
import { isDangerousDetailed } from '../tools/permission-guard.js';
import { RunHistory } from './run-history.js';
import { PromptStore, UnattendedBlockError, UNATTENDED_BLOCK_ANSWER } from './prompt-store.js';

type Exec = { _executeOneInner(tc: unknown): Promise<{ content: unknown; is_error?: boolean }> };

function stub(name: string): ToolEntry & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    definition: { name, description: name, input_schema: { type: 'object', properties: {}, additionalProperties: true } },
    handler: async (input: unknown) => { calls.push(input); return 'done'; },
  } as unknown as ToolEntry & { calls: unknown[] };
}

const call = (agent: Agent, name: string, input: Record<string, unknown>) =>
  (agent as unknown as Exec)._executeOneInner({ type: 'tool_use', id: `t${Math.random()}`, name, input });

const destructive = (mode: 'data' | 'external'): ToolEntry => ({
  definition: { name: 'x', description: 'x', input_schema: { type: 'object', properties: {} } },
  handler: async () => 'done',
  destructive: { mode, check: () => '' },
} as unknown as ToolEntry);

describe('the rule that decides a hard block marks it', () => {
  // One row per `[BLOCKED` return of the guard: the eight hard rules, then the four that ask for an OK.
  it.each([
    ['bash', { command: 'rm -rf /' }],
    ['read_file', { path: '/etc/shadow' }],
    ['write_file', { path: '/etc/passwd', content: 'x' }],
    ['write_file', { path: 'notes.md', content: '  ' }],
    ['write_file', { path: '/srv/elsewhere/notes.md', content: 'x' }],
    ['batch_files', { directory: '/etc/ssl', operation: 'transform' }],
    ['batch_files', { directory: 'docs', operation: 'move', destination: '/etc/ssl' }],
    ['batch_files', { directory: 'docs', operation: 'move', destination: '/srv/elsewhere' }],
  ])('%s %j is a hard block when unattended', (tool, input) => {
    const signal = isDangerousDetailed(tool, input, 'autonomous');
    expect(signal?.warning).toContain('[BLOCKED');
    expect(signal?.hardBlock).toBe(true);
  });

  it.each([
    ['mail_send', { to: 'a@example.org', subject: 's', body: 'b' }, undefined],
    ['data_store_drop', { collection: 'c' }, destructive('data')],
    ['google_drive', { action: 'delete' }, destructive('external')],
    ['http_request', { url: 'https://example.org/x', method: 'DELETE' }, undefined],
  ] as const)('%s asks for an OK: [BLOCKED in the text, and not a hard block', (tool, input, entry) => {
    const signal = isDangerousDetailed(tool, input, 'autonomous', entry);
    expect(signal?.warning, 'positive control: the text alone would read as blocked').toContain('[BLOCKED');
    expect(signal?.hardBlock).toBeUndefined();
  });

  it('every unattended [BLOCKED return of the guard says which class it is', () => {
    const source = readFileSync(join(__dirname, '..', 'tools', 'permission-guard.ts'), 'utf8').split('\n');
    const blockedReturns = source.filter((l) => /return\b.*framed`/.test(l) && /\[BLOCKED|blockReason/.test(l));
    expect(blockedReturns.length, 'positive control: the guard\'s blocked returns are found').toBe(11);
    expect(blockedReturns.filter((l) => !/return (hardBlock|askable)\(framed`/.test(l))).toEqual([]);
  });
});

describe('the store refuses a hard block for a reader who does not watch the run', () => {
  let dir: string;
  let history: RunHistory;
  afterEach(() => { history.close(); rmSync(dir, { recursive: true, force: true }); });

  it('refuses before any row exists; stores it for the run\'s own chat, and stores every other question', () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-unattended-block-'));
    history = new RunHistory(join(dir, 'history.db'));
    const store = new PromptStore(history.getDb());
    expect(() => store.insertQuestion({ blocked: true, attended: false }, 's-unattended', 'rm?', ['Allow', 'Deny'])).toThrow(UnattendedBlockError);
    expect(store.getPending('s-unattended')).toBeUndefined();
    // Twins on the same store: the same question for the run's chat, and an ordinary one unattended.
    store.insertQuestion({ blocked: true, attended: true }, 's-chat', 'rm?', ['Allow', 'Deny']);
    expect(store.getPending('s-chat')?.question).toBe('rm?');
    store.insertQuestion({ blocked: false, attended: false }, 's-worker', 'send mail?', ['Allow', 'Deny']);
    expect(store.getPending('s-worker')?.question).toBe('send mail?');
  });
});

describe('the agent asks a hard block with meta.blocked, and reports a refusal of it', () => {
  it('a hard block carries blocked; an unattended source refuses it and the tool does not run', async () => {
    const bash = stub('bash');
    const metas: Array<PromptMeta | undefined> = [];
    const promptUser = vi.fn(async (_q: unknown, _o?: string[], meta?: PromptMeta) => {
      metas.push(meta);
      return meta?.blocked === true ? UNATTENDED_BLOCK_ANSWER : 'Allow';
    });
    const streamed: Array<{ type: string; result?: unknown; isError?: boolean }> = [];
    const onStream = vi.fn(async (e: { type: string; result?: unknown; isError?: boolean }) => { streamed.push(e); });
    const agent = new Agent({ name: 'a', model: 'claude-sonnet-4-6', provider: 'anthropic', tools: [bash], autonomy: 'autonomous', promptUser, onStream } as ConstructorParameters<typeof Agent>[0]);
    const result = await call(agent, 'bash', { command: 'rm -rf /' });
    expect(metas.map((m) => m?.blocked)).toEqual([true]);
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toMatch(/is blocked, and in a run nobody watches it is not queued for approval/);
    expect(bash.calls).toEqual([]);
    // The record carries it: the owner of a run nobody watches learns of it only there.
    expect(streamed.filter((e) => e.type === 'tool_result').map((e) => [e.result, e.isError])).toEqual([[result.content, true]]);
  });

  it('an action that asks for an OK is asked without blocked, and runs once allowed', async () => {
    const mail = stub('mail_send');
    const bash = stub('bash');
    const metas: Array<PromptMeta | undefined> = [];
    const promptUser = vi.fn(async (_q: unknown, _o?: string[], meta?: PromptMeta) => { metas.push(meta); return 'Allow'; });
    const agent = new Agent({ name: 'a', model: 'claude-sonnet-4-6', provider: 'anthropic', tools: [mail, bash], autonomy: 'autonomous', promptUser });
    await call(agent, 'mail_send', { to: 'a@example.org', subject: 's', body: 'b' });
    expect(mail.calls).toHaveLength(1);
    // Same machinery, the other way: a hard block on the same agent does carry it.
    await call(agent, 'bash', { command: 'rm -rf /' });
    expect(metas.map((m) => m?.blocked === true)).toEqual([false, true]);
  });
});

describe('no question reaches the store past insertQuestion', () => {
  it('outside the store itself, production code stores an ask_user question only through insertQuestion', () => {
    const root = join(__dirname, '..', '..');
    const hits = execFileSync('git', ['grep', '-n', '-e', '.insertAskUser(', '--', 'src', 'packages/*/src'], { cwd: root, encoding: 'utf8' })
      .split('\n').filter((l) => l !== '' && !/\.test\.ts:/.test(l));
    expect(hits.length, 'positive control: the store\'s own call is found').toBeGreaterThan(0);
    expect(hits.filter((l) => !l.startsWith('src/core/prompt-store.ts:'))).toEqual([]);
    expect(readFileSync(join(root, 'src/core/prompt-store.ts'), 'utf8')).toContain('return this.insertAskUser(...args);');
  });
});
