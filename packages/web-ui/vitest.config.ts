// vitest started from this directory would otherwise read `vite.config.ts`, which has no test
// setup: no `browser-compile` project, so rune-module tests (`*.svelte.test.ts`) would compile
// Svelte for the server and pass or fail as the browser never would.
//
// This makes a run from here the SAME run as from the repo root: it switches the process to the
// root and hands vitest the repo's configuration. Both halves are needed, measured:
//  - the repo configuration alone, loaded from here, finds no test: its projects' `include`
//    patterns (`packages/*/src/**/*.svelte.test.ts`, …) resolve from the working directory;
//  - setting `root` on it instead failed in a fresh checkout during dependency optimisation,
//    because tooling still resolves from the working directory, and this package's tsconfig
//    extends a file only `svelte-kit sync` generates.
// Only vitest reads this file; `vite`, `svelte-check` and the build do not.
//
// A path filter keeps working (`src/lib/stores/x.svelte.test.ts` is a substring of the path from
// the root). Without one, the whole repo suite runs, as it would from the root.
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
process.chdir(repoRoot);
const { default: repoConfig } = await import('../../vitest.config.js');

export default repoConfig;
