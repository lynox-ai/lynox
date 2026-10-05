import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from './agent.js';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import { Session } from './session.js';
import type { AbortScope, LynoxConfig } from '../types/config.js';

/**
 * A session's abort reaches ITS OWN chain and nothing else.
 *
 * ⛔ WHAT THIS REPLACES, because the old behaviour was not a corner case. `Session.abort()`
 * used to call `abortSpawnedAgents()` and `abortPipelineAgents()`, each iterating a
 * MODULE-LEVEL `Set<Agent>` — so a stop in one thread aborted every spawned sub-agent and
 * every workflow-step agent IN THE PROCESS. Their parents recorded an abort nobody asked
 * for. In the worker loop it was worse than lost work: a trigger run recorded `failed`
 * re-fires through the backoff, so the collateral STARTED autonomous runs. Filed
 * 2026-08-24, and the row recorded that the line was touched by no test at all — which is
 * the gap this file closes.
 *
 * ⚠ THE OTHER HALF IS NOT HERE. Whether a child ever LANDS in its parent's scope is
 * decided in the spawn tool and in the two step executors, and `spawn.test.ts` carries
 * that witness (including the transitive case: the child inherits the scope, so a
 * grandchild lands in the session's set). A test here that registered members by hand
 * would prove `abort()` iterates a set — true of the broken version too.
 *
 * ⚠ The unit cases below build their sessions with `Object.create`, because `abort()` reads
 * exactly one field and that is all they are about. An earlier version of this note
 * justified it with "no test in this repo constructs a real Session", which is FALSE —
 * `datastore-tools-boot.test.ts` and `google-visibility-boot.test.ts` both do, through a
 * real `Engine` and with the real `Agent`. That false premise is why the headline property
 * went unpinned: a mutant that gives every parentless agent ONE SHARED module-level scope
 * — i.e. restores the exact defect this change removes — survived the whole suite, because
 * hand-made agents with hand-made scopes only ever prove that `abort()` iterates the scope
 * it is handed. The real-Engine case at the bottom of this file is the one that kills it.
 */
function makeMember(): { abort: () => void; aborted: () => boolean } {
  let hit = false;
  return { abort: () => { hit = true; }, aborted: () => hit };
}

/** A session that owns `agent` and nothing else — `abort()` touches no other field. */
function sessionOf(agent: { abort: () => void; abortScope: AbortScope }): Session {
  const s = Object.create(Session.prototype) as { agent: unknown };
  s.agent = agent;
  return s as unknown as Session;
}

function fakeAgent(): { abort: () => void; abortScope: AbortScope; aborted: () => boolean } {
  let hit = false;
  return { abort: () => { hit = true; }, abortScope: { members: new Set() }, aborted: () => hit };
}

