import { describe, it, expect, vi } from 'vitest';
import { applyPluginToolGate } from './session.js';
import type { ToolEntry, IAgent } from '../types/index.js';
import type { PluginManager } from './plugins.js';

/**
 * Regression guard for the plugin-instance agent loop: when a pluginManager is active
 * the session re-wraps every tool's handler with the plugin gate. That wrapping MUST
 * preserve the rest of the ToolEntry — a prior implementation cherry-picked only
 * `{definition, requiresConfirmation, handler}` and dropped `endsTurn`, so a terminal
 * tool (suggest_follow_ups) resolved endsTurn=false, its turn never ended, and the agent
 * looped 7×/turn on the tool-result carrier. It also dropped `detailedGuidance`, so
 * #1006's on-use guidance never fired on a plugin-enabled instance — AND it dropped
 * `destructive` (→ Permission-Guard destructive warn/block bypassed) and
 * `redactInputForAudit` (→ sensitive tool inputs captured un-redacted in the audit
 * trail). The guard below pins the FULL dropped set, not just the two loop-relevant
 * fields, so a future subset-reconstruction can't silently re-drop the security ones.
 */
function makePluginManager(gate: boolean | undefined = true): PluginManager {
  return { fireToolGate: vi.fn().mockResolvedValue(gate) } as unknown as PluginManager;
}

const redactFn = (input: unknown): unknown => input;
const terminalTool: ToolEntry = {
  endsTurn: true,
  detailedGuidance: 'on-use guidance body',
  requiresConfirmation: false,
  destructive: { mode: 'external' },
  redactInputForAudit: redactFn,
  definition: { name: 'suggest_follow_ups', description: 'terminal', input_schema: { type: 'object', properties: {} } },
  handler: vi.fn().mockResolvedValue('Presented 2 follow-up suggestions.'),
};

const nonTerminalTool: ToolEntry = {
  definition: { name: 'read_file', description: 'safe', input_schema: { type: 'object', properties: {} } },
  handler: vi.fn().mockResolvedValue('ok'),
};

describe('applyPluginToolGate — preserves ToolEntry fields through the plugin wrapper', () => {
  it('KEEPS endsTurn (the loop regression) — a terminal tool stays terminal after wrapping', () => {
    const [wrapped] = applyPluginToolGate([terminalTool], makePluginManager());
    expect(wrapped?.endsTurn).toBe(true);
  });

  it('KEEPS detailedGuidance (#1006 on-use guidance survives on plugin instances)', () => {
    const [wrapped] = applyPluginToolGate([terminalTool], makePluginManager());
    expect(wrapped?.detailedGuidance).toBe('on-use guidance body');
  });

  it('KEEPS definition + requiresConfirmation', () => {
    const [wrapped] = applyPluginToolGate([terminalTool], makePluginManager());
    expect(wrapped?.definition.name).toBe('suggest_follow_ups');
    expect(wrapped?.requiresConfirmation).toBe(false);
  });

  it('KEEPS destructive + redactInputForAudit (permission-guard + audit-redaction survive on plugin instances)', () => {
    const [wrapped] = applyPluginToolGate([terminalTool], makePluginManager());
    // The old cherry-pick dropped both — silently bypassing the destructive
    // Permission-Guard and capturing un-redacted sensitive inputs in the audit trail.
    expect(wrapped?.destructive).toEqual({ mode: 'external' });
    expect(wrapped?.redactInputForAudit).toBe(redactFn);
  });

  it('leaves an absent endsTurn undefined (a non-terminal tool does not become terminal)', () => {
    const [wrapped] = applyPluginToolGate([nonTerminalTool], makePluginManager());
    expect(wrapped?.endsTurn).toBeUndefined();
  });

  it('wraps the handler with the gate — passes through when allowed', async () => {
    const pm = makePluginManager(true);
    const [wrapped] = applyPluginToolGate([terminalTool], pm);
    const out = await wrapped!.handler({ suggestions: [] }, {} as IAgent);
    expect(out).toBe('Presented 2 follow-up suggestions.');
    expect(pm.fireToolGate).toHaveBeenCalledWith('suggest_follow_ups', { suggestions: [] });
  });

  it('wraps the handler with the gate — blocks when the plugin gate returns false', async () => {
    const [wrapped] = applyPluginToolGate([terminalTool], makePluginManager(false));
    await expect(wrapped!.handler({}, {} as IAgent)).rejects.toThrow(/blocked by plugin gate/);
    expect(terminalTool.handler).not.toHaveBeenCalledWith({}, expect.anything());
  });
});
