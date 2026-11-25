import { describe, expect, it } from 'vitest';
import { MAX_EXEC_TIMEOUT_MS } from '../shell-sidecar/protocol.js';
import { CLIENT_GRACE_MS } from '../shell-sidecar/client.js';
import { DEFAULT_BASH_TIMEOUT_MS } from './constants.js';
import { FOLLOW_UP_TOOL_NAME } from './follow-up-fallback.js';
import { TOOL_SILENCE_CEILING_MS, TOOL_SILENCE_MARGIN_MS, ToolSilenceClock, toolBoundMs } from './tool-silence.js';

const call = (name: string, toolUseId: string | undefined, input: unknown = {}, subAgentId?: string) =>
  ({ type: 'tool_call', name, input, toolUseId, subAgentId, subAgent: subAgentId === undefined ? undefined : `agent-${subAgentId}` });
const result = (name: string, toolUseId: string | undefined, subAgentId?: string) =>
  ({ type: 'tool_result', name, toolUseId, subAgentId, subAgent: subAgentId === undefined ? undefined : `agent-${subAgentId}` });

describe('toolBoundMs', () => {
  it('gives a shell command its own limit, capped the way the execution caps it', () => {
    expect(toolBoundMs('bash', { timeout_ms: 180_000 })).toBe(180_000 + CLIENT_GRACE_MS);
    // The model writes the input: 99 hours is held to the ceiling.
    expect(toolBoundMs('bash', { timeout_ms: 99 * 3_600_000 })).toBe(MAX_EXEC_TIMEOUT_MS + CLIENT_GRACE_MS);
    expect(toolBoundMs('bash', {})).toBe(DEFAULT_BASH_TIMEOUT_MS + CLIENT_GRACE_MS);
    expect(toolBoundMs('bash', { timeout_ms: 'forever' })).toBe(DEFAULT_BASH_TIMEOUT_MS + CLIENT_GRACE_MS);
    expect(toolBoundMs('bash', null)).toBe(DEFAULT_BASH_TIMEOUT_MS + CLIENT_GRACE_MS);
  });

  it('gives a tool without a bound of its own the named ceiling', () => {
    expect(toolBoundMs('run_workflow', {})).toBe(TOOL_SILENCE_CEILING_MS);
    expect(TOOL_SILENCE_CEILING_MS).toBe(MAX_EXEC_TIMEOUT_MS);
  });
});

