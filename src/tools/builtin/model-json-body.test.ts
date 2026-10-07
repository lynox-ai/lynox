import { describe, expect, it } from 'vitest';
import { repairStrayCloseTag } from './model-json-body.js';

const JSON_CT = { 'Content-Type': 'application/json' } as const;
const HTML_CT = { 'Content-Type': 'text/html' } as const;

describe('repairStrayCloseTag — the shape the model actually produced', () => {
  it('takes `</body>` off a JSON array', () => {
    const got = repairStrayCloseTag('[{"location_code":2756,"keywords":["botox aarau"]}]</body>', JSON_CT);
    expect(got?.body).toBe('[{"location_code":2756,"keywords":["botox aarau"]}]');
  });

  it('returns the repaired body and NOTHING from the original — no echo channel', () => {
    // ⚠ This pins a deliberate absence, so it needs saying why. An earlier version also returned
    // the removed text, for the caller's note to quote. `agent.ts` resolves `secret:NAME` before
    // the handler runs, so a body can arrive ending in `</THE-VALUE>` — and that note sits past
    // both the egress scan and `maskSecrets`. The shape is the guarantee: there is no field to
    // leak through. A length cap was tried first and was the wrong cut.
    const got = repairStrayCloseTag('{"a":1}</Zq7Lm2Xp9Rt4Vb8Nc3Hd6Fj1Ks5Wg0Ya>', JSON_CT);
    expect(got).not.toBeNull();
    expect(Object.keys(got as object)).toEqual(['body']);
    expect(JSON.stringify(got)).not.toContain('Zq7Lm2');
  });

  it('runs in LINEAR time — the first version of this was quadratic', () => {
    // ⚠ A timing assertion, which is normally a bad test. It is the right one here because the
    // defect it guards is a wall-clock defect and nothing else observes it. The original
    // `/\s*<\/[A-Za-z][\w:-]*>\s*$/.replace(body)` retried from every position in a whitespace
    // run: ~6.6–7.7 s on these inputs, synchronous, inside the tool handler.
    //
    // ⚠ TWO margins, and they are not the same number — an earlier version of this comment gave
    // one figure and it was the wrong one for the question being asked.
    //   · FLAKE margin, linear run to the bound: 0.45 ms against 1000 ms, ≈2200×. This is what
    //     says the bound is not delicate.
    //   · KILL margin, bound to the quadratic run: 1000 ms against ~6600 ms, ≈6.6×. This is the
    //     one that could in principle shrink, on a machine ~6× slower than this one, and it is
    //     the smaller of the two, so it is the one to quote when asking whether the test still
    //     witnesses anything.
    // ⚠ The input set is the whole point here, and two earlier versions of it could not fail.
    //
    // The backtrack only happens when the pattern FAILS: on a match the engine stops at the
    // first viable start. So `{…spaces…</x>` runs in 0 ms even against the quadratic version —
    // measured — and a test built only from that input is green for a defect that is present.
    // `{…spaces…x` is slow, but it never reaches the tag path at all, because `endsWith('>')`
    // returns first; a mutant that put the old regex BEHIND that guard survived exactly that.
    //
    // What is needed is an input that PASSES `endsWith('>')` and still makes the pattern fail:
    // a bare `>`, an empty tag, or a name the grammar refuses. Each of those takes ~6.5 s on the
    // quadratic version. Measured, all five.
    for (const body of [
      `{${' '.repeat(80_000)}x`,
      `{${' '.repeat(80_000)}</x>`,
      `{${' '.repeat(80_000)}>`,
      `{${' '.repeat(80_000)}</>`,
      `{${' '.repeat(80_000)}</1x>`,
      // ⚠ The sixth, and it covers a DIFFERENT quadratic site: the `trimEnd()` on the part before
      // the tag. Written as `.replace(/\s+$/, '')` that is the same backtracking shape, and the
      // five inputs above all miss it — their prefix is pure whitespace, which that pattern
      // matches immediately. This one ends the prefix with a non-space, so the pattern fails
      // there too: 4148 ms measured against the regex form, 0 ms against `trimEnd`.
      `{${' '.repeat(80_000)}x</x>`,
    ]) {
      const started = Date.now();
      repairStrayCloseTag(body, JSON_CT);
      expect(Date.now() - started, 'the trailing-tag scan is backtracking over the body again').toBeLessThan(1000);
    }
  });

  it('repairs the same body when the call declares NO content type at all', () => {
    // ⚠ Not a convenience case. Measured against the real model on 2026-10-07: with a prompt that
    // does not spell the header out, 1 of 4 tool calls set no `Content-Type` and still carried
    // the tag. A repair keyed on the header alone would have missed exactly those.
    const got = repairStrayCloseTag('[{"a":2756}]</body>', {});
    expect(got?.body).toBe('[{"a":2756}]');
  });

  it('matches the tag by shape, not by a list of tag names', () => {
    // `</body>` is what was observed; nothing says the next model picks the same one. Keying on
    // the literal would make this a per-instance fix, and the next tag a second bug report.
    for (const tag of ['</body>', '</html>', '</response>', '</ns:payload>']) {
      expect(repairStrayCloseTag(`{"a":1}${tag}`, JSON_CT)?.body, tag).toBe('{"a":1}');
    }
  });

  it('tolerates whitespace around the stray tag', () => {
    // ⚠ Asserted as a PROPERTY, not as a string. An earlier version pinned `'{"a":1}'` exactly,
    // which also pinned that the repair eats the whitespace BEFORE the tag — a formatting detail
    // of the regex that then existed. The linear replacement leaves it, which parses identically
    // and changes less of someone else's data. Pinning the literal made the stricter
    // implementation look like a regression.
    const got = repairStrayCloseTag('{"a":1}\n  </body>\n', JSON_CT);
    expect(JSON.parse(got?.body ?? 'null')).toEqual({ a: 1 });
  });

  it('repairs across whitespace JSON does NOT accept — NBSP, U+FEFF, U+2028', () => {
    // ⚠ The reason this needs its own test: JS `\s` and JSON's whitespace are different sets.
    // `{"a":1}<NBSP></body>` only parses once the NBSP goes too, so a version that cuts at the
    // tag and stops leaves a body that still fails — and declines to repair exactly the inputs
    // it was built for. Found by a delta round comparing against the regex this replaced: 366
    // bodies in that class, and zero in the other direction.
    for (const ws of [' ', ' ', '﻿', '　', ' \t\n']) {
      const got = repairStrayCloseTag(`{"a":1}${ws}</body>`, JSON_CT);
      expect(got, JSON.stringify(ws)).not.toBeNull();
      expect(JSON.parse(got?.body ?? 'null'), JSON.stringify(ws)).toEqual({ a: 1 });
    }
  });

  it('⭐ what it sends is always a PREFIX of what the model wrote', () => {
    // ⚠ This is the invariant every security argument about this function rests on: the egress
    // scan can read the ORIGINAL body and still be a strict superset of what goes out, and no
    // content can be introduced that the layers have not seen. Stated as its own test because
    // it is cited as a reason elsewhere, and a cited property with no witness is just a claim.
    for (const body of [
      '{"a":1}</body>', '[1,2]</html>', '"s"</x>', '{"a":1}\n  </body>\n',
      '  \n[{"a":1}]</body>', '123</body>',
    ]) {
      const got = repairStrayCloseTag(body, JSON_CT);
      expect(got, body).not.toBeNull();
      expect(body.startsWith(got?.body ?? '\u0000'), `${body} → not a prefix`).toBe(true);
    }
  });
});

