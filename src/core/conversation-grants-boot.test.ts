import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from './engine.js';
import { RunHistory } from './run-history.js';
import { ThreadStore } from './thread-store.js';
import { reloadConfig } from './config.js';
import { UNKNOWN_GRANT } from './conversation-grants.js';
import type { LynoxConfig } from '../types/index.js';
import type { Agent } from './agent.js';

/**
 * The boot-wiring proof for the conversation grant set (PRD connection-attribution A5).
 *
 * `conversation-grants.test.ts` proves the set, the table and the agent's seats with the set
 * handed in. What only a real boot shows: that `Engine.init` carries an existing history.db to
 * v67 and fills `unknown` for a thread a previous process left, that a Session resuming that
 * thread hands its agent the thread's set, and that a rebuilt agent keeps the same set.
 */
describe('Engine boot — the conversation grant set', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  let prevDataDir: string | undefined;

  afterEach(async () => {
    for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
    engines.length = 0;
    if (prevDataDir === undefined) delete process.env['LYNOX_DATA_DIR'];
    else process.env['LYNOX_DATA_DIR'] = prevDataDir;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    reloadConfig();
  });

  async function boot(seed?: (dir: string) => void): Promise<Engine> {
    prevDataDir = process.env['LYNOX_DATA_DIR'];
    const dir = mkdtempSync(join(tmpdir(), 'lynox-grants-boot-'));
    dirs.push(dir);
    seed?.(dir);
    process.env['LYNOX_DATA_DIR'] = dir;
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();
    return engine;
  }

  it('a thread from before the table resumes with unknown in its agent\'s set, and keeps the set across a rebuild', async () => {
    const engine = await boot((dir) => {
      // What a previous process left: a thread with a message, on a v66 history.db.
      const before = new RunHistory(join(dir, 'history.db'));
      const store = new ThreadStore(before.getDb());
      store.createThread('old-thread');
      store.appendMessages('old-thread', [{ role: 'user', content: 'hello' }], 0);
      before.getDb().exec('DROP TABLE conversation_grants; DELETE FROM schema_version WHERE version > 66; ALTER TABLE pending_prompts DROP COLUMN answered_mandate_id; ALTER TABLE pending_prompts DROP COLUMN answered_by;');
      before.close();
    });
    const history = engine.getRunHistory();
    expect(history).not.toBeNull();
    expect(history!.getConversationGrants('old-thread')).toEqual([UNKNOWN_GRANT]);

    const session = engine.createSession({ sessionId: 'old-thread' });
    const agentOf = (): Agent => (session as unknown as { agent: Agent }).agent;
    const set = agentOf().conversationGrants;
    expect(set?.threadId).toBe('old-thread');
    expect(set?.members()).toEqual([UNKNOWN_GRANT]);
    expect(agentOf().conversationRoot).toBe(true);

    session._recreateAgent();
    expect(agentOf().conversationGrants).toBe(set);

    // A member the set takes now is in the thread's rows.
    set!.add('g-after-boot');
    expect(history!.getConversationGrants('old-thread')).toEqual([UNKNOWN_GRANT, 'g-after-boot']);

    // Compaction's reset: a new object of the same thread, with everything it had.
    session.reset();
    const renewed = agentOf().conversationGrants;
    expect(renewed).not.toBe(set);
    expect(renewed?.members()).toEqual([UNKNOWN_GRANT, 'g-after-boot']);
    session._recreateAgent();
    expect(agentOf().conversationGrants).toBe(renewed);
  });

  it('a new thread starts with an empty set', async () => {
    const engine = await boot();
    const session = engine.createSession({ sessionId: 'fresh-thread' });
    expect((session as unknown as { agent: Agent }).agent.conversationGrants?.members()).toEqual([]);
  });
});
