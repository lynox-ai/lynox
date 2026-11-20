import { describe, expect, it } from 'vitest';
import { judgeOutliers, markersOf, OUTLIER_MIN_VERDICTS, type OutlierFieldKind, type OutlierInput } from './bulk-outliers.js';

const OWN = ['teehaus.example.ch'];
const KINDS: Record<string, OutlierFieldKind> = { title: 'text', description: 'text', status: 'enum', weight_g: 'number', vegan: 'boolean' };
const SORTS = ['Grüntee', 'Schwarztee', 'Kräutertee', 'Rooibos', 'Mate', 'Chai', 'Oolong', 'Weisstee'];
const ADJ = ['mild', 'kräftig', 'blumig', 'frisch', 'würzig', 'rund', 'fein', 'herb'];

/** One plausible verdict of a run that rewrites tea descriptions: lengths vary by about ±30 %, one to
 *  three fields change, numbers that are no phone numbers (EAN, dimensions, prices) appear in text. */
function plausible(seq: number): OutlierInput {
  const sort = SORTS[seq % SORTS.length]!;
  const adj = ADJ[(seq * 3) % ADJ.length]!;
  const grams = 50 + (seq % 5) * 25;
  const filler = ' Aus kontrolliert biologischem Anbau.'.repeat(seq % 3);
  const before = {
    title: `${sort} ${grams} g`,
    description: `${sort}, ${adj}. EAN 76${String(1000000000 + seq * 7919).slice(0, 11)}. Dose 12 x 8 cm, CHF 1'299.–${filler}`,
    status: 'active',
    weight_g: grams,
    vegan: true,
  };
  const after = {
    ...before,
    description: `Unser ${sort} schmeckt ${adj} und ausgewogen. EAN 76${String(1000000000 + seq * 7919).slice(0, 11)}. Dose 12 x 8 cm, Art. 4711-${seq}, CHF 1'299.–${filler}`,
    ...(seq % 4 === 0 ? { title: `${sort}, ${adj}, ${grams} g` } : {}),
    ...(seq % 7 === 0 ? { weight_g: grams + 5 } : {}),
  };
  return { seq, before, after };
}

const run = (n: number, replace: (t: OutlierInput) => OutlierInput = (t) => t): OutlierInput[] =>
  Array.from({ length: n }, (_, i) => replace(plausible(i + 1)));

const flaggedSeqs = (inputs: OutlierInput[]) => judgeOutliers(inputs, OWN, KINDS).flagged.map((f) => f.seq);

function withAfter(t: OutlierInput, patch: Record<string, unknown>): OutlierInput {
  return { ...t, after: { ...(t.after as Record<string, unknown>), ...patch } };
}

