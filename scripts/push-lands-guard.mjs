#!/usr/bin/env node
/**
 * push-lands-guard.mjs — a push to a branch whose pull request is already merged or closed lands
 * NOWHERE, and `git push` reports success anyway.
 *
 *   node scripts/push-lands-guard.mjs hook <remote-name> <remote-url>   (pre-push; refs on stdin)
 *   node scripts/push-lands-guard.mjs sweep <owner/repo>                (scheduled CI backstop)
 *
 * Exit 0 = every pushed branch can still land · 1 = it cannot (merged/closed PR, or an orphaned
 * head on the remote) · 2 = could not check. **2 blocks the push exactly like 1.**
 *
 * ⭐ WHY. The push exit measures the TRANSPORT, not the landing. Two measured losses:
 *   · 2026-09-30: four lines were pushed to a branch almost three hours after its pull request
 *     had merged.
 *   · 2026-10-01: a commit was pushed to a branch after its pull request had merged, and survived
 *     only because its author re-measured and rescued it into a new pull request.
 * `delete_branch_on_merge` is on, so the late push does not even hit an existing branch — it
 * RE-CREATES one (remote sha `000…0` on stdin). A check that reads "new branch → no PR yet" lets
 * exactly that case through, which is why the PR lookup is by branch NAME, never by remote state.
 * The second session had read the rule describing this and walked into it anyway: a rule without a
 * mechanism loses to the normal case.
 *
 * ⛔ FAIL DIRECTION — closed, on purpose. `gh` missing, not logged in, the network gone, a timeout,
 * an answer that is not the expected JSON, a PR state this file does not know: every one of them
 * is exit 2 and the push stops. That is the moment a person is least attentive (the push "just
 * worked" a minute ago), so letting it through would be the guard failing precisely when needed.
 * There is no environment switch to turn it off; a switch would be the bypass.
 *
 * ⛔ WHY lefthook `scripts:` AND NOT `commands:` — measured with lefthook 2.1.5 and 2.1.8 in clones
 * with `origin/HEAD → origin/main`, as pro and core have it. A pre-push `command` is skipped with
 * "(skip) no matching push files", and the push exits 0, when the PUSHED TREE EQUALS THE TREE OF
 * `origin/HEAD` — e.g. a branch re-created from commits whose content is already on main.
 * `skip_empty: false` does not change it. A `script` runs regardless and receives the remote
 * name/URL as `$1 $2` and the ref lines on stdin. (A first version of this paragraph said "whenever
 * the push changes no file"; that came from fixtures WITHOUT `origin/HEAD`, where lefthook skips
 * even pushes that change files.)
 *
 * What the hook cannot see, and why `sweep` exists: a clone where lefthook is not installed, a
 * `--no-verify` push, and the second between this check and the transport (a merge landing in
 * that second). `sweep` runs on main's schedule, so no branch content can switch it off — a
 * push-triggered workflow could not offer that: GitHub takes it from the PUSHED commit, and a
 * branch cut before this file existed would not carry it.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ZERO = /^0+$/;
const KNOWN_STATES = new Set(['OPEN', 'MERGED', 'CLOSED']);
/** `gh` gets a hard limit: a hung network must end in exit 2, not in a push that never returns. */
const GH_TIMEOUT_MS = 20_000;
/** The sweep lists every PR in one call. Reaching the limit means the list may be cut short. */
const PR_LIMIT = 5000;

/**
 * Classify the EFFECTIVE push URL (git hands pre-push the URL after `pushurl`/`insteadOf`).
 *
 *   { repo: 'o/r' }   a github.com remote — scp form `user@host:o/r`, or `ssh://`, `https://`,
 *                     `git://` with optional user and port; host `github.com` or `ssh.github.com`,
 *                     compared case-insensitively
 *   { repo: null }    plainly not GitHub: no `github` anywhere in it
 *   'unreadable'      mentions `github` but does not parse — an ssh host alias (`github-work`),
 *                     an odd form. ⛔ REFUSED, not passed: a review measured six valid GitHub push
 *                     URLs that an earlier, narrower parser read as "not GitHub" and let through.
 *
 * @param {string} url
 * @returns {{ repo: string | null } | 'unreadable'}
 */
