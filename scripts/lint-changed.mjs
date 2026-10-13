#!/usr/bin/env node
/**
 * lint-changed.mjs — eslint over the source files this branch changes, before the push.
 *
 *   node scripts/lint-changed.mjs
 *
 * Exit 0 = clean, or nothing to lint · 1 = eslint reported an error (or the script crashed) ·
 * 2 = could not check. **Both block the push.**
 *
 * ⭐ WHY. eslint ran in exactly one place: the CI job (`pnpm run lint` in `ci.yml`). The pre-commit
 * hook runs the typecheck, and the typecheck does not know eslint's rules — `eqeqeq`, `no-console`,
 * `consistent-type-imports`. Twice (#1305, #1746) a `!= null` passed every local hook and turned the
 * pull request red in the merge queue. This is the same rule set, run locally on what changed.
 *
 * WHAT IS LINTED. The files the branch changes since it left `origin/main` (three-dot: from the
 * merge base, so main's own newer edits are not read as the branch's), under `src/` (`.ts`) and
 * `packages/web-ui/src/` (`.ts`, `.svelte`), minus `*.test.ts`, which the config does not cover.
 * Each file is linted as COMMITTED at HEAD (`git show HEAD:<path>`), not as it sits on disk: the
 * push carries the commit, and an uncommitted fix in the working tree must not make it look clean.
 *
 * ⛔ FAIL DIRECTION — closed. A run that checked nothing must not read as clean. Exit 2 when:
 * `origin/main` does not resolve or shares no commit with HEAD; a changed file cannot be read at
 * HEAD; eslint cannot be loaded (no `node_modules`) or throws; the config IGNORES a file this hook
 * selected (the selection and the config have drifted apart, so part of the change would go
 * unlinted); eslint returns other than one result for a file; `svelte-kit
 * sync` fails (the web UI's tsconfig extends the file it writes). An empty selection is the only
 * way to exit 0 without linting, and it says so.
 *
 * Its CI twin is the `lint` step in `ci.yml`, which covers a push made with `--no-verify`.
 *
 * Seam for tests: `LINT_CHANGED_BASE` names the ref read as main (default `origin/main`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

export class CannotCheck extends Error {}

/** The paths this hook lints, out of a branch's changed paths. Pure. */
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

/** The paths the branch changes since it left `base` (added, copied, modified, renamed). */
export function changedPaths(root, base) {
  git(root, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  const fork = git(root, ['merge-base', 'HEAD', base]).trim();
  return git(root, ['diff', '--name-only', '--diff-filter=ACMR', fork, 'HEAD']).split('\n').filter(Boolean);
}

/**
 * Lint `files` with `eslint` (an ESLint instance) as `read(path)` returns them. Returns
 * `{ errorCount, results }`; throws CannotCheck when part of the selection would go unlinted.
 */
export async function lintSelected(files, { root, eslint, read }) {
  const results = [];
  for (const f of files) {
    const abs = join(root, f);
    let ignored;
    let out;
    try {
      ignored = await eslint.isPathIgnored(abs);
      out = ignored ? [] : await eslint.lintText(read(f), { filePath: abs });
    } catch (e) {
      if (e instanceof CannotCheck) throw e;
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

async function loadEslint(root) {
  if (!existsSync(join(root, 'node_modules'))) {
    throw new CannotCheck('node_modules is missing in this worktree — run `pnpm install --frozen-lockfile`');
  }
  try {
    const entry = createRequire(join(root, 'package.json')).resolve('eslint');
    const { ESLint } = await import(pathToFileURL(entry).href);
    return new ESLint({ cwd: root });
  } catch (e) {
    throw new CannotCheck(`eslint could not be loaded: ${String(e?.message ?? e).split('\n')[0]}`);
  }
}

async function main() {
  try {
    const base = process.env['LINT_CHANGED_BASE'] ?? 'origin/main';
    let paths;
    try {
      paths = changedPaths(REPO, base);
    } catch (e) {
      if (e instanceof CannotCheck) throw new CannotCheck(`${e.message} — run \`git fetch origin main\``);
      throw e;
    }
    const files = selectFiles(paths);
    if (files.length === 0) {
      console.log(`lint-changed: nothing to lint — the branch changes no .ts/.svelte source under src/ or packages/web-ui/src/ since ${base}`);
      return 0;
    }
    if (files.some((f) => f.startsWith('packages/web-ui/'))) {
      try {
        execFileSync('pnpm', ['--filter', '@lynox-ai/web-ui', 'exec', 'svelte-kit', 'sync'], { cwd: REPO, stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (e) {
        throw new CannotCheck(`svelte-kit sync failed: ${String(e.stderr ?? e.message).split('\n')[0]}`);
      }
    }
    const eslint = await loadEslint(REPO);
    const { errorCount, results } = await lintSelected(files, {
      root: REPO,
      eslint,
      read: (f) => git(REPO, ['show', `HEAD:${f}`]),
    });
    const text = await (await eslint.loadFormatter('stylish')).format(results);
    if (text.trim() !== '') console.log(text);
    if (errorCount > 0) {
      console.error(`lint-changed: ${errorCount} eslint error(s) in ${files.length} changed file(s) — the CI lint step would fail the same way.`);
      return 1;
    }
    console.log(`lint-changed: clean ✓ (${files.length} changed file(s) linted as committed at HEAD)`);
    return 0;
  } catch (e) {
    if (e instanceof CannotCheck) {
      console.error(`lint-changed: could not check — ${e.message}. The push is blocked: a lint that read nothing is not a pass.`);
      return 2;
    }
    throw e;
  }
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
  process.exitCode = await main();
}