describe('ToolSilenceClock', () => {
  const t0 = 1_000_000;

  it('holds while a call is within its limit and lets go once it is past it', () => {
    const clock = new ToolSilenceClock();
    expect(clock.holds(t0)).toBe(false);
    clock.note(call('http_request', 'a'), t0);
    expect(clock.holds(t0 + 60_000 + TOOL_SILENCE_MARGIN_MS - 1)).toBe(true);
    expect(clock.holds(t0 + 60_000 + TOOL_SILENCE_MARGIN_MS)).toBe(false);
  });

  it('lets go when the result arrives', () => {
    const clock = new ToolSilenceClock();
    clock.note(call('bash', 'a', { timeout_ms: 180_000 }), t0);
    clock.note(result('bash', 'a'), t0 + 1);
    expect(clock.holds(t0 + 2)).toBe(false);
  });

  it('holds until the last of two parallel calls has its result', () => {
    const clock = new ToolSilenceClock();
    clock.note(call('bash', 'a', { timeout_ms: 180_000 }), t0);
    clock.note(call('bash', 'b', { timeout_ms: 180_000 }), t0);
    clock.note(result('bash', 'a'), t0 + 1_000);
    expect(clock.holds(t0 + 2_000)).toBe(true);
    clock.note(result('bash', 'b'), t0 + 3_000);
    expect(clock.holds(t0 + 4_000)).toBe(false);
  });

  it('keeps a sub-agent\'s call apart from the parent\'s call with the same id', () => {
    const clock = new ToolSilenceClock();
    clock.note(call('bash', 'a', { timeout_ms: 180_000 }, 'sub-1'), t0);
    clock.note(result('bash', 'a'), t0 + 1);
    expect(clock.holds(t0 + 2)).toBe(true);
    clock.note(result('bash', 'a', 'sub-1'), t0 + 3);
    expect(clock.holds(t0 + 4)).toBe(false);
  });

  it('ends a call whose result never came at its own limit', () => {
    const clock = new ToolSilenceClock();
    clock.note(call('bash', 'a', { timeout_ms: 99 * 3_600_000 }), t0);
    const limit = MAX_EXEC_TIMEOUT_MS + CLIENT_GRACE_MS + TOOL_SILENCE_MARGIN_MS;
    expect(clock.holds(t0 + limit - 1)).toBe(true);
    expect(clock.holds(t0 + limit)).toBe(false);
  });

  it('holds a call without an id until the ceiling, and no result closes it', () => {
    const clock = new ToolSilenceClock();
    clock.note(call('http_request', undefined), t0);
    clock.note(call('http_request', ''), t0);
    clock.note(result('http_request', undefined), t0 + 1);
    clock.note(result('http_request', ''), t0 + 1);
    clock.note(result('http_request', 'other'), t0 + 1);
    const ceiling = TOOL_SILENCE_CEILING_MS + TOOL_SILENCE_MARGIN_MS;
    expect(clock.holds(t0 + ceiling - 1)).toBe(true);
    expect(clock.holds(t0 + ceiling)).toBe(false);
  });

  it('does not let a call without an id close a call that has one', () => {
    const clock = new ToolSilenceClock();
    clock.note(call('bash', 'a', { timeout_ms: 180_000 }), t0);
    clock.note(result('bash', undefined), t0 + 1);
    expect(clock.holds(t0 + 2)).toBe(true);
  });

  // A refused call answers the model without a streamed result; the agent's next response shows
  // that every call of the response before has settled.
  it('lets go of a response\'s calls once the agent streams its next response', () => {
    for (const next of [{ type: 'text', text: 'next' }, { type: 'thinking', thinking: 'next' }, call('http_request', 'z')]) {
      const clock = new ToolSilenceClock();
      clock.note(call('bash', 'a', { timeout_ms: 180_000 }), t0);
      clock.note({ type: 'turn_end' }, t0 + 1);
      expect(clock.holds(t0 + 2), 'the call runs after its response ended').toBe(true);
      clock.note(next, t0 + 3);
      // Only the new call, if the next event is one, still holds.
      expect(clock.holds(t0 + 70_001), `after ${next.type}`).toBe(false);
    }
  });

  // A call runs after its response's turn_end. Nothing but the agent's NEXT response, its own
  // result, or its limit ends its hold: not a sibling's result, not a sub-agent's events.
  it('keeps a running call after its response ended, whatever else arrives meanwhile', () => {
    const clock = new ToolSilenceClock();
    clock.note(call('bash', 'long', { timeout_ms: 180_000 }), t0);
    clock.note(call('http_request', 'short'), t0 + 1);
    clock.note({ type: 'turn_end' }, t0 + 2);
    clock.note(result('http_request', 'short'), t0 + 3);
    clock.note({ type: 'text', text: 'a child works', subAgent: 'agent-sub-1' }, t0 + 4);
    clock.note(call('bash', 'c', {}, 'sub-1'), t0 + 5);
    clock.note({ type: 'turn_end', subAgent: 'agent-sub-1' }, t0 + 6);
    clock.note(result('bash', 'c', 'sub-1'), t0 + 7);
    expect(clock.holds(t0 + 150_000)).toBe(true);
  });

  it('keeps a call open while the response that made it is still streaming', () => {
    const clock = new ToolSilenceClock();
    clock.note(call('bash', 'a', { timeout_ms: 180_000 }), t0);
    clock.note({ type: 'text', text: 'and one more thing' }, t0 + 1);
    clock.note(call('bash', 'b', { timeout_ms: 180_000 }), t0 + 2);
    expect(clock.holds(t0 + 3)).toBe(true);
    clock.note(result('bash', 'b'), t0 + 4);
    expect(clock.holds(t0 + 5), 'a is still open').toBe(true);
  });

  it('keeps a call open while a different agent writes', () => {
    const clock = new ToolSilenceClock();
    clock.note(call('spawn_agent', 'a'), t0);
    clock.note({ type: 'turn_end' }, t0 + 1);
    clock.note({ type: 'text', text: 'the child works', subAgent: 'agent-sub-1' }, t0 + 2);
    expect(clock.holds(t0 + 3)).toBe(true);
    clock.note(call('bash', 'c', { timeout_ms: 180_000 }, 'sub-1'), t0 + 4);
    clock.note({ type: 'turn_end', subAgent: 'agent-sub-1' }, t0 + 5);
    clock.note({ type: 'text', text: 'the parent' }, t0 + 6);
    expect(clock.holds(t0 + 7), 'the parent\'s text ends only the parent\'s calls').toBe(true);
    clock.note(result('bash', 'c', 'sub-1'), t0 + 8);
    expect(clock.holds(t0 + 9)).toBe(false);
  });

  it('does not hold for the follow-up suggestions answered at the end of a turn', () => {
    const clock = new ToolSilenceClock();
    clock.note({ type: 'tool_call', name: FOLLOW_UP_TOOL_NAME, input: {} }, t0);
    expect(clock.holds(t0 + 1)).toBe(false);
  });

  it('does not count a wait on a person against a call\'s limit', () => {
    const clock = new ToolSilenceClock();
    clock.note(call('bash', 'a', { timeout_ms: 180_000 }), t0);
    const limit = 180_000 + CLIENT_GRACE_MS + TOOL_SILENCE_MARGIN_MS;
    clock.pause(t0 + 10_000);
    clock.pause(t0 + 50_000); // a second pause does not restart the wait
    expect(clock.holds(t0 + limit + 1_000), 'still waiting').toBe(true);
    clock.resume(t0 + 130_000);
    clock.resume(t0 + 200_000); // nor does a second resume add more
    expect(clock.holds(t0 + limit + 120_000 - 1)).toBe(true);
    expect(clock.holds(t0 + limit + 120_000)).toBe(false);
  });
});
