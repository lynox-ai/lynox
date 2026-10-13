#!/usr/bin/env node
/**
 * lint-changed.mjs — eslint over the source files a push changes, as they are in the pushed commit.
 *
 *   node scripts/lint-changed.mjs <base> <tip>   (from .lefthook/pre-push/lint-changed.sh, per pushed ref)
 *   node scripts/lint-changed.mjs                (by hand: from where HEAD leaves origin/main to HEAD)
 *
 * Exit 0 = clean, or nothing to lint · 1 = eslint reported an error (or the script crashed) ·
 * 2 = could not check. **Both block the push.**
 *
 * ⭐ WHY. eslint ran in exactly one place: the CI job (`pnpm run lint` in `ci.yml`). The pre-commit
 * hook runs the typecheck, and the typecheck does not know eslint's rules — `eqeqeq`, `no-console`,
 * `consistent-type-imports`. Twice (#1305, #1746) a `!= null` passed every local hook and turned the
 * pull request red in the merge queue.
 *
 * WHAT IS LINTED. The files that change between `<base>` and `<tip>` — the range
 * `pushed-ranges.sh` derives from git's pre-push lines, so a push of a branch you are not standing
 * on is linted as that branch — under `src/` (`.ts`) and `packages/web-ui/src/` (`.ts`, `.svelte`),
 * minus `*.test.ts`, which the config does not cover. They are linted in a TEMPORARY WORKTREE
 * checked out at `<tip>`: every source file the type-aware rules read, the eslint config and the
 * tsconfigs are then exactly the pushed commit. node_modules is borrowed from this tree, so a push
 * that changes a dependency is linted against the install you have. Linting the working tree instead let an uncommitted edit of a
 * file the change depends on decide the verdict for a commit that does not contain it.
 *
 * ⚠ WHAT IT DOES NOT SEE. Only CHANGED files are linted. A type-aware rule (`no-floating-promises`)
 * can fail in a file the push did not touch — make a function async, and a caller elsewhere now
 * floats a promise. CI lints everything and catches that; this hook does not.
 *
 * ⛔ FAIL DIRECTION — closed. Exit 2 when: a ref does not resolve or the range cannot be diffed;
 * `node_modules` is missing; the temporary worktree cannot be created; `svelte-kit sync` fails (the
 * web UI's tsconfig extends the file it writes); eslint cannot be loaded or throws; the config
 * IGNORES a file this hook selected (the selection and the config have drifted apart, so part of
 * the change would go unlinted); eslint returns other than one result for a file. A range that
 * changes no selected file exits 0 and says so.
 *
 * Its CI twin is the `lint` step in `ci.yml`, which covers a push made with `--no-verify`.
 *
 * Seam for tests: `LINT_CHANGED_BASE` names the ref read as main in the by-hand form
 * (default `origin/main`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export class CannotCheck extends Error {}

/** The paths this hook lints, out of a range's changed paths. Pure. */
export function selectFiles(paths) {
  return paths.filter((p) => !p.endsWith('.test.ts') && (
    (p.startsWith('src/') && p.endsWith('.ts'))
    || (p.startsWith('packages/web-ui/src/') && (p.endsWith('.ts') || p.endsWith('.svelte')))
  ));
}

function git(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    throw new CannotCheck(`git ${args.join(' ')} failed: ${String(e.stderr ?? e.message).split('\n')[0]}`);
  }
}

/**
 * The paths that change from `base` to `tip` (added, copied, modified, renamed — under their new
 * name). NUL-separated: with `core.quotePath` a non-ASCII name is otherwise printed quoted and
 * escaped, and no longer starts with `src/`.
 */
export function changedPaths(root, base, tip) {
  return git(root, ['diff', '-z', '--name-only', '--diff-filter=ACMR', base, tip, '--']).split('\0').filter(Boolean);
}

/**
 * Lint `files` (repo-relative) with `eslint`, inside `root`. Returns `{ errorCount, results }`;
 * throws CannotCheck when part of the selection would go unlinted.
 */
export async function lintSelected(files, { root, eslint }) {
  const results = [];
  for (const f of files) {
    const abs = join(root, f);
    let ignored;
    let out;
    try {
      ignored = await eslint.isPathIgnored(abs);
      out = ignored ? [] : await eslint.lintFiles([abs]);
    } catch (e) {
      throw new CannotCheck(`eslint failed on ${f}: ${String(e?.message ?? e).split('\n')[0]}`);
    }
    if (ignored) {
      throw new CannotCheck(`the eslint config ignores ${f}, which this hook selected — the two have drifted apart, and that file would go unlinted`);
    }
    if (out.length !== 1) throw new CannotCheck(`eslint returned ${out.length} results for ${f}, expected 1`);
    results.push(...out);
  }
  return { errorCount: results.reduce((n, r) => n + r.errorCount, 0), results };
}

/** The node_modules directories a checkout needs: the root's, and the web UI's for `svelte-kit`. */
const MODULE_DIRS = ['node_modules', 'packages/web-ui/node_modules'];

