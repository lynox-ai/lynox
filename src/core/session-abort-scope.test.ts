import { describe, it, expect, vi } from 'vitest';
import { Agent } from './agent.js';
import { Session } from './session.js';
import type { AbortScope } from '../types/config.js';

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
 * ⚠ And why the sessions are built with `Object.create`: constructing a real `Session`
 * needs an engine, a config and a store, and `abort()` reads exactly one field. No test
 * in this repo constructs one, so the alternative was not "a better test" but "no test".
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
});
