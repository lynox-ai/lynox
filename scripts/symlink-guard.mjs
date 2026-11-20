#!/usr/bin/env node
// === Symlink guard ===
//
// A symlink is committed as a blob with mode 120000 whose content is its target. A worktree whose
// `node_modules` is a link to another checkout is not covered by `.gitignore`'s `node_modules/`
// (the slash matches only a directory), so `git add -A` commits the link, and its target, an
// absolute path, names the machine's user and the worktree it points into.
//
// `check <base> <head>` reads every commit in base..head, merges included against their first
// parent, and fails on each entry it adds or changes into a link whose target is absolute or
// leads out of the tree. Every commit, not the net diff: a link added and removed again on the
// branch is still in the branch's history, and a pull request shows that history.
//
// The target itself is never printed: the job's log is as public as the repository.
//
// Exit 0 clean, 1 a link found, 2 a usage or git error.

import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Why a link's target is refused, or null for one that stays inside the tree. */
export function linkProblem(linkPath, target) {
  if (target.startsWith('/') || /^[A-Za-z]:[\\/]/.test(target) || target.startsWith('\\\\')) return 'absolute target';
  const resolved = posix.normalize(posix.join(posix.dirname(linkPath), target));
  if (resolved === '..' || resolved.startsWith('../')) return 'target outside the tree';
  return null;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/** The links a commit adds or changes, against its first parent: `[path, blob]` pairs. */
function linksIn(commit) {
  const raw = git(['diff-tree', '-r', '-z', '--no-commit-id', '--no-renames', '--root', '-m', '--first-parent', commit]);
  const fields = raw.split('\0');
  const links = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i];
    const path = fields[i + 1];
    if (!meta.startsWith(':')) break;
    const [, newMode, , newBlob, status] = meta.slice(1).split(' ');
    if (newMode === '120000' && /^[AMT]/.test(status ?? '')) links.push([path, newBlob]);
  }
  return links;
}

export function check(base, head) {
  const commits = git(['rev-list', `${base}..${head}`]).split('\n').filter(Boolean);
  const found = [];
  for (const commit of commits) {
    for (const [path, blob] of linksIn(commit)) {
      const problem = linkProblem(path, git(['cat-file', 'blob', blob]));
      if (problem !== null) found.push({ commit, path, problem });
    }
  }
  return { commits: commits.length, found };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
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
    console.error(`symlink-guard: ${f.commit.slice(0, 12)} adds the link ${JSON.stringify(f.path)} with ${f.problem === 'absolute target' ? 'an absolute target' : 'a target outside the tree'}. Remove it from the commit (git rm --cached ${JSON.stringify(f.path)}); a link to node_modules belongs in no commit.`);
  }
  if (result.found.length > 0) process.exit(1);
  console.log(`symlink-guard: clean — ${result.commits} commit(s) read, no link that points out of the tree.`);
}