describe('judgeOutliers', () => {
  it('flags no verdict of a run of 200 plausible ones, with EANs, dimensions, prices and article numbers in text', () => {
    const result = judgeOutliers(run(200), OWN, KINDS);
    expect(result).toMatchObject({ decided: 200, measured: true, flagged: [], spread: [] });
  });

  it('flags nothing and says it did not measure below 20 verdicts, even with an injected link', () => {
    const inputs = run(OUTLIER_MIN_VERDICTS - 1, (t) => (t.seq === 3 ? withAfter(t, { description: 'Mehr auf evil.example.com' }) : t));
    expect(judgeOutliers(inputs, OWN, KINDS)).toEqual({ decided: 19, measured: false, flagged: [], spread: [] });
  });

  it('flags the one verdict among 200 that adds a link its before text does not hold, and only it', () => {
    const inputs = run(200, (t) => (t.seq === 137
      ? withAfter(t, { description: `${(t.after as Record<string, string>)['description']} Jetzt günstiger auf https://tee-deals.example.net/x` })
      : t));
    expect(judgeOutliers(inputs, OWN, KINDS).flagged).toEqual([{ seq: 137, reasons: ['new_link'] }]);
  });

  it.each([
    ['written as words', 'Bestellen unter teedeals dot net'],
    ['with a bracketed dot', 'Bestellen unter teedeals[.]net'],
    ['as hxxp', 'Bestellen unter hxxps://teedeals.net/'],
    ['in punycode', 'Bestellen unter xn--tee-deal-q2a.net'],
  ])('counts an obfuscated link %s as a new link', (_name, text) => {
    const inputs = run(200, (t) => (t.seq === 42 ? withAfter(t, { description: text }) : t));
    expect(judgeOutliers(inputs, OWN, KINDS).flagged.find((f) => f.seq === 42)?.reasons).toContain('new_link');
  });

  it('flags a new e-mail address and a new phone number, each with its own reason', () => {
    const inputs = run(200, (t) => {
      if (t.seq === 10) return withAfter(t, { description: 'Fragen an bestellung@teedeals.example.net' });
      if (t.seq === 20) return withAfter(t, { description: 'Bestellungen: +41 44 123 45 67' });
      if (t.seq === 30) return withAfter(t, { description: 'Hotline 044 123 45 67' });
      return t;
    });
    const result = judgeOutliers(inputs, OWN, KINDS).flagged;
    expect(result.find((f) => f.seq === 10)?.reasons).toContain('new_email');
    expect(result.find((f) => f.seq === 20)?.reasons).toContain('new_phone');
    expect(result.find((f) => f.seq === 30)?.reasons).toContain('new_phone');
  });

  it('flags a script scheme in text', () => {
    const inputs = run(200, (t) => (t.seq === 55 ? withAfter(t, { description: 'Klick: javascript:alert(1)' }) : t));
    expect(judgeOutliers(inputs, OWN, KINDS).flagged.find((f) => f.seq === 55)?.reasons).toContain('new_script');
  });

  it('does not flag a link to the store or a start domain, nor a link or number the before text already holds', () => {
    const inputs = run(200, (t) => {
      const desc = (x: unknown) => (x as Record<string, string>)['description'];
      if (t.seq === 11) return withAfter(t, { description: `${desc(t.after)} Mehr auf https://shop.teehaus.example.ch/tee` });
      if (t.seq === 12) {
        return { ...t, before: { ...(t.before as object), description: `${desc(t.before)} Info: partner.example.org, +41 44 999 88 77` },
          after: { ...(t.after as object), description: `${desc(t.after)} Infos: partner.example.org, +41 44 999 88 77.` } };
      }
      return t;
    });
    expect(flaggedSeqs(inputs)).toEqual([]);
  });

  it('names a link that most verdicts add on a line for the run, and still flags each verdict whose host no before text holds', () => {
    const inputs = run(200, (t) => withAfter(t, { description: `${(t.after as Record<string, string>)['description']} Lieferant: https://feed-partner.example.biz/p` }));
    const result = judgeOutliers(inputs, OWN, KINDS);
    expect(result.spread).toEqual([{ kind: 'link', count: 200, hosts: ['feed-partner.example.biz'] }]);
    expect(result.flagged).toHaveLength(200);
    expect(result.flagged.every((f) => f.reasons.includes('new_link'))).toBe(true);
  });

  it('names a link many verdicts add for the run without flagging each, when before texts of the run already hold it', () => {
    const inputs = run(200, (t) => {
      if (t.seq <= 5) return { ...t, before: { ...(t.before as object), description: `${(t.before as Record<string, string>)['description']} Siehe tee-wissen.example.org` } };
      if (t.seq <= 40) return withAfter(t, { description: `${(t.after as Record<string, string>)['description']} Mehr: tee-wissen.example.org` });
      return t;
    });
    const result = judgeOutliers(inputs, OWN, KINDS);
    expect(result.spread).toEqual([{ kind: 'link', count: 35, hosts: ['tee-wissen.example.org'] }]);
    expect(result.flagged).toEqual([]);
  });

  it('flags a verdict that changes far more fields than the rest', () => {
    const inputs = run(200, (t) => (t.seq === 77
      ? withAfter(t, { title: 'Neu', status: 'draft', weight_g: 75, vegan: false, description: `${(t.after as Record<string, string>)['description']} Neu.` })
      : t));
    expect(judgeOutliers(inputs, OWN, KINDS).flagged.find((f) => f.seq === 77)?.reasons).toContain('changed_fields');
  });

  it('flags a text whose length jumps against the rest of the run, and judges texts filled from empty only among themselves', () => {
    const long = 'Ein sehr ausführlicher Text. '.repeat(40);
    const inputs = run(200, (t) => {
      if (t.seq === 90) return withAfter(t, { description: long });
      // 30 targets whose description was empty: each filled with an ordinary text.
      if (t.seq > 160 && t.seq <= 190) return { ...t, before: { ...(t.before as object), description: '' } };
      return t;
    });
    const result = judgeOutliers(inputs, OWN, KINDS).flagged;
    expect(result.find((f) => f.seq === 90)?.reasons).toContain('length_jump');
    expect(result.filter((f) => f.seq > 160 && f.seq <= 190)).toEqual([]);
  });

  it('flags a rare value in an enum or boolean field the verdict changed, and a number far off the run\'s change', () => {
    const inputs = run(200, (t) => {
      if (t.seq === 101) return withAfter(t, { status: 'archived' });
      if (t.seq === 102) return withAfter(t, { vegan: false });
      if (t.seq === 103) return withAfter(t, { weight_g: 5000 });
      return t;
    });
    const result = judgeOutliers(inputs, OWN, KINDS).flagged;
    for (const seq of [101, 102, 103]) expect(result.find((f) => f.seq === seq)?.reasons).toContain('rare_value');
  });

  it('lists every reason of a verdict in a fixed order', () => {
    const inputs = run(200, (t) => (t.seq === 5
      ? withAfter(t, { status: 'archived', description: `Kontakt: info@teedeals.example.net, +41 44 123 45 67, ${'x'.repeat(900)}` })
      : t));
    expect(judgeOutliers(inputs, OWN, KINDS).flagged).toEqual([{ seq: 5, reasons: ['new_email', 'new_phone', 'rare_value', 'length_jump'] }]);
  });
});

describe('markersOf', () => {
  it('reads no link, address or phone number in product text with abbreviations, EANs, dimensions and prices', () => {
    const text = "z.B. Art.Nr. 4711-12, ca. 5 kg, inkl. MwSt., EAN 7612345678901, 120 x 80 cm, CHF 1'299.–, Gr. M, v2.0";
    const m = markersOf(text);
    expect([...m.values()].every((s) => s.size === 0)).toBe(true);
  });

  it('reads hosts lower case, without www, port or obfuscation', () => {
    expect([...markersOf('Siehe WWW.Example.COM:8080/x und example dot org').get('link')!]).toEqual(['example.com', 'example.org']);
  });
});