/** Check `tip` out into a temporary worktree that borrows this tree's node_modules. */
function checkoutAt(repo, tip) {
  let dir = null;
  let wt = null;
  const remove = () => {
    // The links first: `worktree remove --force` must never reach through them into the real trees.
    if (wt !== null) for (const m of MODULE_DIRS) rmSync(join(wt, m), { force: true });
    if (wt !== null) { try { git(repo, ['worktree', 'remove', '--force', wt]); } catch { /* the prune below still runs */ } }
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    try { git(repo, ['worktree', 'prune']); } catch { /* best effort */ }
  };
  try {
    dir = mkdtempSync(join(tmpdir(), 'lint-changed-'));
    wt = join(dir, 'tree');
    git(repo, ['worktree', 'add', '--quiet', '--detach', wt, tip]);
    // A tip without packages/web-ui has nowhere to put that link, and needs none.
    for (const m of MODULE_DIRS) {
      if (existsSync(join(repo, m)) && existsSync(dirname(join(wt, m)))) symlinkSync(join(repo, m), join(wt, m));
    }
  } catch (e) {
    remove();
    throw e instanceof CannotCheck ? e : new CannotCheck(`the temporary checkout could not be created: ${String(e?.message ?? e).split('\n')[0]}`);
  }
  // Ctrl-C reaches node before any `finally`; without this the checkout stays registered.
  const onSignal = (sig) => { remove(); process.kill(process.pid, sig); };
  for (const sig of SIGNALS) process.once(sig, onSignal);
  return {
    wt,
    remove() {
      for (const sig of SIGNALS) process.removeListener(sig, onSignal);
      remove();
    },
  };
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

async function loadEslint(repo, cwd) {
  try {
    const entry = createRequire(join(repo, 'package.json')).resolve('eslint');
    const { ESLint } = await import(pathToFileURL(entry).href);
    return new ESLint({ cwd });
  } catch (e) {
    throw new CannotCheck(`eslint could not be loaded: ${String(e?.message ?? e).split('\n')[0]}`);
  }
}

/** Lint one range. Returns the exit code; throws CannotCheck. */
export async function lintRange(repo, base, tip) {
  const sha = git(repo, ['rev-parse', '--verify', '--quiet', `${tip}^{commit}`]).trim();
  const files = selectFiles(changedPaths(repo, base, sha));
  if (files.length === 0) {
    console.log(`lint-changed: nothing to lint in ${sha.slice(0, 8)} — no .ts/.svelte source under src/ or packages/web-ui/src/ changes`);
    return 0;
  }
  if (!existsSync(join(repo, 'node_modules'))) {
    throw new CannotCheck('node_modules is missing in this worktree — run `pnpm install --frozen-lockfile`');
  }
  const co = checkoutAt(repo, sha);
  try {
    if (files.some((f) => f.startsWith('packages/web-ui/'))) {
      try {
        execFileSync('pnpm', ['--filter', '@lynox-ai/web-ui', 'exec', 'svelte-kit', 'sync'], { cwd: co.wt, stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (e) {
        throw new CannotCheck(`svelte-kit sync failed: ${String(e.stderr ?? e.message).split('\n')[0]}`);
      }
    }
    const eslint = await loadEslint(repo, co.wt);
    const { errorCount, results } = await lintSelected(files, { root: co.wt, eslint });
    const text = (await (await eslint.loadFormatter('stylish')).format(results)).split(`${co.wt}/`).join('');
    if (text.trim() !== '') console.log(text);
    if (errorCount > 0) {
      // stdout, like the listing above, so the two stay in order when lefthook relays them.
      console.log(`lint-changed: ${errorCount} eslint error(s) in ${files.length} changed file(s) of ${sha.slice(0, 8)} — fix them before the push; the CI lint step runs the same rules.`);
      return 1;
    }
    console.log(`lint-changed: clean ✓ (${files.length} changed file(s) of ${sha.slice(0, 8)}, linted in a checkout of that commit; unchanged files are CI's)`);
    return 0;
  } finally {
    co.remove();
  }
}

async function main(argv) {
  const repo = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  let base;
  let tip;
  if (argv.length === 2) {
    [base, tip] = argv;
  } else if (argv.length === 0) {
    const main = process.env['LINT_CHANGED_BASE'] ?? 'origin/main';
    try {
      base = git(repo, ['merge-base', 'HEAD', main]).trim();
    } catch (e) {
      throw new CannotCheck(`${e.message} — run \`git fetch origin main\``);
    }
    tip = 'HEAD';
  } else {
    console.error('usage: node scripts/lint-changed.mjs [<base> <tip>]');
    return 2;
  }
  return lintRange(repo, base, tip);
}

let invoked = null;
try {
  invoked = process.argv[1] === undefined ? null : realpathSync(process.argv[1]);
} catch {
  process.stderr.write(`lint-changed: could not resolve ${process.argv[1]}\n`);
  process.exitCode = 2;
}
if (invoked !== null && fileURLToPath(import.meta.url) === invoked) {
  // An unexpected crash is node's exit 1, which blocks the push like a lint error does.
  process.exitCode = await main(process.argv.slice(2)).catch((e) => {
    if (!(e instanceof CannotCheck)) throw e;
    console.error(`lint-changed: could not check — ${e.message}. The push is blocked: a lint that read nothing is not a pass.`);
    return 2;
  });
}
