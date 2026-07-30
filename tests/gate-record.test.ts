/**
 * Tests for scripts/gate-record.mjs.
 *
 * The guard's whole claim is that it turns a recurring process failure into a
 * hard stop. That claim is worth exactly as much as these tests: a guard that
 * passes everything is indistinguishable from no guard, and it is WORSE, because
 * a green check reads as verification.
 *
 * So each test names the thing that would otherwise slip through, and the suite
 * is deliberately unbalanced towards the SHA-freshness case — the one fact CI can
 * establish on its own, and the one that actually recurs (gates run, then more
 * commits land).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — plain ESM CLI, no type declarations by design.
import { evaluate, extractRecord, requiredGates } from '../scripts/gate-record.mjs';

const HEAD = 'abc1234def5678901234567890abcdef12345678';

/** A record that should pass, so each test can spoil exactly one thing. */
function record(over: Record<string, string> = {}): string {
  const f = {
    head: HEAD.slice(0, 8),
    gates: 'code-review, delta',
    delta: 'clean',
    mutations: '12 killed, 0 survived',
    ...over,
  };
  const body = Object.entries(f)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  return `## Summary\n\nSomething.\n\n\`\`\`gate-record\n${body}\n\`\`\`\n`;
}

const CODE = ['src/core/agent.ts'];

describe('gate-record — the SHA pin', () => {
  it('accepts a record taken at this head', () => {
    expect(evaluate({ body: record(), head: HEAD, files: CODE })).toMatchObject({ ok: true });
  });

  it('REJECTS a record taken at an earlier head', () => {
    // The failure this guard exists for: the gates ran, then three more commits
    // landed and nobody re-ran them. Every other check in the record still reads
    // true — they were true, about code that is no longer what merges.
    const v = evaluate({ body: record({ head: 'deadbee' }), head: HEAD, files: CODE });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toContain('Commits landed after the gates ran');
  });

  it('rejects a SHA prefix too short to identify a commit', () => {
    // `a` is a prefix of almost everything; without a floor the pin is decorative.
    const v = evaluate({ body: record({ head: HEAD.slice(0, 4) }), head: HEAD, files: CODE });
    expect(v.ok).toBe(false);
  });

  it('rejects a record with no head at all', () => {
    const v = evaluate({ body: record({ head: '' }), head: HEAD, files: CODE });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toContain('`head:`');
  });

  it('accepts the same SHA in upper case', () => {
    // A false red on a legitimate PR is how a guard earns a bypass and then a
    // deletion. Some tools echo SHAs upper-cased; it is the same commit.
    expect(evaluate({ body: record({ head: HEAD.slice(0, 8).toUpperCase() }), head: HEAD, files: CODE }).ok).toBe(true);
  });

  it('tells a placeholder apart from a stale SHA', () => {
    // Both are red, but the instruction differs: one says "fill this in", the
    // other says "your gates are older than your code". Collapsing them sends
    // the reader looking for commits that do not exist.
    const v = evaluate({ body: record({ head: '<short SHA>' }), head: HEAD, files: CODE });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toContain('not a commit SHA');
    expect(v.errors.join(' ')).not.toContain('Commits landed');
  });
});

describe('gate-record — the record itself', () => {
  it('rejects a PR body with no record', () => {
    const v = evaluate({ body: '## Summary\n\nJust a description.\n', head: HEAD, files: CODE });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toContain('no gate record');
  });

  it('does not see a record hidden inside an HTML comment', () => {
    // GitHub renders no HTML comment, so such a record is invisible to every
    // human who opens the PR while satisfying the check — the durable record
    // evaporates and the tick stays green. It is one missing `-->` away in the
    // template, where the instructions sit directly above the block.
    const v = evaluate({ body: `<!--\n${record()}\n-->`, head: HEAD, files: CODE });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toContain('no gate record');
  });

  it('does not accept a record indented into some other block', () => {
    // A fenced block is defined at the start of a line. Indented, it is a code
    // sample inside a list item or a quoted diff — someone else's record pasted
    // for discussion, not a claim about this PR.
    const indented = record().split('\n').map((l) => (l ? '    ' + l : l)).join('\n');
    expect(evaluate({ body: indented, head: HEAD, files: CODE }).ok).toBe(false);
  });

  it('rejects TWO records rather than picking one', () => {
    // Two blocks are two claims. Reading the first silently is how a stale
    // record survives an edit that was meant to replace it.
    const v = evaluate({ body: record() + '\n' + record({ head: 'deadbee' }), head: HEAD, files: CODE });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toContain('one');
  });

  it('rejects a delta round that did not come back clean', () => {
    for (const delta of ['dirty', 'pending', 'n/a', '']) {
      expect(evaluate({ body: record({ delta }), head: HEAD, files: CODE }).ok).toBe(false);
    }
  });

  it('rejects a surviving mutation', () => {
    const v = evaluate({ body: record({ mutations: '9 killed, 1 survived' }), head: HEAD, files: CODE });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toContain('survivor');
  });

  it('accepts an honest zero, and rejects prose in its place', () => {
    // A refactor with no behaviour change really can kill nothing. What must not
    // pass is a field that says something unparseable and reads as compliance.
    expect(evaluate({ body: record({ mutations: '0 killed, 0 survived' }), head: HEAD, files: CODE }).ok).toBe(true);
    expect(evaluate({ body: record({ mutations: 'n/a' }), head: HEAD, files: CODE }).ok).toBe(false);
    expect(evaluate({ body: record({ mutations: 'lots killed' }), head: HEAD, files: CODE }).ok).toBe(false);
  });

  it('rejects a gate name it does not know', () => {
    // A typo'd gate is a gate that did not run, claimed in a way that looks like
    // it did — the exact substitution this guard exists to stop.
    const v = evaluate({ body: record({ gates: 'code-review, delta, code-reveiw' }), head: HEAD, files: CODE });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toContain('unknown gate');
  });
});

