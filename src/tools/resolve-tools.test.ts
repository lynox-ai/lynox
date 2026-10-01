import { describe, it, expect } from 'vitest';
import { resolveTools, withinSurface, type ToolResolutionProfile } from './resolve-tools.js';
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

describe('withinSurface', () => {
  it('answers on NAMES, so a filtered copy counts as the same grant', () => {
    // Identity would be the wrong test: a route may hand on the parent's own objects or a
    // filtered copy of them, and both are the same grant. Asserted in both directions so the
    // predicate cannot degrade into `derived.length <= parent.length`.
    expect(withinSurface([tool('read_file')], BASE)).toBe(true);
    expect(withinSurface(BASE.filter(t => t.definition.name !== 'bash'), BASE)).toBe(true);
    expect(withinSurface([tool('never_registered')], BASE)).toBe(false);
    expect(withinSurface([tool('read_file'), tool('never_registered')], BASE)).toBe(false);
  });

  it('an empty derived list is within any surface, and that is not a pass for a route', () => {
    // True by definition and stated because it is the trap: a route that grants NOTHING
    // satisfies this predicate. Every route test therefore asserts a non-empty result beside
    // it — the predicate bounds the grant, it does not prove one was made.
    expect(withinSurface([], BASE)).toBe(true);
    expect(withinSurface([], [])).toBe(true);
    expect(withinSurface([tool('read_file')], [])).toBe(false);
  });
});

describe('resolveTools — the request, then the bound', () => {
  it('an explicit list narrows within a profile and cannot reach past its denylist', () => {
    // Pinned the OPPOSITE until 2026-09-30 ('an explicit list wins over a profile, for
    // a role without a ceiling'): the request returned before the profile was read, so
    // a caller naming `bash` against a role that denies it got `bash`. Rewritten rather
    // than deleted — a deleted pin is a silent change of contract.
    const profile: ToolResolutionProfile = { deniedTools: ['bash'] };
    expect(names(resolveTools(['bash'], profile, BASE))).toEqual([]);
    expect(names(resolveTools(['bash', 'read_file'], profile, BASE))).toEqual(['read_file']);
    // The precedence still holds in the direction it exists for: the role allows
    // `task_list` and the caller did not ask for it, so the caller's list wins there.
    expect(names(resolveTools(['read_file'], profile, BASE))).toEqual(['read_file']);
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
    // The case the bound exists for: the caller's list is applied first, so a bound
    // written inside that step would not be reached by the other route in at all.
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

  it('holds for every combination of the other inputs, in every flag state', () => {
    // The claim is about ALL inputs, so it is asserted over the product rather than a
    // sample: whatever else is passed, nothing outside the declared allowlist comes
    // back. The flag is one of the axes since 2026-09-30 — it used to be fixed at
    // `true` here, which is precisely the state the bound was keyed on, so the product
    // could not see that the other two states were not bounded at all.
    const explicits: Array<string[] | undefined> = [
      undefined, [], ['bash'], ['read_file'], ['bash', 'read_file', 'bash'],
    ];
    const denies: Array<string[] | undefined> = [undefined, [], ['bash'], ['task_list']];
    const excludes: Array<ReadonlySet<string> | undefined> = [
      undefined, new Set<string>(), new Set(['read_file']),
    ];
    const flags: Array<boolean | undefined> = [true, false, undefined];
    let checked = 0;
    for (const explicit of explicits) {
      for (const denied of denies) {
        for (const excludeSet of excludes) {
          for (const readOnly of flags) {
            const profile: ToolResolutionProfile = {
              readOnly, allowedTools: ['read_file', 'task_list'], deniedTools: denied,
            };
            for (const n of names(resolveTools(explicit, profile, BASE, excludeSet))) {
              expect(['read_file', 'task_list']).toContain(n);
            }
            checked++;
          }
        }
      }
    }
    // The count is written out, not computed from the arrays above: deriving it from
    // them would let shrinking any array to one element pass unnoticed.
    expect(checked).toBe(180);
    expect(names(resolveTools(undefined, {
      readOnly: true, allowedTools: ['read_file', 'task_list'],
    }, BASE)).length).toBeGreaterThan(0);
  });

});

describe('resolveTools — a profile without readOnly bounds the result too', () => {
  it('bounds an explicit list by a plain allowlist', () => {
    // Pinned the opposite until 2026-09-30 ('leaves a NON-readOnly profile untouched by
    // any of this'): the bound keyed on the flag, so the roles without it were left to
    // whatever the caller named. `collector` is that shape — an allowlist and no
    // denylist — which is why a set drawn around `denyTools` would have missed it.
    const plain: ToolResolutionProfile = { allowedTools: ['read_file', 'task_list'] };
    expect(names(resolveTools(['bash'], plain, BASE))).toEqual([]);
    expect(names(resolveTools(['bash', 'task_list'], plain, BASE))).toEqual(['task_list']);
  });

  it('what `readOnly` still decides is the ABSENT allowlist', () => {
    // A role that declared no allowlist keeps the parent set minus its denylist...
    expect(names(resolveTools(undefined, { deniedTools: ['bash'] }, BASE)))
      .toEqual(['read_file', 'task_list', 'write_file']);
    // ...and the same profile carrying the flag grants nothing, because an unfilled
    // bound on a read-only label fails closed. One value, two meanings, and the flag is
    // the only thing that tells them apart.
    expect(names(resolveTools(undefined, { deniedTools: ['bash'], readOnly: true }, BASE)))
      .toEqual([]);
  });

  it('treats an absent profile the same whether it is null or undefined', () => {
    // The signature says `| null` and both production callers pass exactly that, so this
    // is not about the type — it is about the function's two halves agreeing. The line
    // reading `deniedTools` optional-chains; the one reading `allowedTools` dereferences.
    // A caller arriving from JS met that difference as a THROW.
    const absent = undefined as unknown as ToolResolutionProfile | null;
    expect(names(resolveTools(['bash'], absent, BASE))).toEqual(['bash']);
    expect(names(resolveTools(undefined, absent, BASE)))
      .toEqual(['read_file', 'task_list', 'bash', 'write_file']);
    // The same two calls with `null`, so what is asserted is that they AGREE rather than
    // that one of them works.
    expect(names(resolveTools(['bash'], null, BASE))).toEqual(['bash']);
    expect(names(resolveTools(undefined, null, BASE)))
      .toEqual(['read_file', 'task_list', 'bash', 'write_file']);
  });

  it('an allowlist of `[]` is a declared bound, not an absent one', () => {
    // `[]` and `undefined` are the same value to a `?? []`, and that collapse is what
    // would turn every denylist-only role into a role with no tools at all. Asserted in
    // both directions so the two cannot be merged back together unnoticed.
    expect(names(resolveTools(undefined, { allowedTools: [] }, BASE))).toEqual([]);
    expect(names(resolveTools(undefined, { allowedTools: undefined }, BASE)))
      .toEqual(['read_file', 'task_list', 'bash', 'write_file']);
  });
});
