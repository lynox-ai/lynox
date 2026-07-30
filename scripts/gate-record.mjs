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
const KNOWN_GATES = new Set(['code-review', 'security', 'delta', 'prd', 'staging-walk']);

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
  const fence = new RegExp('```' + mark + '\\s*\\n([\\s\\S]*?)```', 'g');
  const found = [...body.matchAll(fence)];
  if (found.length === 0) return null;
  if (found.length > 1) return { error: `found ${found.length} record blocks; a body may carry one` };

  const fields = {};
  for (const line of found[0][1].split('\n')) {
    const m = /^\s*([a-z-]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (m) fields[m[1]] = m[2];
  }
  return { fields };
}

/** Gates this diff requires, given the files it changes. */
export function requiredGates(files) {
  const code = files.filter((f) => !DOC_ONLY.some((p) => p.test(f)));
  if (code.length === 0) return null; // docs-only: exempt
  const gates = new Set(['code-review', 'delta']);
  if (code.some((f) => SECURITY_PATHS.some((p) => p.test(f)))) gates.add('security');
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
      ],
    };
  }
  if (rec.error) return { ok: false, errors: [rec.error] };

  const f = rec.fields;

  // The load-bearing check. Everything else here is an attestation; this one is
  // a fact CI can establish on its own, and it is the failure that actually
  // recurs — gates run, then more commits land.
  if (!f.head) {
    errors.push('record has no `head:` — without it nothing ties the gates to this code');
  } else if (!head.startsWith(f.head) || f.head.length < 7) {
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

  // A delta round that did not come back clean is a reason not to merge, so
  // there is exactly one accepted value.
  if (f.delta !== 'clean') {
    errors.push(`\`delta:\` must be \`clean\` (got \`${f.delta ?? '<missing>'}\`) — an unclean delta round is not a merge`);
  }

  const mut = /^\s*(\d+)\s+killed\s*[,/]\s*(\d+)\s+survived\s*$/.exec(f.mutations ?? '');
  if (!mut) {
    errors.push('`mutations:` must read `<n> killed, <n> survived`');
  } else if (Number(mut[2]) > 0) {
    errors.push(`${mut[2]} surviving mutation(s) reported — a survivor means no test covers that line`);
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
