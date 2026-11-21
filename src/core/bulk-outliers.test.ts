import { describe, expect, it } from 'vitest';
import { judgeOutliers, markersOf, OUTLIER_MIN_VERDICTS, targetMarkers, type OutlierFieldKind, type OutlierInput } from './bulk-outliers.js';
import { TOP_LEVEL_DOMAINS } from './top-level-domains.js';

const OWN = ['teehaus.example.ch'];
const KINDS: Record<string, OutlierFieldKind> = { title: 'text', description: 'text', status: 'enum', weight_g: 'number', vegan: 'boolean', price: 'number', origin: 'text', note: 'text' };
const SORTS = ['Grüntee', 'Schwarztee', 'Kräutertee', 'Rooibos', 'Mate', 'Chai', 'Oolong', 'Weisstee'];
const ADJ = ['mild', 'kräftig', 'blumig', 'frisch', 'würzig', 'rund', 'fein', 'herb'];

/** One plausible verdict of a run that rewrites tea descriptions and raises every price by 8 %: lengths
 *  vary by about ±30 %, two to four fields change, each price is its own value, and numbers that are no
 *  phone numbers (EAN, dimensions, prices, part numbers) appear in text. */
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
    price: Math.round((9.9 + seq * 1.37) * 100) / 100,
    origin: 'Schweiz',
    note: `Bestellnummer 0815 ${String(123456 + seq)}`,
  };
  const after = {
    ...before,
    description: `Unser ${sort} schmeckt ${adj} und ausgewogen. EAN 76${String(1000000000 + seq * 7919).slice(0, 11)}. Dose 12 x 8 cm, Art. 4711-${seq}, CHF 1'299.–${filler}`,
    price: Math.round((9.9 + seq * 1.37) * 108) / 100,
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
  it('flags no verdict of a run of 200 plausible ones that each raise a price of their own, with EANs, dimensions, prices and part numbers in text', () => {
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
    ['as hxxp, with a top-level domain no list holds', 'Bestellen unter hxxps://teedeals.zz/'],
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
      ? withAfter(t, { title: 'Neu', status: 'draft', weight_g: 75, vegan: false, origin: 'Japan', note: 'Neu', description: `${(t.after as Record<string, string>)['description']} Neu.` })
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

describe('judgeOutliers on domains in other scripts, phone numbers and the own shop', () => {
  it('reads a domain with an umlaut whole, as the own shop when it is one and as new when a letter is added', () => {
    const own = ['möbel-meier.ch'];
    const inputs = run(200, (t) => {
      const desc = (t.after as Record<string, string>)['description'];
      if (t.seq === 8) return withAfter(t, { description: `${desc} Mehr auf möbel-meier.ch` });
      if (t.seq === 9) return withAfter(t, { description: `${desc} Mehr auf neu-ömöbel-meier.ch` });
      if (t.seq === 10) return withAfter(t, { description: `${desc} Mehr auf evіl.com` });
      return t;
    });
    const result = judgeOutliers(inputs, own, KINDS);
    expect(result.flagged.map((f) => f.seq)).toEqual([9, 10]);
    expect([...markersOf('Mehr auf evіl.com').get('link')!]).toEqual([new URL('http://evіl.com').hostname]);
  });

  it('flags a phone number written with (0), with 00, or behind an EAN that ends in the same digits', () => {
    const inputs = run(200, (t) => {
      const desc = (t.after as Record<string, string>)['description'];
      if (t.seq === 21) return withAfter(t, { description: `${desc} Tel. +41 (0)44 123 45 67` });
      if (t.seq === 22) return withAfter(t, { description: `${desc} Tel. 0041 44 123 45 67` });
      if (t.seq === 23) {
        return { ...t, before: { ...(t.before as object), description: 'EAN 7610441234567' }, after: { ...(t.after as object), description: `${desc} 044 123 45 67` } };
      }
      return t;
    });
    const result = judgeOutliers(inputs, OWN, KINDS).flagged;
    for (const seq of [21, 22, 23]) expect(result.find((f) => f.seq === seq)?.reasons).toContain('new_phone');
  });

  it('holds a phone number the before text writes as a run of digits with its country, but not one an EAN merely ends in', () => {
    const added = (before: string, after: string): string[] => [...targetMarkers({ seq: 1, before: { description: before }, after: { description: after } }, OWN).added.get('phone')!];
    expect(added('Tel 41441234567', 'Tel +41 44 123 45 67')).toEqual([]);
    expect(added('EAN 7610441234567', 'Tel 044 123 45 67')).toEqual(['41441234567']);
  });

  it('flags an address to a host the before text names only as a link, whatever its local part', () => {
    for (const local of ['info', '_', '-', '+']) {
      const m = targetMarkers({ seq: 1, before: { description: 'Partner: lieferant.ch' }, after: { description: `Partner: lieferant.ch, ${local}@lieferant.ch` } }, OWN);
      expect([...m.added.get('email')!], local).toEqual(['lieferant.ch']);
    }
  });

  it('lists a verdict with a new link before many that only jump in length, and names a host that marks no row first', () => {
    const inputs = run(200, (t) => {
      const desc = (t.after as Record<string, string>)['description'];
      if (t.seq <= 60) return withAfter(t, { description: desc.repeat(6) });
      if (t.seq === 150) return withAfter(t, { description: `${desc} Mehr auf neu-tee.example.net` });
      return t;
    });
    const flagged = judgeOutliers(inputs, OWN, KINDS).flagged;
    expect(flagged[0]).toEqual({ seq: 150, reasons: ['new_link'] });
    // A host most verdicts add: the one some before-image holds is named before one with more rows.
    const spreadInputs = run(200, (t) => {
      const desc = (t.after as Record<string, string>)['description'];
      if (t.seq === 1) return { ...t, before: { ...(t.before as object), note: 'Partner gepflanzt-shop.net' } };
      if (t.seq <= 20) return withAfter(t, { description: `${desc} gepflanzt-shop.net` });
      if (t.seq <= 60) return withAfter(t, { description: `${desc} haeufig-shop.net` });
      return t;
    });
    expect(judgeOutliers(spreadInputs, OWN, KINDS).spread.find((x) => x.kind === 'link')!.hosts).toEqual(['gepflanzt-shop.net', 'haeufig-shop.net']);
  });

  it('does not flag a verdict that changes four fields where the run changes one or two, and flags one that changes all eight', () => {
    const fields = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const inputs: OutlierInput[] = Array.from({ length: 40 }, (_, i) => {
      const seq = i + 1;
      const n = seq === 7 ? 4 : seq === 9 ? 8 : seq % 2 === 0 ? 1 : 2;
      const before = Object.fromEntries(fields.map((f) => [f, `alt ${f}${String(seq)}`]));
      const after = Object.fromEntries(fields.map((f, k) => [f, k < n ? `neu ${f}${String(seq)}` : `alt ${f}${String(seq)}`]));
      return { seq, before, after };
    });
    expect(judgeOutliers(inputs, OWN).flagged).toEqual([{ seq: 9, reasons: ['changed_fields'] }]);
  });

  it('holds a phone number the before text writes without grouping', () => {
    const inputs = run(200, (t) => (t.seq === 24
      ? { ...t, before: { ...(t.before as object), note: 'Tel 0441234567' }, after: { ...(t.after as object), note: 'Tel 044 123 45 67' } }
      : t));
    expect(flaggedSeqs(inputs)).toEqual([]);
  });
});

/** Every form of a link or an address in text that some earlier reading of this module flagged,
 *  collected over four review rounds: a later change to the reading must still flag each. The own
 *  shop's domain stands in some to show that it does not hide the foreign one. */
const FORMS_ONCE_CAUGHT = [
    'evil.com_', 'Besuch evil.com_ jetzt', '_evil.com_', '*evil.com*', '**evil.com**', 'evil.com%20', 'evil.com+',
    '+evil.com', 'evil.com@', 'evil.com@home', 'evil.com@x.y', '.evil.com.', '-evil.com-', '...evil.com...',
    'info@evil.com_', 'info@evil.com_x', 'info_x@evil.com', '%info@evil.com', 'a+b@evil.com', 'https://user:pw@evil.com/x',
    'https://moebel-meier.ch@evil.icu', 'hxxps://evil.icu', 'https://evil.icu:8080', 'evil.\u017fhop', 'evil.\u017fite',
    'evil.\u017ftore', 'evil.u\u017f', 'evil.lin\u212a', 'EVIL.\u017fHOP', 'evil.\u0282hop', '\ud835\udc1e\ud835\udc2f\ud835\udc22\ud835\udc25.com',
    'evil.\ud835\udc1c\ud835\udc28\ud835\udc26', 'evil.\uff43\uff4f\uff4d', '\u0435vil.com', 'evil.\u0440\u0444',
    'evil.\u4e2d\u56fd', 'evil.xn--p1ai', 'evil.XN--P1AI', '\u0448\u043e\u043f.\u0440\u0444', 'ev\u200dil.com',
    'ev\u00adil.com', 'ev\u0301il.com', '\u00e9vil.com', 'evil.c\u00f3m', 'evil\u3002com', 'evil\uff0ecom',
    'evil\uff61com', 'evil[.]com', 'evil(dot)com', 'evil dot com', 'Evil.Com', 'Evil.Io', 'Evil.Ly', 'Evil.Ai',
    'www.Evil.De', 'EVIL.DE', 'Evil.DE', 'Evil.Xn--p1ai', 'info@Evil.De', 'info@evil.icu', 'http://1.2.3.4/',
    'http://0x7f.1/', 'evil.com\\x', 'https://evil.com\\@moebel-meier.ch', 'Visit evil.com.', 'Visit evil.com, now',
    'evil.com/path', '(evil.com)', '"evil.com"', '<evil.com>', 'evil.com?', 'evil.com#x', 'evil.com:80',
    'evil.co.uk', 'a.b.c.evil.shop', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.com',
    'a_b.com', 'evil.com_x.net', '%evil.com', 'x@y@evil.com', 'info@evil.com@x', 'info@evil.com%', 'info@evil.com+',
    'info@evil.com.', 'info@evil.icu-', 'a%2Fevil.com', 'evil.com%2F', 'x+evil.icu', 'moebel-meier.ch@evil.icu',
    'a@b.c', 'z.B._evil.com', 'evil.co_uk', 'www.Evil.De_', 'evil.\u017fhop_', 'mail@evil.\u0131o', 'evil.\u0131o',
    'evil.\u0131cu', 'x.\u017fhop+', 'evil.com@@x', '@@evil.com', 'evil.com@.', 'a.com a.com a.com a.com a.com ',
    'evil.icu%', 'evil.com_evil.icu', '%%evil.icu%%', 'evil.icu@', 'user@evil.icu@', 'see@evil.icu', 'Kontakt@Evil.De',
    'info@evil.com@', 'Schreib an info@evil.com@ heute', 'a@evil.com@b', 'info@evil.com@moebel-meier.ch',
    'info@evil.icu_x@moebel-meier.ch', 'kontakt@evil.icu@x.ch', 'evil.com_shop', 'Besuche evil.com_jetzt',
    'go_now.evil.com', 'a_b.evil.com', 'go_now.evil.com/x', '%65vil.com', 'ev%69l.com', '%41evil.com', 'e%41vil.com',
    'info%40evil.com', 'https%3A%2F%2Fevil.com', 'evil.com%40x.y',
];

/** Links and addresses, by kind and host, that some earlier reading found in those forms; each pair
 *  here must still be read. Not here:
 *  the hosts an earlier reading cut wrongly out of a percent escape (`2fevil.com` for `%2Fevil.com`)
 *  or out of a user part (`user` for `https://user:pw@evil.com`), a hyphen it kept at a domain's end,
 *  and `@@evil.com`, which has no local part and is read as a link. */
const MARKERS_ONCE_READ: [string, string][] = [
    ['evil.com_', 'link:evil.com'], ['Besuch evil.com_ jetzt', 'link:evil.com'], ['_evil.com_', 'link:evil.com'],
    ['*evil.com*', 'link:evil.com'], ['**evil.com**', 'link:evil.com'], ['evil.com%20', 'link:evil.com'],
    ['evil.com+', 'link:evil.com'], ['+evil.com', 'link:evil.com'], ['evil.com@', 'link:evil.com'], ['evil.com@home', 'link:evil.com'],
    ['evil.com@x.y', 'email:x.y'], ['.evil.com.', 'link:evil.com'], ['-evil.com-', 'link:evil.com'], ['...evil.com...', 'link:evil.com'],
    ['info@evil.com_', 'email:evil.com'], ['info@evil.com_x', 'email:evil.com'], ['info_x@evil.com', 'email:evil.com'],
    ['%info@evil.com', 'email:evil.com'], ['a+b@evil.com', 'email:evil.com'], ['https://user:pw@evil.com/x', 'email:evil.com'],
    ['https://user:pw@evil.com/x', 'link:evil.com'], ['https://moebel-meier.ch@evil.icu', 'email:evil.icu'],
    ['https://moebel-meier.ch@evil.icu', 'link:evil.icu'], ['hxxps://evil.icu', 'link:evil.icu'], ['https://evil.icu:8080', 'link:evil.icu'],
    ['evil.\u017fhop', 'link:evil.shop'], ['evil.\u017fite', 'link:evil.site'], ['evil.\u017ftore', 'link:evil.store'],
    ['evil.u\u017f', 'link:evil.us'], ['evil.lin\u212a', 'link:evil.link'], ['EVIL.\u017fHOP', 'link:evil.shop'],
    ['evil.\u0282hop', 'link:evil.xn--hop-0xb'], ['\ud835\udc1e\ud835\udc2f\ud835\udc22\ud835\udc25.com', 'link:evil.com'],
    ['evil.\ud835\udc1c\ud835\udc28\ud835\udc26', 'link:evil.com'], ['evil.\uff43\uff4f\uff4d', 'link:evil.com'],
    ['\u0435vil.com', 'link:xn--vil-qdd.com'], ['evil.\u0440\u0444', 'link:evil.xn--p1ai'], ['evil.\u4e2d\u56fd', 'link:evil.xn--fiqs8s'],
    ['evil.xn--p1ai', 'link:evil.xn--p1ai'], ['evil.XN--P1AI', 'link:evil.xn--p1ai'], ['\u0448\u043e\u043f.\u0440\u0444', 'link:xn--n1acz.xn--p1ai'],
    ['ev\u200dil.com', 'link:il.com'], ['ev\u00adil.com', 'link:il.com'], ['ev\u0301il.com', 'link:il.com'],
    ['\u00e9vil.com', 'link:xn--vil-9la.com'], ['evil.c\u00f3m', 'link:evil.xn--cm-5ja'], ['evil\u3002com', 'link:evil.com'],
    ['evil\uff0ecom', 'link:evil.com'], ['evil\uff61com', 'link:evil.com'], ['evil[.]com', 'link:evil.com'],
    ['evil(dot)com', 'link:evil.com'], ['evil dot com', 'link:evil.com'], ['Evil.Com', 'link:evil.com'],
    ['Evil.Io', 'link:evil.io'], ['Evil.Ly', 'link:evil.ly'], ['Evil.Ai', 'link:evil.ai'], ['www.Evil.De', 'link:evil.de'],
    ['EVIL.DE', 'link:evil.de'], ['Evil.DE', 'link:evil.de'], ['Evil.Xn--p1ai', 'link:evil.xn--p1ai'], ['info@Evil.De', 'email:evil.de'],
    ['info@evil.icu', 'email:evil.icu'], ['http://1.2.3.4/', 'link:1.2.3.4'], ['http://0x7f.1/', 'link:127.0.0.1'],
    ['evil.com\\x', 'link:evil.com'], ['https://evil.com\\@moebel-meier.ch', 'link:evil.com'], ['Visit evil.com.', 'link:evil.com'],
    ['Visit evil.com, now', 'link:evil.com'], ['evil.com/path', 'link:evil.com'], ['(evil.com)', 'link:evil.com'],
    ['"evil.com"', 'link:evil.com'], ['<evil.com>', 'link:evil.com'], ['evil.com?', 'link:evil.com'], ['evil.com#x', 'link:evil.com'],
    ['evil.com:80', 'link:evil.com'], ['evil.co.uk', 'link:evil.co.uk'], ['a.b.c.evil.shop', 'link:a.b.c.evil.shop'],
    ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.com', 'link:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.com'],
    ['a_b.com', 'link:b.com'], ['evil.com_x.net', 'link:evil.com'], ['evil.com_x.net', 'link:x.net'], ['%evil.com', 'link:evil.com'],
    ['x@y@evil.com', 'email:evil.com'], ['info@evil.com@x', 'email:evil.com'], ['info@evil.com%', 'email:evil.com'],
    ['info@evil.com+', 'email:evil.com'], ['info@evil.com.', 'email:evil.com'], ['info@evil.icu-', 'email:evil.icu'],
    ['a%2Fevil.com', 'link:evil.com'], ['evil.com%2F', 'link:evil.com'], ['x+evil.icu', 'link:evil.icu'],
    ['moebel-meier.ch@evil.icu', 'email:evil.icu'], ['a@b.c', 'email:b.c'], ['z.B._evil.com', 'link:evil.com'],
    ['evil.co_uk', 'link:evil.co'], ['www.Evil.De_', 'link:evil.de'], ['evil.\u017fhop_', 'link:evil.shop'],
    ['mail@evil.\u0131o', 'email:evil.xn--o-eka'], ['evil.\u0131o', 'link:evil.xn--o-eka'], ['evil.\u0131cu', 'link:evil.xn--cu-gpa'],
    ['x.\u017fhop+', 'link:x.shop'], ['evil.com@@x', 'link:evil.com'], ['evil.com@.', 'link:evil.com'], ['a.com a.com a.com a.com a.com ', 'link:a.com'],
    ['evil.icu%', 'link:evil.icu'], ['evil.com_evil.icu', 'link:evil.com'], ['%%evil.icu%%', 'link:evil.icu'],
    ['evil.icu@', 'link:evil.icu'], ['user@evil.icu@', 'email:evil.icu'], ['see@evil.icu', 'email:evil.icu'],
    ['Kontakt@Evil.De', 'email:evil.de'], ['_@x.ch', 'email:x.ch'], ['-@x.ch', 'email:x.ch'], ['+@x.ch', 'email:x.ch'],
    ['.@x.ch', 'email:x.ch'], ['%@x.ch', 'email:x.ch'], ['a@@x.ch', 'email:x.ch'], ['info@evil.com@', 'email:evil.com'],
    ['Schreib an info@evil.com@ heute', 'email:evil.com'], ['a@evil.com@b', 'email:evil.com'], ['info@evil.com@moebel-meier.ch', 'email:evil.com'],
    ['info@evil.icu_x@moebel-meier.ch', 'email:evil.icu'], ['kontakt@evil.icu@x.ch', 'email:evil.icu'], ['kontakt@evil.icu@x.ch', 'email:x.ch'],
    ['evil.com_shop', 'link:evil.com'], ['Besuche evil.com_jetzt', 'link:evil.com'], ['go_now.evil.com', 'link:now.evil.com'],
    ['a_b.evil.com', 'link:b.evil.com'], ['go_now.evil.com/x', 'link:now.evil.com'], ['%65vil.com', 'link:vil.com'],
    ['ev%69l.com', 'link:l.com'], ['%41evil.com', 'link:evil.com'], ['e%41vil.com', 'link:vil.com'], ['info%40evil.com', 'link:evil.com'],
    ['https%3A%2F%2Fevil.com', 'link:evil.com'], ['evil.com%40x.y', 'link:evil.com'],
];

describe('markersOf against every form an earlier reading caught', () => {
  it('flags a foreign link or address in each of them', () => {
    const own = ['moebel-meier.ch'];
    const foreign = (text: string): string[] => [...markersOf(text)]
      .filter(([kind]) => kind === 'link' || kind === 'email')
      .flatMap(([, keys]) => [...keys].filter((h) => !own.some((d) => h === d || h.endsWith(`.${d}`))));
    const missed = FORMS_ONCE_CAUGHT.filter((text) => foreign(text).length === 0);
    expect(missed).toEqual([]);
    expect(FORMS_ONCE_CAUGHT.length).toBe(127);
  });

  it('reads each link and address an earlier reading read in them, by kind and host', () => {
    const missed = MARKERS_ONCE_READ.filter(([text, marker]) => {
      const [kind, host] = [marker.slice(0, marker.indexOf(':')), marker.slice(marker.indexOf(':') + 1)];
      return !markersOf(text).get(kind as 'link' | 'email')!.has(host);
    });
    expect(missed).toEqual([]);
    expect(MARKERS_ONCE_READ.length).toBe(136);
  });
});

describe('markersOf', () => {
  it('reads no link where a full stop lacks its space before a word, nor a part number or a GTIN as a phone number', () => {
    const m = markersOf('Aus Baumwolle.Es ist weich. Holz.Co und Stk.No. Bestellnummer 0815 123456, Teil 0711 2345678, EAN 0041234567890, Lot 00123456789.');
    expect([...m.values()].every((x) => x.size === 0)).toBe(true);
  });

  it('reads a host under any top-level domain written in lower case or capitals, and no abbreviation or file name', () => {
    for (const text of ['Mehr auf evil.cloud', 'evil.swiss', 'evil.live', 'EVIL.SWISS', 'evil.zip']) {
      expect([...markersOf(text).get('link')!], text).toHaveLength(1);
    }
    for (const text of ['Art.Nr 4711', 'Str.St Gallen', 'Tel.Tel', 'datei.pdf']) {
      expect([...markersOf(text).get('link')!], text).toEqual([]);
    }
    expect(TOP_LEVEL_DOMAINS.size).toBe(1449);
  });

  it('reads a host whose dot markup or a character reference hides, or blanks or braces surround', () => {
    for (const text of ['evil&#46;com', 'evil&#x2e;com', 'evil<b></b>.com', 'evil<span>.</span>com', '<p>Mehr auf evil.com</p>', 'evil . com', 'evil{.}com']) {
      expect([...markersOf(text).get('link')!], text).toEqual(['evil.com']);
    }
    expect([...markersOf('info&#64;evil.com').get('link')!]).toEqual(['evil.com']);
  });

  it('reads no host across the end of one paragraph and the start of the next, in any case', () => {
    for (const word of ['design', 'Design', 'DESIGN', 'black', 'Black', 'bio']) {
      for (const tag of ['</p><p>', '<br>', '</li><li>', '</div>\n<div class="x">', '</td><td>']) {
        const text = `<p>Aus Eiche.${tag}${word} zeitlos</p>`;
        expect([...markersOf(text).get('link')!], text).toEqual([]);
      }
    }
  });

  it('reads a capitalised host only under a common top-level domain, and any in lower case or capitals', () => {
    expect([...markersOf('Navy.Black, Material.Bio, Holz.Art, Eiche.Design').get('link')!]).toEqual([]);
    expect([...markersOf('Evil.Com und Evil.Shop').get('link')!].sort()).toEqual(['evil.com', 'evil.shop']);
    expect([...markersOf('evil.design und EVIL.CLOUD').get('link')!].sort()).toEqual(['evil.cloud', 'evil.design']);
    expect([...markersOf('Evil.Xn--p1ai').get('link')!]).toEqual(['evil.xn--p1ai']);
    expect([...markersOf('Evil.Рф').get('link')!]).toEqual(['evil.xn--p1ai']);
  });

  it('reads a host however its top-level domain is capitalised, where that domain is no word, and one under icu', () => {
    for (const text of ['Besuche Evil.Com', 'evil.Com', 'Evil.Shop heute', 'evil.Ch heute', 'Besuche evil.icu']) {
      expect([...markersOf(text).get('link')!], text).toHaveLength(1);
    }
  });

  it('reads a Swiss number grouped, ungrouped or in parts, and keys it by its country', () => {
    for (const text of ['044 123 45 67', '044 1234567', '0441234567', '044.123.45.67', '+41 44 123 45 67', '0041 44 123 45 67', '+41 (0)44 123 45 67']) {
      expect([...markersOf(text).get('phone')!], text).toEqual(['41441234567']);
    }
    expect([...markersOf('+49 44 123 45 67').get('phone')!]).toEqual(['49441234567']);
  });

  it('ends a host at a backslash and takes the host after the user, refuses one longer than a host may be, and reads full stops of other scripts as dots', () => {
    // The address ends at the backslash: evil.icu is the host; the own shop after the @ is read as a word too.
    expect([...markersOf('https://evil.icu\\@moebel-meier.ch/').get('link')!].sort()).toEqual(['evil.icu', 'moebel-meier.ch']);
    // The link goes to evil.icu, whatever the user part names; that part is read as a word too.
    expect([...markersOf('https://moebel-meier.ch@evil.icu/').get('link')!].sort()).toEqual(['evil.icu', 'moebel-meier.ch']);
    expect([...markersOf('https://shop@evil.icu/').get('link')!]).toEqual(['evil.icu']);
    // A host whose top-level domain is on no list is read only from the address: up to the backslash.
    expect([...markersOf('https://evil.zz\\@moebel-meier.ch/').get('link')!].sort()).toEqual(['evil.zz', 'moebel-meier.ch']);
    expect([...markersOf(`Mehr auf ${'a'.repeat(63)}.com`).get('link')!]).toEqual([`${'a'.repeat(63)}.com`]);
    expect([...markersOf(`Mehr auf ${'a'.repeat(64)}.com`).get('link')!]).toEqual([]);
    // 125 labels and com: 253 characters, the longest a host may be; one label more is not one.
    expect([...markersOf(`Mehr auf ${'a.'.repeat(125)}com`).get('link')!]).toHaveLength(1);
    expect([...markersOf(`Mehr auf ${'a.'.repeat(126)}com`).get('link')!]).toEqual([]);
    for (const dot of ['\u3002', '\uFF0E', '\uFF61']) expect([...markersOf(`Mehr auf evil${dot}com`).get('link')!], dot).toEqual(['evil.com']);
  });

  it('reads no host cut out of a percent escape, an address after every @, and a host on each side of an underscore', () => {
    expect([...markersOf('Mehr auf https://x.example/?ref=https%3A%2F%2Fmoebel-meier.ch').get('link')!].sort()).toEqual(['moebel-meier.ch', 'x.example']);
    expect([...markersOf('x@y@evil.com').get('email')!]).toEqual(['evil.com']);
    expect([...markersOf('info@evil.com@').get('email')!]).toEqual(['evil.com']);
    expect([...markersOf('kontakt@evil.icu@x.ch').get('email')!].sort()).toEqual(['evil.icu', 'x.ch']);
    // A local part of one sign is a local part: the domain is an address, not a link.
    for (const text of ['_@lieferant.ch', '-@lieferant.ch', '+@lieferant.ch', '.@lieferant.ch', 'a@@lieferant.ch']) {
      expect([...markersOf(text).get('email')!], text).toEqual(['lieferant.ch']);
      expect([...markersOf(text).get('link')!], text).toEqual([]);
    }
    // An _ inside a word cuts it, and every side is read: a hidden host is worth more than the false
    // one a shop name with an underscore yields ("moebel_meier.ch" reads meier.ch).
    expect([...markersOf('go_now.evil.com').get('link')!]).toEqual(['now.evil.com']);
    expect([...markersOf('moebel_meier.ch').get('link')!]).toEqual(['meier.ch']);
  });

  it('reads a host whatever sign stands at its ends or after an @ that starts no address, and a top-level domain with a long s', () => {
    for (const text of ['evil.com_', '_evil.com_', '*evil.com*', 'evil.com%20', 'evil.com+', '+evil.com', 'evil.com@', 'evil.com@home', '.evil.com.', '-evil.com-', 'Besuch evil.com_ jetzt']) {
      expect([...markersOf(text).get('link')!], text).toEqual(['evil.com']);
    }
    for (const text of ['evil.\u017Fhop', 'EVIL.\u017FHOP']) expect([...markersOf(text).get('link')!], text).toEqual(['evil.shop']);
    expect([...markersOf('info@evil.com_').get('email')!]).toEqual(['evil.com']);
  });

  it('reads a host or an address a text repeats thousands of times, as words or as parts of one word, in a fraction of the time as many', () => {
    const time = (text: string): number => { const t0 = performance.now(); markersOf(text); return performance.now() - t0; };
    const many = Array.from({ length: 5000 }, (_, i) => `a${String(i)}.com`);
    time(many.join(' '));
    // The fastest of three runs each, so a pause of the process does not decide.
    const best = (text: string): number => Math.min(time(text), time(text), time(text));
    const distinct = Math.min(best(many.join(' ')), best(many.join('+')));
    expect([...markersOf('a.com '.repeat(5000)).get('link')!]).toEqual(['a.com']);
    expect([...markersOf('a.com+'.repeat(5000)).get('link')!]).toEqual(['a.com']);
    expect(best('a.com '.repeat(5000))).toBeLessThan(distinct / 4);
    expect(best('a.com+'.repeat(5000))).toBeLessThan(distinct / 4);
    // An address is read once per word as well.
    const addresses = Array.from({ length: 5000 }, (_, i) => `i@a${String(i)}.com`).join(' ');
    expect(best('i@a.com '.repeat(5000))).toBeLessThan(best(addresses) / 4);
  });

  it('reads a long run of signs inside a word, of @, of letters before an @, of labels, of brackets, or of blanks and obfuscated dots in time linear in its length', () => {
    const time = (text: string): number => { const t0 = performance.now(); markersOf(text); return performance.now() - t0; };
    // A unit repeated, and what stands before or after the run: a bracket makes the obfuscated dots read.
    const shapes: [string, string, string][] = [['a', '-', 'a'], ['a', '.', 'a'], ['a', '_', 'a'], ['a', '%', 'a'], ['a', '+', 'a'], ['a', '<', 'a'], ['a', '&', 'a'], ['', '@', 'x.ch'], ['', 'a@', 'x.ch'], ['', 'a', '@x.ch'], ['', 'a.', ''], ['', 'a [.] ', ''], ['', 'a dot ', ''], ['[', ' ', ''], ['', ' ', '[.]'], ['', '-a', ''], ['', 'ä.', '']];
    for (const [head, unit, tail] of shapes) {
      const shaped = (n: number): string => head + unit.repeat(n) + tail;
      time(shaped(1000));
      const small = time(shaped(4000));
      const large = time(shaped(32000));
      // Eight times the text: linear stays well under 64 times the time, quadratic does not.
      expect(large, unit).toBeLessThan(Math.max(small, 20) * 24);
    }
  });

  it('reads no link, address or phone number in product text with abbreviations, EANs, dimensions and prices', () => {
    const text = "z.B. Art.Nr. 4711-12, ca. 5 kg, inkl. MwSt., EAN 7612345678901, 120 x 80 cm, CHF 1'299.–, Gr. M, v2.0";
    const m = markersOf(text);
    expect([...m.values()].every((s) => s.size === 0)).toBe(true);
  });

  it('reads hosts lower case, without www, port or obfuscation', () => {
    expect([...markersOf('Siehe WWW.Example.COM:8080/x und example dot org').get('link')!]).toEqual(['example.com', 'example.org']);
  });
});
