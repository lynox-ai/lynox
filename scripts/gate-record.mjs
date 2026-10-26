#!/usr/bin/env node
/**
 * Verify a pull request carries a gate record pinned to its CURRENT head.
 *
 * WHY THIS EXISTS. The merge rule in CLAUDE.md — every relevant gate ran, its
 * findings are fixed, a delta round on those fixes came back clean, CI is green
 * — was prose for four revisions and lost to the default every time. The failure
 * is never a refusal to run gates; it is the quiet substitution of "CI is green"
 * for "the gates ran", and its close cousin: the gates DID run, then three more
 * commits landed and nobody re-ran them.
 *
 * CI cannot judge whether a review was any good. It can enforce that a record
 * EXISTS and PINS THE EXACT HEAD SHA, which converts the second failure into a
 * hard stop and makes the first one a deliberate lie rather than an oversight.
 * Most of what follows is an attestation and is documented as one — but not all:
 * the gates a diff OWES are derived from the real file list, which is a fact this
 * check establishes on its own. (The line used to read "everything past
 * SHA-freshness is an attestation", which was never quite true.)
 *
 * NOT A SECURITY BOUNDARY. Anyone who can open a PR can write the block. The
 * point is friction in the right place and a durable record on the PR, not
 * defence against a hostile author.
 *
 * Usage:
 *   node scripts/gate-record.mjs --body-file <path> --head <sha> \
 *        --files-file <path> [--base <merge-base sha>] [--author <login>] [--repo-visibility public|private] \
 *        [--title-file <path>] [--commits-file <path>]
 *   `--base` is the PR's merge base; without it a diff with any non-doc, non-test file owes `ux:`
 *   unjudged (see `uxOwed`).
 *   In CI `--event-file <path>` replaces `--body-file`/`--title-file`. `--commits-file` holds
 *   `git log --format='%h%x1f%B%x1e' <base>..<head>`; its wording is warned about, never refused.
 *
 * ⚠ Without `--repo-visibility`, a LOCAL run resolves to `unknown` and is therefore judged as
 * PUBLIC — the strict case. In THIS repo that is also the right answer, so the flag only matters
 * to a preflight run against the private repo's copy of this check. The refusal says so.
 *
 * Exits 0 when the record is acceptable (or the PR is exempt), 1 otherwise.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { proseOpenCountLines } from './guard-patterns/prose-open-count.mjs';
import { LEGAL_APPROVERS, approvedVerdict } from './guard-patterns/legal-sign-off.mjs';
import { proseWarnings } from './disclosure-vocabulary-scan.mjs';

/**
 * The token that opens the record block, assembled rather than written.
 *
 * This guard only ever reads a PR BODY, so it cannot literally match itself the
 * way a file-scanning guard can. Built from parts anyway, because the failure it
 * protects against is cheap to prevent and expensive to notice: the moment
 * someone adds a file-scanning sibling, a plaintext marker in this source turns
 * that sibling red against its own guard.
 */
const MARK = ['gate', 'record'].join('-');

/** Gate names the record may claim. An unknown name is a typo, not a new gate. */
const KNOWN_GATES = new Set(['code-review', 'security', 'delta', 'prd', 'staging-walk', 'legal']);

/**
 * Paths whose change ALWAYS requires the security gate: untrusted input,
 * permissions, secrets, the network edge, and the capability surface an agent
 * can reach (every module under `tools/builtin` is a thing the model can call).
 *
 * ⚠️ THIS IS A FLOOR, NOT A CLASSIFIER, and the difference is not academic. A
 * path map cannot see that a change opens a new trust boundary somewhere
 * ordinary: core#1099 added an LLM call that turns an excerpt of attacker-
 * influenceable text into a persisted, one-click-executable instruction — all
 * of it inside `src/core/agent.ts`, which is deliberately NOT listed here
 * because listing it would demand the gate on nearly every PR and teach people
 * to type the word without doing the work. Relevance is judged by the change's
 * AXIS; this list only catches the axes that happen to have a fixed address.
 *
 * ⚠️ A FLOOR IS ASYMMETRIC, and the integrations entry is here because it was
 * built symmetrically and failed in the direction that costs something. Too
 * NARROW is fail-open: the gate is not demanded, and whether it runs depends on
 * the author asking more of themselves than the tool does. Too BROAD costs one
 * gate run. So when in doubt this list reaches wider.
 *
 * That is why the entry below is the whole directory rather than a name
 * pattern. It used to be `/^src\/integrations\/.*\/(auth|oauth)/`, and the
 * numbers are the argument (core `d9fed2ac`, patterns executed against
 * `git ls-tree`, not read):
 *
 *   · it reached **2 of 72** non-test integration modules — `mail/auth/` and
 *     `mail/providers/oauth-gmail.ts` — and **0 of the 24** under
 *     `src/integrations/google/`, because the expression wants `auth` at the
 *     start of a path segment and that segment starts with `google-`;
 *   · the file that decides the SHAPE is `src/integrations/google/vault-keys.ts`,
 *     whose entire content is the vault slot name the Google OAuth tokens are
 *     stored under, imported by `engine.ts` and `google-auth.ts`. It contains
 *     neither `auth` nor `oauth` in its path. **No name pattern can see it**,
 *     and the next credential module named `broker-mode.ts` is the same story.
 *
 * ⚠️ FREQUENCY IS NOT WHAT DISTINGUISHES THIS FROM `src/core/agent.ts`, and an
 * earlier revision of this comment argued that it was. Measured over the last
 * 60 / 150 / 300 commits on main (squash-merge, so one commit is one PR):
 *
 *     src/integrations/   13 (21.7%)   21 (14.0%)   29 ( 9.7%)
 *     the old pattern      2 ( 3.3%)    5 ( 3.3%)    5 ( 1.7%)
 *     src/core/agent.ts    6 (10.0%)   19 (12.7%)   36 (12.0%)
 *
 * The two land in the same band, and over the widest window the new entry fires
 * LESS often than the file excluded for firing too often. So "it would be red on
 * nearly every PR" is neither the real reason `agent.ts` is off this list nor an
 * argument against this entry. What separates them is the AXIS: `agent.ts` is
 * where ordinary orchestration lives and a trust boundary opens there only
 * exceptionally (core#1099 is that exception, and it is recorded above precisely
 * because a path map could not have caught it). Everything under
 * `src/integrations/` talks to a third party on the user's behalf with the
 * user's credentials — that is a fixed address, which is exactly what this list
 * is for. Read the 21.7% as the recency-biased end of the range, not as the cost.
 */
export const SECURITY_PATHS = [
  /^src\/core\/data-boundary\.ts$/,
  /^src\/core\/output-guard\.ts$/,
  /^src\/core\/secret-store\.ts$/,
  /^src\/core\/migration-crypto\.ts$/,
  /^src\/core\/input-guard\.ts$/,
  /^src\/tools\/permission-guard\.ts$/,
  // The single exit every tool grant to a child agent passes through: the caller's
  // requested list, a role's own grant, and the parent set all meet here. Added
  // 2026-10-01, because it was NOT here while it was where a role's grant was decided
  // — a change confined to this file owed no security gate, and the change that made
  // that grant bind on every route in only owed one because it also touched
  // `src/tools/builtin/`. Cheap by the measure the note above uses: **1** of the last 300 commits on main
  // touched it, and 1 of the last 60, against 6 and 2 for `permission-guard.ts` beside
  // it. Over the whole history as of `da03ba5b` (1414 commits) it is 2 against 19 — the
  // ref belongs to the number, which is a count over a history that grows: it read 1415
  // one commit later, while a delta round was still checking this line.
  //
  // The first draft of this line said "2 of the last 300" and was wrong in its SET, not
  // its direction: `git log -n 300 <ref> -- <path>` applies the limit AFTER the path
  // filter, so it counts every commit that ever touched the file and the window is not
  // a window at all. The tell was that 60, 150 and 300 all printed the same number —
  // three windows agreeing looks like stability and is what a limit that never binds
  // looks like. Measured as ranges (`$(git rev-list -n N <ref> | tail -1)^..<ref>`).
  /^src\/tools\/resolve-tools\.ts$/,
  /^src\/tools\/builtin\//,
  /^src\/server\//,
  /^src\/integrations\//,
  // The web UI's own trust boundary. Every entry above is anchored at `^src/`, and the
  // second package carries real login code: the session cookie, link codes, magic links,
  // passkey and renew routes. `packages/web-ui/src/lib/server/auth.ts` owed only
  // code-review and delta until this was added (requiredGates at b58ba62b). The
  // DIRECTORY, not file names, for the reason the integrations note gives: public-paths.ts
  // and demo-mode.ts sit beside auth.ts and decide who gets in just as much. The account
  // settings directory is here because `account/mobile` hands an owner session a link
  // code that logs a device in as the owner, from under `routes/`, and the root page is
  // here because in demo mode it sets an owner session cookie for any visitor the rate
  // limiter lets through. Cheap by the measure
  // above: 1 of the last 60 and 7 of the last 300 commits on main touched these paths
  // (ranges, at b58ba62b).
  /^packages\/web-ui\/src\/lib\/server\//,
  /^packages\/web-ui\/src\/hooks\.server\.ts$/,
  /^packages\/web-ui\/src\/routes\/auth\//,
  /^packages\/web-ui\/src\/routes\/login\//,
  /^packages\/web-ui\/src\/routes\/logout\//,
  /^packages\/web-ui\/src\/routes\/\+page\.server\.ts$/,
  /^packages\/web-ui\/src\/routes\/app\/settings\/account\//,
];

/** A diff touching only these needs no record at all. */
/**
 * Texts that BIND a customer or are a statutory disclosure. In this repo that is one
 * file — but it is the file the managed DPA contractually points customers at, and it
 * lives in the PUBLIC repo, so a drift here is a published contradiction of a signed
 * document. Mirrors `LEGAL_PATHS` in the pro repo, where the rest of the set lives.
 *
 * ⚠️ Matched BEFORE the docs-only exemption below, and that is the whole point: this is
 * a `.md` file, so `DOC_ONLY` would otherwise wave it straight through.
 */
const LEGAL_PATHS = [
  /^SUBPROCESSORS\.md$/,
];

const DOC_ONLY = [/^docs\//, /\.md$/, /^\.github\/ISSUE_TEMPLATE\//, /^LICENSE$/];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (key) out[key] = argv[i + 1] ?? '';
  }
  return out;
}

