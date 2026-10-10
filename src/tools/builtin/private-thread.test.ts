import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from '../../core/engine-db.js';
import { SubjectStore } from '../../core/subject-store.js';
import { KnowledgeStore } from '../../core/knowledge-store.js';
import { createToolContext } from '../../core/tool-context.js';
import { rememberTool, memoryBlockEditTool, memoryRetireTool } from './knowledge.js';
import { memoryStoreTool, memoryUpdateTool } from './memory.js';
import { privateThreadRefusal } from './private-thread.js';
import type { IAgent } from '../../types/index.js';

/**
 * In a private chat, no tool puts new content into memory.
 *
 * The UI promises "this chat is kept out of memory" without exception. The end-of-turn
 * capture honoured that; the tools did not, so `remember` — chosen by the model, or asked
 * for by the user — wrote from a chat the user had marked private.
 */
describe('memory-writing tools refuse in a private chat', () => {
  const tmpDirs: string[] = [];
  afterEach(() => { for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  function memoryMock() {
    return {
      append: vi.fn().mockResolvedValue(undefined),
      appendScoped: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(true),
      updateScoped: vi.fn().mockResolvedValue(true),
      load: vi.fn().mockResolvedValue(''),
      save: vi.fn().mockResolvedValue(undefined),
    };
  }

  /**
   * `privateThread` is the thread store's answer; `globalExtractionOff` is the agent flag the
   * global `memory_extraction: false` setting also sets — which must NOT refuse a tool.
   */
  function make(opts: { privateThread: boolean; globalExtractionOff?: boolean }) {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-private-tools-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    const ks = new KnowledgeStore(engine, new SubjectStore(engine));
    const ctx = createToolContext({} as never);
    ctx.knowledgeStore = ks;
    ctx.threadStore = {
      getThread: (id: string) => (id === 't1' ? { id, skip_extraction: opts.privateThread ? 1 : 0 } : null),
    } as never;
    const memory = memoryMock();
    const agent = {
      toolContext: ctx,
      memory,
      sawUntrustedData: false,
      sawExternalContentTool: false,
      conversationSawUntrusted: false,
      autonomy: 'supervised',
      skipMemoryExtraction: opts.globalExtractionOff ?? false,
      currentThreadId: 't1',
      currentRunId: 'r1',
      promptUser: async (_q: unknown, options: string[] = []) => options[0] ?? 'Apply',
    } as unknown as IAgent;
    return { agent, ks, memory };
  }

  it('remember: refused, nothing stored, and the answer names private mode', async () => {
    const { agent, ks } = make({ privateThread: true });
    const out = await rememberTool.handler({ text: 'Jana Reber lives in Bern' }, agent);
    expect(out).toBe(privateThreadRefusal(agent));
    expect(out).toContain('private mode');
    expect(ks.listActive().length + ks.pendingCount()).toBe(0);
  });

  it('remember: stores in a chat that is not private — the refusal is not a blanket one', async () => {
    const { agent, ks } = make({ privateThread: false });
    await rememberTool.handler({ text: 'Jana Reber lives in Bern' }, agent);
    expect(ks.listActive().length + ks.pendingCount()).toBe(1);
  });

  it('remember: the GLOBAL extraction switch does not refuse it — only the chat\'s private flag does', async () => {
    // `memory_extraction: false` sets the same agent flag as private mode, but it switches off
    // automatic capture; it never promised that an explicit `remember` is refused.
    const { agent, ks } = make({ privateThread: false, globalExtractionOff: true });
    await rememberTool.handler({ text: 'Jana Reber lives in Bern' }, agent);
    expect(ks.listActive().length + ks.pendingCount()).toBe(1);
  });

  it('remember from a sub-agent of a private chat: refused — the child is checked against the chat it came from', async () => {
    // A spawned child has no currentThreadId; spawn hands it the chat's id as originThreadId.
    const { agent, ks } = make({ privateThread: true });
    const child = Object.assign(Object.create(agent) as object, { currentThreadId: undefined, originThreadId: 't1' }) as IAgent;
    const out = await rememberTool.handler({ text: 'Jana Reber lives in Bern' }, child);
    expect(out).toBe(privateThreadRefusal(child));
    expect(ks.listActive().length + ks.pendingCount()).toBe(0);
  });

  it('memory_block_edit: refused, the profile block unchanged', async () => {
    const { agent, ks } = make({ privateThread: true });
    ks.setBlockContent('profile', 'Operator: Alex.');
    const out = await memoryBlockEditTool.handler({ block: 'profile', mode: 'append', new_text: 'Jana Reber lives in Bern' } as never, agent);
    expect(out).toBe(privateThreadRefusal(agent));
    expect(ks.getBlock('profile')?.content).toBe('Operator: Alex.');
  });

  it('memory_block_edit: private mode switched on while the Apply dialog is open — still refused', async () => {
    const opts = { privateThread: false };
    const { agent, ks } = make(opts);
    ks.setBlockContent('profile', 'Operator: Alex.');
    const flipping = Object.assign(Object.create(agent) as object, {
      promptUser: async () => { opts.privateThread = true; return 'Apply'; },
    }) as IAgent;
    const out = await memoryBlockEditTool.handler({ block: 'profile', mode: 'append', new_text: 'Jana Reber lives in Bern' } as never, flipping);
    expect(out).toContain('private mode');
    expect(ks.getBlock('profile')?.content).toBe('Operator: Alex.');
  });

  it('memory_store: refused, the legacy store never written', async () => {
    const { agent, memory } = make({ privateThread: true });
    const out = await memoryStoreTool.handler({ namespace: 'knowledge', content: 'Jana Reber lives in Bern' } as never, agent);
    expect(out).toBe(privateThreadRefusal(agent));
    expect(memory.append).not.toHaveBeenCalled();
    expect(memory.appendScoped).not.toHaveBeenCalled();
  });

  it('memory_store: writes in a chat that is not private', async () => {
    const { agent, memory } = make({ privateThread: false });
    await memoryStoreTool.handler({ namespace: 'knowledge', content: 'Jana Reber lives in Bern' } as never, agent);
    expect(memory.append.mock.calls.length + memory.appendScoped.mock.calls.length).toBe(1);
  });

  it('memory_update: refused, the legacy store never written', async () => {
    const { agent, memory } = make({ privateThread: true });
    const out = await memoryUpdateTool.handler({ namespace: 'knowledge', old_content: 'Bern', new_content: 'Jana Reber lives in Zug' } as never, agent);
    expect(out).toBe(privateThreadRefusal(agent));
    for (const fn of Object.values(memory)) expect(fn).not.toHaveBeenCalled();
  });

  it('memory_retire still works in a private chat — removing carries nothing from it', async () => {
    const { agent, ks } = make({ privateThread: true });
    // An agent-written entry: the agent may retire its own tier, not a user-asserted one.
    const entry = ks.write({ text: 'ACME renews in March', sourceChannel: 'agent', sourceUntrusted: false });
    const out = await memoryRetireTool.handler({ id: entry.id }, agent);
    expect(out).not.toBe(privateThreadRefusal(agent));
    expect(ks.getEntry(entry.id)?.status).toBe('superseded');
  });

  it('the refusal offers the user\'s own switch and nothing else', () => {
    // Prompt surface: the answer teaches the model a rule. It names the one legitimate way —
    // the user turning private mode off — and must not point at another place to keep it.
    const { agent } = make({ privateThread: true });
    const text = privateThreadRefusal(agent)!;
    expect(text).toContain('turn private mode off');
    expect(text).not.toMatch(/instead|another tool|elsewhere|data_store|contacts|task|note/i);
  });
});
