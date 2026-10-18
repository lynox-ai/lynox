import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// `ApiStore.getAll()` is the set of USABLE profiles. A check whether another profile uses a name
// or a slot reads `knownProfiles()`, which adds the stored profiles the boot held back; through
// `getAll()` such a profile is invisible and the check answers "free". This counts the callers,
// so a new one has to be looked at and either moved to `knownProfiles()` or added below.
// It reads the receiver's text, a cast to `ApiStore` included: a store reached through another
// variable name, and the loops over `this.profiles` inside api-store.ts, are not counted.
const CALLER = /(?:[Aa]piStore(?:\(\))?[!?)]?|(?<![.\w])store)\.getAll\(\)/g;

/** Every caller today, with why it wants the usable profiles only. */
const EXPECTED: Record<string, { count: number; why: string }> = {
  'src/tools/builtin/api-setup.ts': { count: 2, why: 'the list action and the note on waiting connections show usable profiles' },
  'src/server/http-api.ts': { count: 1, why: 'the profiles route lists usable profiles' },
  'src/core/transcribe/session-context.ts': { count: 1, why: 'profile names as transcription hints' },
};

const ROOT = join(__dirname, '..', '..');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

describe('callers of ApiStore.getAll()', () => {
  it('the pattern finds the call shapes it is meant to find', () => {
    for (const line of ['apiStore.getAll()', 'apiStore?.getAll()', 'apiStore!.getAll()', 'this._apiStore.getAll()', 'getApiStore()?.getAll()', '(apiStore as unknown as ApiStore).getAll()', 'const x = store.getAll();']) {
      expect(line.match(CALLER), line).toHaveLength(1);
    }
    for (const line of ['this.store.getAll()', 'vault.getAll()', 'apiStore.knownProfiles()']) {
      expect(line.match(CALLER), line).toBeNull();
    }
  });

  it('are the ones listed, each asked for usable profiles and not for whether a name is taken', () => {
    const found: Record<string, number> = {};
    for (const file of sources(join(ROOT, 'src'))) {
      const n = readFileSync(file, 'utf-8').match(CALLER)?.length ?? 0;
      if (n > 0) found[relative(ROOT, file).split('\\').join('/')] = n;
    }
    const expected = Object.fromEntries(Object.entries(EXPECTED).map(([f, { count }]) => [f, count]));
    expect(found, 'A caller of ApiStore.getAll() was added or removed. If it asks whether ANOTHER profile uses a name or a slot, read knownProfiles() instead; otherwise update EXPECTED with the reason.').toEqual(expected);
  });
});
