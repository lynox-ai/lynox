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
 *        --files-file <path> [--author <login>]
 *
 * Exits 0 when the record is acceptable (or the PR is exempt), 1 otherwise.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
export function requiredGates(files) {
  if (files.length === 0) return 'empty';
  // Legal texts are matched against the FULL file list, before the docs-only filter —
  // the subprocessor list is markdown and would otherwise be exempt as documentation.
  const legal = files.some((f) => LEGAL_PATHS.some((p) => p.test(f)));
  const code = files.filter((f) => !DOC_ONLY.some((p) => p.test(f)));
  if (code.length === 0 && !legal) return null; // docs-only: exempt
  const gates = new Set();
  if (code.length > 0) { gates.add('code-review'); gates.add('delta'); }
  if (code.some((f) => SECURITY_PATHS.some((p) => p.test(f)))) gates.add('security');
  if (legal) gates.add('legal');
  return gates;
}

/**
 * The whole verdict, as data. Kept pure so the tests drive THIS rather than a
 * shell wrapper around it — a guard whose logic is only reachable through
 * `process.exit` is a guard nobody can characterise.
 */
export function evaluate({ body, head, files, author }) {
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
        'the delta-round verdict, and the mutation count. See .github/pull_request_template.md.',
        'A round is CLEAN when nothing it found is left unhandled — fixed here, or filed as a',
        'register row. Findings do not make a round unclean; carrying them silently does.',
        'A filed row does NOT belong in `closes:` — that field names rows this PR settles.',
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
  const closes = f.closes;
  if (closes === undefined) {
    // Nested rather than `&& !docsOnlyRecord` on the `if`: that form skipped the
    // error and then fell into the `else if`, which dereferences `closes`. The
    // existing test caught the crash on the first run.
    if (!docsOnlyRecord) errors.push(
      '`closes:` is missing — name the register rows this PR settles, or `closes: none`. ' +
      'It is required WITH `none` allowed on purpose: an optional field is absent both when ' +
      'nothing is closed and when someone forgot, and then nobody can tell those apart.',
    );
  } else if (closes.toLowerCase() !== 'none') {
    // Case-insensitive, for the same reason `head:` is: `None` is what a person
    // types, and a false red on a legitimate PR is how a guard earns a bypass.
    const ids = closes.split(/[,·]/).map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) {
      errors.push('`closes:` is empty — write `closes: none` if this PR settles no register row');
    }
    for (const id of ids) {
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
  // repo is valid in the other.
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
  // model name), while a single letter still says nothing — so each half owes its own witness, and
  // `1 x round` cannot witness the length while `[a-z]` already refuses it.
  //
  // Not demanded for the other gates: `delta` carries its verdict in `delta:`, `legal` in
  // `approved:`. ⚠ `security` has NO evidence line and wants the same treatment — left out so this
  // is one gate, one field, fully tested, and filed as a register row.
  if (required.has('code-review')) {
    const raw = (f.review ?? '').trim().replace(/\.$/, '');
    if (!raw) {
      errors.push(
        'this diff owes the `code-review` gate, so the record needs a `review:` line saying what the round FOUND.',
        'Format: `review: <n> <model> round(s), <result>` — e.g. `review: 1 opus round, no findings`,',
        '`review: 1 opus round, 5 findings, all fixed`, or `review: 1 opus round, 5 findings, 3 fixed, 1 filed, 1 refuted`.',
        'The model is the one that RAN the round (your own, if you reviewed it yourself).',
      );
    } else {
      const m = /^(\d+)\s+([a-z][a-z0-9.+-]{1,})\s+rounds?\s*,\s*(.+)$/i.exec(raw);
      if (!m) {
        errors.push(
          `\`review: ${raw}\` is not \`<n> <model> round(s), <result>\` — e.g. \`review: 1 opus round, no findings\`.`,
          'The model name must START WITH A LETTER and have at least two characters, so neither `1 x',
          'round` nor `1 ... round` passes as evidence. ⚠ Two, not three: `o3` and `r1` are real model',
          'names, and a floor of three REFUSED them — measured against the names actually in use.',
        );
      } else if (Number(m[1]) < 1) {
        errors.push(`\`review: ${raw}\` claims ${m[1]} rounds — a gate with no round is the omission this field exists for.`);
      } else {
        const result = m[3].trim();
        if (/^no\s+findings$/i.test(result)) {
          // Nothing to reconcile.
        } else if (/^0\s+findings\b/i.test(result)) {
          // One canonical spelling, or a synonym list grows and the field stops being checkable.
          errors.push('write `no findings` rather than `0 findings` — one spelling, so this stays checkable.');
        } else {
          const head = /^(\d+)\s+findings?\s*,\s*(.+)$/i.exec(result);
          if (!head) {
            errors.push(
              `\`review: ${raw}\` — the result must read \`no findings\` or \`<N> findings, <breakdown>\`,`,
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
                  `\`review: ${raw}\` — \`${bad}\` is not \`<n> fixed|filed|refuted\`, or repeats a kind.`,
                  'A finding is fixed in this diff, filed as a register row, or refuted on inspection.',
                );
              } else {
                const sum = [...seen.values()].reduce((a, b) => a + b, 0);
                if (sum !== total) {
                  errors.push(
                    `\`review: ${raw}\` does not add up — the breakdown sums to ${String(sum)}, not ${String(total)}.`,
                    'Every finding is fixed here, filed as a register row, or refuted on inspection;',
                    `${sum < total ? 'a missing one is a finding nobody accounted for' : 'an extra one means a finding was counted twice'}.`,
                  );
                }
              }
            }
          }
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
  if (required.has('legal')) {
    const approved = (f.approved ?? '').trim();
    if (!approved) {
      errors.push(
        'this diff changes a binding customer text, so the record needs an `approved:` line',
        'naming who signed off on the WORDING and when (e.g. `approved: rafael 2026-08-01`).',
        'Run `/legal-review` first — its findings are what the sign-off is given on.',
      );
    } else if (!/\d{4}-\d{2}-\d{2}/.test(approved)) {
      errors.push(`\`approved: ${approved}\` has no ISO date — a sign-off without one cannot be tied to this revision`);
    }
  }

return errors.length ? { ok: false, errors } : { ok: true, notes };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const body = args['body-file'] ? readFileSync(args['body-file'], 'utf-8') : '';
  const files = args['files-file']
    ? readFileSync(args['files-file'], 'utf-8').split('\n').map((s) => s.trim()).filter(Boolean)
    : [];
  const verdict = evaluate({ body, head: args.head ?? '', files, author: args.author ?? '' });

  for (const n of verdict.notes ?? []) console.log(`${MARK}: ${n}`);
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
