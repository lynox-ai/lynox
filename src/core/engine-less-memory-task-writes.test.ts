import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import { memoryStoreTool, memoryUpdateTool, memoryDeleteTool, memoryPromoteTool } from '../tools/builtin/memory.js';
import { taskCreateTool, taskUpdateTool } from '../tools/builtin/task.js';
import { EngineLessRefused, engineLessStoreText } from './engine-less-refusal.js';
import { OWNER_PRINCIPAL } from './request-principal.js';
import type { IAgent, LynoxConfig } from '../types/index.js';

/**
 * Without engine.db, durable memory on, the engine registers the old `memory_*` tools; what they
 * would write lands where the next boot with engine.db does not read it the same way, and a to-do
 * lands in history.db only. The tools refuse with a plain reason instead, and nothing changes.
 *
 * Real boots through `Engine.init` on one data directory. engine.db is broken the way
 * `durable-memory-boot-gate.test.ts` breaks it: a directory where the file belongs. The first boot
 * has engine.db and writes the fact and the to-do the refused calls then aim at; that boot, and a
 * boot without engine.db but with durable memory off, show that the same calls write otherwise.
 */
describe('an engine without engine.db refuses changes to memory and to-dos', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  afterEach(async () => {
    for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
    engines.length = 0;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const k of Object.keys(savedEnv)) delete savedEnv[k];
    reloadConfig();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function setEnv(key: string, value: string): void {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    process.env[key] = value;
  }

  async function boot(dir: string, durable: boolean): Promise<Engine> {
    setEnv('LYNOX_DATA_DIR', dir);
    setEnv('LYNOX_DURABLE_MEMORY_ENABLED', durable ? 'true' : 'false');
    // loadConfig() memoises per process; several boots in one process need it read again.
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();
    return engine;
  }

  async function stop(engine: Engine): Promise<void> {
    await engine.shutdown();
    engines.splice(engines.indexOf(engine), 1);
  }

  /** The agent fields the tool handlers read, filled from the engine the way a session fills them. */
  function agentOf(engine: Engine): IAgent {
    return {
      principal: OWNER_PRINCIPAL,
      toolContext: engine.getToolContext(),
      memory: engine.getMemory(),
      secretStore: engine.getSecretStore(),
      activeScopes: undefined,
      sawUntrustedData: false,
      sawExternalContentTool: false,
      conversationSawUntrusted: false,
      autonomy: 'supervised',
      skipMemoryExtraction: false,
    } as unknown as IAgent;
  }

  const FACT = 'The warehouse moved to Thun in October.';
  const MEMORY_REFUSAL = engineLessStoreText('memory', 'model');
  const TASK_REFUSAL = `Error: ${engineLessStoreText('task', 'model')}`;

  function brokenDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-engine-less-writes-'));
    dirs.push(dir);
    return dir;
  }

  /**
   * A first boot with engine.db and durable memory on that writes the fact and one to-do, then
   * engine.db made unopenable.
   */
  async function seededThenBroken(): Promise<{ dir: string; taskId: string }> {
    const dir = brokenDir();
    const healthy = await boot(dir, true);
    expect(healthy.getEngineDb(), 'the seeding boot has engine.db').not.toBeNull();
    expect(healthy.getLegacyMemoryReason(), 'the seeding boot has its durable memory').toBeNull();
    // The same calls on an engine with engine.db write: the refusals below are not the tools' default.
    expect(await memoryStoreTool.handler({ namespace: 'knowledge', content: FACT } as never, agentOf(healthy))).toMatch(/^Stored in knowledge\./);
    const created = await taskCreateTool.handler({ title: 'Order new shelves' } as never, agentOf(healthy));
    expect(created).toMatch(/^Created: /);
    const taskId = healthy.getTaskManager()!.list().find((t) => t.title === 'Order new shelves')?.id;
    expect(taskId, `the seeding boot created a to-do: ${created}`).toBeDefined();
    await stop(healthy);
    renameSync(join(dir, 'engine.db'), join(dir, 'engine.db.aside'));
    mkdirSync(join(dir, 'engine.db'));
    return { dir, taskId: taskId! };
  }

  it('with durable memory on, the four memory tools refuse with the reason and the memory stays as it was', async () => {
    const { dir } = await seededThenBroken();
    const outage = await boot(dir, true);
    // The premise, so the test cannot pass on a boot that kept engine.db.
    expect(outage.getEngineDb()).toBeNull();
    expect(outage.getLegacyMemoryReason()).toBe('store_missing');
    const before = await outage.getMemory()!.load('knowledge');
    expect(before).toContain(FACT);

    const agent = agentOf(outage);
    expect(await memoryStoreTool.handler({ namespace: 'knowledge', content: 'The office closes on Fridays.' } as never, agent)).toBe(MEMORY_REFUSAL);
    expect(await memoryUpdateTool.handler({ namespace: 'knowledge', old_content: FACT, new_content: 'The warehouse moved to Bern.' } as never, agent)).toBe(MEMORY_REFUSAL);
    expect(await memoryDeleteTool.handler({ namespace: 'knowledge', pattern: 'warehouse' } as never, agent)).toBe(MEMORY_REFUSAL);
    expect(await memoryPromoteTool.handler({ namespace: 'knowledge', content_pattern: 'warehouse', from_scope: 'global', to_scope: 'global' } as never, agent)).toBe(MEMORY_REFUSAL);

    expect(await outage.getMemory()!.load('knowledge')).toBe(before);
  }, 120_000);

  it('refuses adding, completing and changing a to-do with the reason, and the to-do stays as it was', async () => {
    const { dir, taskId } = await seededThenBroken();
    const outage = await boot(dir, true);
    expect(outage.getEngineDb()).toBeNull();
    const agent = agentOf(outage);
    const manager = outage.getTaskManager()!;
    const before = manager.getTask(taskId);
    expect(before?.status).toBe('open');

    expect(await taskCreateTool.handler({ title: 'Call the landlord' } as never, agent)).toBe(TASK_REFUSAL);
    expect(await taskUpdateTool.handler({ task_id: taskId, status: 'completed' } as never, agent)).toBe(TASK_REFUSAL);
    expect(await taskUpdateTool.handler({ task_id: taskId, title: 'Order two shelves' } as never, agent)).toBe(TASK_REFUSAL);
    expect(() => manager.deleteTodo(taskId)).toThrow(EngineLessRefused);
    expect(() => manager.reopen(taskId)).toThrow(EngineLessRefused);

    expect(manager.getTask(taskId)).toEqual(before);
    expect(manager.list().map((t) => t.title)).toEqual(['Order new shelves']);
  }, 120_000);

  it('with durable memory off the memory files are the memory: a store is written; a to-do is still refused', async () => {
    const dir = brokenDir();
    mkdirSync(join(dir, 'engine.db'));
    const outage = await boot(dir, false);
    expect(outage.getEngineDb()).toBeNull();
    expect(outage.getLegacyMemoryReason()).toBe('dk_off');
    const agent = agentOf(outage);

    expect(await memoryStoreTool.handler({ namespace: 'knowledge', content: FACT } as never, agent)).toMatch(/^Stored in knowledge\./);
    expect(await outage.getMemory()!.load('knowledge')).toContain(FACT);
    expect(await taskCreateTool.handler({ title: 'Call the landlord' } as never, agent)).toBe(TASK_REFUSAL);
  }, 120_000);
});