export function classifyRemote(url) {
  const u = url.trim();
  const path = '([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\\.git)?/?';
  const host = '(?:ssh\\.)?github\\.com';
  const scp = new RegExp(`^[A-Za-z0-9_.-]+@${host}:${path}$`, 'i');
  const urlForm = new RegExp(`^(?:ssh|https?|git)://(?:[^@/]+@)?${host}(?::\\d+)?/${path}$`, 'i');
  const m = scp.exec(u) ?? urlForm.exec(u);
  if (m !== null) return { repo: `${m[1]}/${m[2]}` };
  return /github/i.test(u) ? 'unreadable' : { repo: null };
}

/**
 * The branch updates a pre-push stdin announces. Deletions (local sha all zeros) and non-branch
 * refs (tags, notes) are dropped: neither can carry work into a pull request.
 *
 * ⛔ A line that does not have the four documented fields THROWS. Skipping it would be the
 * fail-open direction: an unreadable line can never become a finding.
 *
 * @param {string} text
 * @returns {{ branch: string, localSha: string, remoteSha: string }[]}
 */
export function branchUpdates(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const f = line.trim().split(/\s+/);
    if (f.length !== 4 || !/^[0-9a-f]{40,64}$/.test(f[1]) || !/^[0-9a-f]{40,64}$/.test(f[3])) {
      throw new Error(`unreadable pre-push line: ${JSON.stringify(line)}`);
    }
    const [, localSha, remoteRef, remoteSha] = f;
    if (ZERO.test(localSha)) continue;
    if (!remoteRef.startsWith('refs/heads/')) continue;
    out.push({ branch: remoteRef.slice('refs/heads/'.length), localSha, remoteSha });
  }
  return out;
}

/**
 * Can a push to this branch still land, given every PR that ever had it as head?
 *
 *   any OPEN            → land (a reused branch name with a fresh PR is fine)
 *   else any MERGED     → merged  (the most recent merge is named)
 *   else any CLOSED     → closed
 *   none at all         → land (work in flight; the PR comes later)
 *
 * ⛔ A state outside OPEN/MERGED/CLOSED THROWS — a new GitHub state is "could not check", not
 * "fine", because only the three known ones have a known meaning here.
 *
 * @param {{ number: number, state: string, mergedAt?: string | null, closedAt?: string | null }[]} prs
 * @returns {{ kind: 'land' } | { kind: 'merged' | 'closed', pr: number, at: string }}
 */
export function verdict(prs) {
  for (const p of prs) {
    if (!KNOWN_STATES.has(p.state)) throw new Error(`unknown pull-request state ${JSON.stringify(p.state)} on #${p.number}`);
  }
  if (prs.some((p) => p.state === 'OPEN')) return { kind: 'land' };
  const latest = (state, key) => prs
    .filter((p) => p.state === state)
    .sort((a, b) => String(b[key] ?? '').localeCompare(String(a[key] ?? '')))[0];
  const merged = latest('MERGED', 'mergedAt');
  if (merged !== undefined) return { kind: 'merged', pr: merged.number, at: String(merged.mergedAt ?? '') };
  const closed = latest('CLOSED', 'closedAt');
  if (closed !== undefined) return { kind: 'closed', pr: closed.number, at: String(closed.closedAt ?? '') };
  return { kind: 'land' };
}

/**
 * Branches whose head no pull request will ever carry: no OPEN PR, at least one merged or closed
 * PR, and a head that is NONE of those PRs' last head. A merged branch that simply was not deleted
 * (head == the PR's head) is not an orphan; it holds nothing that did not land.
 *
 * @param {{ name: string, sha: string }[]} heads
 * @param {{ number: number, state: string, headRefName: string, headRefOid: string }[]} prs
 * @returns {{ branch: string, sha: string, prs: number[] }[]}
 */
