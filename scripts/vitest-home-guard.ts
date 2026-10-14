/**
 * Runs before every test file, in both projects: a worker whose home or engine data dir is not
 * this run's own refuses to run tests (see `test-run-home.ts`).
 *
 * Asked of the real `getLynoxDir()`, not of the variables: the guard has to see what the engine
 * would see, and a check on the variables would pass the day the engine reads something else.
 */
import { homedir } from 'node:os';
import { getLynoxDir } from '../src/core/config.js';
import { HOME_GUARD_RAN, readRunHomeFacts, runHomeViolation } from './test-run-home.js';

const violation = runHomeViolation(readRunHomeFacts(homedir(), getLynoxDir()));
if (violation !== null) {
  throw new Error(
    `Refusing to run tests: ${violation}. The real ~/.lynox on this machine is a live instance ` +
      'directory, and no test may open it. Run the suite through vitest with its config, so ' +
      'globalSetup (scripts/vitest-global-setup.ts) redirects HOME first.',
  );
}
(globalThis as Record<symbol, unknown>)[HOME_GUARD_RAN] = true;
