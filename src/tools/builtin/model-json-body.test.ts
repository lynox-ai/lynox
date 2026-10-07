import { describe, expect, it } from 'vitest';
import { repairStrayCloseTag } from './model-json-body.js';

const JSON_CT = { 'Content-Type': 'application/json' } as const;
const HTML_CT = { 'Content-Type': 'text/html' } as const;

describe('repairStrayCloseTag — the shape the model actually produced', () => {
  it('takes `</body>` off a JSON array and reports exactly what it removed', () => {
    const got = repairStrayCloseTag('[{"location_code":2756,"keywords":["botox aarau"]}]</body>', JSON_CT);
    expect(got?.body).toBe('[{"location_code":2756,"keywords":["botox aarau"]}]');
    expect(got?.removed).toBe('</body>');
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
    expect(repairStrayCloseTag('{"a":1}\n  </body>\n', JSON_CT)?.body).toBe('{"a":1}');
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

  it('caps what it reports, because the caller puts it in a system line', () => {
    // The tag grammar forbids whitespace and punctuation, so no sentence fits — but the NAME is
    // unbounded, and the note that quotes it sits outside the untrusted-data wrap.
    const long = `</${'a'.repeat(200)}>`;
    const got = repairStrayCloseTag(`{"a":1}${long}`, JSON_CT);
    expect(got?.body).toBe('{"a":1}');
    expect(got?.removed.length).toBeLessThanOrEqual(40);
    expect(got?.removed.endsWith('…')).toBe(true);
    // …and a normal tag is reported whole, or the cap would be hiding the useful case.
    expect(repairStrayCloseTag('{"a":1}</body>', JSON_CT)?.removed).toBe('</body>');
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