export function orphanHeads(heads, prs) {
  for (const p of prs) {
    if (!KNOWN_STATES.has(p.state)) throw new Error(`unknown pull-request state ${JSON.stringify(p.state)} on #${p.number}`);
  }
  const byBranch = new Map();
  for (const p of prs) {
    const list = byBranch.get(p.headRefName);
    if (list === undefined) byBranch.set(p.headRefName, [p]); else list.push(p);
  }
  const out = [];
  for (const { name, sha } of heads) {
    const mine = byBranch.get(name);
    if (mine === undefined) continue;
    if (mine.some((p) => p.state === 'OPEN')) continue;
    if (mine.some((p) => p.headRefOid === sha)) continue;
    out.push({ branch: name, sha, prs: mine.map((p) => p.number).sort((a, b) => a - b) });
  }
  return out.sort((a, b) => (a.branch < b.branch ? -1 : a.branch > b.branch ? 1 : 0));
}

/** Run `gh` with a hard timeout; any failure is a thrown Error carrying gh's own first line. */
function gh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', timeout: GH_TIMEOUT_MS, killSignal: 'SIGKILL' });
  if (r.error !== undefined) throw new Error(`gh could not run: ${r.error.message}`);
  if (r.status !== 0) {
    const first = `${r.stderr ?? ''}`.trim().split('\n')[0] ?? '';
    throw new Error(`gh ${args.slice(0, 2).join(' ')} exited ${r.status ?? 'by signal'}: ${first}`);
  }
  return r.stdout;
}

/** Parse JSON that must be an array; anything else is an Error, never an empty list. */
function jsonArray(text, what) {
  let v;
  try { v = JSON.parse(text); } catch { throw new Error(`${what}: gh did not return JSON`); }
  if (!Array.isArray(v)) throw new Error(`${what}: gh returned ${typeof v}, not a list`);
  return v;
}

function hook(remoteName, remoteUrl, stdin) {
  if (remoteUrl === undefined || remoteUrl === '') {
    console.error('push-lands-guard: no remote URL was passed — refusing the push rather than guessing the repository.');
    return 2;
  }
  const remote = classifyRemote(remoteUrl);
  if (remote === 'unreadable') {
    console.error(`⛔ push-lands-guard: ${remoteName ?? '?'} (${remoteUrl}) looks like GitHub but does not parse as`);
    console.error('   owner/repo (an ssh host alias?) — refusing rather than treating it as "not GitHub".');
    return 2;
  }
  const repo = remote.repo;
  if (repo === null) {
    // Not GitHub: nothing there can hold a pull request, so there is nothing to land in.
    console.log(`push-lands-guard: ${remoteName ?? '?'} (${remoteUrl}) is not a github.com remote — no pull request to check.`);
    return 0;
  }
  const updates = branchUpdates(stdin);
  let fail = 0;
  for (const { branch } of updates) {
    if (branch === 'main') continue;
    const prs = jsonArray(gh(['pr', 'list', '--repo', repo, '--head', branch, '--state', 'all',
      '--json', 'number,state,mergedAt,closedAt', '--limit', '100']), `pull requests for ${branch}`);
    const v = verdict(prs);
    if (v.kind === 'land') continue;
    fail = 1;
    const what = v.kind === 'merged' ? `was MERGED at ${v.at}` : `was CLOSED at ${v.at} without merging`;
    console.error('');
    console.error(`⛔ push-lands-guard: ${repo} #${v.pr} ${what}, and it was the pull request of '${branch}'.`);
    console.error('   Anything pushed to that branch now lands NOWHERE — git would report success anyway.');
    if (v.kind === 'merged') {
      console.error('   Put the commits on a new branch and open a new pull request:');
      console.error(`     git switch -c ${branch}-2 && git push -u origin ${branch}-2`);
    } else {
      console.error(`   Reopen it first (gh pr reopen ${v.pr} --repo ${repo}), or move the commits to a new branch.`);
    }
  }
  if (fail === 0) {
    console.log(updates.length > 0
      ? `push-lands-guard: ${updates.map((u) => u.branch).join(', ')} — can still land ✓`
      // Empty stdin is real: git runs pre-push with no ref lines on an "Everything up-to-date" push.
      : 'push-lands-guard: no branch update in this push — nothing to check.');
  }
  return fail;
}