describe('repairStrayCloseTag — what it must never touch', () => {
  it('leaves a legitimate HTML document alone — this is the objection the repair has to answer', () => {
    // An HTML POST really does end in `</body>`. It survives because of (c): stripping the tag
    // does not make it parse either. Both header spellings, because an author who mislabels the
    // call must not thereby get their document edited.
    for (const headers of [HTML_CT, JSON_CT, {}]) {
      expect(repairStrayCloseTag('<!DOCTYPE html><html><body><p>hi</p></body>', headers)).toBeNull();
      expect(repairStrayCloseTag('<html><body>x</body>', headers)).toBeNull();
    }
  });

  it('leaves valid JSON that merely ENDS in a tag inside one of its strings', () => {
    const body = '{"html":"<p>x</p></body>"}';
    expect(repairStrayCloseTag(body, JSON_CT)).toBeNull();
  });

  it('refuses a body that is broken for some OTHER reason', () => {
    // The trailing comma is the real defect; removing the tag does not rescue it. Repairing here
    // would send a body that still fails, having edited the model's output for nothing.
    expect(repairStrayCloseTag('[{"a":1,}]</body>', JSON_CT)).toBeNull();
  });

  it('refuses bodies that do not end in a tag at all', () => {
    for (const body of ['', 'a=1&b=2', '<?xml version="1.0"?><root/>', '{"a":1}']) {
      expect(repairStrayCloseTag(body, JSON_CT), body).toBeNull();
    }
  });

  it('refuses a body that is NOTHING but the tag', () => {
    expect(repairStrayCloseTag('</body>', JSON_CT)).toBeNull();
  });

  it('removes ONE tag, not a run of them', () => {
    // `[1]</p></body>` is not the observed defect and not obviously a JSON body with one stray
    // tag; stripping until something parses is a different, much greedier rule than this one.
    expect(repairStrayCloseTag('[1]</p></body>', JSON_CT)).toBeNull();
  });
});

