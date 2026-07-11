import { describe, it, expect } from 'vitest';
import {
  memoryStoreTool, memoryRecallTool, memoryUpdateTool,
  memoryListTool, memoryPromoteTool, memoryDeleteTool,
} from './memory.js';
import { parseScopeString, ACCEPTED_SCOPE_TYPES } from '../../core/scope-resolver.js';
import type { ToolEntry } from '../../types/index.js';

/**
 * Wave 1.8 / PRD §2.12 — enum-drift guard. Tool descriptions used to hand-write the
 * scope guidance next to the parser ("organization"), which `parseScopeString` rejects —
 * a loud failure that burns a turn. Descriptions now render from `ACCEPTED_SCOPE_TYPES`.
 * This test fails if any memory tool's scope description names a scope TYPE the parser
 * rejects, so the two can never drift again.
 */
const TOOLS_WITH_SCOPE: Array<{ name: string; tool: ToolEntry<never> }> = [
  { name: 'memory_store', tool: memoryStoreTool as unknown as ToolEntry<never> },
  { name: 'memory_recall', tool: memoryRecallTool as unknown as ToolEntry<never> },
  { name: 'memory_update', tool: memoryUpdateTool as unknown as ToolEntry<never> },
  { name: 'memory_list', tool: memoryListTool as unknown as ToolEntry<never> },
  { name: 'memory_promote', tool: memoryPromoteTool as unknown as ToolEntry<never> },
  { name: 'memory_delete', tool: memoryDeleteTool as unknown as ToolEntry<never> },
];

function scopeDescription(tool: ToolEntry<never>): string | undefined {
  const props = tool.definition.input_schema.properties as Record<string, { description?: string }> | undefined;
  return props?.scope?.description;
}

/** Pull every quoted `"<type>"` / `"<type>:<id>"` token's TYPE out of a description. */
function quotedScopeTypes(desc: string): string[] {
  const types: string[] = [];
  const re = /"([a-z_]+)(?::[^"]*)?"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(desc)) !== null) {
    if (m[1]) types.push(m[1]);
  }
  return types;
}

describe('memory tool scope descriptions do not drift from the parser (§2.12)', () => {
  it('every scope type named in a description is accepted by parseScopeString', () => {
    for (const { name, tool } of TOOLS_WITH_SCOPE) {
      const desc = scopeDescription(tool);
      if (!desc) continue;
      for (const type of quotedScopeTypes(desc)) {
        // A representative value of this type must parse. `global` is bare; the others take an id.
        const probe = type === 'global' ? 'global' : `${type}:probe`;
        expect(
          parseScopeString(probe),
          `${name} description names scope type "${type}" which parseScopeString rejects`,
        ).toBeDefined();
      }
    }
  });

  it('no description contains the retired "organization" scope token', () => {
    for (const { name, tool } of TOOLS_WITH_SCOPE) {
      const desc = scopeDescription(tool) ?? '';
      expect(desc.includes('organization'), `${name} still advertises "organization"`).toBe(false);
    }
  });

  it('ACCEPTED_SCOPE_TYPES is the parser\'s real accept-set', () => {
    for (const t of ACCEPTED_SCOPE_TYPES) {
      const probe = t === 'global' ? 'global' : `${t}:x`;
      expect(parseScopeString(probe)).toBeDefined();
    }
    expect(parseScopeString('organization:x')).toBeUndefined();
    expect(parseScopeString('project:x')).toBeUndefined();
  });
});
