/**
 * Runs before every test file, in both projects: a worker whose home or engine data dir is not
 * this run's own refuses to run tests (see `test-run-home.ts`).
 *
 * Asked of the real `getLynoxDir()`, not of the variables: the guard has to see what the engine
 * would see, and a check on the variables would pass the day the engine reads something else.
 *
 * ⛔ The module registry is reset afterwards. Loading `config.js` here loads what it imports too,
 * before the test file's `vi.mock` calls are registered, so a test that mocks one of those modules
 * (`node:fs` in `atomic-write.test.ts`) got the copy loaded here, unmocked, and failed. Measured:
 * the fsync spy in that file saw no call until the reset was added.
 */
import { homedir } from 'node:os';
import { vi } from 'vitest';
import { HOME_GUARD_RAN, readRunHomeFacts, runHomeViolation } from './test-run-home.js';

const { getLynoxDir } = await import('../src/core/config.js');
const violation = runHomeViolation(readRunHomeFacts(homedir(), getLynoxDir()));
vi.resetModules();
if (violation !== null) {
  throw new Error(
    `Refusing to run tests: ${violation}. The real ~/.lynox on this machine is a live instance ` +
      'directory, and no test may open it. Run the suite through vitest with its config, so ' +
      'globalSetup (scripts/vitest-global-setup.ts) redirects HOME first.',
  );
}
(globalThis as Record<symbol, unknown>)[HOME_GUARD_RAN] = true;
