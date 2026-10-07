// vitest started from this directory would otherwise read `vite.config.ts`, which has no test
// setup: no `browser-compile` project, so rune-module tests (`*.svelte.test.ts`) would compile
// Svelte for the server and pass or fail as the browser never would.
//
// This makes a run from here the SAME run as from the repo root: it switches the process to the
// root and hands vitest the repo's configuration. The switch is load-bearing, measured:
//  - the repo configuration loaded from here WITHOUT it: in a fresh checkout dependency
//    optimisation fails ("Tsconfig not found": this package's tsconfig extends a file only
//    `svelte-kit sync` generates); after a sync, no test is found, because the projects'
//    `include` patterns (`packages/*/src/**/*.svelte.test.ts`, …) resolve from here;
//  - setting `root` on it instead: still no test found, and the global setup's
//    `resolve('packages/web-ui')` (scripts/vitest-global-setup.ts) resolves from here too.
// What follows from it: relative output paths (`--outputFile`, coverage reports) land at the
// repo root, as they would from there. A filter keeps working (`src/lib/stores/x.svelte.test.ts`
// is a substring of the path from the root); without one, the whole repo suite runs.
// Only vitest reads this file; `vite`, `svelte-check` and the build do not.
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
process.chdir(repoRoot);
const { default: repoConfig } = await import('../../vitest.config.js');

export default repoConfig;