describe('repairStrayCloseTag — which conditions actually discriminate', () => {
  // ⚠ These two tests ARE the mutation probe, written as assertions instead of run by hand: each
  // names a body that only one condition refuses. Delete that condition and the test goes red.

  it('(a) JSON intent is load-bearing: a plain-text body ending in markup is left alone', () => {
    // `123` parses as JSON, so (b) and (c) both PASS here. Only (a) stops it. Without (a) this
    // function would rewrite a text body that was never JSON.
    for (const body of ['123</body>', 'true</body>', 'null</body>']) {
      expect(repairStrayCloseTag(body, {}), body).toBeNull();
    }
    // And the same bodies ARE repaired once the call declares JSON — otherwise the test above
    // would pass for a function that always returns null.
    expect(repairStrayCloseTag('123</body>', JSON_CT)?.body).toBe('123');
  });

  it('(c) carries the HTML objection: a mislabelled HTML body passes (a) and (b) and still fails', () => {
    const htmlAsJson = '<!DOCTYPE html><html><body>x</body>';
    expect(repairStrayCloseTag(htmlAsJson, JSON_CT)).toBeNull();
    // It really did pass (a) and (b): the header declares JSON, and it does not parse.
    expect(() => JSON.parse(htmlAsJson)).toThrow();
  });

  it('a leading-whitespace body still gets its intent read — `trimStart` is load-bearing', () => {
    // Without the trim, `lead` is a space, `looksLikeJson` is false, and this falls through to
    // the header. It would then be repaired here and NOT repaired without a content type —
    // a difference nothing else in the file would notice.
    expect(repairStrayCloseTag('  \n[{"a":1}]</body>', {})?.body).toBe('  \n[{"a":1}]');
  });

  it('a JSON STRING body counts as JSON intent', () => {
    // `"` is in the lead set for a reason: a bare string is a valid JSON document and an API can
    // legitimately want one. Dropping it from the set makes this case header-dependent.
    expect(repairStrayCloseTag('"hallo"</body>', {})?.body).toBe('"hallo"');
  });

  it('reads the content type case-insensitively, header name and value both', () => {
    // HTTP header names are case-insensitive and `application/JSON` is a real spelling. A body
    // with no JSON-looking lead reaches the repair only through the header, so each folding is
    // the single thing standing between this call and an unrepaired body.
    for (const headers of [
      { 'content-type': 'application/json' },
      { 'CONTENT-TYPE': 'application/json' },
      { 'Content-Type': 'APPLICATION/JSON' },
      { 'Content-Type': 'application/json; charset=utf-8' },
    ]) {
      expect(repairStrayCloseTag('123</body>', headers)?.body, JSON.stringify(headers)).toBe('123');
    }
  });

  it('(b) is REDUNDANT under (c), and that is recorded rather than re-derived', () => {
    // No body both parses and ends in a closing tag — valid JSON ends in `}`, `]`, `"`, a digit
    // or `e`/`l`, never in `>`. So (b) refuses nothing that (c) would accept. It stays in the
    // function because it states the guarantee directly; this test is why nobody has to work
    // that out again.
    const parses = (s: string): boolean => {
      try {
        JSON.parse(s);
        return true;
      } catch {
        return false;
      }
    };
    const endsInTag = (s: string): boolean => /<\/[A-Za-z][\w:-]*>\s*$/.test(s);
    const corpus = [
      '{"a":1}', '[1,2]', '"s"', '123', 'true', 'null', '{"h":"</body>"}',
      '"x</body>"', '["</p>"]', '{"a":1} ', '{"a":1}\n', '[]', '{}',
    ];
    expect(corpus.filter((s) => parses(s) && endsInTag(s))).toEqual([]);
    // Positive control: the two predicates are not both vacuous on this corpus.
    expect(corpus.filter(parses).length).toBe(corpus.length);
    expect(['[1,2]</body>', '{"a":1}</html>'].filter(endsInTag).length).toBe(2);
  });
});
