import { describe, expect, it } from 'vitest';
import { MAX_EXEC_TIMEOUT_MS } from '../shell-sidecar/protocol.js';
import { CLIENT_GRACE_MS } from '../shell-sidecar/client.js';
import { DEFAULT_BASH_TIMEOUT_MS } from './constants.js';
import { TOOL_SILENCE_CEILING_MS, TOOL_SILENCE_MARGIN_MS, ToolSilenceClock, toolBoundMs } from './tool-silence.js';

const call = (name: string, toolUseId: string | undefined, input: unknown = {}, subAgentId?: string) =>
  ({ type: 'tool_call', name, input, toolUseId, subAgentId });
const result = (name: string, toolUseId: string | undefined, subAgentId?: string) =>
  ({ type: 'tool_result', name, toolUseId, subAgentId });

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
});
