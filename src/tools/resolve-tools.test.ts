import { describe, it, expect } from 'vitest';
import { resolveTools, type ToolResolutionProfile } from './resolve-tools.js';
import type { ToolEntry } from '../types/index.js';

/**
 * The resolution contract, tested at the function rather than through a grant path.
 *
 * `spawn.test.ts` and `runtime-adapter.test.ts` pin the two callers; this pins what
 * they rely on. The ceiling in particular is a claim about ALL inputs, and a claim of
 * that shape is cheapest to break here, where every input is a parameter.
 */

const tool = (name: string): ToolEntry => ({
  definition: { name, description: name, input_schema: { type: 'object' as const, properties: {} } },
  handler: async () => name,
});

const BASE = [tool('read_file'), tool('task_list'), tool('bash'), tool('write_file')];
const names = (entries: ToolEntry[]): string[] => entries.map(t => t.definition.name);

describe('resolveTools — the three tiers', () => {
  it('an explicit list wins over a profile, for a role without a ceiling', () => {
    const profile: ToolResolutionProfile = { deniedTools: ['bash'] };
    expect(names(resolveTools(['bash'], profile, BASE))).toEqual(['bash']);
  });

  it('a profile allowlist is applied, then its denylist', () => {
    const profile: ToolResolutionProfile = {
      allowedTools: ['read_file', 'bash'], deniedTools: ['bash'],
    };
    expect(names(resolveTools(undefined, profile, BASE))).toEqual(['read_file']);
  });

  it('no explicit list and no profile grants everything the excludeSet leaves', () => {
    expect(names(resolveTools(undefined, null, BASE, new Set(['write_file']))))
      .toEqual(['read_file', 'task_list', 'bash']);
  });
});

describe('resolveTools — the readOnly ceiling', () => {
  const ceiling: ToolResolutionProfile = {
    readOnly: true, allowedTools: ['read_file', 'task_list'],
  };

  it('clamps an explicit list that reaches past it', () => {
    // The case the ceiling exists for: tier 1 returns before the profile is consulted,
    // so a clamp inside the tiers would not be reached at all.
    expect(names(resolveTools(['bash', 'read_file'], ceiling, BASE))).toEqual(['read_file']);
  });

  it('still lets an explicit list NARROW within it', () => {
    expect(names(resolveTools(['read_file'], ceiling, BASE))).toEqual(['read_file']);
  });

  it('clamps an explicit list down to nothing when it names nothing allowed', () => {
    expect(names(resolveTools(['bash', 'write_file'], ceiling, BASE))).toEqual([]);
  });

  it('subtracts deniedTools on every route in, not only through the profile tier', () => {
    const denying: ToolResolutionProfile = {
      readOnly: true, allowedTools: ['read_file', 'task_list'], deniedTools: ['read_file'],
    };
    // Both routes in must agree: via an explicit list, and via the profile alone.
    expect(names(resolveTools(['read_file', 'task_list'], denying, BASE))).toEqual(['task_list']);
    expect(names(resolveTools(undefined, denying, BASE))).toEqual(['task_list']);
  });

  it('grants nothing when the ceiling was never filled in', () => {
    // Fail-closed on purpose: an unfilled ceiling is an empty ceiling, not an absent
    // one. `roles.test.ts` separately forbids a built-in role from arriving this way.
    expect(names(resolveTools(undefined, { readOnly: true }, BASE))).toEqual([]);
    expect(names(resolveTools(['read_file'], { readOnly: true, allowedTools: [] }, BASE))).toEqual([]);
  });

  it('holds for every combination of the other three inputs', () => {
    // The claim is about ALL inputs, so it is asserted over the product rather than a
    // sample: whatever else is passed, nothing outside the ceiling comes back.
    const explicits: Array<string[] | undefined> = [
      undefined, [], ['bash'], ['read_file'], ['bash', 'read_file', 'bash'],
    ];
    const denies: Array<string[] | undefined> = [undefined, [], ['bash'], ['task_list']];
    const excludes: Array<ReadonlySet<string> | undefined> = [
      undefined, new Set<string>(), new Set(['read_file']),
    ];
    let checked = 0;
    for (const explicit of explicits) {
      for (const denied of denies) {
        for (const excludeSet of excludes) {
          const profile: ToolResolutionProfile = {
            readOnly: true, allowedTools: ['read_file', 'task_list'], deniedTools: denied,
          };
          for (const n of names(resolveTools(explicit, profile, BASE, excludeSet))) {
            expect(['read_file', 'task_list']).toContain(n);
          }
          checked++;
        }
      }
    }
    // The count is written out, not computed from the arrays above: deriving it from
    // them would let shrinking any array to one element pass unnoticed.
    expect(checked).toBe(60);
    expect(names(resolveTools(undefined, {
      readOnly: true, allowedTools: ['read_file', 'task_list'],
    }, BASE)).length).toBeGreaterThan(0);
  });

  it('leaves a NON-readOnly profile untouched by any of this', () => {
    // The clamp must key on the flag, not on the presence of an allowlist.
    const plain: ToolResolutionProfile = { allowedTools: ['read_file', 'task_list'] };
    expect(names(resolveTools(['bash'], plain, BASE))).toEqual(['bash']);
  });
});
