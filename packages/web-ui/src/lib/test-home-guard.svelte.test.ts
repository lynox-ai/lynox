// The home guard (`scripts/vitest-home-guard.ts`) runs in this project too: without it here, a
// rune-module test could open the machine's real `~/.lynox` and nothing would say so. The symbol
// is the one `scripts/test-run-home.ts` registers; read by name, so this file imports nothing
// from outside the package.
import { describe, it, expect } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

describe('the browser-compile project runs with the run’s home', () => {
  it('the guard ran in this worker, and the home is the run’s', () => {
    expect((globalThis as Record<symbol, unknown>)[Symbol.for('lynox.test.homeGuardRan')]).toBe(true);
    expect(homedir()).toBe(join(tmpdir(), 'home'));
  });
});
