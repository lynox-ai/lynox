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
 * Everything past SHA-freshness is an attestation and is documented as one.
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
 */
const SECURITY_PATHS = [
  /^src\/core\/data-boundary\.ts$/,
  /^src\/core\/output-guard\.ts$/,
  /^src\/core\/secret-store\.ts$/,
  /^src\/core\/migration-crypto\.ts$/,
  /^src\/core\/input-guard\.ts$/,
  /^src\/tools\/permission-guard\.ts$/,
  /^src\/tools\/builtin\//,
  /^src\/server\//,
  /^src\/integrations\/.*\/(auth|oauth)/,
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
  //   · `closes: DEF-a,` with the second id on a continuation line — the id was
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

  const required = requiredGates(files);
  if (required === 'empty') {
    return {
      ok: false,
      errors: ['no changed files were reported — refusing to pass on a diff this check could not see'],
    };
  }
  if (required === null) {
    return { ok: true, notes: ['diff touches documentation only'] };
  }

  const rec = extractRecord(body ?? '');
  if (rec === null) {
    return {
      ok: false,
      errors: [
        'no gate record in the PR body.',
        `Add a \`\`\`${MARK} block naming the head SHA it was taken at, the gates that ran,`,
        'the delta-round verdict, and the mutation count. See .github/pull_request_template.md.',
        'A round is CLEAN when nothing it found is left unhandled — fixed here, or filed as a',
        'register row. Findings do not make a round unclean; carrying them silently does.',
      ],
    };
  }
  if (rec.error) return { ok: false, errors: [rec.error] };

  const f = rec.fields;

  // The load-bearing check. Everything else here is an attestation; this one is
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
  // `git log --grep "<DEF-id>"` — was measured at recall 0/2, because neither
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
    errors.push(
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
      // `[A-Za-z0-9-]`, not `[a-z0-9-]`. The register really does contain
      // `DEF-dk-engineDb-init-partial-wire`, and the lower-case-only class
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

  // A delta round that did not come back clean is a reason not to merge, so
  // there is exactly one accepted value.
  //
  // WHAT `clean` MEANS, because the one-line version was read as "no round ever
  // found anything" and that reading makes the gate UNSATISFIABLE for exactly the
  // PRs that were reviewed hardest — a PR whose review found something could never
  // attest, and the `head:` field below would be pointless. Three parts:
  //   1. nothing the round found is left unhandled — fixed in this diff, or filed
  //      as a register row (that is what `closes:` is for; filing is the norm here);
  //   2. it ran at the head `head:` names — the load-bearing half, checked below;
  //   3. the delta since that round only REMOVES.
  // Part 3 is what makes this terminate rather than regress. Every fix produces a
  // new head, and a new head would demand a new round for ever. A deletion can be
  // taken by inspection — not because inspection is cheaper, but because there is
  // nothing added to check it AGAINST. Anything ADDED needs a fresh round, and
  // "added" includes code: a one-line guard change asserts no prose and still
  // changes behaviour. A rewording is an addition and a deletion at once, so it
  // falls on the round side — which is the incentive we want. Deleting is the way
  // out; rewording is not. (An earlier draft of this rule said "adds no new CLAIM",
  // which was reasoned from a prose case and would have waved every code fix
  // through on the grounds that it claims nothing.)
  //
  // NOT a second accepted value: someone merging while attesting an unclean round
  // is the failure this field exists for. The restriction was never the problem —
  // its description was.
  //
  // `delta` and `mutations` describe a CODE round, so they are demanded only when one
  // was owed. A markdown-only legal change has neither, and forcing those fields would
  // buy a fabricated line — a record filled in to get past CI is worth less than none.
  if (required.has('delta')) {
    if (f.delta !== 'clean') {
      errors.push(
        `\`delta:\` must be \`clean\` (got \`${f.delta ?? '<missing>'}\`) — an unclean delta round is not a merge.`,
        'A round is clean when nothing it found is left unhandled — fixed in this diff or filed',
        'as a register row — and when it ran at the head `head:` names.',
        'A round that found things is normal. What decides it is the delta since: if that only',
        'REMOVED, `clean` still holds; anything ADDED — text or code — needs a fresh round.',
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
  // An attestation, like every line here except `head:`. It cannot prove the sign-off
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