describe('gate-record — which gates a diff requires', () => {
  it('demands code-review and a delta round for any code change', () => {
    const v = evaluate({ body: record({ gates: 'code-review' }), head: HEAD, files: CODE });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toContain('`delta`');
  });

  it('demands the security gate when the diff touches a trust boundary', () => {
    for (const file of [
      'src/core/data-boundary.ts',
      'src/tools/permission-guard.ts',
      'src/tools/builtin/spawn.ts',
      // Any builtin, not just spawn: every module here is a capability the model
      // can call, so changing one changes what an agent is able to do.
      'src/tools/builtin/http-request.ts',
      'src/server/http-api.ts',
    ]) {
      const v = evaluate({ body: record(), head: HEAD, files: [file] });
      expect(v.ok, file).toBe(false);
      expect(v.errors.join(' ')).toContain('`security`');
    }
  });

  it('does NOT demand it for ordinary code', () => {
    expect(requiredGates(['src/core/prompts.ts']).has('security')).toBe(false);
    expect(evaluate({ body: record(), head: HEAD, files: ['src/core/prompts.ts'] }).ok).toBe(true);
  });

  it('characterises what the path map CANNOT see', () => {
    // Not an endorsement — a record of the floor's shape, so the next person
    // does not mistake a green check for "no security review needed".
    // core#1099 opened a real trust boundary (an excerpt of attacker-influenceable
    // text becomes a persisted, one-click-executable instruction) entirely inside
    // `src/core/agent.ts`. Listing that file would demand the gate on nearly every
    // PR, which trades a real signal for a ritual — so this passes, and judging
    // relevance by AXIS stays a human job.
    expect(requiredGates(['src/core/agent.ts']).has('security')).toBe(false);
  });

  it('lets a security-listed path pass once the gate is claimed', () => {
    const v = evaluate({
      body: record({ gates: 'code-review, delta, security' }),
      head: HEAD,
      files: ['src/core/data-boundary.ts'],
    });
    expect(v.ok).toBe(true);
  });
});

describe('gate-record — who is exempt', () => {
  it('exempts a documentation-only diff', () => {
    const v = evaluate({ body: 'no record here', head: HEAD, files: ['docs/a.md', 'README.md'] });
    expect(v.ok).toBe(true);
  });

  it('does NOT exempt a diff that merely INCLUDES docs', () => {
    // The gap a naive "any .md present" rule leaves: ship the change, add a
    // README line, and the whole PR reads as documentation.
    const v = evaluate({ body: 'no record here', head: HEAD, files: ['docs/a.md', 'src/core/agent.ts'] });
    expect(v.ok).toBe(false);
  });

  it('does NOT exempt a diff it could not see at all', () => {
    // "No files changed" is not "only documentation changed". They were one
    // branch, so the check passed whenever the file list failed to arrive — a
    // wrong diff range, a shallow clone, a cherry-pick already in base. A guard
    // that opens when its input goes missing is worse than none: the tick still
    // appears, and it is the tick people read.
    const v = evaluate({ body: 'no record here', head: HEAD, files: [] });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toContain('could not see');
  });

  it('exempts a bot, because its PRs merge through a different workflow', () => {
    const v = evaluate({ body: '', head: HEAD, files: CODE, author: 'dependabot[bot]' });
    expect(v.ok).toBe(true);
  });

  it('does NOT exempt a human whose name merely ends in "bot"', () => {
    const v = evaluate({ body: '', head: HEAD, files: CODE, author: 'talbot' });
    expect(v.ok).toBe(false);
  });
});

/**
 * The template is part of the guard, and it was the hole.
 *
 * The first version shipped `gates: code-review, delta`, `delta: clean` and
 * `mutations: 0 killed, 0 survived` pre-filled, with only `head:` blank. Passing
 * meant pasting seven hex characters — every attestation answered in advance, by
 * the same file that asks the question. A guard satisfiable by ritual is the
 * failure it exists to prevent, wearing a green tick.
 */
describe('gate-record — the shipped template does not answer its own questions', () => {
  const TEMPLATE = readFileSync(
    fileURLToPath(new URL('../.github/pull_request_template.md', import.meta.url)),
    'utf-8',
  );

  it('is REJECTED as shipped', () => {
    const v = evaluate({ body: TEMPLATE, head: HEAD, files: CODE });
    expect(v.ok).toBe(false);
  });

  it('is rejected on EVERY field, not just the blank one', () => {
    const errors = evaluate({ body: TEMPLATE, head: HEAD, files: CODE }).errors.join(' ');
    expect(errors).toContain('not a commit SHA');
    expect(errors).toContain('unknown gate');
    expect(errors).toContain('`delta:`');
    expect(errors).toContain('`mutations:`');
  });
});

describe('gate-record — the block is found where it is written', () => {
  it('reads fields regardless of surrounding prose', () => {
    const parsed = extractRecord(record());
    expect(parsed.fields).toMatchObject({ delta: 'clean', gates: 'code-review, delta' });
  });

  it('returns null rather than throwing on an empty body', () => {
    expect(extractRecord('')).toBeNull();
  });
});