describe('Session.abort() is scoped to its own chain', () => {
  it('aborts its OWN members and leaves another session\'s alone', () => {
    const a = fakeAgent();
    const b = fakeAgent();
    const mine = makeMember();
    const theirs = makeMember();
    a.abortScope.members.add(mine);
    b.abortScope.members.add(theirs);

    sessionOf(a).abort();

    // Its own agent and its own chain.
    expect(a.aborted(), 'the session\'s own agent').toBe(true);
    expect(mine.aborted(), 'and the agents its chain created').toBe(true);
    // ⛔ THE ASSERTION THE OLD CODE COULD NOT PASS: the other session is untouched. Both
    // of its halves matter — a fix that aborted nothing would pass this line and fail the
    // two above.
    expect(theirs.aborted(), 'another session\'s sub-agent').toBe(false);
    expect(b.aborted(), 'and another session\'s own agent').toBe(false);
  });

  it('one member that throws does not keep the others running', () => {
    // The loop is the only thing that ends them, so it cannot stop at the first throw.
    // `abort()` reaches into an agent, which is where a throw would come from.
    const a = fakeAgent();
    const boom = { abort: (): void => { throw new Error('abort exploded inside the agent'); } };
    const after = makeMember();
    a.abortScope.members.add(boom);
    a.abortScope.members.add(after);

    expect(() => sessionOf(a).abort()).not.toThrow();
    expect(after.aborted(), 'the member registered after the throwing one').toBe(true);
  });

  it('a session with no agent aborts nothing and does not throw', () => {
    const s = Object.create(Session.prototype) as { agent: unknown };
    s.agent = null;
    expect(() => (s as unknown as Session).abort()).not.toThrow();
  });

  it('every Agent owns a scope, so the code that registers into it never finds undefined', () => {
    // The constructor's half: `abortScope` is REQUIRED on `IAgent`, and an agent built
    // without one still has its own — otherwise `parentAgent.abortScope.members.add(...)`
    // in the spawn path would throw on an agent nobody handed a scope to.
    const parentless = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });
    expect(parentless.abortScope.members.size).toBe(0);
    // And a supplied scope is the SAME object, not a copy — that identity is what makes
    // a child's registration visible to its session.
    const shared: AbortScope = { members: new Set() };
    const child = new Agent({ name: 'child', model: 'claude-sonnet-4-6', abortScope: shared });
    expect(child.abortScope).toBe(shared);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // The property the whole change exists for, against a real Engine.
  // ────────────────────────────────────────────────────────────────────────────
  describe('two real sessions do not share a scope', () => {
    const dirs: string[] = [];
    const engines: Engine[] = [];
    const ENV_KEYS = ['LYNOX_DATA_DIR', 'LYNOX_VAULT_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
      'GOOGLE_SERVICE_ACCOUNT_KEY', 'LYNOX_MANAGED_INSTANCE_ID'] as const;
    const saved = new Map<string, string | undefined>();

    function setEnv(key: string, value: string | undefined): void {
      if (!saved.has(key)) saved.set(key, process.env[key]);
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }

    afterEach(async () => {
      for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
      engines.length = 0;
      for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      saved.clear();
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
      dirs.length = 0;
      reloadConfig();
    });

    async function boot(): Promise<Engine> {
      const dir = mkdtempSync(join(tmpdir(), 'lynox-abortscope-'));
      dirs.push(dir);
      for (const k of ENV_KEYS) setEnv(k, undefined);
      setEnv('LYNOX_DATA_DIR', dir);
      reloadConfig(); // loadConfig() caches, and an earlier boot in this file filled it
      const engine = new Engine({} as LynoxConfig);
      engines.push(engine);
      await engine.init();
      return engine;
    }

    it('each session gets its own, and an abort in one leaves the other alone', async () => {
      // ⛔ THE MUTANT THIS KILLS, and nothing else in the suite did: give `Agent`'s
      // constructor a module-level shared default instead of a fresh Set, which is the
      // process-wide behaviour this change removes, and every test stayed green. Two
      // hand-made agents cannot see it — they carry hand-made scopes. Two REAL sessions
      // from a real Engine can, because the scope they get is the one the constructor
      // chose.
      const engine = await boot();
      const a = engine.createSession();
      const b = engine.createSession();
      const agentA = a.getAgent();
      const agentB = b.getAgent();
      expect(agentA, 'the probe needs a real agent, not a pass').not.toBeNull();
      expect(agentB).not.toBeNull();

      expect(agentA!.abortScope, 'separate objects, not one shared default').not.toBe(agentB!.abortScope);

      // And the behaviour, not only the identity: a member in each, one abort.
      const mine = makeMember();
      const theirs = makeMember();
      agentA!.abortScope.members.add(mine);
      agentB!.abortScope.members.add(theirs);
      a.abort();
      expect(mine.aborted(), 'the aborting session\'s own chain').toBe(true);
      expect(theirs.aborted(), 'the other session\'s chain').toBe(false);
    });

    it('an agent REBUILD keeps the session\'s scope, so a stop still reaches what is registered', async () => {
      // ⛔ The scope became a session-lifetime identity field the moment it moved onto the
      // agent — and the agent is rebuilt by seven call sites, four of them public API
      // (`setModel`, `setEffort`, `setThinking`, `addTool`, `reloadUserConfig`, plus
      // `_recreateAgent` and the constructor), none of which checks for an in-flight run.
      // Without carrying it across, every rebuild mints an empty Set and ORPHANS whatever
      // is registered: a later `abort()` reaches nothing, silently. The module-level set
      // this replaced was immune by construction, so this is a cost the change introduced
      // and has to pay for.
      //
      // `setEffort` is the cheapest of the four to drive — no model resolution, no registry
      // reload — and the claim is about the rebuild, not about which knob caused it.
      const engine = await boot();
      const session = engine.createSession();
      const before = session.getAgent();
      expect(before, 'the probe needs a real agent').not.toBeNull();
      const scope = before!.abortScope;
      const member = makeMember();
      scope.members.add(member);

      session.setEffort('high');

      const after = session.getAgent();
      expect(after, 'still an agent after the rebuild').not.toBeNull();
      expect(after!.abortScope, 'the SAME scope object, not a fresh one').toBe(scope);
      expect(after!.abortScope.members.has(member), 'and what was registered is still in it').toBe(true);
      // The consequence, not only the identity: the stop still reaches it.
      session.abort();
      expect(member.aborted()).toBe(true);
    });
  });
});
