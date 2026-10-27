import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Which mandate a plan acts for, and which connections the owner's stamp lets it use, is decided in
// one place: `planConnectionState` (profile-secret-view.ts). A second reader of the plan context
// would be a second answer to "may this plan use that connection", and the one that drifts. And a
// second place that starts a plan's run is one that could hand it a list the stamp never held. This
// counts both; a new site fails here until it says why it may stand. Tests are not counted.

const SRC = join(__dirname, '..');

const SITES: readonly RegExp[] = [/\bcurrentPlan(Of|Stamp)\(/, /\brunAsPlanOf\(/];

const PINNED: Readonly<Record<string, string>> = {
  "core/profile-secret-view.ts|if (currentPlanOf() === undefined) return 'no-plan';": 'planConnectionState: the one reader',
  'core/profile-secret-view.ts|const entry = currentPlanStamp()?.find((e) => e.profile === profile.id);': 'planConnectionState: the one reader',
  'core/worker-loop.ts|const collected = runCollectingMemberNotes(() => (entry.planOf !== undefined ? runAsPlanOf(entry.planOf, dispatch, stamp, trail?.key) : dispatch()));': 'the dispatch: the list read back against the stamp this run carries',
};

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

describe('the plan context has one reader and one writer', () => {
  it('finds the plan context read or started only where it is pinned', () => {
    const found: string[] = [];
    for (const f of files(SRC)) {
      const rel = relative(SRC, f);
      if (rel === join('core', 'plan-run-context.ts')) continue;
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        if (SITES.some((r) => r.test(line))) found.push(`${rel}|${line.trim()}`);
      }
    }
    expect(found.filter((k) => !(k in PINNED))).toEqual([]);
    // A pin whose line is gone is a pin that guards nothing.
    expect(Object.keys(PINNED).filter((k) => !found.includes(k))).toEqual([]);
  });
});