function sweep(repo) {
  if (repo === undefined || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    console.error(`push-lands-guard sweep: expected <owner/repo>, got ${JSON.stringify(repo)}`);
    return 2;
  }
  const prs = jsonArray(gh(['pr', 'list', '--repo', repo, '--state', 'all', '--json',
    'number,state,headRefName,headRefOid', '--limit', String(PR_LIMIT)]), 'pull requests');
  if (prs.length >= PR_LIMIT) {
    console.error(`push-lands-guard sweep: ${prs.length} pull requests reached the limit of ${PR_LIMIT} — the list may be cut short, refusing to report.`);
    return 2;
  }
  // One JSON object per line via --jq: `--paginate` concatenates pages, and a page boundary inside
  // a single JSON array is exactly how a paginated read turns into a parse error or a short list.
  const lines = gh(['api', '--paginate', `repos/${repo}/git/matching-refs/heads/`,
    '--jq', '.[] | {name: (.ref | ltrimstr("refs/heads/")), sha: .object.sha} | @json']).split('\n').filter((l) => l !== '');
  const heads = lines.map((l) => JSON.parse(l));
  if (heads.length === 0 || !heads.some((h) => h.name === 'main')) {
    console.error('push-lands-guard sweep: the branch list does not contain main — the read is broken, refusing to report.');
    return 2;
  }
  const orphans = orphanHeads(heads, prs);
  if (orphans.length === 0) {
    console.log(`push-lands-guard sweep: clean ✓ (${heads.length} branches, ${prs.length} pull requests; no head that no PR will carry)`);
    return 0;
  }
  console.log(`::error::${orphans.length} branch(es) in ${repo} carry commits that no pull request will land:`);
  for (const o of orphans) {
    console.log(`  ${o.branch}  ${o.sha.slice(0, 8)}  (PR ${o.prs.map((n) => `#${n}`).join(', ')} merged or closed; none open)`);
  }
  console.log('  → per branch: is the content on main? Then delete the branch. If not, rescue it into a new PR.');
  return 1;
}

/**
 * The last line of every hook-mode run. `.lefthook/pre-push/push-lands-guard.sh` lets the push
 * through only when it sees `VERDICT 0` — so a run that ends WITHOUT reaching a verdict (the
 * entrypoint idiom below exits 0 silently when argv[1] does not resolve to this file; a crash
 * before `main`) blocks instead of passing. A review measured that silent 0 as fail-open.
 */
export const VERDICT = 'push-lands-guard verdict:';

function couldNotCheck(e) {
  console.error('');
  console.error(`⛔ push-lands-guard: could not check — ${e instanceof Error ? e.message : String(e)}`);
  console.error('   Refusing rather than passing: an unreadable PR state is exactly when a late push goes unnoticed.');
  console.error('   Check `gh auth status` and the network, then push again.');
  return 2;
}

function main(argv) {
  const [mode, ...rest] = argv;
  if (mode === 'hook') {
    let rc;
    try { rc = hook(rest[0], rest[1], readFileSync(0, 'utf8')); } catch (e) { rc = couldNotCheck(e); }
    console.log(`${VERDICT} ${rc}`);
    return rc;
  }
  try {
    if (mode === 'sweep') return sweep(rest[0]);
  } catch (e) {
    return couldNotCheck(e);
  }
  console.error('usage: push-lands-guard.mjs hook <remote> <url>  |  sweep <owner/repo>');
  return 2;
}

// The house entrypoint idiom (`entrypoint-selfcheck-guard.mjs` refuses every other form). Said out
// loud on failure: a silent no-op here would let the hook read exit 0 as "can land".
let invoked = null;
try {
  invoked = process.argv[1] === undefined ? null : realpathSync(process.argv[1]);
} catch {
  process.stderr.write(`entrypoint self-check: ${import.meta.url} could not resolve process.argv[1]\n`);
}
if (invoked !== null && fileURLToPath(import.meta.url) === invoked) {
  process.exitCode = main(process.argv.slice(2));
}
