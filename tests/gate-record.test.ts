/**
 * Tests for scripts/gate-record.mjs.
 *
 * The guard's whole claim is that it turns a recurring process failure into a
 * hard stop. That claim is worth exactly as much as these tests: a guard that
 * passes everything is indistinguishable from no guard, and it is WORSE, because
 * a green check reads as verification.
 *
 * So each test names the thing that would otherwise slip through, and the suite
 * is deliberately unbalanced towards the SHA-freshness case — the failure that
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
    closes: 'none',
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

  it('does not see a record under an UNCLOSED html comment either', () => {
    // The half-closed version of the hole above, and the one its own comment
    // named: an unterminated `<!--` hides everything after it to the end of the
    // body on GitHub, while a strip that only matches well-formed pairs leaves
    // the record perfectly visible to the regex. Forgetting one `-->` bought a
    // green tick over a record nobody could read.
    const v = evaluate({ body: `<!-- forgot to close\n\n${record()}`, head: HEAD, files: CODE });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toContain('no gate record');
  });

  it('is not fooled by prose that MENTIONS the comment syntax AROUND the record', () => {
    // The other direction, and the one that costs trust: a PR whose body
    // discusses this guard had its real record stripped, because any `<!--`
    // anywhere opened a strip that a later `-->` closed. A false red teaches
    // people to route around the check.
    //
    // The two mentions must straddle the record. With both on the same side the
    // strip removes only the prose between them and the record survives — so a
    // test written that way passes against the very implementation it exists to
    // rule out. (Found by mutating the line, not by reading it.)
    const body = 'An HTML comment opens with `<!--`.\n\n'
      + record()
      + '\n…and closes with `-->`.\n';
    expect(evaluate({ body, head: HEAD, files: CODE }).ok).toBe(true);
  });

  it('reads a record from a body written in a browser (CRLF)', () => {
    // GitHub's web editor writes `\r\n`. The opener required a bare `\n`, so
    // every browser-authored PR reported "no gate record" while displaying one —
    // the widest false red this guard could have shipped with.
    const body = record().replace(/\n/g, '\r\n');
    expect(evaluate({ body, head: HEAD, files: CODE }).ok).toBe(true);
  });

  it('does not accept a record whose OPENING fence is indented', () => {
    const indented = record().split('\n').map((l) => (l ? '    ' + l : l)).join('\n');
    expect(evaluate({ body: indented, head: HEAD, files: CODE }).ok).toBe(false);
  });

  it('does not accept a record whose CLOSING fence is indented', () => {
    // Pins the closing anchor specifically. Indenting the whole block kills the
    // opener, so that test passes with the closing fence unanchored — it proved
    // half of what it looked like it proved. Here the opener is untouched.
    const body = record().replace(/\n```\n$/, '\n    ```\n');
    expect(evaluate({ body, head: HEAD, files: CODE }).ok).toBe(false);
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

  it('demands the `legal` gate for the subprocessor list — despite it being markdown', () => {
    // This is the one binding text in the PUBLIC repo, and it is a .md file, so the
    // docs-only exemption would have waved through exactly the document the managed DPA
    // points customers at. Legal paths are matched before that filter.
    const gates = requiredGates(['SUBPROCESSORS.md']);
    expect(gates).not.toBeNull();
    expect([...gates].sort()).toEqual(['legal']);
  });

  it('leaves other markdown exempt — the scope is one file, not "all docs"', () => {
    expect(requiredGates(['README.md'])).toBeNull();
    expect(requiredGates(['docs/src/content/docs/setup/remote-access.md'])).toBeNull();
  });

  it('takes a sign-off with a date for the legal text, and refuses one without', () => {
    const ok = evaluate({
      body: record({ gates: 'legal', approved: 'rafael 2026-08-01', delta: '', mutations: '' }),
      head: HEAD, files: ['SUBPROCESSORS.md'],
    });
    expect(ok.ok, JSON.stringify(ok.errors)).toBe(true);

    const missing = evaluate({
      body: record({ gates: 'legal', delta: '', mutations: '' }),
      head: HEAD, files: ['SUBPROCESSORS.md'],
    });
    expect(missing.ok).toBe(false);
    // Matched on text unique to the MISSING branch — both errors mention `approved:`.
    expect(missing.errors.join(' ')).toContain('needs an `approved:` line');

    const undated = evaluate({
      body: record({ gates: 'legal', approved: 'rafael', delta: '', mutations: '' }),
      head: HEAD, files: ['SUBPROCESSORS.md'],
    });
    expect(undated.ok).toBe(false);
    expect(undated.errors.join(' ')).toContain('ISO date');
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

describe('gate-record — `closes:`, required with `none` allowed', () => {
  it('⭐ refuses a record that omits it, so absence cannot mean two things', () => {
    // The whole design in one test. An OPTIONAL field is missing both when a PR
    // closes nothing and when its author was in a hurry — and a query over a
    // field like that cannot tell those apart, which is exactly why the detector
    // built on `git log --grep "<DEF-id>"` measured recall 0/2.
    const v = evaluate({ body: record({ closes: '' }), head: HEAD, files: CODE });
    expect(v.ok).toBe(false);
    expect(v.errors?.join(' ')).toContain('`closes:` is missing');
  });

  it('accepts `none` — declining is an answer, not a silence', () => {
    expect(evaluate({ body: record({ closes: 'none' }), head: HEAD, files: CODE }).ok).toBe(true);
  });

  it('accepts one id and a list, in either separator this register uses', () => {
    for (const value of ['DEF-merge-consent-inherited-mode',
                         'DEF-a-row, DEF-b-row',
                         'DEF-a-row · DEF-b-row']) {
      const v = evaluate({ body: record({ closes: value }), head: HEAD, files: CODE });
      expect(v.ok, `rejected ${value}`).toBe(true);
    }
  });

  it('refuses something that is not a register id, and says so about `closes`', () => {
    // Including the near-misses a person actually types: a PR number, prose that
    // reads like an answer, and the template's own placeholder — `head:` has a
    // dedicated placeholder test and this field had none.
    for (const value of ['#1262', 'nothing', 'DEF_underscore', 'def-lowercase-prefix',
                         '<DEF-… ids this PR settles, or none>']) {
      const v = evaluate({ body: record({ closes: value }), head: HEAD, files: CODE });
      expect(v.ok, `accepted ${value}`).toBe(false);
      // Asserting only `ok:false` lets a mutant that reds for an unrelated reason
      // survive — the reader would be sent to the wrong field.
      expect(v.errors?.join(' '), `wrong error for ${value}`).toContain('closes');
    }
  });

  it('tells an EMPTY field apart from a missing one', () => {
    // Two different mistakes and two different instructions: one forgot the line,
    // the other left it blank. The helper drops empty values, so a blank line has
    // to be built by hand — which is why this branch went untested.
    const blank = record().replace('closes: none', 'closes:');
    const v = evaluate({ body: blank, head: HEAD, files: CODE });
    expect(v.ok).toBe(false);
    expect(v.errors?.join(' ')).toContain('`closes:` is empty');
    expect(v.errors?.join(' ')).not.toContain('is missing');
  });

  it('accepts `none` whatever its case, as `head:` accepts a SHA in any case', () => {
    // `None` is what a person types. A false red on a legitimate PR is how a
    // guard earns a bypass — this file says so about `head:` and it is the same
    // argument here.
    for (const value of ['none', 'None', 'NONE']) {
      expect(evaluate({ body: record({ closes: value }), head: HEAD, files: CODE }).ok, value).toBe(true);
    }
  });

  it('⭐ does not demand it where no record is demanded at all', () => {
    // The two standing exemptions must keep working, or every dependabot PR goes
    // permanently red and this field's first effect is to break auto-merge.
    //
    // The record is PRESENT and its `closes:` absent — that combination is the
    // point. An earlier version passed `body: ''`, which has no record at all,
    // so the exemption returned before reaching any new code: it passed on the
    // implementation from BEFORE this change and proved nothing about it.
    const noCloses = record({ closes: '' });
    expect(evaluate({ body: noCloses, head: HEAD, files: ['docs/getting-started.md'] }).ok).toBe(true);
    expect(evaluate({ body: noCloses, head: HEAD, files: CODE, author: 'dependabot[bot]' }).ok).toBe(true);
    // The control: the same body on a non-exempt, human, code diff IS refused —
    // without it the two lines above would also pass if the check never ran.
    expect(evaluate({ body: noCloses, head: HEAD, files: CODE }).ok).toBe(false);
  });

  it('⭐ reports the missing field ALONGSIDE other problems, not instead of them', () => {
    // A check that returns on the first error teaches people to fix one thing
    // per CI round. The record here is wrong in two independent ways and both
    // must be named in one run.
    const v = evaluate({ body: record({ closes: '', gates: 'code-review' }), head: HEAD, files: CODE });
    const joined = v.errors?.join(' ') ?? '';
    expect(joined).toContain('`closes:` is missing');
    expect(joined).toContain('requires the `delta` gate');
  });
});

describe('gate-record — a line nothing reads is a line that lost something', () => {
  it('⭐ refuses an id continued on the next line instead of dropping it', () => {
    // The failure this whole PR exists to prevent, reproduced INSIDE the fix: a
    // second id on a continuation line parsed as nothing, and the guard against
    // a datum going missing let a datum go missing. Green tick, id gone.
    const body = record().replace('closes: none', 'closes: DEF-a-row,\n  DEF-b-row');
    const v = evaluate({ body, head: HEAD, files: CODE });
    expect(v.ok).toBe(false);
    expect(v.errors?.join(' ')).toContain('nothing reads it');
  });

  it('⭐ refuses a repeated field rather than letting the last one win', () => {
    // A leftover `closes: none` under a real answer silently overwrote it. Same
    // reasoning this file already applies to two BLOCKS, one level down.
    const body = record().replace('closes: none', 'closes: DEF-a-row\ncloses: none');
    const v = evaluate({ body, head: HEAD, files: CODE });
    expect(v.ok).toBe(false);
    expect(v.errors?.join(' ')).toContain('repeats');
  });

  it('still accepts blank lines inside the block', () => {
    // The control. Rejecting every unparsed line must not reject the ones people
    // use to group fields — that would be a false red on a correct record.
    const body = record().replace('delta: clean', '\ndelta: clean\n');
    expect(evaluate({ body, head: HEAD, files: CODE }).ok).toBe(true);
  });
});

describe('gate-record — a real register id may carry a capital', () => {
  it('⭐ accepts DEF-dk-engineDb-init-partial-wire, which is a row that exists', () => {
    // The lower-case-only shape refused it, so that row could never be named in
    // `closes:` — a guard that cannot express a correct answer. Core cannot check
    // existence (the register is in the private repo), which makes getting the
    // SHAPE right the only thing standing between a typo and a green tick here.
    expect(evaluate({ body: record({ closes: 'DEF-dk-engineDb-init-partial-wire' }), head: HEAD, files: CODE }).ok)
      .toBe(true);
  });

  it('still refuses what is not an id at all', () => {
    // The control: widening for capitals must not widen into accepting anything.
    for (const value of ['#1262', 'DEF_underscore', 'Def-wrong-prefix', 'nothing']) {
      expect(evaluate({ body: record({ closes: value }), head: HEAD, files: CODE }).ok, value).toBe(false);
    }
  });
});
