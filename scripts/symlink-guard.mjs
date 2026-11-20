#!/usr/bin/env node
// === Symlink guard ===
//
// A symlink is committed as a blob with mode 120000 whose content is its target. A worktree whose
// `node_modules` is a link to another checkout is not covered by `.gitignore`'s `node_modules/`
// (the slash matches only a directory), so `git add -A` commits the link, and its target, an
// absolute path, names the machine's user and the worktree it points into.
//
// `check <base> <head>` reads every commit in base..head and fails on each link a commit adds or
// changes whose target is absolute, climbs with `..`, or holds a backslash, a colon or a control
// character (paths that only Windows reads as absolute or outside, or text hidden behind a NUL).
// Without `..` and without an absolute start, a target can leave the tree only through another
// committed link that has one of them, and that link is refused where it is added. So the rule
// needs no file system walk, and a tree that changes later cannot reopen it. A link inside the
// tree that needs `..` is refused too; neither repository has one.
//
// That reasoning assumes the base holds no such link, which is true of main (no link at all) and
// stays true as long as every change reaches main through a pull request this job reads. A link
// on a base that is not main, and that no pull request read, is not seen.
//
// Every commit, not the net diff: a link added and removed again on the branch is still in the
// branch's history, and a pull request shows that history. A merge counts only for what differs
// from every parent: a link that came in with one side is read in the commit that made it, when
// that commit is in the range.
//
// Not closed, by design: a target that stays inside the tree is a path of the tree's own names,
// and those names can still carry text. Paths git does not track (a CI checkout's installed
// `node_modules`, with its own links) are not seen. A link named `node_modules` is ignored by
// `.gitignore` first, whatever its target.
//
// The target itself is never printed: the job's log is as public as the repository.
//
// Exit 0 clean, 1 a link found, 2 a usage or git error.

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** What each problem is called in the job's log. */
export const PROBLEM_WORDS = {
  absolute: 'an absolute target',
  climbs: 'a target that climbs with ".."',
  unusual: 'a target with a backslash, a colon or a control character',
};

/** Why a link's target is refused, or null for one that names a path inside the tree. */
export function linkProblem(target) {
  if (target.startsWith('/')) return 'absolute';
  if (/[\\:\u0000-\u001f\u007f]/.test(target)) return 'unusual';
  if (target.split('/').includes('..')) return 'climbs';
  return null;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/** The links a `diff-tree -r -z --no-renames` output adds or changes: path → blob. */
function linkEntries(raw) {
  const fields = raw.split('\0');
  const links = new Map();
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i];
    if (!meta.startsWith(':')) break;
    const [, newMode, , newBlob, status] = meta.slice(1).split(' ');
    if (newMode === '120000' && /^[AMT]/.test(status ?? '')) links.set(fields[i + 1], newBlob);
  }
  return links;
}

/** The links a commit adds or changes: against its parent, or for a merge, against every parent. */
function linksIn(commit) {
  const parents = git(['rev-list', '--parents', '-n', '1', commit]).trim().split(' ').slice(1);
  if (parents.length <= 1) return linkEntries(git(['diff-tree', '-r', '-z', '--no-commit-id', '--no-renames', '--root', commit]));
  const perParent = parents.map((parent) => linkEntries(git(['diff-tree', '-r', '-z', '--no-renames', parent, commit])));
  const [first, ...rest] = perParent;
  return new Map([...first].filter(([path, blob]) => rest.every((links) => links.get(path) === blob)));
}

export function check(base, head) {
  const commits = git(['rev-list', `${base}..${head}`]).split('\n').filter(Boolean);
  const found = [];
  for (const commit of commits) {
    for (const [path, blob] of linksIn(commit)) {
      const problem = linkProblem(git(['cat-file', 'blob', blob]));
      if (problem !== null) found.push({ commit, path, problem });
    }
  }
  return { commits: commits.length, found };
}

// Run as a script, not when imported (the tests import `linkProblem`). Both sides resolved: a bare
// comparison of `argv[1]` with `import.meta.url` fails through a symlinked path, and the guard
// would then exit 0 without reading anything.
let invoked = null;
try {
  invoked = process.argv[1] === undefined ? null : realpathSync(process.argv[1]);
} catch {
  process.stderr.write('symlink-guard: argv[1] does not resolve; not run as a script\n');
}
if (invoked !== null && realpathSync(fileURLToPath(import.meta.url)) === invoked) main();

function main() {
  const [mode, base, head] = process.argv.slice(2);
  if (mode !== 'check' || !base || !head) {
    console.error('usage: node scripts/symlink-guard.mjs check <base> <head>');
    process.exit(2);
  }
  let result;
  try {
    result = check(base, head);
  } catch (err) {
    console.error(`symlink-guard: git failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    process.exit(2);
  }
  for (const f of result.found) {
    console.error(`symlink-guard: ${f.commit.slice(0, 12)} adds the link ${JSON.stringify(f.path)} with ${PROBLEM_WORDS[f.problem]}. Remove it from the commit (git rm --cached ${JSON.stringify(f.path)}); a link to node_modules belongs in no commit.`);
  }
  if (result.found.length > 0) process.exit(1);
  console.log(`symlink-guard: clean — ${result.commits} commit(s) read, no link whose target is absolute, climbs or holds unusual characters.`);
}
