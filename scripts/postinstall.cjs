#!/usr/bin/env node
/*
 * postinstall hint — tells users that @lynox-ai/core is a CLI, not a library,
 * and points them to `npx lynox` after a direct `npm i @lynox-ai/core`.
 *
 * Runs only for top-level direct installs (where the init package.json lists
 * @lynox-ai/core in dependencies). Silent for transitive deps, dev installs
 * inside the core repo, global installs, and CI environments.
 *
 * Must never fail the install — everything is wrapped in try/catch.
 */

try {
  if (process.env.CI) return;
  if (process.env.npm_config_global === 'true') return;

  const path = require('node:path');
  const fs = require('node:fs');

  const init = process.env.INIT_CWD;
  if (!init) return;

  // Dev install in the core repo itself — pnpm install at the package root.
  if (path.resolve(init) === path.resolve(process.cwd())) return;

  // Verify we're a direct dep of the init package (works for npm/pnpm/yarn,
  // regardless of their node_modules layout). Transitive deps and indirect
  // installs fall through here silently.
  const initPkgPath = path.join(init, 'package.json');
  if (!fs.existsSync(initPkgPath)) return;

  let initPkg;
  try {
    initPkg = JSON.parse(fs.readFileSync(initPkgPath, 'utf-8'));
  } catch {
    return;
  }
  const directDeps = Object.assign(
    {},
    initPkg.dependencies,
    initPkg.devDependencies,
    initPkg.optionalDependencies,
  );
  if (!directDeps['@lynox-ai/core']) return;

  const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;
  const paint = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
  const bold = (t) => paint('1', t);
  const dim = (t) => paint('2', t);
  const green = (t) => paint('32', t);
  const yellow = (t) => paint('33', t);

  process.stdout.write(
    '\n' +
    '  ' + green('✓') + ' ' + bold('@lynox-ai/core installed') + '\n' +
    '\n' +
    '  ' + yellow('Note:') + ' lynox is a ' + bold('CLI') + ', not a library.\n' +
    '\n' +
    '  Start it:      ' + bold('npx lynox') + '\n' +
    '  Or (one-shot): ' + bold('npx @lynox-ai/core') + '\n' +
    '\n' +
    '  Docs: ' + dim('https://docs.lynox.ai') + '\n' +
    '\n',
  );
} catch {
  // Postinstall must never break the user's install.
}
