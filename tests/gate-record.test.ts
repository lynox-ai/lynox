/**
 * Tests for scripts/gate-record.mjs.
 *
 * The guard's whole claim is that it turns a recurring process failure into a
 * hard stop. That claim is worth exactly as much as these tests: a guard that
 * passes everything is indistinguishable from no guard, and it is WORSE, because
 * a green check reads as verification.
 *
 * So each test names the thing that would otherwise slip through.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — plain ESM CLI, no type declarations by design.
import { evaluate, extractRecord, requiredGates, SECURITY_PATHS, roundResultErrors, repoVisibility, openFiledCount } from '../scripts/gate-record.mjs';

const HEAD = 'abc1234def5678901234567890abcdef12345678';

/** A record that should pass, so each test can spoil exactly one thing. */
function record(over: Record<string, string> = {}): string {
  const f = {
    head: HEAD.slice(0, 8),
    gates: 'code-review, delta',
    review: '1 opus round, no findings',
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
/** A file the SECURITY path map covers, so the `security` gate becomes due. Asserted below rather
 *  than assumed: a test that silently stopped owing the gate would pass for the wrong reason. */
const SEC = ['src/core/secret-store.ts'];


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

  it('demands it for EVERY integration module, not for the ones named auth', () => {
    // The entry used to be `/^src\\/integrations\\/.*\\/(auth|oauth)/`. Executed against
    // `git ls-tree` at core d9fed2ac it reached 3 of 72 non-test integration modules and
    // 0 of the 24 under `src/integrations/google/`, because it wants `auth` at the start
    // of a path segment and that segment starts with `google-`.
    for (const file of [
      'src/integrations/google/google-auth.ts',
      // The case that decides the SHAPE rather than the width: this file's entire
      // content is the vault slot name the Google OAuth tokens are stored under, and
      // it is imported by engine.ts and google-auth.ts. Its path contains neither
      // `auth` nor `oauth`, so no name pattern can reach it — and the next credential
      // module called `broker-mode.ts` is the same story.
      'src/integrations/google/vault-keys.ts',
      'src/integrations/google/broker-mode.ts',
      'src/integrations/mail/auth/app-password.ts',
      'src/integrations/mail/providers/imap-smtp.ts',
    ]) {
      expect(requiredGates([file]).has('security'), file).toBe(true);
    }
  });

  it('demands it for the one exit every tool grant to a child passes through', () => {
    // Added 2026-10-01 with the entry itself. The template test above derives its tokens
    // FROM this list, so it goes green either way — removing the entry has to fail
    // something, and this is that something.
    expect(requiredGates(['src/tools/resolve-tools.ts']).has('security')).toBe(true);
    // The floor's edge, named rather than implied: the registry beside it carries the
    // same allow/deny vocabulary in `scopedView` and is NOT on the list. Nothing in
    // production calls it today, which is the reason and also the thing that can change.
    expect(requiredGates(['src/tools/registry.ts']).has('security')).toBe(false);
  });

  it('anchors that entry at src/ — a settings PAGE about integrations is not one', () => {
    // The control for the line above: without the `^src/` anchor the widened entry
    // would swallow the web UI too. This path exists in the repository today.
    expect(
      requiredGates(['packages/web-ui/src/routes/app/settings/integrations/google/+page.ts'])
        .has('security'),
    ).toBe(false);
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

  it('needs the `security:` LINE on a listed path, not just the gate named', () => {
    // ⚠ This test used to be called "lets a security-listed path pass once the gate is claimed"
    // and asserted `ok === true` for exactly the body below. That was the old contract — naming
    // the gate was the whole obligation — and the `security:` field is what changed it, so this
    // is the witness of the change rather than a test that quietly moved.
    //
    // Both directions, because a correction is a NEW claim and not just the absence of the old
    // one: named without a line is refused, named WITH a line passes.
    const named = evaluate({
      body: record({ gates: 'code-review, delta, security' }),
      head: HEAD,
      files: ['src/core/data-boundary.ts'],
    });
    expect(named.ok).toBe(false);
    expect(named.errors.join(' ')).toMatch(/needs a `security:` line/);

    const proven = evaluate({
      body: record({ gates: 'code-review, delta, security', security: 'own round, no findings' }),
      head: HEAD,
      files: ['src/core/data-boundary.ts'],
    });
    expect(proven.ok).toBe(true);
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

  /**
   * The map is the mechanism; this template is where its INTENT is written down for
   * a human, and the two drift apart silently.
   * So the list is derived from the source rather than typed out — adding an
   * entry nobody documents turns this red.
   */
  it('names every path the security map enforces', () => {
    /** The literal head of a regex, before its first metacharacter. */
    const literal = (re: RegExp): string =>
      re.source
        .replace(/^\^/, '')
        .replace(/\\(.)/g, '$1')
        .split(/[.*+?^$(){}|[\]]/)[0] ?? '';
    const tokens = (SECURITY_PATHS as RegExp[]).map((re) => {
      const lit = literal(re);
      // A single-file entry (`src/core/output-guard.ts`) is named by its basename in
      // the prose; a directory entry (`src/server/`) is named in full.
      return lit.endsWith('/') ? lit : (lit.split('/').pop() ?? lit);
    });
    expect(tokens.length).toBe(SECURITY_PATHS.length);
    // The extractor is the suspect, and "non-empty" was not enough: `/^s/` yields
    // `"s"` and `/^src\\//` yields `"src/"`, both of which `toContain` finds in any
    // prose that mentions a path at all — coverage by substring accident. A token
    // must be specific enough to BE documentation: two path segments, or a
    // hyphenated module name.
    const specific = (t: string) => t.split('/').filter(Boolean).length >= 2 || t.includes('-');
    expect(tokens.filter((t) => !specific(t))).toEqual([]);
    for (const t of tokens) expect(TEMPLATE, t).toContain(t);
  });

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
    // ⭐ This assertion is why the field is in the template at all. Without it, adding a mandatory
    // field and forgetting the template leaves the perfectly-filled template REJECTED — measured:
    // that is what happened on pro's first cut, and this test is the one that would have caught it.
    expect(errors).toContain('`review: <n> <model> round(s), <result>`');
  });

  it('is rejected on `security:` too, which needs a diff that OWES that gate', () => {
    // ⚠ The test above runs against `CODE`, which does not owe `security` — so the template's
    // `security:` placeholder is not read there at all. Without this case the field could be added
    // to the template, be nonsense, and nothing would notice until a security diff hit it. Same
    // reasoning as the assertion above, one gate further.
    const errors = evaluate({ body: TEMPLATE, head: HEAD, files: SEC }).errors.join(' ');
    expect(errors).toContain('`security: <origin>, <result>`');
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
    // built on `git log --grep` measured recall 0/2.
    const v = evaluate({ body: record({ closes: '' }), head: HEAD, files: CODE });
    expect(v.ok).toBe(false);
    expect(v.errors?.join(' ')).toContain('`closes:` is missing');
  });

  it('accepts `none` — declining is an answer, not a silence', () => {
    expect(evaluate({ body: record({ closes: 'none' }), head: HEAD, files: CODE }).ok).toBe(true);
  });

  it('accepts one id and a list, in either separator this register uses', () => {
    // Invented ids; none names a real row.
    for (const value of ['DEF-' + 'example-single-id',
                         'DEF-a-row, DEF-b-row', // public-repo-guard:allow: fabricated ids, parser INPUT not a reference
                         'DEF-a-row · DEF-b-row']) { // public-repo-guard:allow: fabricated ids, parser INPUT not a reference
      const v = evaluate({ body: record({ closes: value }), head: HEAD, files: CODE });
      expect(v.ok, `rejected ${value}`).toBe(true);
    }
  });

  it('refuses something that is not a register id, and says so about `closes`', () => {
    // Including the near-misses a person actually types: a PR number, prose that
    // reads like an answer, and the template's own placeholder — `head:` has a
    // dedicated placeholder test and this field had none.
    // The wrong-case values are assembled, so this file adds no id-shaped literal.
    for (const value of ['#1262', 'nothing', 'DEF_underscore', ['def', 'lowercase-prefix'].join('-'),
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
    const body = record().replace('closes: none', 'closes: DEF-a-row,\n  DEF-b-row'); // public-repo-guard:allow: fabricated ids, parser INPUT not a reference
    const v = evaluate({ body, head: HEAD, files: CODE });
    expect(v.ok).toBe(false);
    expect(v.errors?.join(' ')).toContain('nothing reads it');
  });

  it('⭐ refuses a repeated field rather than letting the last one win', () => {
    // A leftover `closes: none` under a real answer silently overwrote it. Same
    // reasoning this file already applies to two BLOCKS, one level down.
    const body = record().replace('closes: none', 'closes: DEF-a-row\ncloses: none'); // public-repo-guard:allow: fabricated ids, parser INPUT not a reference
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
  it('⭐ accepts a closes: id containing a capital letter', () => {
    // The lower-case-only shape refused such an id, so a row named that way
    // could never appear in `closes:` — a guard that cannot express a correct
    // answer. Core cannot check existence (the register is in the private repo),
    // which makes getting the SHAPE right the only thing standing between a typo
    // and a green tick here.
    expect(evaluate({ body: record({ closes: 'DEF-' + 'example-camelCase-id' }), head: HEAD, files: CODE }).ok)
      .toBe(true);
  });

  it('still refuses what is not an id at all', () => {
    // The control: widening for capitals must not widen into accepting anything.
    for (const value of ['#1262', 'DEF_underscore', ['Def', 'wrong-prefix'].join('-'), 'nothing']) {
      expect(evaluate({ body: record({ closes: value }), head: HEAD, files: CODE }).ok, value).toBe(false);
    }
  });
});

describe('gate-record — a docs diff owes no gates, which is not the same as owing no record', () => {
  const DOCS = ['docs/getting-started.md'];

  // The check used to `return { ok: true }` the moment it saw a docs-only diff —
  // before `extractRecord` ran. So on those PRs it printed a tick without reading a
  // single field, and the output could not tell "checked and clean" from "never
  // looked". Both look the same from outside, which is the whole cost: on
  // 2026-09-02 a session judged three docs-only PRs by their `gate-record` block
  // and, on one of them, re-pinned `head:` after an `update-branch` and read the
  // green check as confirmation. It had never been read.
  it('THE POINT: a stale head pin on a docs PR is refused, where it used to pass unread', () => {
    const stale = record({ head: '9999999999999999999999999999999999999999' });
    const v = evaluate({ body: stale, head: HEAD, files: DOCS });
    expect(v.ok).toBe(false);
    expect(v.errors?.join(' ')).toContain('record pins head');
  });

  // pro#685, live at the time of writing: `gates:` written as a bullet list, so the
  // two gate attestations under it are read by nothing at all.
  it('a line that is not `field: value` is refused on a docs PR too', () => {
    const body = [
      '## Summary', '', 'Docs.', '', '```gate-record',
      `head: ${HEAD.slice(0, 8)}`,
      'gates:',
      '  - code-review: not-run (docs-only diff)',
      '```', '',
    ].join('\n');
    const v = evaluate({ body, head: HEAD, files: DOCS });
    expect(v.ok).toBe(false);
    expect(v.errors?.join(' ')).toContain('is not `field: value`');
  });

  it('an unknown gate name is refused on a docs PR too', () => {
    const v = evaluate({ body: record({ gates: 'code-review, vibes' }), head: HEAD, files: DOCS });
    expect(v.ok).toBe(false);
    expect(v.errors?.join(' ')).toContain('unknown gate');
  });

  // The delayed ignition, as one assertion: the SAME body, silently passing on a
  // docs diff and refused the day a source file joins the branch. That gap is what
  // made the defect expensive — a record can be "passing" for weeks and then fail
  // all at once, on a PR nobody touched.
  it('⭐ the same broken record no longer passes on docs and fails on code', () => {
    const stale = record({ head: '9999999999999999999999999999999999999999' });
    expect(evaluate({ body: stale, head: HEAD, files: DOCS }).ok).toBe(false);
    expect(evaluate({ body: stale, head: HEAD, files: CODE }).ok).toBe(false);
  });

  // What a docs diff genuinely does not owe. Each of these would be an error on a
  // code diff, and demanding them here would buy a fabricated line.
  it('no gate is demanded, and neither is a delta round', () => {
    const v = evaluate({ body: record({ gates: '', delta: '', mutations: '' }), head: HEAD, files: DOCS });
    expect(v.ok).toBe(true);
    // The control: the same record on a code diff IS refused, or the line above
    // would also pass if the docs branch skipped every check as it used to.
    expect(evaluate({ body: record({ gates: '', delta: '', mutations: '' }), head: HEAD, files: CODE }).ok).toBe(false);
  });

  it('a docs PR with no record at all still passes', () => {
    // 4 of the 5 open docs-only PRs across both repos carry no block. Demanding one
    // would turn a fix for a silent check into a wave of red on work that never
    // claimed anything.
    const v = evaluate({ body: '## Summary\n\nJust docs.\n', head: HEAD, files: DOCS });
    expect(v.ok).toBe(true);
    expect(v.notes?.join(' ')).toContain('no gate record required');
  });

  // The finding was that the OUTPUT could not distinguish the two states. A fix that
  // leaves them printing the same thing has not closed it.
  it('⭐ says which of the two happened, so a reader can tell them apart', () => {
    const read = evaluate({ body: record(), head: HEAD, files: DOCS });
    expect(read.ok).toBe(true);
    expect(read.notes?.join(' ')).toContain('the record is still read');
    const unread = evaluate({ body: '## Summary\n\nJust docs.\n', head: HEAD, files: DOCS });
    expect(unread.notes?.join(' ')).not.toContain('the record is still read');
  });

  it('the bot exemption still returns before any of this', () => {
    const stale = record({ head: '9999999999999999999999999999999999999999' });
    expect(evaluate({ body: stale, head: HEAD, files: CODE, author: 'dependabot[bot]' }).ok).toBe(true);
  });
});

// An independent mutation round against the block above found 9 survivors in 19
// mutations — while the author's own 6 all died. Not one survivor was a defect:
// every behaviour below was already correct and measured to be correct. What was
// missing was the assertion, which is the same thing as the guard being deletable.
//
// Kept in one place because they share a cause: each pins a boundary that the
// existing tests approached from one side only.
describe('gate-record — boundaries a foreign mutation set walked straight through', () => {
  const DOCS = ['docs/getting-started.md'];

  // The docs block asserts head, gates and parse shape — and never touches
  // `closes:`. So the one field this change deliberately does NOT demand there was
  // also the one whose SHAPE went unchecked, which is the delayed ignition again:
  // green for weeks, red the day a source file lands.
  it('a malformed `closes:` is refused on a docs PR too — not demanded is not unread', () => {
    const v = evaluate({ body: record({ closes: '#1262' }), head: HEAD, files: DOCS });
    expect(v.ok).toBe(false);
    expect(v.errors?.join(' ')).toContain('is not a register id');
  });

  // `startsWith`, not `includes`. A pin taken from the MIDDLE of the SHA would
  // otherwise satisfy "pins this commit", and the field's whole job is to name one
  // commit rather than to appear somewhere in it.
  it('a non-prefix substring of the head is not a pin', () => {
    const middle = HEAD.slice(3, 11);
    expect(HEAD).toContain(middle);          // control: it really is a substring
    expect(HEAD.startsWith(middle)).toBe(false);
    expect(evaluate({ body: record({ head: middle }), head: HEAD, files: CODE }).ok).toBe(false);
  });

  // The floor is 7. The existing test uses a 4-character pin, so every floor from 5
  // to 7 passed it — the boundary was pinned from one side only.
  it('the pin floor is 7, checked from just below it', () => {
    expect(evaluate({ body: record({ head: HEAD.slice(0, 6) }), head: HEAD, files: CODE }).ok).toBe(false);
    expect(evaluate({ body: record({ head: HEAD.slice(0, 7) }), head: HEAD, files: CODE }).ok).toBe(true);
  });

  // The junk-line check exists so a line nothing reads cannot sit in the block
  // pretending to. Its tests used bullets and continuation lines; a capitalised key
  // is the form that LOOKS like a field, which is the one that would actually be
  // written by someone.
  it('`Note: prose` is junk too — a capital does not make it a field', () => {
    const body = [
      '## Summary', '', 'x', '', '```gate-record',
      `head: ${HEAD.slice(0, 8)}`, 'gates: code-review, delta', 'delta: clean',
      'mutations: 12 killed, 0 survived', 'closes: none',
      'Note: prose that nothing reads',
      '```', '',
    ].join('\n');
    const v = evaluate({ body, head: HEAD, files: CODE });
    expect(v.ok).toBe(false);
    expect(v.errors?.join(' ')).toContain('is not `field: value`');
  });

  // `delta:` is an EQUALITY check. The rejection cases are all words that do not
  // contain "clean", so a substring implementation passed every one of them and
  // died only on the shipped PR template's `<clean?>` placeholder — i.e. the
  // equality was held up by a test about something else, and a reworded template
  // would have dropped it silently.
  it('`delta: not clean` is refused — equality, not a substring match', () => {
    const v = evaluate({ body: record({ delta: 'not clean' }), head: HEAD, files: CODE });
    expect(v.ok).toBe(false);
    expect(v.errors?.join(' ')).toContain('must be `clean`');
  });

  // DOC_ONLY is anchored on both ends. Unanchored, `notes.md.ts` reads as markdown
  // and a whole source file is exempt from every gate — the same class as the
  // "append a line to the README" hole, reached through the pattern instead of
  // through the file mix.
  it('a source file is not documentation because `.md` or `docs/` appears inside its path', () => {
    expect(requiredGates(['src/core/notes.md.ts'])).not.toBe(null);
    expect(requiredGates(['src/server/docs/handler.ts'])).not.toBe(null);
    // Controls, so the assertions above cannot pass by the filter being broken:
    expect(requiredGates(['docs/getting-started.md'])).toBe(null);
    expect(requiredGates(['README.md'])).toBe(null);
  });

  // The bot exemption returns FIRST, ahead of both the `empty` guard and the docs
  // branch. Ordering is the whole content of that claim, and the test named after it
  // ran with a code diff — which exercises neither. Pinned here as it behaves, with
  // the tension stated rather than changed: a bot PR whose file list failed to
  // arrive is exempted, and the `empty` guard exists precisely for that shape.
  it('the bot exemption really is first — including ahead of the `empty` guard', () => {
    const bot = { body: record(), head: HEAD, author: 'dependabot[bot]' };
    const onEmpty = evaluate({ ...bot, files: [] });
    expect(onEmpty.ok).toBe(true);
    expect(onEmpty.notes?.join(' ')).toContain('is a bot');
    const onDocs = evaluate({ ...bot, files: DOCS });
    expect(onDocs.notes?.join(' ')).toContain('is a bot');
    // The control: without the bot author, the empty list is refused.
    expect(evaluate({ body: record(), head: HEAD, files: [] }).ok).toBe(false);
  });
});

describe('gate-record — the `review:` evidence line', () => {
  // ⛔ Why this block is long: the field exists because a PR listed `code-review` with no round
  // behind it, went green because the LINE was there, and merged — the late review then found five
  // things, four with code effect. And the FORM had to be rebuilt once, so both the accepted and the
  // refused shapes are pinned here, including the arithmetic in both directions.
  it('is required when the diff owes the code-review gate', () => {
    const v = evaluate({ body: record({ review: '' }), head: HEAD, files: CODE });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/needs a `review:` line/);
  });

  it('is NOT required for a docs-only diff, which owes no code gate', () => {
    // No `gates:` at all, which is what a docs-only record looks like — `none` would be read as a
    // gate NAME and rejected as unknown, which is right and cost me one red test.
    const body = `## Summary\n\nDocs.\n\n\`\`\`gate-record\nhead: ${HEAD.slice(0, 8)}\ncloses: none\n\`\`\`\n`;
    expect(evaluate({ body, head: HEAD, files: ['docs/internal/x.md'] }).ok).toBe(true);
  });

  it('accepts `no findings`', () => {
    expect(evaluate({ body: record({ review: '2 sonnet rounds, no findings' }), head: HEAD, files: CODE }).ok).toBe(true);
  });

  it('accepts `all fixed`, which needs no arithmetic', () => {
    expect(evaluate({ body: record({ review: '1 opus round, 5 findings, all fixed' }), head: HEAD, files: CODE }).ok).toBe(true);
  });

  it('accepts `<N> fixed` for all of them — the first line anybody actually wrote', () => {
    // ⛔ The first cut REFUSED this, and it was the shape the first real `review:` line in an open
    // PR used: `2 findings, 2 fixed`. A format whose only way to say "all of them" is a special
    // word rejects the natural sentence, and then the gate looks like pedantry.
    expect(evaluate({ body: record({ review: '1 sonnet round, 2 findings, 2 fixed' }), head: HEAD, files: CODE }).ok).toBe(true);
  });

  it('accepts a breakdown with `refuted`, the slot whose absence forced a lie', () => {
    // ⛔ A finding the author CHECKED AND REJECTED has to be sayable. Without this slot the honest
    // author must write `filed` for a register row that does not exist, or quietly lower N.
    // ⚠ `visibility: 'private'` because the count is INCIDENTAL here: this test is about the
    // `refuted` slot, and in the public repo an open count is refused on its own grounds. Flipping
    // the verdict instead would delete the witness this test exists to be.
    expect(evaluate({ body: record({ review: '1 opus round, 5 findings, 3 fixed, 1 filed, 1 refuted' }), head: HEAD, files: CODE, visibility: 'private' }).ok).toBe(true);
  });

  it('accepts fixed + filed when they sum to N', () => {
    // `visibility: 'private'` — the arithmetic is the subject; see the note above.
    expect(evaluate({ body: record({ review: '1 opus round, 5 findings, 3 fixed, 2 filed' }), head: HEAD, files: CODE, visibility: 'private' }).ok).toBe(true);
  });

  it('REJECTS an UNDER-count — a finding nobody accounted for', () => {
    const e = roundResultErrors('5 findings, 1 fixed, 1 filed', 'review: x').join(' ');
    expect(e).toMatch(/sums to 2, not 5/);
    expect(e).toMatch(/nobody accounted for/);
  });

  it('REJECTS an OVER-count — the same finding counted twice', () => {
    // ⭐ The mutant this exists for: `!== total` weakened to `< total` keeps every other test green,
    // and then `2 findings, 9 fixed, 9 filed` passes. Both directions are errors.
    const e = roundResultErrors('5 findings, 3 fixed, 3 filed', 'review: x').join(' ');
    expect(e).toMatch(/sums to 6, not 5/);
    expect(e).toMatch(/counted twice/);
  });

  it('names the two directions differently, so the message says which mistake it is', () => {
    const under = roundResultErrors('9 findings, 1 fixed', 'review: x').join(' ');
    const over = roundResultErrors('1 findings, 9 fixed', 'review: x').join(' ');
    expect(under).toMatch(/nobody accounted for/);
    expect(over).toMatch(/counted twice/);
  });

  it('rejects `0 findings` and names the one spelling it wants', () => {
    expect(roundResultErrors('0 findings', 'review: x').join(' ')).toMatch(/`no findings` rather than `0 findings`/);
  });

  it('rejects a zero breakdown, which the first cut let through', () => {
    // `all fixed` had an N<1 guard and the breakdown branch did not, so `0 findings, 0 fixed,
    // 0 filed` passed and the "one canonical spelling" was bypassable.
    expect(roundResultErrors('0 findings, 0 fixed, 0 filed', 'review: x')).not.toHaveLength(0);
    expect(roundResultErrors('0 findings, all fixed', 'review: x')).not.toHaveLength(0);
  });

  it('rejects zero rounds — a gate with no round is the omission this field exists for', () => {
    const v = evaluate({ body: record({ review: '0 opus rounds, no findings' }), head: HEAD, files: CODE });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/claims 0 rounds/);
  });

  it('rejects free text, which is exactly what the field replaces', () => {
    // Measured before building this: three attempts to detect "names a result" in PROSE all failed,
    // the third against my own PR body. If a pattern cannot find it, a gate cannot demand it.
    const v = evaluate({ body: record({ review: 'a reviewer looked at it and was happy' }), head: HEAD, files: CODE });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/is not `<n> <model> round\(s\), <result>`/);
  });

  it('rejects a model slot that does not START with a letter', () => {
    // ⚠ "At least three characters" was not enough: `1 ... round` and `1 --- rounds` were ACCEPTED,
    // with `...` as the model name, because punctuation satisfies the character class. The letter is
    // what stops a PURE-PUNCTUATION placeholder — and only that one: `a.` and `a-` pass, as the
    // accepting test below says out loud.
    expect(evaluate({ body: record({ review: '1 ... round, no findings' }), head: HEAD, files: CODE }).ok).toBe(false);
    expect(evaluate({ body: record({ review: '1 --- rounds, no findings' }), head: HEAD, files: CODE }).ok).toBe(false);
    expect(evaluate({ body: record({ review: '1 4.6 rounds, no findings' }), head: HEAD, files: CODE }).ok).toBe(false);
  });

  it('rejects a ONE-character model, which the letter rule alone would allow', () => {
    // ⛔ Separate from the test above, because they witness different halves. `1 x round` starts with
    // a letter, so only the length floor refuses it — and with both halves in one test the length
    // mutant survived: `{2,}` → `{1,}` changed nothing for `x`, which is refused either way.
    //
    // ⚠ That mutant is HISTORY, not something you can run here: the floor IS `{1,}` now. The mutant
    // this test kills today is `{1,}` → `{0,}`; the one that raises the floor again is killed by the
    // accepting test below, not by this one.
    expect(evaluate({ body: record({ review: '1 x round, no findings' }), head: HEAD, files: CODE }).ok).toBe(false);
  });

  it('ACCEPTS a two-character model, because `o3` and `r1` are real names', () => {
    // ⚠ The floor is two, not three, and that is measured: three rejected `o3` and `r1`. A gate that
    // refuses a real model name produces a false red, and a false red is how a guard earns a bypass.
    //
    // ⛔ The BOUND this buys, named rather than discovered later: `1 xy round` passes too, and so do
    // `1 a. round` and `1 a- round` — measured, not assumed. So the slot refuses exactly the FORMS it
    // names (one character, pure punctuation, a digit-initial token) — plus, less obviously,
    // anything carrying a character outside `[a-z0-9.+-]`: `gpt_4o`, `deepseek/r1` and `llama3:8b`
    // are all refused, which is why the slot takes a short HANDLE rather than a provider id, and why
    // the error message now says so. A space cannot occur at all, because the format reads the slot
    // as one token. What this is NOT is a check that the model EXISTS. An allowlist would be that check and is the wrong
    // instrument: it would date, and dating is how this slot would start refusing next year's
    // models. What makes the line true is the author; the field exists so the claim is written down,
    // not so CI can verify it. No test of its own for `xy`: mutant `{1,}`→`{2,}` kills it together
    // with the line below, and a second witness for one mutant preserves no more than the first.
    expect(evaluate({ body: record({ review: '1 o3 round, no findings' }), head: HEAD, files: CODE }).ok).toBe(true);
    expect(evaluate({ body: record({ review: '2 r1 rounds, no findings' }), head: HEAD, files: CODE }).ok).toBe(true);
  });

  it('refuses junk BEFORE the count, which the start-anchor is there for', () => {
    // ⛔ The `^` had no witness at all — pre-existing, not introduced here, and found by refuting
    // this diff rather than by reading it. Drop the `^` from the review pattern and every other test
    // in this file stays green, while `garbage 1 opus round, no findings` is ACCEPTED: the record
    // would take free text in front of the claim. A field whose whole job is to be read literally
    // cannot have a loose left edge.
    expect(evaluate({ body: record({ review: 'garbage 1 opus round, no findings' }), head: HEAD, files: CODE }).ok).toBe(false);
    expect(evaluate({ body: record({ review: 'no round at all 2 opus rounds, no findings' }), head: HEAD, files: CODE }).ok).toBe(false);
  });

  // ⛔ THREE end-anchors, THREE tests — deliberately not one. Vitest stops at the first failing
  // assertion, so two anchors asserted in one `it()` means the second is only witnessed when the
  // first already passes: a mutant that removes just the second is then killed by a test that never
  // reached it. Measured — that is how one of these looked covered while it was not.
  //
  // ⭐ And they drive `roundResultErrors` DIRECTLY rather than through `evaluate`, because the
  // grammar now has two callers. A test that reaches it through one of them witnesses that
  // caller's wiring as much as the grammar, and when the second caller lands, the same assertion
  // would say nothing about it. The wiring has its own test below — two claims, two witnesses.
  //
  // ⚠ The precise claim, because the first version of this comment overstated it: every grammar
  // case is witnessed directly — rejections AND acceptances. The `evaluate` tests that also carry
  // grammar shapes stay, because for a POSITIVE case going through the caller is the only way to
  // witness that the caller does not reject what the grammar accepts.
  it('refuses trailing junk after `no findings`', () => {
    expect(roundResultErrors('no findings and 3 left open', 'review: x')).not.toHaveLength(0);
    expect(roundResultErrors('no findings', 'review: x')).toHaveLength(0);
  });

  it('refuses trailing junk after a breakdown count', () => {
    expect(roundResultErrors('2 findings, 2 fixed extra', 'review: x')).not.toHaveLength(0);
    expect(roundResultErrors('2 findings, 2 fixed but also more', 'review: x')).not.toHaveLength(0);
  });

  it('refuses trailing junk after `all fixed`, the third anchor', () => {
    // The one the first pass left unwitnessed: without its `$`, `5 findings, all fixed extra` and
    // `all fixed and 2 left` both pass, and the result trails off into free text again.
    expect(roundResultErrors('5 findings, all fixed extra', 'review: x')).not.toHaveLength(0);
    expect(roundResultErrors('5 findings, all fixed and 2 left', 'review: x')).not.toHaveLength(0);
  });

  it('cites the field the author wrote in EVERY message, not only one', () => {
    // `quoted` exists so a second caller's message names ITS field. A grammar that hard-codes
    // `review:` would mislabel every error the next field produces, and the mislabel is the kind
    // of defect that survives review because the message still reads plausibly.
    //
    // ⚠ THREE messages interpolate it, and the first version of this test witnessed one: deleting
    // `${quoted}` from either of the other two survived all 129 tests. Found by refuting, and the
    // lesson is the general one — a test that says "every message" has to drive every message.
    // ⚠ The inputs avoid the anchors on purpose. `no findings and more` and `2 fixed extra` reach
    // the right messages, but they reach them THROUGH the end-anchors — so this test would also
    // kill the anchor mutants, and each of those would then die in two tests. A kill count that
    // counts a collateral hit overstates the coverage. `something else` and an unknown disposition
    // trigger the same two messages without touching an anchor.
    const cases: Array<[string, RegExp]> = [
      ['something else', /must read/],
      ['2 findings, 1 ignored, 1 fixed', /is not `<n> fixed/],
      ['5 findings, 1 fixed', /does not add up/],
    ];
    for (const [input, shape] of cases) {
      const msgs = roundResultErrors(input, 'security: own round, X');
      expect(msgs.join(' '), input).toMatch(shape);
      expect(msgs[0], input).toContain('security: own round, X');
      expect(msgs[0], input).not.toContain('review:');
    }
  });

  it('REFUSES to run without `quoted`, because the message would read `undefined`', () => {
    // The failure mode of a second caller forgetting the argument is a message that looks right
    // and names no field. So it throws rather than producing one.
    // @ts-expect-error — the runtime guard is the subject; the type already forbids this.
    expect(() => roundResultErrors('no findings', undefined)).toThrow(/needs `quoted`/);
    expect(() => roundResultErrors('no findings', '')).toThrow(/needs `quoted`/);
  });

  it('ACCEPTS the forms it is meant to — directly, not only through a caller', () => {
    // ⚠ Refute-round finding: the REJECTION cases drove the grammar directly, the ACCEPTANCE cases
    // still went through `evaluate`. So the `i`-flag mutants hung on a test that runs through one
    // caller, and would have said nothing about a second one.
    for (const r of ['no findings', 'No Findings', '3 findings, all fixed', '3 findings, All Fixed',
                     '3 findings, 2 fixed, 1 filed', '3 findings, 1 fixed, 1 filed, 1 refuted',
                     '3 findings, 2 Fixed, 1 Filed'])
      expect(roundResultErrors(r, 'review: x'), r).toHaveLength(0);
  });

  it('ACCEPTS the SINGULAR `1 finding`, which no test covered', () => {
    // Mutant `findings?` → `findings` survived all 129 tests: every case used the plural, so the
    // optional `s` was unwitnessed and `1 finding, 1 fixed` would have started being refused.
    expect(roundResultErrors('1 finding, 1 fixed', 'review: x')).toHaveLength(0);
  });

  it('TOLERATES a trailing comma in the breakdown, deliberately', () => {
    // `.filter(Boolean)` is what allows it, and removing it survived all 129 tests. A trailing
    // comma is a typo, not a different claim — refusing it would be a false red, and a false red
    // is how a guard earns a bypass. So the tolerance is ASSERTED rather than left to a filter
    // nobody witnesses; whoever tightens it now has to argue with a test.
    expect(roundResultErrors('2 findings, 2 fixed,', 'review: x')).toHaveLength(0);
  });

  it('REACHES the grammar from the review field — the wiring, not the grammar', () => {
    // ⛔ Its own test, and it is not redundant with the three above: delete the
    // `roundResultErrors(...)` call from the `review:` branch and those three stay green while
    // every malformed result is ACCEPTED. This one dies instead. Measured.
    const r = evaluate({ body: record({ review: '1 opus round, 5 findings, 1 fixed' }), head: HEAD, files: CODE });
    expect(r.ok).toBe(false);
    expect((r.errors ?? []).join('\n')).toContain('sums to 1, not 5');
  });

  it('rejects an unknown disposition', () => {
    expect(roundResultErrors('2 findings, 1 fixed, 1 ignored', 'review: x')).not.toHaveLength(0);
  });

  it('rejects a REPEATED disposition even when the sum happens to work out', () => {
    // ⛔ The discriminator, and the first version of this test did not have it: `3 findings, 2 fixed,
    // 1 fixed` is rejected with OR without the duplicate check, because the later value overwrites
    // the earlier and the sum then fails. So that case proved nothing about the check it named.
    // `2 findings, 2 fixed, 2 fixed` is the case that separates them: overwriting leaves a sum of 2,
    // which MATCHES, so only the duplicate check can refuse it.
    expect(roundResultErrors('2 findings, 2 fixed, 2 fixed', 'review: x').join(' ')).toMatch(/repeats a kind/);
  });

  it('is case-insensitive and tolerates a trailing full stop, like `head:` and `closes:`', () => {
    // A false red here is how a guard earns a bypass — and `head:`/`closes:` are deliberately lax
    // about case for exactly that reason. Being pedantic about `Opus` while accepting `1 x round`
    // would be strict where it does not help and open where it counts.
    // ⚠ The MODEL slot's case is this test's subject; the RESULT's case belongs to the grammar and
    // is witnessed directly above. Asserting both here made the `all fixed` `i`-flag mutant die in
    // two tests, which reads as better coverage than it is.
    expect(evaluate({ body: record({ review: '1 Opus round, no findings' }), head: HEAD, files: CODE }).ok).toBe(true);
    expect(evaluate({ body: record({ review: '1 opus round, 5 findings, all fixed.' }), head: HEAD, files: CODE }).ok).toBe(true);
    expect(evaluate({ body: record({ review: '1 opus round, 5 findings, 3 Fixed, 2 Filed' }), head: HEAD, files: CODE }).ok).toBe(true);
  });

  it('accepts a model name with a version or a combination, because our rounds mix them', () => {
    // CLAUDE.md prescribes a regime of a fable round, an opus delta and a fable close — sayable as
    // one combined slot. ⚠ NOT per-round models; that is a limit of this form, named rather than
    // hidden: `3 fable+opus rounds` says which models ran, not which ran when.
    expect(evaluate({ body: record({ review: '1 sonnet-4.6 round, no findings' }), head: HEAD, files: CODE }).ok).toBe(true);
    expect(evaluate({ body: record({ review: '3 fable+opus rounds, 7 findings, 5 fixed, 2 filed' }), head: HEAD, files: CODE, visibility: 'private' }).ok).toBe(true);
  });

  it('accepts a human round, because a person reviewing is not a format error', () => {
    expect(evaluate({ body: record({ review: '1 human round, no findings' }), head: HEAD, files: CODE }).ok).toBe(true);
  });
});

describe('the `security:` evidence line', () => {
  // The gate must actually be due for these to mean anything — a fixture that stopped owing it
  // would make every test below pass by not applying. Checked, not assumed.
  it('owes the gate for this fixture at all', () => {
    const r = requiredGates(SEC);
    expect(r).not.toBeNull();
    expect([...(r as Set<string>)]).toContain('security');
  });

  it('demands the line when the gate is due', () => {
    const v = evaluate({ body: record({ gates: 'code-review, security, delta' }), head: HEAD, files: SEC });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/needs a `security:` line/);
  });

  it('does NOT demand it when the diff does not owe the gate', () => {
    expect(evaluate({ body: record(), head: HEAD, files: CODE }).ok).toBe(true);
  });

  it('accepts `own round` and `leaning on <what>`', () => {
    for (const sec of ['own round, no findings', 'leaning on the v1/v2 parity run, no findings',
                       'own round, 2 findings, 1 fixed, 1 filed', 'Own Round, no findings.'])
      // ⚠ `visibility: 'private'`: one of these counts an OPEN finding, which a PUBLIC record
      // refuses for its own reason. The origin vocabulary is what this test is about.
      expect(evaluate({ body: record({ gates: 'code-review, security, delta', security: sec }), head: HEAD, files: SEC, visibility: 'private' }), sec).toMatchObject({ ok: true });
  });

  it('accepts `origin unclear` as a FULL value, not an escape hatch', () => {
    // ⭐ The third value is what makes the other two honest. A vocabulary of two forces the session
    // that does not KNOW whose round it was to write `own round` — which is the lie this field
    // exists to prevent, and which is how the one recorded instance arose. So this is a plain
    // accept, with no penalty and no second-class message.
    expect(evaluate({ body: record({ gates: 'code-review, security, delta', security: 'origin unclear, no findings' }), head: HEAD, files: SEC }).ok).toBe(true);
    expect(evaluate({ body: record({ gates: 'code-review, security, delta', security: 'origin unclear, 2 findings, 1 fixed, 1 filed' }), head: HEAD, files: SEC, visibility: 'private' }).ok).toBe(true);
  });

  it('names `origin unclear` in the message a missing line produces', () => {
    // If the field demands an origin but never tells the author the honest option exists, the
    // vocabulary is three values wide and two values discoverable.
    const e = evaluate({ body: record({ gates: 'code-review, security, delta' }), head: HEAD, files: SEC }).errors.join(' ');
    expect(e).toMatch(/origin unclear/);
    expect(e).toMatch(/FULL answer/);
  });

  it('rejects an origin outside the three', () => {
    for (const sec of ['nonsense, no findings', 'leaning, no findings', 'own, no findings'])
      expect(evaluate({ body: record({ gates: 'code-review, security, delta', security: sec }), head: HEAD, files: SEC }).ok, sec).toBe(false);
  });

  it('rejects an origin with no result', () => {
    expect(evaluate({ body: record({ gates: 'code-review, security, delta', security: 'own round' }), head: HEAD, files: SEC }).ok).toBe(false);
  });

  it('REACHES the shared result grammar — the wiring, not the grammar', () => {
    // Delete the `roundResultErrors(...)` call from this branch and every other test here stays
    // green while `own round, 2 findings, 1 fixed` passes. One grammar, two callers, two wirings.
    const v = evaluate({ body: record({ gates: 'code-review, security, delta', security: 'own round, 2 findings, 1 fixed' }), head: HEAD, files: SEC });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/sums to 1, not 2/);
  });

  it('points at the REFERENCE when a comma inside it broke the parse', () => {
    // ⚠ `leaning on a, b, no findings` parses as origin `leaning on a` and result `b, no findings`,
    // so the grammar refuses the RESULT — technically true and aimed at the wrong half. The hint
    // sends the reader to the reference instead.
    const e = evaluate({ body: record({ gates: 'code-review, security, delta', security: 'leaning on a, b, no findings' }), head: HEAD, files: SEC }).errors.join(' ');
    expect(e).toMatch(/read as the/);
  });

  it('anchors the origin at the START — a valid origin as a SUFFIX does not count', () => {
    // ⛔ The mutant this exists for: drop the `^` and `x own round, no findings` is ACCEPTED,
    // while every other test here stays green, because none of them put junk in front of a VALID
    // origin. `nonsense` and `own` do not contain one, so they witness the vocabulary and not the
    // anchor. Measured by refuting, not by reading.
    for (const sec of ['x own round, no findings', 'my own round, no findings',
                       'see origin unclear, no findings'])
      expect(evaluate({ body: record({ gates: 'code-review, security, delta', security: sec }), head: HEAD, files: SEC }).ok, sec).toBe(false);
  });

  it('needs a SPACE after `on`, so `leaning onwards` is not an origin', () => {
    // `leaning\s+on\s+` weakened to `\s*` accepts `leaning onwards, no findings`, with `wards` as
    // the reference. Three origins, and each needs its word boundary witnessed — a vocabulary that
    // matches prefixes is not closed.
    for (const sec of ['leaning onwards, no findings', 'own rounds, no findings',
                       'origin unclearly, no findings'])
      expect(evaluate({ body: record({ gates: 'code-review, security, delta', security: sec }), head: HEAD, files: SEC }).ok, sec).toBe(false);
  });

  it('TOLERATES extra whitespace around the words and the comma', () => {
    // The other side of the same patterns: `\s+` rather than a literal space, and `\s*,` rather
    // than `,`. Without these the field would refuse `own  round` and `own round , …`, which are
    // typos and not different claims — and a false red is how a guard earns a bypass. Asserting
    // the tolerance is what keeps a later tightening honest.
    for (const sec of ['own  round, no findings', 'own round , no findings',
                       'own round,no findings', 'origin   unclear, no findings'])
      expect(evaluate({ body: record({ gates: 'code-review, security, delta', security: sec }), head: HEAD, files: SEC }).ok, sec).toBe(true);
  });

  it('refuses a reference made of nothing, and says THAT rather than the shape', () => {
    // ⛔ Measured as accepted before the fix: `leaning on  , no findings` (two spaces),
    // `leaning on ., …` and `leaning on -, …` all passed the shape. A reference with no letters
    // names nothing a reader can check, so it is the one answer that is neither true nor false —
    // and `origin unclear` is the honest form of that, which the message points at.
    // ⚠ `leaning on , …` with ONE space is in this list on purpose: with `[^,]+?` it failed the
    // SHAPE and got the generic message, while two spaces got the precise one — same defect, two
    // diagnoses, decided by whitespace the author cannot see. The pattern is `*?` for that reason,
    // and this case is what holds it there.
    for (const sec of ['leaning on , no findings', 'leaning on  , no findings',
                       'leaning on ., no findings', 'leaning on -, no findings']) {
      const v = evaluate({ body: record({ gates: 'code-review, security, delta', security: sec }), head: HEAD, files: SEC });
      expect(v.ok, sec).toBe(false);
      expect(v.errors.join(' '), sec).toMatch(/leans on nothing/);
    }
    // And it does not fire on a reference that says something.
    expect(evaluate({ body: record({ gates: 'code-review, security, delta', security: 'leaning on x, no findings' }), head: HEAD, files: SEC }).ok).toBe(true);
  });

  it('adds the comma hint for a CAPITALISED origin too', () => {
    // `/^leaning/i` → `/^leaning/` survives every other test here, because they all write the
    // origin in lower case. The hint would then go missing for `Leaning on …`, which the field
    // accepts — a guard that is case-insensitive in the parse and case-sensitive in the advice.
    const e = evaluate({ body: record({ gates: 'code-review, security, delta', security: 'Leaning on a, b, no findings' }), head: HEAD, files: SEC }).errors.join(' ');
    expect(e).toMatch(/read as the/);
  });

  it('adds NO comma hint when the result is fine, even for a reference origin', () => {
    // The second half of the hint's condition: `resultErrors.length > 0`. Without it the hint
    // would ride along on a perfectly good line — and advice that appears when nothing is wrong
    // is how advice stops being read.
    const v = evaluate({ body: record({ gates: 'code-review, security, delta', security: 'leaning on the parity run, no findings' }), head: HEAD, files: SEC });
    expect(v.ok).toBe(true);
    expect((v.errors ?? []).join(' ')).not.toMatch(/read as the/);
  });

  it('does NOT add the comma hint when the origin was not a reference', () => {
    // The discriminator: a sum error under `own round` has nothing to do with commas, and a hint
    // that fires on every result error would be noise — which is how a message stops being read.
    const e = evaluate({ body: record({ gates: 'code-review, security, delta', security: 'own round, 2 findings, 1 fixed' }), head: HEAD, files: SEC }).errors.join(' ');
    expect(e).toMatch(/sums to 1, not 2/);
    expect(e).not.toMatch(/read as the/);
  });
});

describe('a PUBLIC record does not count open findings', () => {
  // ⛔ Why this exists: the `review:` and `security:` evidence lines were designed in the PRIVATE
  // repo, where `2 findings, 0 fixed, 2 filed` is a useful, checkable sentence. Nobody asked what
  // that sentence means HERE. This repo is public, and the rule is that a security finding which
  // is not yet closed must not be named in public text — not even its existence, which is exactly
  // what a `filed` count states. `gate-record` was the thing REQUIRING it. The grammar was innocent; the SCOPE
  // was the gap.
  const G = 'code-review, security, delta';
  const WITH_COUNT = '1 opus round, 2 findings, 1 fixed, 1 filed';
  const SEC_COUNT = 'own round, 2 findings, 1 fixed, 1 filed';
  const pub = (over: Record<string, string>, files = SEC, visibility = 'public') =>
    evaluate({ body: record(over), head: HEAD, files, visibility });

  it('resolves visibility from the PROPERTY, with the slug as a second source', () => {
    expect(repoVisibility({ privateFlag: 'false', repoSlug: 'lynox-ai/lynox' })).toBe('public');
    expect(repoVisibility({ privateFlag: 'true', repoSlug: 'lynox-ai/lynox-pro' })).toBe('private');
    expect(repoVisibility({ privateFlag: 'false' })).toBe('public');
    expect(repoVisibility({ repoSlug: 'lynox-ai/lynox-pro' })).toBe('private');
  });

  it('answers `unknown` when the two sources CONTRADICT, rather than picking one', () => {
    // The second source exists to contradict, not to decide: if the property says public and the
    // slug says private, something is wrong in a way neither value explains.
    expect(repoVisibility({ privateFlag: 'false', repoSlug: 'lynox-ai/lynox-pro' })).toBe('unknown');
    expect(repoVisibility({ privateFlag: 'true', repoSlug: 'lynox-ai/lynox' })).toBe('unknown');
  });

  it('answers `unknown` with no sources, and lets an explicit value win', () => {
    expect(repoVisibility({})).toBe('unknown');
    expect(repoVisibility({ privateFlag: 'false', repoSlug: 'lynox-ai/lynox', explicit: 'private' })).toBe('private');
  });

  it('counts only `filed`, because that is what stays open', () => {
    expect(openFiledCount('no findings')).toBe(0);
    expect(openFiledCount('5 findings, all fixed')).toBe(0);
    expect(openFiledCount('findings filed privately')).toBe(0);
    expect(openFiledCount('2 findings, 1 fixed, 1 filed')).toBe(1);
    expect(openFiledCount('13 findings, 11 fixed, 1 filed, 1 refuted')).toBe(1);
    // ⛔ Two surviving mutants, both fail-OPEN in the public repo: dropping the `i` flag misses
    // `1 Filed`, which the result grammar accepts as a legal spelling, and `\d+` → `\d` reads a
    // two-digit count as its first digit. Nothing drove either case.
    expect(openFiledCount('3 findings, 2 Fixed, 1 Filed')).toBe(1);
    expect(openFiledCount('20 findings, 8 fixed, 12 filed')).toBe(12);
  });

  it('REFUSES a `security:` count in public, and says where the number belongs', () => {
    const v = pub({ gates: G, review: '1 opus round, no findings', security: SEC_COUNT });
    expect(v.ok).toBe(false);
    const e = v.errors.join(' ');
    expect(e).toMatch(/counts OPEN findings/);
    expect(e).toMatch(/private register row/);
  });

  it('ACCEPTS the same `security:` count when the record goes into the private repo', () => {
    // The same check ships in both repos, so `private` has to stay a working answer here.
    const v = evaluate({ body: record({ gates: G, review: '1 opus round, no findings', security: SEC_COUNT }), head: HEAD, files: SEC, visibility: 'private' });
    expect(v.ok, (v.errors ?? []).join(' ')).toBe(true);
  });

  it('REFUSES a `review:` count in public WHEN the record also owes security', () => {
    // The overlap is real wherever security is in play: the same findings get counted in both
    // halves, and the two numbers are then one set rather than two.
    const v = pub({ gates: G, review: WITH_COUNT, security: 'own round, findings filed privately' });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/the `review:` line counts OPEN findings/);
  });

  it('ACCEPTS a `review:` count in public when security is NOT in play — the narrow cut', () => {
    // ⭐ The discriminator for the whole cut: a review finding is not a security finding. Two filed
    // CODE defects counted in public break no rule, and forbidding them would cost measurability
    // for nothing. Without this test the condition could be dropped and the suite stay green.
    const v = evaluate({ body: record({ gates: 'code-review, delta', review: WITH_COUNT }), head: HEAD, files: CODE, visibility: 'public' });
    expect(v.ok, (v.errors ?? []).join(' ')).toBe(true);
  });

  it('counts `security` as in play when the record CLAIMS it, not only when the diff owes it', () => {
    // `securityInPlay` reads both sets. A record that names the gate on a diff with no security
    // path has still told the reader a security round happened, so its `review:` count carries the
    // same risk — and without this case the `claimed` half could be dropped and the suite stay
    // green. (That a claimed gate owes no proof of its own is a separate, registered question.)
    const v = evaluate({
      body: record({ gates: 'code-review, security, delta', review: WITH_COUNT }),
      head: HEAD, files: CODE, visibility: 'public',
    });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/the `review:` line counts OPEN findings/);
  });

  it('treats `unknown` as public AND says the property was undeterminable', () => {
    // Fail-closed, with the diagnosis the false red needs: without it the author looks for the
    // mistake in their own body, and a false red without a reason teaches going around the check.
    const v = pub({ gates: G, review: '1 opus round, no findings', security: SEC_COUNT }, SEC, 'unknown');
    expect(v.ok).toBe(false);
    const e = v.errors.join(' ');
    expect(e).toMatch(/COULD NOT BE DETERMINED/);
    expect(e).toMatch(/the mistake is NOT in your body/);
    expect(e).toMatch(/--repo-visibility private/);
  });

  it('reads the FIELD, not the branch — a CLAIMED security gate is checked too', () => {
    // ⛔ The first cut hung this on `required.has('security')`, so a record that merely NAMES the
    // gate, or carries the line on a diff with no security path, was never read: measured GREEN
    // with a `filed` count on a plain code diff. A rule hung on `required` is a rule about the
    // DIFF; this one is about the TEXT.
    for (const over of [
      { gates: G, review: '1 opus round, no findings', security: SEC_COUNT },   // claimed, not owed
      { gates: 'code-review, delta', review: '1 opus round, no findings', security: SEC_COUNT }, // not even named
    ]) {
      const v = evaluate({ body: record(over), head: HEAD, files: CODE, visibility: 'public' });
      expect(v.ok, JSON.stringify(over)).toBe(false);
      expect(v.errors.join(' ')).toMatch(/counts OPEN findings/);
    }
  });

  it('counts security as in play when the LINE is there, even unnamed and unowed', () => {
    // ⛔ Surviving mutant: dropping `|| !!f.security` from `securityInPlay` left every test green,
    // because the claimed-gate case has the count in `security:` itself — so the security check
    // fires and the review half is never reached. This is the case that separates them: a
    // `security:` line with NO count, the gate neither owed nor named, and the number in
    // `review:`. A security round ran (the line says so), so the review count can be the same
    // findings.
    const v = evaluate({
      body: record({ gates: 'code-review, delta', review: WITH_COUNT, security: 'own round, findings filed privately' }),
      head: HEAD, files: CODE, visibility: 'public',
    });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/the `review:` line counts OPEN findings/);
  });

  it('reads the WHOLE field, so the origin free text cannot carry the count', () => {
    // Measured GREEN before: `leaning on the 2 findings 2 filed round, no findings` — the count was
    // read from the result half only, and `leaning on <what>` is free text by design.
    const v = evaluate({
      body: record({ gates: G, review: '1 opus round, no findings', security: 'leaning on the 2 findings 2 filed round, no findings' }),
      head: HEAD, files: SEC, visibility: 'public',
    });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/counts OPEN findings/);
  });

  it('refuses an INVALID explicit visibility rather than falling back to the env', () => {
    // `--repo-visibility pubic` is a typo, and using the environment instead would make the
    // strictness depend on which mistake you made. Fail-closed includes the flag.
    expect(repoVisibility({ explicit: 'pubic', privateFlag: 'true' })).toBe('unknown');
    expect(repoVisibility({ explicit: 'PUBLIC', privateFlag: 'true' })).toBe('unknown');
    expect(repoVisibility({ explicit: 'private', privateFlag: 'false' })).toBe('private');
    expect(repoVisibility({ explicit: 'public', privateFlag: 'true' })).toBe('public');
  });

  it('is robust about the property and the slug, as the resolver claims', () => {
    // ⛔ Four surviving mutants: `.trim()` and both `.toLowerCase()` calls could be deleted with
    // every test green, because nothing drove a padded or upper-case value. The docblock claims
    // robustness; a claim without a witness is a comment.
    expect(repoVisibility({ privateFlag: ' true ' })).toBe('private');
    expect(repoVisibility({ privateFlag: 'TRUE' })).toBe('private');
    expect(repoVisibility({ privateFlag: 'False' })).toBe('public');
    expect(repoVisibility({ repoSlug: 'LYNOX-AI/LYNOX-PRO' })).toBe('private');
    expect(repoVisibility({ repoSlug: ' lynox-ai/lynox ' })).toBe('public');
  });

  it('is fail-closed in the `review:` branch too, not only in `security:`', () => {
    // ⛔ Measured as a surviving mutant: `visibility !== 'private'` weakened to `=== 'public'` in
    // the review branch left every other test here green, because the `unknown` case was only
    // witnessed through `security:`. Fail-closed has to hold in both branches, and a rule proven
    // in one place is proven in one place.
    const v = evaluate({
      body: record({ gates: G, review: WITH_COUNT, security: 'own round, findings filed privately' }),
      head: HEAD, files: SEC, visibility: 'unknown',
    });
    expect(v.ok).toBe(false);
    const e = v.errors.join(' ');
    expect(e).toMatch(/the `review:` line counts OPEN findings/);
    expect(e).toMatch(/COULD NOT BE DETERMINED/);
  });

  it('does NOT add that diagnosis when the repo IS known to be public', () => {
    // The discriminator: a public repo is a determined answer, so the advice about an
    // undeterminable property would be noise — and noise is how advice stops being read.
    const e = pub({ gates: G, review: '1 opus round, no findings', security: SEC_COUNT }).errors.join(' ');
    expect(e).toMatch(/counts OPEN findings/);
    expect(e).not.toMatch(/COULD NOT BE DETERMINED/);
  });

  it('ACCEPTS the count-free form everywhere, in both fields', () => {
    for (const visibility of ['public', 'private', 'unknown']) {
      const v = evaluate({
        body: record({ gates: G, review: '1 opus round, findings filed privately', security: 'own round, findings filed privately' }),
        head: HEAD, files: SEC, visibility,
      });
      expect(v.ok, `${visibility}: ${(v.errors ?? []).join(' ')}`).toBe(true);
    }
  });

  it('⛔ does NOT echo the refused value back — an Actions log is public text too', () => {
    // The message is printed in a public Actions log, and the value is the count being refused:
    // quoting it back would publish the number in the course of refusing it. The repo's own
    // precedent says so out loud — public-repo-guard names a commit by its short SHA alone,
    // "never by its subject line". So the message carries the FIELD NAME and nothing else.
    const e = pub({ gates: G, review: '1 opus round, no findings', security: SEC_COUNT }).errors.join(' ');
    expect(e).toMatch(/the `security:` line counts OPEN findings/);
    expect(e).not.toMatch(/2 findings/);
    expect(e).not.toMatch(/1 filed/);
  });

  it('still ACCEPTS `all fixed` in public — nothing is open, so there is nothing to hide', () => {
    const v = pub({ gates: G, review: '1 opus round, 2 findings, all fixed', security: 'own round, 2 findings, all fixed' });
    expect(v.ok, (v.errors ?? []).join(' ')).toBe(true);
  });

  it('⛔ keeps the TEMPLATE from teaching the form the check now refuses', () => {
    // The template's `security:` example used to read `1 finding, 1 filed`, so an author following
    // it produced exactly what this cut forbids — a false red earned by reading the docs. The
    // other direction of the same trap: a template that still says `filed` while the check refuses
    // it is a documented lie, and nothing else notices.
    const tpl = readFileSync(new URL('../.github/pull_request_template.md', import.meta.url), 'utf8');
    expect(tpl).toContain('findings filed privately');
    expect(tpl).not.toMatch(/`security:[^`]*\d+ filed`/);
  });
});