/**
 * Pull the record out of a PR body.
 *
 * Returns `null` when there is no block. A body may hold at most one: two blocks
 * mean two claims, and picking either silently is how a stale one survives.
 */
export function extractRecord(body, mark = MARK) {
  // HTML comments come out FIRST. GitHub renders none of them, so a record
  // inside one is invisible to every human who opens the PR while satisfying
  // this check.
  //
  // Two details, both learned by getting them wrong:
  //   · The opener must START A LINE. Stripping any `<!--` anywhere ate a record
  //     that sat below prose mentioning `` `<!--` `` in inline code — a false red
  //     on a PR whose only crime was discussing this guard. Line-anchored is also
  //     what CommonMark treats as an HTML block, so it matches what GitHub hides.
  //   · An UNTERMINATED comment hides everything after it, to the end of the
  //     body. The first version only stripped well-formed pairs, so "forgot to
  //     close the comment" still bought a green tick over an invisible record —
  //     the exact hole the comment above claimed to close.
  const visible = body
    .replace(/^[ \t]*<!--[\s\S]*?-->/gm, '')
    .replace(/^[ \t]*<!--[\s\S]*$/m, '');
  // Both fences anchored to the start of a line, as a fenced block is defined.
  // `\r?` because GitHub's web editor writes CRLF: without it every PR body
  // authored in a browser went red with "no gate record" while showing one.
  const fence = new RegExp('^```' + mark + '[ \\t]*\\r?\\n([\\s\\S]*?)^```', 'gm');
  const found = [...visible.matchAll(fence)];
  if (found.length === 0) return null;
  if (found.length > 1) return { error: `found ${found.length} record blocks; a body may carry one` };

  // Every non-blank line in the block must parse, and no key may appear twice.
  //
  // The loop used to skip whatever it did not recognise, which turned the record
  // into a place where writing something and having nothing read it looked
  // identical to writing nothing. Two measured shapes, both green before this:
  //   · a second id wrapped onto a continuation line after `closes: <id>,` — that id was
  //     dropped, silently, by the guard whose entire purpose is to stop a datum
  //     from going missing;
  //   · a second `closes:` line below the first — the last one won, so a
  //     leftover `closes: none` could quietly overwrite a real answer.
  // That is the same reasoning the two-blocks rule above already states, one
  // level down: picking silently is how a stale claim survives.
  const fields = {};
  const junk = [];
  const dupes = [];
  for (const line of found[0][1].split('\n')) {
    if (!line.trim()) continue;
    const m = /^\s*([a-z-]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (!m) { junk.push(line.trim()); continue; }
    if (Object.prototype.hasOwnProperty.call(fields, m[1])) dupes.push(m[1]);
    fields[m[1]] = m[2];
  }
  if (dupes.length > 0) {
    return { error: `record repeats \`${dupes[0]}:\` — two values for one field, and the later one wins silently` };
  }
  if (junk.length > 0) {
    return {
      error: `record line \`${junk[0].slice(0, 60)}\` is not \`field: value\` — nothing reads it, ` +
        'so anything written there is lost. Keep the block to one field per line and put prose below it.',
    };
  }
  return { fields };
}

/**
 * Gates this diff requires, given the files it changes. `null` means exempt.
 *
 * An EMPTY list is not exempt. "No files changed" and "only documentation
 * changed" are different facts, and conflating them makes the check pass
 * whenever the file list fails to arrive — a wrong diff range, a cherry-pick
 * already in base, a shallow clone. A guard that opens when its input goes
 * missing is worse than no guard, because the tick still appears.
 */
/**
 * A name git printed C-QUOTED (`"…"`). The workflow lists files with `core.quotePath=false`, so a
 * name with a non-ASCII byte arrives as it is; a name with `"`, a backslash or a control character
 * is still quoted, and then no path rule can match it. It counts as a match for every path rule —
 * security and legal here, a user surface in `uxOwed` — so a name nobody can read does not open
 * a gate. Zero such files on main when this was written; that does not change the direction.
 */
export const isQuotedPath = (f) => f.startsWith('"');

export function requiredGates(files) {
  if (files.length === 0) return 'empty';
  // Legal texts are matched against the FULL file list, before the docs-only filter —
  // the subprocessor list is markdown and would otherwise be exempt as documentation.
  const legal = files.some((f) => isQuotedPath(f) || LEGAL_PATHS.some((p) => p.test(f)));
  const code = files.filter((f) => !DOC_ONLY.some((p) => p.test(f)));
  if (code.length === 0 && !legal) return null; // docs-only: exempt
  const gates = new Set();
  if (code.length > 0) { gates.add('code-review'); gates.add('delta'); }
  if (code.some((f) => isQuotedPath(f) || SECURITY_PATHS.some((p) => p.test(f)))) gates.add('security');
  if (legal) gates.add('legal');
  return gates;
}

/**
 * ── ux: what a user is left with ───────────────────────────────────────────────
 *
 * Every PR that changes code carries a `ux:` line. Security had a lane, a refuter and a line in
 * this record; how a flow FEELS had none, and a lock decided in half an hour was checked only for
 * whether the old path still worked technically. A voice with a gate wins against one without.
 *
 * Three answers, decided by the ux lane (2026-10-26):
 *   · `ux: reviewed U-NNN` — the ux lane looked at it before the merge; `U-NNN` is an opaque
 *     number from its decisions file, the same in both repos and safe in a public body;
 *   · `ux: self — way out: <what the user can still do>` (or `Ausweg:`) — the author's own word,
 *     for a change near the user that leaves no new dead end. Naming the way out is the point:
 *     whoever cannot write it in one sentence owes a review;
 *   · `ux: not user-facing — <reason>`.
 *
 * The line itself is cheap and always owed. What this check DETECTS is narrower: whether the diff
 * owes a REVIEW, so that only `reviewed` will do. That is the case when a line the head ADDS
 * (one it has more often than the merge base), outside comments, tests and documentation:
 *   a) adds or reaches a refusal, a lock or a confirmation — a `*_REFUSAL(S)`/`*_REFUSED`
 *      constant, a call to `refuse…(` (a NEW call site of an old refusal is a new lock on a
 *      further path), a `Blocked:` or `Not allowed` text, an ask-the-user call, or a state the user has
 *      to see (`contained`, `awaiting_approval`, `private_only`). Import, re-export and type lines
 *      do not count, nor a name that only appears as a string (a registry entry);
 *   b) adds a page or a component the user walks through (a NEW file, see `UX_NEW_FLOW`);
 *   c) adds a user text that says what to do next — a new i18n key whose name reads like a
 *      refusal, an error, an empty state or a confirmation. A changed value of an existing key
 *      does not fire; that is what `self` is for — except under a key named `confirm`: what a
 *      confirmation says is what the user agrees to, so a new wording is a new consent.
 * Narrower cuts were measured against the ux lane's own marking of 61 matches and dropped (ux,
 * 2026-10-26): skipping a reworded `Blocked:` opening and the `halt` key name lost 4 of its 30
 * "needs a review" cases to remove 4 of its 31 "self would do". A cut that lets a real lock through
 * fails the wrong way; a later one is an entry in these tables, measured against a new marking.
 * What it costs, measured with this function over first-parent commits of main, every commit judged
 * as if its base already had the line: in core at `9348db5e`, 61 of the last 295 code PRs owe a
 * review (19 of the last 99); in pro at `85f29cdd`, 10 of the last 203. Against the ux lane's own
 * marking of the 61 core matches: all 30 it judged as needing a review are caught.
 * And it owes a review whenever it cannot read: no `--base`, no `--head`, a commit or object git
 * cannot open, a path git printed quoted. A miss here costs a review that should have happened;
 * an unreadable diff is not evidence that none was needed.
 *
 * What it cannot see, stated so nobody reads more into it: a lock tightened by editing only its
 * condition (`if (role !== 'owner')`); a refusal spelled otherwise (a German text, a
 * `ForbiddenError`); a line that starts as a comment, even with code after it or inside a
 * template literal the user reads. Those stay the author's to declare. And where it errs the
 * other way, it asks for a review it did not need: a renamed file reads as all-new lines, as does
 * a re-indented one, and the inner lines of a multi-line import or type are read as sites.
 *
 * Lines are compared as a MULTISET, read with `git cat-file`, never with `git diff`: a full diff
 * can run an author-chosen diff driver, which `--name-only` avoids for the file list and this
 * avoids for content. A moved line is not an addition; a duplicated one is.
 *
 * THE TRANSITION. A PR whose merge base predates this function owes no `ux:` line: it was opened
 * under a record that had none, and turning it red for that alone would punish work already in
 * flight. The test is whether this script AT THE MERGE BASE contains `UX_LINE_MARK`. Rebasing
 * onto main brings a branch under the rule; a base that cannot be read owes a review.
 */
/** a): what reads as a refusal, a lock, a confirmation or a state the user has to see. */
export const UX_REVIEW_SIGNALS = [
  ['a refusal', /\b[A-Z][A-Z0-9_]*_(?:REFUSALS?|REFUSED)\b|\brefuse\w*\s*\(|\bBlocked:|\bNot allowed\b/],
  ['a confirmation', /\b(?:askUser|ask_user|requestConfirmation|input_required|inputRequired)\b|\bconfirm\s*\(/],
  ['a state the user has to see', /\bcontained\b|\bawaiting_approval\b|\bprivate_only\b/],
];
/** c): a new i18n key (`'<key>': { de: …`) whose name reads like a refusal, error, empty state or confirmation. */
export const UX_KEY_NAME = /refus|denied|error|empty|confirm|lock|contain|not_allowed|halt|forbidden/i;
/** An i18n entry line: `'<key>': { de: …`, `{ en: …`, or `{` that opens a multi-line entry. */
export const UX_NEW_TEXT = /^\s*(['"])([\w.-]+)\1\s*:\s*\{\s*(?:(?:de|en)\s*:|$)/;
/** Bundles that are JSON: compared as parsed key paths, since a leaf name repeats across parents. */
export const UX_JSON_BUNDLE = /(?:^|\/)i18n\/[^/]+\.json$/;
/** a) does not count these: an import, a re-export, a type. */
const UX_NOT_A_SITE = /^\s*(?:import\b|export\s*(?:\*|\{[^}]*\})\s*from\b|(?:export\s+)?(?:type|interface)\s)/;
const UX_COMMENT = /^\s*(?:\/\/|\*|\/\*|#|<!--)/;

/** b): a NEW file here is a page or a component the user walks through. */
export const UX_NEW_FLOW = [
  /^packages\/web-ui\/src\/routes\/(?:.*\/)?\+(?:page|layout|error)\.svelte$/,
  /^packages\/web-ui\/src\/lib\/components\/.+\.svelte$/,
];

/** Tests are never what a user reads. Fixture directories are NOT here: demo data is shown to users. */
const UX_NOT_SHOWN = [/\.(?:test|spec)\.[cm]?[jt]sx?$/, /^tests\//];

/** This script's own path, read at the merge base for the transition. */
export const UX_SELF_PATH = 'scripts/gate-record.mjs';
export const UX_LINE_MARK = 'export function ' + 'uxOwed(';

/**
 * What this diff owes on the `ux:` line. `read(sha, path)` returns the text, `null` when the path
 * does not exist at that commit, and throws when it cannot tell (as for `legalPartsOwed`).
 *
 * @returns {{ line: boolean, review: boolean, why: string[], predates?: boolean }}
 *   `line`: a `ux:` line is owed at all; `review`: only `reviewed U-NNN` will do, for `why`.
 */
export function uxOwed({ files, base, head, read }) {
  const code = files.filter((f) => !DOC_ONLY.some((p) => p.test(f)));
  if (code.length === 0) return { line: false, review: false, why: [] };
  const review = (why) => ({ line: true, review: true, why: [why] });
  if (!base) return review(`without \`--base\` nothing can tell what ${code[0]} adds`);
  if (!head) return review('no `--head` to read the changed files at');
  const text = (sha, path) => {
    try { return { value: read(sha, path) }; } catch (e) {
      return { error: `cannot read ${path} at ${sha.slice(0, 12)}: ${e instanceof Error ? e.message : String(e)}` };
    }
  };
  const self = text(base, UX_SELF_PATH);
  if (self.error) return review(self.error);
  if (self.value === null || !self.value.includes(UX_LINE_MARK)) return { line: false, review: false, why: [], predates: true };
  const why = [];
  for (const f of code) {
    if (UX_NOT_SHOWN.some((p) => p.test(f))) continue;
    if (isQuotedPath(f)) return review(`${f} is a name git printed quoted, so it could not be read`);
    const b = text(base, f);
    const h = text(head, f);
    for (const side of [b, h]) if (side.error) return review(side.error);
    // At neither end: the name is not one git has at these commits, so the file was never read.
    if (b.value === null && h.value === null) return review(`${f} exists at neither the merge base nor the head, so it could not be read`);
    if (b.value === null && UX_NEW_FLOW.some((p) => p.test(f))) { why.push(`${f} is a new page or component`); continue; }
    const count = new Map();
    for (const l of (h.value ?? '').split('\n')) count.set(l, (count.get(l) ?? 0) + 1);
    for (const l of (b.value ?? '').split('\n')) count.set(l, (count.get(l) ?? 0) - 1);
    const added = [...count].filter(([l, n]) => n > 0 && !UX_COMMENT.test(l)).map(([l]) => l);
    const sites = added.filter((l) => !UX_NOT_A_SITE.test(l));
    // A refusal NAME that only appears quoted (`'FOO_REFUSAL'`) is a registry entry, not a site.
    // Only for that signal: a quoted `'input_required'` or `'contained'` IS the state being set.
    const unquoted = (l) => l.replace(/(['"`])[A-Za-z_]\w*\1/g, "''");
    const hit = UX_REVIEW_SIGNALS.find(([kind, re]) => sites.some((l) => re.test(kind === 'a refusal' ? unquoted(l) : l)));
    if (hit) { why.push(`${f} adds ${hit[0]}`); continue; }
    // c) counts a KEY the merge base does not have; a new value under an old key is `self` —
    // except a confirmation: its wording is what the user agrees to (ux, 2026-10-26).
    let keys;
    if (UX_JSON_BUNDLE.test(f)) {
      try { keys = uxJsonKeyChanges(b.value, h.value); } catch (e) {
        return review(`cannot parse ${f}: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      // Is the key in the base as a KEY, in either quote — not merely as a substring somewhere.
      const inBase = (k) => new RegExp(`(['"])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1\\s*:`).test(b.value ?? '');
      const entries = added.map((l) => UX_NEW_TEXT.exec(l)).filter((m) => m !== null && UX_KEY_NAME.test(m[2]));
      // An entry over several lines changes in its `de:`/`en:` lines while its key line stays:
      // attribute every added line inside an open entry to that entry's key.
      const inside = new Set();
      let open = null;
      const left = new Map(count);
      for (const l of (h.value ?? '').split('\n')) {
        const m = UX_NEW_TEXT.exec(l);
        if (m !== null && /\{\s*$/.test(l)) { open = m[2]; continue; }
        if (open !== null && /^\s*\}/.test(l)) { open = null; continue; }
        if (open !== null && (left.get(l) ?? 0) > 0 && !UX_COMMENT.test(l)) { inside.add(open); left.set(l, left.get(l) - 1); }
      }
      keys = {
        added: entries.filter((m) => !inBase(m[2])).map((m) => m[2]),
        changed: [...entries.filter((m) => inBase(m[2])).map((m) => m[2]), ...[...inside].filter(inBase)],
      };
    }
    if (keys.added.some((k) => UX_KEY_NAME.test(k))) why.push(`${f} adds a user text that says what to do next`);
    else if (keys.changed.some((k) => /confirm/i.test(k))) why.push(`${f} changes what a confirmation asks the user to agree to`);
  }
  return { line: true, review: why.length > 0, why };
}

/**
 * Key paths of a JSON bundle that are new at the head, and those whose value changed. `null` text
 * is an absent file (no keys). Throws on JSON it cannot parse — the caller owes a review then.
 */
export function uxJsonKeyChanges(baseText, headText) {
  const flat = (text) => {
    const out = new Map();
    const walk = (v, path) => {
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
      else out.set(path, JSON.stringify(v));
    };
    if (text !== null) walk(JSON.parse(text), '');
    return out;
  };
  const b = flat(baseText);
  const h = flat(headText);
  const added = [...h.keys()].filter((k) => !b.has(k));
  const changed = [...h.keys()].filter((k) => b.has(k) && b.get(k) !== h.get(k));
  return { added, changed };
}

/** Values that fill a slot without answering it. */
const UX_PLACEHOLDER = /^(?:<[^>]*>|none|n\/?a|not applicable|tbd|todo|-+|\?+|yes|no|nope|ok|lgtm|skip(?:ped)?|[.…\s]+)\.*$/i;
/** `reviewed U-NNN`: the ux lane's decision number. Tightening or widening the form is this line. */
export const UX_REVIEWED = /^reviewed[ \u00a0]U-\d{3,}$/;
/** A public record names no private place, in a reason or a way out. */
const UX_PRIVATE_PLACE = /docs\/internal|lynox-plans|(?<![\w.-])lynox-pro\b|(?<![\w-])pro\/(?:docs|packages|scripts)\b|~\/(?!\.lynox\/)|(?<!\.[a-z]{2,24})\/home\/|(?<!\.[a-z]{2,24})\/Users\//i;
const UX_SEP = /^(?:—|–|-{1,2}|:|because\b)\s*(.*)$/i;

/**
 * What is wrong with the record's `ux:` line, as messages. Pure.
 *
 * @param {string|undefined} raw  the field value, `undefined` when the line is absent
 * @param {{ line: boolean, review: boolean, why: string[] }} ux
 * @param {'public'|'private'|'unknown'} visibility
 */
export function uxErrors(raw, ux, visibility) {
  const why = ux.why.slice(0, 3).join('; ') + (ux.why.length > 3 ? `; and ${ux.why.length - 3} more` : '');
  const reviewOwed = () => [
    `this diff owes a ux REVIEW (${why}): write \`ux: reviewed U-<number>\` with the number the ux lane gives it.`,
    'Only a review answers this; if it is owed wrongly, the ux lane says so in the review.',
  ];
  if (raw === undefined) {
    if (!ux.line) return [];
    if (ux.review) return reviewOwed();
    return ['this diff changes code, so the record needs a `ux:` line: `ux: reviewed U-<number>`, '
      + '`ux: self — way out: <what the user can still do>`, or `ux: not user-facing — <reason>`.'];
  }
  const value = raw.trim();
  if (visibility !== 'private' && UX_PRIVATE_PLACE.test(value)) {
    return ['`ux:` names a private place, and this record is PUBLIC. Say it in words, or give the review number.'];
  }
  if (UX_REVIEWED.test(value)) return [];
  if (ux.review) return [`\`ux: ${value}\` does not answer it.`, ...reviewOwed()];
  // Any spelling of "not user-facing" is that answer, and owes its reason.
  const nuf = /^not[\s-]+user[\s-]*facing(?![\w-])\s*(.*)$/i.exec(value);
  if (nuf) {
    const reason = UX_SEP.exec(nuf[1])?.[1]?.trim() ?? '';
    if (reason.length < 3 || UX_PLACEHOLDER.test(reason)) {
      return [`\`ux: ${value}\` names no reason — write \`ux: not user-facing — <why no user meets this>\``];
    }
    return [];
  }
  const own = /^self(?![\w-])\s*(.*)$/i.exec(value);
  if (own) {
    const out = /^(?:way\s+out|ausweg)\s*:\s*(.*)$/i.exec(UX_SEP.exec(own[1])?.[1]?.trim() ?? '')?.[1]?.trim() ?? '';
    if (out.length < 3 || UX_PLACEHOLDER.test(out)) {
      return [`\`ux: ${value}\` names no way out — write \`ux: self — way out: <what the user can still do>\`; if you cannot say it in one sentence, the change owes a review`];
    }
    return [];
  }
  return [`\`ux: ${value}\` is not an answer — write \`ux: reviewed U-<number>\`, \`ux: self — way out: <…>\` or \`ux: not user-facing — <reason>\``];
}

/**
 * The ONE place the `review:` format is written down for a human.
 *
 * ⚠ Four copies of it once existed — these two messages, the PR template's skeleton and the
 * template's field description — and three were wrong in the same way: the plural marker sat
 * OUTSIDE the angle brackets, so an author who substituted every slot correctly still produced
 * a line the grammar refuses. They agreed with each other, which is not the same as being
 * right. Both messages now read this constant and the template is held to it by a test.
 *
 * ⚠ This file deliberately contains NO example of the refused form, not even as history. A test
 * sweeps the template and this script for it, and a sweep with an exception is a sweep somebody
 * will widen. The story is told in `tests/gate-record.test.ts`, where prose describing a defect
 * belongs and where nothing copies from.
 *
 * The plural lives INSIDE a slot on purpose: the skeleton has to stay refused while
 * unsubstituted (an attestation must not be pre-answered) and be valid once filled.
 */
export const REVIEW_FORMAT = '<n> <model> <round|rounds>, <result>';

/**
 * roundResultErrors — the RESULT half of a round field, as a pure function.
 *
 * WHY IT IS ITS OWN FUNCTION. `review:` was the first field to demand what a round FOUND, and
 * the `security` gate is getting the same demand. The two differ in their HEAD —
 * `<n> <model> <round|rounds>` against an origin vocabulary — and agree completely on their TAIL:
 * `no findings`, or `<N> findings` followed by `all fixed` or counts that sum to N. Copying
 * that tail would produce two grammars that drift, and the copy nobody tests is the one that
 * drifts first. Naming it once means the mutants that witness it keep witnessing it for every
 * caller, instead of witnessing one caller's copy of it.
 *
 * `quoted` is what a message should cite — e.g. `review: 1 opus round, 2 findings` — so the
 * error names the field the author actually wrote rather than this function's idea of it.
 *
 * ⚠ PURE on purpose: strings in, messages out, nothing touched. That is what makes it testable
 * DIRECTLY instead of through a caller, and the difference is not cosmetic — a test that drives
 * it through `evaluate` witnesses one caller's WIRING, not the grammar. Both assertions are
 * worth having and they are not the same one, so the tests carry both.
 */
export function roundResultErrors(result, quoted) {
  // ⛔ Loud about a missing `quoted`, and that is the point of the check rather than a formality:
  // without it the three interpolating messages read `\`undefined\` — the result must read …`,
  // which is plausible enough to ship and names no field at all. The whole reason this function
  // takes the citation as an argument is that a SECOND caller is coming; the failure mode of
  // forgetting it is a message that looks right, so it has to be the failure mode that shouts.
  if (typeof quoted !== 'string' || quoted === '') {
    throw new TypeError('roundResultErrors needs `quoted`: the field text a message should cite.');
  }
  const errors = [];
  // ⭐ A form with NO count, because THIS repo is public: how many findings are still open is a
  // fact that lives in the private register row, not in a body anyone can read. Accepted
  // everywhere — it says less, and saying less is never the failure this record guards against —
  // but it is only REQUIRED where `repoVisibility` says the record becomes public.
  if (/^findings\s+filed\s+privately$/i.test(result)) {
    // Nothing to reconcile, and deliberately nothing to count.
  } else if (/^no\s+findings$/i.test(result)) {
    // Nothing to reconcile.
  } else if (/^0\s+findings\b/i.test(result)) {
    // One canonical spelling, or a synonym list grows and the field stops being checkable.
    errors.push('write `no findings` rather than `0 findings` — one spelling, so this stays checkable.');
  } else {
    const head = /^(\d+)\s+findings?\s*,\s*(.+)$/i.exec(result);
    if (!head) {
      errors.push(
        `\`${quoted}\` — the result must read \`no findings\` or \`<N> findings, <breakdown>\`,`,
        'where the breakdown is `all fixed` or counts that sum to N: `3 fixed`, `2 fixed, 1 filed`,',
        '`3 fixed, 1 filed, 1 refuted`. A finding is fixed here, filed as a row, or refuted on inspection.',
      );
    } else {
      const total = Number(head[1]);
      const breakdown = head[2].trim();
      // ⚠ No `total < 1` branch here, and that is measured rather than an oversight: the
      // `0 findings` check above matches `0 findings, …` too, so every N = 0 shape is already
      // answered with the one hint that is right for it ("write `no findings`"). A guard that
      // cannot fire is a reader's false confidence — and worse here, because it would look
      // like the arithmetic covered a case the spelling check already owns.
      if (/^all\s+fixed$/i.test(breakdown)) {
        // `all` needs no arithmetic; it means N.
      } else {
        // ⭐ The arithmetic is the point: a field that only has to LOOK right is a form, a
        // field whose numbers must add up is a claim somebody can be wrong about. Both
        // directions are errors — under-counting hides a finding nobody accounted for, and
        // over-counting means the same finding was counted twice.
        const KINDS = ['fixed', 'filed', 'refuted'];
        const parts = breakdown.split(',').map((x) => x.trim()).filter(Boolean);
        const seen = new Map();
        let bad = null;
        for (const part of parts) {
          const pm = /^(\d+)\s+([a-z]+)$/i.exec(part);
          if (!pm || !KINDS.includes(pm[2].toLowerCase())) { bad = part; break; }
          const kind = pm[2].toLowerCase();
          if (seen.has(kind)) { bad = part; break; }
          seen.set(kind, Number(pm[1]));
        }
        if (bad !== null) {
          errors.push(
            `\`${quoted}\` — \`${bad}\` is not \`<n> fixed|filed|refuted\`, or repeats a kind.`,
            'A finding is fixed in this diff, filed as a register row, or refuted on inspection.',
          );
        } else {
          const sum = [...seen.values()].reduce((a, b) => a + b, 0);
          if (sum !== total) {
            errors.push(
              `\`${quoted}\` does not add up — the breakdown sums to ${String(sum)}, not ${String(total)}.`,
              'Every finding is fixed here, filed as a register row, or refuted on inspection;',
              `${sum < total ? 'a missing one is a finding nobody accounted for' : 'an extra one means a finding was counted twice'}.`,
            );
          }
        }
      }
    }
  }
  return errors;
}

/**
 * The whole verdict, as data. Kept pure so the tests drive THIS rather than a
 * shell wrapper around it — a guard whose logic is only reachable through
 * `process.exit` is a guard nobody can characterise.
 */
/**
 * repoVisibility — is the repo this record gets PUBLISHED in public?
 *
 * WHY THIS EXISTS, and it is not a refinement of the fields: the `review:` and `security:`
 * evidence lines were designed in the PRIVATE repo, where `2 findings, 0 fixed, 2 filed` is a
 * useful, checkable sentence. **Nobody asked what that sentence means HERE.** This repo is
 * public, and the standing rule is that a security finding which is not yet closed must not be
 * named in public text — NOT EVEN ITS EXISTENCE. A `filed` count in a public body is that
 * existence,
 * stated in a number, and `gate-record` was the thing REQUIRING it. The grammar is innocent; the
 * SCOPE was the gap. The owner decided the number stays out of the public body and lives in the
 * private register row.
 *
 * ⚠ AND NO OTHER GUARD IN THIS REPO READS A PR BODY — measured, not assumed. `public-repo-guard.sh`
 * is here and does a lot: it scans the tracked TREE for internal infra, hostnames and
 * doubled-bracket cross-references, and COMMIT MESSAGES for third-party names. Its `check-meta`
 * header used to claim "plus the PR title/body when the caller exports them", which was a surface
 * it does not have: `PR_BODY=<a private register id> check-meta base HEAD` comes back clean, while
 * the same id in a commit subject is what gets scanned. (That header is corrected in this change.)
 * `public-text-check.mjs`, whose whole job is to keep an open finding — including its existence —
 * out of public text, lives only in the PRIVATE repo, i.e. the one place it is least needed. So
 * for the PR body in the public repo, this file is the only mechanism there is.
 *
 * ⚠ THE PROPERTY, NOT A PROXY. A repo NAME is a proxy — rename the repo and the guard is wrong
 * without a symptom. GitHub puts the property itself in the event payload
 * (`pull_request.base.repo.private`), so the workflow passes that: no network call, no rate
 * limit, no token, and the value comes from GitHub rather than from the author. Measured:
 * `lynox-ai/lynox` is `private=false`, `lynox-ai/lynox-pro` is `private=true`, and a real PR
 * payload carries `base.repo.private`.
 *
 * The slug is kept as a SECOND, independent source — not to decide, but to CONTRADICT. If the
 * two disagree, something is wrong in a way neither value can explain, and the answer is
 * `unknown`.
 *
 * ⚠ FAIL-CLOSED: `unknown` is treated as PUBLIC by the callers, because the failure directions
 * are not symmetric. Wrongly strict is a false red on a `filed` count; wrongly lax publishes the
 * existence of an open finding, and a merged PR body cannot be taken back by anyone but the repo owner
 * through the UI. ⛔ And the false red must SAY that the property was undeterminable — otherwise
 * the author looks for the mistake in their own body, and a false red without a diagnosis is
 * what teaches people to go around a check.
 */
export function repoVisibility({ privateFlag, repoSlug, explicit } = {}) {
  // ⚠ An explicit value that is neither word answers `unknown` rather than falling through to the
  // environment: `--repo-visibility pubic` is a typo, and silently using the env instead would make
  // the strictness depend on which mistake you made. Fail-closed includes the flag.
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    return explicit === 'public' || explicit === 'private' ? explicit : 'unknown';
  }
  const v = String(privateFlag ?? '').trim().toLowerCase();
  const fromProperty = v === 'true' ? 'private' : v === 'false' ? 'public' : null;
  const slug = String(repoSlug ?? '').trim().toLowerCase();
  const fromSlug = slug === 'lynox-ai/lynox' ? 'public'
    : slug === 'lynox-ai/lynox-pro' ? 'private'
      : null;
  if (fromProperty && fromSlug && fromProperty !== fromSlug) return 'unknown';
  return fromProperty ?? fromSlug ?? 'unknown';
}

/**
 * How many findings a text reports as still OPEN, summed over every mention: `<n> filed` (carried
 * into a register row), `<n> open`, `<n> left/remaining/still open`, `<n> deferred`.
 *
 * `fixed` is closed in this diff and `refuted` was no finding. `all fixed` is 0 by definition, and
 * `findings filed privately` carries no number at all, which is the whole point of that form.
 * Every match counts, not the first: `0 filed` early in a line must not hide a later count.
 */
export function openFiledCount(result) {
  // ⛔ `all fixed` and `findings filed privately` had an early `return 0` here, and it was DEAD
  // CODE: neither string can match `<digits> filed`, so removing the line changed no answer on any
  // input — a surviving mutant whose repair is to delete the redundancy rather than to write a
  // test that keeps the extra half alive. What the two forms need is this comment, not a branch.
  // ⛔ No `\b` after `filed`, deliberately, and the mutation round is the argument: nothing drove
  // the word boundary, and its two failure directions are not symmetric. WITH it, `2 filedx` is
  // not counted — fail-OPEN, the direction that publishes a number. WITHOUT it, a string like
  // `2 filedump` would be counted — a false red on text nobody writes. An unwitnessed element
  // whose removal is strictly the safer direction gets removed, not a test that preserves it.
  // The `i` flag and the `+` DO have witnesses: the result grammar accepts `1 Filed`, and a
  // two-digit count must read as itself rather than as its first digit.
  let n = 0;
  for (const m of String(result ?? '').matchAll(OPEN_COUNT)) n += Number(m[1]);
  return n;
}

/** `<n>[x] [findings] filed|open|deferred` and `<n> [findings] left|remaining|still open`. */
const OPEN_COUNT = /(\d+)x?\s+(?:findings?\s+)?(?:filed|open|offen|deferred|(?:left|remain(?:s|ing)?|still|stays?)\s+open)/gi;

/** The message a public record gets when it counts open findings. One place, two callers. */
function openCountRefusal(field, visibility) {
  const out = [
    // ⛔ The FIELD NAME, never the value. This message is printed in an Actions log, which on the
    // public repo anyone can read, and the value is the count being refused — echoing it back
    // would publish the number in the course of refusing it. The repo's own precedent is explicit:
    // public-repo-guard names a commit by its short SHA alone, "never by its subject line". The
    // author has their own body in front of them and needs the field, not a quotation.
    `the \`${field}:\` line counts OPEN findings, and this record goes into a PUBLIC repo.`,
    'A finding that is not yet closed — security or not — must not be named in public text, not even its',
    'existence, which is what that number states. It belongs in the private register row instead.',
    'Write `findings filed privately` (no count), or, if nothing is unresolved, `no findings` /',
    '`<N> findings, all fixed`.',
  ];
  if (visibility === 'unknown') {
    out.push(
      '⚠ AND THE REPO COULD NOT BE DETERMINED: no `pull_request.base.repo.private` in the event payload',
      'and no known repo slug, so this record is treated as PUBLIC — the strict case. If it is the',
      'private repo, the mistake is NOT in your body: pass `--repo-visibility private`, or set',
      '`REPO_PRIVATE` — the workflow fills it from that payload field.',
    );
  }
  return out;
}

// The prose scan lives in guard-patterns/ so the private repo can vendor the same file.
export { proseOpenCountLines };
export { LEGAL_APPROVERS, approvedVerdict };

/**
 * The refusal for a legal sign-off, by the verdict `approvedVerdict` gave. Fails closed: a verdict
 * this function does not know (a later version of the vendored reader may add one) refuses too.
 *
 * @param {string} verdict  what `approvedVerdict` returned
 * @param {string} approved the trimmed value of the `approved:` field
 * @param {boolean} owed    whether the diff owes the `legal` gate (else the record only names it)
 * @returns {string[]}
 */
export function signOffErrors(verdict, approved, owed) {
  const out = [];
  if (verdict === 'missing') {
    out.push(
      owed
        ? 'this diff changes a binding customer text, so the record needs an `approved:` line'
        : 'the record NAMES the `legal` gate, so it needs an `approved:` line — or take `legal` out of `gates:`',
      'naming who signed off on the WORDING and when (e.g. `approved: rafael 2026-08-01`).',
      '`approved: PENDING — <why>` is a valid answer and blocks the merge rather than failing',
      'the format: if the sign-off does not exist yet, saying so is the true line.',
      'Run `/legal-review` first — its findings are what the sign-off is given on.',
    );
  } else if (verdict === 'pending') {
    // An explicit "not yet" is the true answer while the wording is unseen, so it blocks the
    // merge, with a message that does not read as a format complaint.
    out.push(
      `\`approved: ${approved}\` says the sign-off is PENDING — which is the honest answer, so this`,
      'is NOT a format complaint. The merge waits for the sign-off, not for a better line.',
    );
  } else if (verdict === 'not-an-approver') {
    out.push(
      `\`approved: ${approved}\` does not start with who signed off. A sign-off reads`,
      `\`approved: <who> <YYYY-MM-DD> [anything]\`, where <who> is one of: ${LEGAL_APPROVERS.join(', ')}.`,
      'If the sign-off does not exist yet, write `approved: PENDING — <why>`.',
    );
  } else if (verdict === 'undated') {
    // A name without a date cannot be told apart from a sign-off carried over from an
    // earlier revision of the same text.
    out.push(`\`approved: ${approved}\` has no valid ISO date right after the name — a sign-off without one cannot be tied to this revision`);
  } else if (verdict !== 'ok') {
    out.push(`\`approved: ${approved}\` was read as \`${verdict}\`, which this check does not know — refused until it does`);
  }
  return out;
}

/**
 * Lines of a PR body that name a register row (`DEF-<slug>`). The register lives in the private
 * repo; in a public body its ids are no pointer anyone here can follow, only a disclosure, and an
 * id often spells the gap it tracks. The whole body is read, record and prose, code and quotes:
 * the raw body is public, rendered or not. Line numbers only: the refusal does not repeat the id.
 */
// Case-insensitive: a pasted row file name or a hand-typed id can arrive in lower case.
const REGISTER_ID = /(?<![A-Za-z0-9])DEF-[A-Za-z0-9]/i;
const REGISTER_ID_ALL = /(?<![A-Za-z0-9])DEF-[A-Za-z0-9][A-Za-z0-9-]*/gi;

/** A message with every register id in it replaced, so no refusal repeats one into a public log. */
export function withoutRegisterIds(text) {
  return String(text).replace(REGISTER_ID_ALL, 'DEF-…');
}

export function registerIdLines(body) {
  const out = [];
  String(body ?? '').split('\n').forEach((line, i) => {
    if (REGISTER_ID.test(line)) out.push(i + 1);
  });
  return out;
}

/**
 * Lines of the title, body and commit messages that use the wording
 * `disclosure-vocabulary-scan.mjs` warns about in code: a gap left open, work put off, a
 * pointer at where open work is tracked. A squash merge here takes the branch's commit
 * messages as its own, so they reach `main` as permanently as the title.
 *
 * A WARNING, never a refusal, for the reason that scan gives: wording only approximates
 * meaning, and a sentence about what a feature does on purpose is honest and stays.
 * It names the place by line number and never repeats the text: the log is public.
 */
export function openWorkWarnings({ title = '', body = '', commits = [] } = {}) {
  const out = [];
  const say = (where, hits) => {
    if (hits.length === 0) return;
    out.push(
      `${where} may say that work is left open or put off (line ${hits.map((h) => h.line).join(', ')}). ` +
      'In this public repo an open gap is described in the private register, not here; what a ' +
      'feature does on purpose can stay. A hint for whoever merges; it does not fail this check.',
    );
  };
  say('the TITLE', proseWarnings(title));
  say('the body', proseWarnings(body));
  for (const c of commits) say(`the message of commit ${c.sha}`, proseWarnings(c.message));
  return out;
}

/**
 * Commit messages from `git log --format='%h%x1f%B%x1e'`: one record per commit. A message
 * may itself contain the separator bytes, so a record counts only when what stands before
 * its `\x1f` is a hex SHA: the SHA is printed in the warning, and author text must not be.
 * A message that forges a record this way can split itself, and the forged tail is then
 * either dropped or attributed to the hex word it names — never printed.
 */
export function parseCommits(text) {
  return String(text ?? '')
    .split('\x1e')
    .filter((r) => r.includes('\x1f'))
    .map((r) => {
      const i = r.indexOf('\x1f');
      return { sha: r.slice(0, i).trim(), message: r.slice(i + 1) };
    })
    .filter((c) => /^[0-9a-f]{4,40}$/.test(c.sha));
}

export function evaluate(input) {
  const verdict = evaluateRecord(input);
  const { body, title, commits = [], author, visibility = 'unknown' } = input;
  // Same scope as the field rule: public or unknown, never a bot's body.
  if (visibility === 'private' || (author && /\[bot\]$/.test(author))) return verdict;
  const warnings = openWorkWarnings({ title, body, commits });
  const extra = [];
  if (registerIdLines(title).length > 0) {
    extra.push('the TITLE names a register row, and the title becomes the commit subject on the public main branch. Take it out.');
  }
  const idLines = registerIdLines(body);
  if (idLines.length > 0) {
    extra.push(
      `the body names a register row (line ${idLines.join(', ')}), and this body goes into a PUBLIC repo.`,
      'The register is private: here an id points nowhere and can spell out the gap it tracks.',
      'Take it out of the body. The row is closed by a PR in the private',
      'repo that names this PR\'s merge commit; in this repo `closes:` is `none`.',
    );
  }
  const lines = proseOpenCountLines(body);
  if (lines.length > 0) {
    extra.push(
      `the body counts OPEN findings (paragraph at line ${lines.join(', ')}), and this body goes into a PUBLIC repo.`,
      'A finding that is not yet closed must not be named in public text, not even its existence, which is what',
      'a count states. Write `findings filed privately` without a number, or `<N> findings, all fixed`.',
    );
  }
  // Messages of the record checks quote field values (`review:`, `delta:`, `gates:`, `head:`, a
  // stray line); one of them may carry an id. Masked here, once, for every error. The notes that
  // reach this point are fixed sentences (the docs-only ones); the bot note, which quotes the
  // author's login, returned above. Nothing in them to mask.
  const masked = {
    ...verdict,
    ...(verdict.errors ? { errors: verdict.errors.map(withoutRegisterIds) } : {}),
  };
  if (extra.length === 0) return { ...masked, ...(warnings.length ? { warnings } : {}) };
  return {
    ...masked,
    ...(warnings.length ? { warnings } : {}),
    ok: false,
    errors: [
      ...(masked.errors ?? []),
      ...extra,
      ...(visibility === 'unknown'
        ? ['⚠ The repo could not be determined, so it is treated as PUBLIC. For the private repo pass `--repo-visibility private`.']
        : []),
    ],
  };
}

function evaluateRecord({ body, head, files, author, visibility = 'unknown', ux = null }) {
  const errors = [];
  const notes = [];

  if (author && /\[bot\]$/.test(author)) {
    return { ok: true, notes: [`author ${author} is a bot — dependency PRs merge through their own workflow`] };
  }

  let required = requiredGates(files);
  if (required === 'empty') {
    return {
      ok: false,
      errors: ['no changed files were reported — refusing to pass on a diff this check could not see'],
    };
  }

  const rec = extractRecord(body ?? '');

  // ── docs-only: nothing is OWED, which is not the same as nothing being READ ──
  //
  // This used to `return { ok: true }` right here, BEFORE `extractRecord` — so on a
  // documentation diff the check reported success without reading the block at all.
  // Two questions had been collapsed into one: "which gates does this diff owe?" and
  // "is the record the author wrote well-formed?". Only the first depends on what the
  // diff touches.
  //
  // Why that was expensive, in the words this file already uses about `'empty'`: the
  // output could not tell "checked and clean" from "never looked". Both printed the
  // same tick. Measured 2026-09-02: a session judged three docs-only PRs by their
  // `gate-record` block and, on one, re-pinned `head:` after an `update-branch` and
  // read the green check as confirmation. It had never been read.
  //
  // And it does not stay quiet. A malformed record on a docs PR is INVISIBLE until
  // someone adds one source file to the same branch — then every field is read at
  // once, on a record that has been "passing" for weeks. Live instance at the time of
  // writing: pro#685 wrote `gates:` as a bullet list, so the two gate attestations
  // under it are read by nothing at all.
  //
  // The fix is an EMPTY requirement set, not a demand for gates a docs diff does not
  // owe: `for (const g of required)` iterates nothing and `required.has('delta')` is
  // false, while the head pin, the gate NAMES, and the shape of every field that IS
  // written are held to exactly what they will be held to the day a source file joins
  // the branch.
  //
  // Two things stay exempt, and both are measured rather than assumed:
  //   1. A docs PR with NO record still passes. Of the 5 open docs-only PRs across
  //      both repos, 4 carry no block; demanding one would turn a fix for a silent
  //      check into a wave of red on work that never claimed anything.
  //   2. `closes:` is not demanded here. `docsOnlyRecord` carries that, and the
  //      exemption is older than this change — a test asserts it directly ("does not
  //      demand it where no record is demanded at all"), and it was deliberately
  //      strengthened to use a record that IS present with `closes:` absent, i.e. it
  //      argues for exactly this case rather than passing by accident.
  //
  // The residue, stated rather than glossed: a docs PR whose record omits `closes:`
  // still turns red the day a source file lands. That path is narrower than it was —
  // it can no longer carry a false CLAIM, only a missing field — but it is not zero.
  const docsOnlyRecord = required === null;
  if (docsOnlyRecord) {
    if (rec === null) {
      return { ok: true, notes: ['diff touches documentation only — no gate record required'] };
    }
    required = new Set();
    notes.push('diff touches documentation only — no gates required; the record is still read');
  }

  if (rec === null) {
    return {
      ok: false,
      errors: [
        'no gate record in the PR body.',
        `Add a \`\`\`${MARK} block naming the head SHA it was taken at, the gates that ran,`,
        'the delta-round verdict, and the mutation count — and `ux:` on any code change.',
        'See .github/pull_request_template.md.',
        'A round is CLEAN when nothing it found is left unhandled — fixed here, or filed as a',
        'register row. Findings do not make a round unclean; carrying them silently does.',
        'In this public repo `closes:` is `none`; a row is closed in the private repo.',
      ],
    };
  }
  if (rec.error) return { ok: false, errors: [rec.error] };

  const f = rec.fields;

  // The load-bearing check. Nearly everything else here is an attestation; this one is
  // a fact CI can establish on its own, and it is the failure that actually
  // recurs — gates run, then more commits land.
  // Compared case-insensitively: a SHA pasted from a tool that upper-cases it is
  // the same commit, and a false red here is how a guard earns a bypass.
  const pinned = (f.head ?? '').toLowerCase();
  if (!pinned) {
    errors.push('record has no `head:` — without it nothing ties the gates to this code');
  } else if (!/^[0-9a-f]+$/.test(pinned)) {
    // Catches the template placeholder and anything else that is not a SHA,
    // separately from a real-but-stale one. Same red, different instruction.
    errors.push(`\`head: ${f.head}\` is not a commit SHA — fill it in with \`git rev-parse --short HEAD\``);
  } else if (pinned.length < 7) {
    errors.push(`\`head: ${f.head}\` is too short to name one commit — use at least 7 characters`);
  } else if (!head.toLowerCase().startsWith(pinned)) {
    errors.push(
      `record pins head \`${f.head}\`, but this PR's head is \`${head.slice(0, 12)}\`. ` +
      'Commits landed after the gates ran: re-run them and update the record.',
    );
  }

  const claimed = new Set((f.gates ?? '').split(',').map((g) => g.trim()).filter(Boolean));
  for (const g of claimed) {
    if (!KNOWN_GATES.has(g)) errors.push(`unknown gate \`${g}\` — known: ${[...KNOWN_GATES].join(', ')}`);
  }
  for (const g of required) {
    if (!claimed.has(g)) errors.push(`this diff requires the \`${g}\` gate; the record does not list it`);
  }

  // ── closes: which register rows this PR settles ─────────────────────────────
  //
  // MANDATORY, with `none` as a valid answer. That combination is the whole
  // point and it is not pedantry: an OPTIONAL field is absent both when a PR
  // closes nothing and when its author was in a hurry, so absence says nothing
  // and a query over it cannot be trusted. Required-with-`none` turns "this
  // closes no row" into a statement someone made, and costs that author four
  // characters.
  //
  // Measured reason it exists: on 2026-08-24 two register rows still read
  // `open` four days after their fix merged, and the week's cut ranked finished
  // work above unfinished. The detector our own notes recommend for that —
  // `git log --grep "<id>"` — was measured at recall 0/2, because neither
  // fix commit named its row. Nothing required it to. This is that requirement;
  // the query is exact once the datum exists.
  //
  // SHAPE only, never existence — and NOTHING else checks existence either, in
  // either repo. `deferred-id-guard` reads REGISTER.md for duplicate ids; it
  // never sees a PR body, and core has no such script at all. So a `closes:`
  // naming a row that does not exist passes, and that is a stated gap rather
  // than a division of labour (an earlier version of this comment claimed the
  // latter, which was a control that did not exist).
  //
  // Existence is not checkable HERE for a real reason: the register lives in the
  // pro repo, so a core PR cannot reach it, and a rule that passes in one repo
  // and fails in the other teaches people to leave the field out.
  //
  // In this PUBLIC repo the field takes only `none` (2026-10-15). A row named here
  // is no pointer anyone can follow, and its id can spell out the gap it tracks.
  // The `git log --grep <id>` purpose moves to the private repo, where the PR that
  // closes the row names this PR's merge commit. The id shape below still runs for
  // a private-visibility run (`--repo-visibility private`).
  const closes = f.closes;
  if (closes === undefined) {
    // Nested rather than `&& !docsOnlyRecord` on the `if`: that form skipped the
    // error and then fell into the `else if`, which dereferences `closes`. The
    // existing test caught the crash on the first run.
    if (!docsOnlyRecord) errors.push(
      (visibility === 'private'
        ? '`closes:` is missing — name the register rows this PR settles, or `closes: none`. '
        : '`closes:` is missing — write `closes: none`; in this public repo the field takes nothing else. ') +
      'It is required WITH `none` allowed on purpose: an optional field is absent both when ' +
      'nothing is closed and when someone forgot, and then nobody can tell those apart.',
    );
  } else if (closes.toLowerCase() !== 'none') {
    // Case-insensitive, for the same reason `head:` is: `None` is what a person
    // types, and a false red on a legitimate PR is how a guard earns a bypass.
    const ids = closes.split(/[,·]/).map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) {
      errors.push('`closes:` is empty — write `closes: none` if this PR settles no register row');
    } else if (visibility !== 'private') {
      // In a public repo the field takes only `none`. A core PR cannot settle a row it cannot see:
      // the register is private, and a named row is a public disclosure of it. The row is closed by
      // a private PR that names this PR's merge commit, so `git log --grep <id>` stays exact where
      // the register lives. The value is not echoed (see `withoutRegisterIds`).
      errors.push(
        '`closes:` names something other than `none`. In this PUBLIC repo it takes only `none`: the register',
        'is private, so a row named here is a disclosure, not a pointer. Close the row in a private-repo PR',
        'that names this PR\'s merge commit.',
      );
    }
    for (const id of visibility === 'private' ? ids : []) {
      // `[A-Za-z0-9-]`, not `[a-z0-9-]`. The lower-case-only class
      // refused a row that EXISTS — a false red on a correct answer, which this
      // file elsewhere calls the way a guard earns a bypass. Found in pro, where
      // the same class ALSO made the heading scan mint a phantom id; core has no
      // heading scan (the register is not in this repo, see below), so only the
      // shape half applies here.
      if (!/^DEF-[A-Za-z0-9-]+$/.test(id)) {
        errors.push(`\`closes: ${id}\` is not a register id — use \`DEF-<slug>\`, a comma-separated list, or \`none\``);
      }
    }
  }

  // `delta` and `mutations` describe a CODE round, so they are demanded only when one
  // was owed. A markdown-only legal change has neither, and forcing those fields would
  // buy a fabricated line — a record filled in to get past CI is worth less than none.
  //
  // ⚠ THE DUPLICATION WITH PRO IS DELIBERATE, and the same reasoning as the test-temp-root
  // helper: the two repos are decoupled by design, each ships its own `gate-record.mjs`, and a
  // CI record check is not a wire contract — so it does not belong in the vendored `contract/`
  // either. Two copies beat a dependency that exists to share one branch. They may diverge, and
  // nothing breaks if they do: each governs its own repo's records. pro's copy landed first
  // (pro#1406); this is the same field with the same accepted shapes, so a record written for one
  // repo is valid in the other. (The prose scan is the opposite case: a weaker copy lets public
  // text through, so it has ONE source in guard-patterns/, for pro to vendor.)
  //
  // ⛔ WHY THIS FIELD EXISTS, and it is a measured reason rather than a tidiness one.
  //
  // `gates:` is a list of names. The check verifies that the names are KNOWN and that the ones this
  // diff owes are present — nothing more, and nothing more is possible from a body. On 2026-10-02 a
  // PR listed `code-review` with no round behind it, this check went green because the line was
  // there, and it merged. The review was then run late and found FIVE things, four with code
  // effect: a wiring test satisfiable from outside its own subject, a teardown no test covered, two
  // opposite outcomes sharing one value, and a file in no typecheck project while the PR said
  // "typecheck clean". The attestation-without-a-round is therefore not a paperwork failure; it let
  // four defects through, counted.
  //
  // It CANNOT prove a round happened. What it does is make the omission impossible — the author has
  // to write down what the round found, which turns forgetting into a deliberate lie. Same shape as
  // `approved:` for binding texts, one step more general.
  //
  // ⛔ AND THE FORM HAD TO BE REBUILT ONCE, which is the part worth reading. The first cut accepted
  // `all fixed` or `<n> fixed, <n> filed` and nothing else. A refuter measured what that does:
  //   · a finding that the author CHECKED AND REJECTED (the refuter was wrong) has no slot, so the
  //     honest author must write `filed` for a register row that does not exist, or quietly lower N;
  //   · the first `review:` line anybody actually wrote — `2 findings, 2 fixed` on an open PR —
  //     was REFUSED, because `all fixed` was the only accepted way to say "all of them".
  // A mandatory format that cannot express a legitimate state forces a lie, and the first cut
  // forced two. So the result is now a BREAKDOWN whose parts must sum to N, with a `refuted` slot,
  // and `<N> fixed` for all of them needs no special word.
  //
  // ⚠ Case-insensitive and a trailing full stop allowed, deliberately, like `head:` and
  // `closes: none` — a false red here is how a guard earns a bypass. The model slot is NOT an
  // allowlist (it would date) but must START WITH A LETTER and have at least two characters, so
  // neither `1 x round` nor `1 ... round` passes as evidence.
  //
  // ⚠ Two characters, not three, and the floor was MEASURED rather than chosen: three refused `o3`
  // and `r1`, which are real model names, and a gate that refuses a true answer earns a bypass. The
  // two halves also do different work — punctuation satisfied the old class (`...` passed AS the
  // model name), while a single letter still says nothing — so each half owes its own witness.
  //
  // Which witness carries which half, because getting this backwards is easy: `1 x round` is the
  // LENGTH witness — `[a-z]` ACCEPTS `x`, and only the floor refuses it — and `1 ... round` is the
  // LETTER witness, because three dots clear the floor. What `1 x round` cannot witness is the SIZE
  // of the floor: `{2,}` and `{1,}` both refuse a bare `x`, which is exactly why the mutant that
  // lowered it survived, and why the ACCEPTING side needs its own assertion (`1 o3 round`).
  //
  // Not demanded for the other gates: `delta` carries its verdict in `delta:`, `legal` in
  // `approved:`. ⚠ `security` has NO evidence line and wants the same treatment — left out so this
  // is one gate, one field, fully tested, and filed as a register row.
  if (required.has('code-review')) {
    const raw = (f.review ?? '').trim().replace(/\.$/, '');
    if (!raw) {
      errors.push(
        'this diff owes the `code-review` gate, so the record needs a `review:` line saying what the round FOUND.',
        `Format: \`review: ${REVIEW_FORMAT}\` — e.g. \`review: 1 opus round, no findings\`,`,
        '`review: 1 opus round, 5 findings, all fixed`, or `review: 1 opus round, 5 findings, 3 fixed, 1 filed, 1 refuted`.',
        'The model is the one that RAN the round (your own, if you reviewed it yourself).',
      );
    } else {
      const m = /^(\d+)\s+([a-z][a-z0-9.+-]{1,})\s+rounds?\s*,\s*(.+)$/i.exec(raw);
      if (!m) {
        errors.push(
          `\`review: ${raw}\` is not \`${REVIEW_FORMAT}\` — e.g. \`review: 1 opus round, no findings\`.`,
          'The model slot takes a short HANDLE: a letter, then at least one more character from',
          '`[a-z0-9.+-]` — so neither `1 x round` nor `1 ... round` passes as evidence. Two characters,',
          'not three, because a floor of three refused `o3` and `r1`.',
          'Write the handle, not a provider id: `gpt_4o`, `deepseek/r1` and `llama3:8b` are refused',
          'because `_`, `/` and `:` are outside the class, and a space cannot occur at all — the',
          'format reads the slot as ONE token.',
        );
      } else if (Number(m[1]) < 1) {
        errors.push(`\`review: ${raw}\` claims ${m[1]} rounds — a gate with no round is the omission this field exists for.`);
      } else {
        const result = m[3].trim();
        errors.push(...roundResultErrors(result, `review: ${raw}`));
      }
    }
  }

  // ⭐ `security:` — what the security round ASKED, by naming where it came from.
  //
  // WHY IT IS THE ORIGIN AND NOT THE QUESTION. `review:` carries round count, model and result,
  // all of them enumerable. The obvious shape for this field was "name the question the round
  // asked" — and the question is free text, which is exactly what was measured as uncheckable
  // when `review:` was built (three patterns too narrow, one of them against this file's own PR
  // body). A mandatory free-text field at the scale this gate runs becomes a phrase nobody reads.
  //
  // MEASURED, because the scale is the argument: `security` appears in the `gates:` line of
  // 90 of 202 merged PRs with a gate record (17 of 55 in pro, 73 of 147 in core, over the last
  // 150 merged PRs per repo). A second count over a wider set found 127 of 281 — different sets,
  // and the QUOTE is what survives both: 44.6 % against 45.2 %, so roughly every second PR with
  // a record owes this gate. A field that is wrong for one PR in two is not a field.
  //
  // ⚠ What this buys is not a true line — it will often be wrong. It is a FALSIFIABLE one.
  // `gates: security` without a line is an assumption nobody can contradict; `security: own round`
  // is a claim a refuter can take apart. The one instance on record surfaced exactly that way: a
  // track carried `security` on the strength of a PARITY run, whose brief was "does v2 behave like
  // v1", which is behavioural equality and not "what is new or loosened". It was caught by a
  // question, not by a measurement — and `leaning on …` is that question, built in.
  //
  // ⭐⭐ THREE values, and the third is the one that makes the other two honest.
  // `own round` and `leaning on <what>` cover two states. The third exists too: the session does
  // not KNOW whether the round was its own. ⚠ An earlier draft of this comment called it "the most
  // common", which is UNMEASURED — one instance is on record (the parity run of 2026-10-02), and a
  // frequency claim in a paragraph that argues from measurement is the thing this file keeps
  // catching elsewhere. What is established is that the state OCCURS and produced a wrong record.
  // That is how the recorded instance arose — not by deception, but because nobody had asked.
  // A closed vocabulary of two
  // forces that session to write `own round`, i.e. to lie, and this field exists to stop exactly
  // that. So `origin unclear` is a FULL value, not an escape hatch: when an instrument cannot
  // tell two cases apart, the repair is to SAY so, not to guess better.
  //
  // The result half is `roundResultErrors`, the same grammar `review:` uses — one grammar, two
  // callers, and the mutants that witness it witness it for both.
  //
  // ⚠ `leaning on <what>` takes no comma, because the comma is what separates origin from result.
  // That is a real limit and the message says it rather than letting the parse go wrong quietly.
  //
  // ⭐ `[^,]*?` and not `[^,]+?`, which looks like a loosening and is the opposite: with `+?` the
  // reference `leaning on , x` fails the SHAPE and gets the generic "is not `<origin>, <result>`"
  // message, while `leaning on  , x` (two spaces) reaches the empty-reference check and gets the
  // precise one. Same defect, two diagnoses, decided by a space the author cannot see. With `*?`
  // the shape accepts the empty reference and the content check refuses it — one defect, one
  // message. Measured both ways; the refusal is identical, only the diagnosis differs, and a
  // diagnosis that depends on invisible whitespace is the kind a reader cannot act on.
  //
  // ⭐ And the `[^,]` in that pattern is an ANCHOR AGAINST A LATER EDIT, not a second check on the
  // input — measured, because it looks like a duplicate of what `+?` already does. Over eight
  // reference shapes, `[^,]+?` and `.+?` produce identical origin/result splits: lazy matching
  // stops at the first comma either way, so removing the class ALONE changes nothing and that
  // mutant is equivalent. ⚠ Equivalent FOR THIS FIELD, not for the regex: `.` does not match `\r`
  // or a newline and `[^,]` does, so the two patterns differ on a value containing one. That value
  // cannot reach here — the record parser refuses a line that is not `field: value` before this
  // code runs — which is why the equivalence holds where it is claimed and nowhere wider. What the class defends against is the quantifier losing its `?`:
  // `.+` greedy reads `leaning on a, b, no findings` as origin `leaning on a, b` and result
  // `no findings`, which PASSES — silently, because that result is valid. `[^,]+` greedy still
  // stops at the comma. So the class and the laziness guard one door from two sides, and only
  // removing BOTH opens it; that combination is a mutant the tests kill.
  if (required.has('security')) {
    const raw = (f.security ?? '').trim().replace(/\.$/, '');
    if (!raw) {
      errors.push(
        'this diff owes the `security` gate, so the record needs a `security:` line saying WHERE the',
        'round came from and what it found. Format: `security: <origin>, <result>`, where origin is',
        '`own round`, `leaning on <what>`, or `origin unclear` — e.g. `security: own round, no findings`,',
        '`security: leaning on the parity run, no findings`, `security: origin unclear, findings filed privately`.',
        '⚠ `origin unclear` is a FULL answer, not an admission: if you cannot tell whether the round was',
        'its own, saying so is the true line, and writing `own round` instead is the lie this field exists for.',
        '⚠ And THIS REPO IS PUBLIC, so the result half carries no count of open findings: write',
        '`findings filed privately`, and the number lives in the private register row.',
      );
    } else {
      const m = /^(own\s+round|origin\s+unclear|leaning\s+on\s+[^,]*?)\s*,\s*(.+)$/i.exec(raw);
      if (!m) {
        errors.push(
          `\`security: ${raw}\` is not \`<origin>, <result>\`.`,
          'The origin is one of three: `own round` · `leaning on <what>` · `origin unclear`.',
          '⚠ A `leaning on <what>` reference carries NO comma — the comma separates origin from result,',
          'so write `leaning on the v1/v2 parity run, no findings` and keep the reference in one piece.',
        );
      } else if (/^leaning/i.test(m[1]) && !/[\p{L}\p{N}]/u.test(m[1].replace(/^leaning\s+on/i, ''))) {
        // ⛔ A reference made of whitespace or punctuation passes the shape and says nothing.
        // `leaning on  , no findings` and `leaning on -, no findings` were ACCEPTED — measured —
        // and the whole point of this origin is that it names something a reader can go and check.
        // An empty reference is the one answer that is neither true nor false, which is exactly
        // what `origin unclear` exists for: it is the honest form of "I cannot name it".
        errors.push(
          `\`security: ${raw}\` leans on nothing — the reference has no letters or digits.`,
          'Name what the round was: `leaning on the v1/v2 parity run`. If you cannot name it,',
          '`origin unclear` is the honest answer and carries no penalty.',
        );
      } else {
        const resultErrors = roundResultErrors(m[2].trim(), `security: ${raw}`);
        errors.push(...resultErrors);
        // ⚠ The diagnosis would otherwise point at the wrong end. `leaning on a, b, no findings`
        // parses as origin `leaning on a` and result `b, no findings`, so the grammar refuses the
        // RESULT and the author reads "the result must read `no findings` or …" while the actual
        // cause is a comma inside the reference. A message that is technically true and points
        // somewhere else costs more than no message: it sends the reader to the wrong half.
        if (resultErrors.length > 0 && /^leaning/i.test(m[1])) {
          errors.push(
            '⚠ If your `leaning on …` reference contains a COMMA, that comma was read as the',
            'separator and everything after it as the result — write the reference without one.',
          );
        }
      }
    }
  }

  if (required.has('delta')) {
    // A delta round that did not come back clean is a reason not to merge, so
    // there is exactly one accepted value.
    //
    // WHAT `clean` MEANS, because the one-line version got read as "no round ever
    // found anything" — and that reading makes the gate UNSATISFIABLE for exactly
    // the PRs reviewed hardest: a PR whose review found something could never
    // attest, and the `head:` check above would be pointless. Two parts:
    //   1. nothing the round found is left unhandled — fixed in this diff, or filed
    //      as a register row. NOT via `closes:`, which names rows this PR SETTLES;
    //      a freshly filed row is open, and putting it there corrupts the very
    //      datum that field exists to make queryable.
    //   2. it ran at the head `head:` names. No exception, and that is deliberate.
    //
    // Deliberate because every fix produces a new head, so this is strict: fix,
    // re-run, attest. It terminates the ordinary way — when a round finds nothing.
    //
    // An escape hatch for "the delta since only deleted something harmless" was
    // drafted and CUT: review found a defect in every draft of it. Do not re-draft
    // it here.
    //
    // NOT a second accepted value either: someone merging while attesting an unclean
    // round is the failure this field exists for. The restriction was never the
    // problem — its description was.
    if (f.delta !== 'clean') {
      errors.push(
        `\`delta:\` must be \`clean\` (got \`${f.delta ?? '<missing>'}\`) — an unclean delta round is not a merge.`,
        'Clean does NOT mean the round found nothing. It means nothing it found is left',
        'unhandled — fixed here, or filed as a register row (not listed in `closes:`, which',
        'names rows this PR settles) — and that it ran at the head `head:` names.',
        'Findings are normal; carrying them silently is not.',
      );
    }

    const mut = /^\s*(\d+)\s+killed\s*[,/]\s*(\d+)\s+survived\s*$/.exec(f.mutations ?? '');
    if (!mut) {
      errors.push('`mutations:` must read `<n> killed, <n> survived`');
    } else if (Number(mut[2]) > 0) {
      errors.push(`${mut[2]} surviving mutation(s) reported — a survivor means no test covers that line`);
    }
  }

  // A binding text does not ship on an assistant's judgement. `/legal-review` produces
  // flags, never advice, and its counsel-half is explicitly not self-authorable — so the
  // wording needs a human yes on the record before it reaches a customer.
  //
  // An attestation, like most lines here. It cannot prove the sign-off
  // happened; it makes FORGETTING impossible — the failure that actually recurs — and
  // turns the alternative into a deliberate lie rather than an oversight.
  // ⛔ THE PUBLIC RESTRICTION BELONGS TO THE FIELD, NOT TO THE BRANCH — and the first cut of this
  // got that wrong in two ways at once, both found by refuting it:
  //
  //   1. The `security:` branch runs only when the diff OWES the gate, so a record that merely
  //      NAMES it — or carries the line on a diff with no security path — was never read.
  //      Measured: a `2 filed` security line on a plain code diff came back GREEN. A rule hung on
  //      `required` is a rule about the DIFF; this one is about the TEXT.
  //   2. The count was read from the result half only, so the origin's free text carried it
  //      instead: `security: leaning on the 2 findings 2 filed round, no findings` was GREEN.
  //
  // Reading the WHOLE field value fixes both, and it is the honest scope: what must not become
  // public is the NUMBER anywhere in the line, not the number in one slot of it.
  //
  // EVERY field, not two: a field whose grammar does not run on this diff (`security:` on a
  // code-only diff, `review:` on a docs diff) accepts any wording, and so does an unknown field
  // (`open: 3`). And `review:` ALWAYS, not only where security is in play: an earlier cut exempted
  // a review count with no security gate named, reasoning that an open CODE defect counted in
  // public breaks no rule. The rule is wider: no open gap is named in public text, security or not.
  //
  // The record's PROSE is read by `proseOpenCountLines` (guard-patterns/prose-open-count.mjs), with a narrower pattern.
  // Bounded, not exact: a count in words ("two remain") passes.
  if (visibility !== 'private') {
    for (const [field, raw] of Object.entries(f)) {
      const value = String(raw ?? '').trim();
      if (!value) continue;
      if (openFiledCount(value) > 0) errors.push(...openCountRefusal(field, visibility));
    }
  }

  // A record that NAMES `legal` is read too, not only a diff that owes it: a sign-off the record
  // claims has to be one.
  if (claimed.has('legal') || required.has('legal')) {
    const approved = (f.approved ?? '').trim();
    errors.push(...signOffErrors(approvedVerdict(approved), approved, required.has('legal')));
  }

  // `ux` is judged in `main` (it reads files at two commits); `null` means nobody judged it, which
  // only a caller that is not `main` can produce — the CLI test holds `main` to passing it.
  const uxVerdict = ux ?? { line: false, review: false, why: [] };
  if (uxVerdict.predates) notes.push('ux: not owed — this branch\'s merge base predates the `ux:` line; rebasing onto main brings it under the rule');
  for (const w of uxVerdict.review ? uxVerdict.why : []) notes.push(`ux review owed: ${w}`);
  errors.push(...uxErrors(f.ux, uxVerdict, visibility));

return errors.length ? { ok: false, errors } : { ok: true, notes };
}

/** The PR body and title from a GitHub event payload file; empty strings where absent. */
export function readEventPr(path) {
  const pr = JSON.parse(readFileSync(path, 'utf-8'))?.pull_request ?? {};
  return { body: typeof pr.body === 'string' ? pr.body : '', title: typeof pr.title === 'string' ? pr.title : '' };
}

/**
 * A file at a commit, for `uxOwed`: its text, `null` when the commit has no such path, and a throw
 * when the commit itself cannot be read — a missing object must not read as "the file is absent",
 * which would turn a shallow clone into a pass. `cat-file`, never `diff`: no driver runs.
 */
function gitRead(sha, path) {
  const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  // `ls-tree` answers "is the path in this tree" with an empty listing and THROWS when it cannot
  // open the commit or the tree; `cat-file -e <sha>:<path>` fails for both, so its catch turned
  // an unreadable object into "absent". `--full-tree`: without it the path is taken relative to
  // the cwd, and a run from a subdirectory would find nothing anywhere. `--literal-pathspecs`: a
  // name starting with `:(` is a name, not pathspec magic.
  if (git('--literal-pathspecs', 'ls-tree', '--full-tree', `${sha}`, '--', path) === '') return null;
  return git('cat-file', 'blob', `${sha}:${path}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  // In CI the body and title come from the event payload FILE (`--event-file "$GITHUB_EVENT_PATH"`),
  // not from the step's `env`: Actions prints a step's env block, values included, into the log,
  // and this repo's logs are public. `--body-file` stays for a local preflight run.
  const event = args['event-file'] ? readEventPr(args['event-file']) : null;
  const body = event ? event.body : args['body-file'] ? readFileSync(args['body-file'], 'utf-8') : '';
  const title = event ? event.title : args['title-file'] ? readFileSync(args['title-file'], 'utf-8') : '';
  const commits = args['commits-file'] ? parseCommits(readFileSync(args['commits-file'], 'utf-8')) : [];
  const files = args['files-file']
    ? readFileSync(args['files-file'], 'utf-8').split('\n').map((s) => s.trim()).filter(Boolean)
    : [];
  // The visibility of the repo this record will be published in. The property comes from the
  // event payload via the workflow (`REPO_PRIVATE`), the slug from Actions' own env as a second,
  // independent source, and `--repo-visibility` is the local override for a preflight run — where
  // neither exists and the answer would otherwise be `unknown`, i.e. the strict case.
  const visibility = repoVisibility({
    privateFlag: process.env.REPO_PRIVATE,
    repoSlug: process.env.GITHUB_REPOSITORY,
    explicit: args['repo-visibility'],
  });
  const ux = uxOwed({ files, base: args.base || '', head: args.head || '', read: gitRead });
  const verdict = evaluate({ body, title, commits, head: args.head ?? '', files, author: args.author ?? '', visibility, ux });

  for (const n of verdict.notes ?? []) console.log(`${MARK}: ${n}`);
  for (const w of verdict.warnings ?? []) console.log(`::warning::${MARK}: ${w}`);
  if (verdict.ok) {
    console.log(`${MARK}: ok`);
    return;
  }
  for (const e of verdict.errors) console.log(`::error::${MARK}: ${e}`);
  process.exitCode = 1;
}

// Run only when invoked directly, so the tests can import `evaluate` without the
// CLI setting an exit code on them.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
