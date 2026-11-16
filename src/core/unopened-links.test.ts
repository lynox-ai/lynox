import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';
import { defuseUnopenedLinks, shownAddress } from './unopened-links.js';

// The chat renders with `marked` (GFM on, its default) — the web UI's copy, so the test reads
// the output the way the chat does, autolinker included.
const require = createRequire(new URL('../../packages/web-ui/package.json', import.meta.url));
const { marked } = require('marked') as { marked: { parse: (src: string, opts: { async: false }) => string } };
const render = (md: string): string => marked.parse(md, { async: false });

const de = (text: string, given = ''): string => defuseUnopenedLinks(text, given, 'de');
const en = (text: string, given = ''): string => defuseUnopenedLinks(text, given, 'en');

/** Rendered by the chat: no anchor at all, and the note exactly `count` times. */
function expectPlain(out: string, note: string, count = 1): void {
  const html = render(out);
  expect(html).not.toMatch(/<a\b/i);
  expect(html.split(`(${note}`).length - 1 + html.split(`, ${note})`).length - 1).toBe(count);
}

describe('defuseUnopenedLinks — every link form becomes plain text', () => {
  it('inline markdown link, with and without www.', () => {
    expect(de('Preis: [Kitco](https://www.kitco.com/gold).')).toBe('Preis: Kitco (kitco.com/gold, nicht geprüft).');
    expect(de('[Kitco](https://kitco.com/gold)')).toBe('Kitco (kitco.com/gold, nicht geprüft)');
    expectPlain(de('Preis: [Kitco](https://www.kitco.com/gold).'), 'nicht geprüft');
  });

  it('a link whose text is the address names it once', () => {
    expect(de('[kitco.com/gold](https://kitco.com/gold)')).toBe('kitco.com/gold (nicht geprüft)');
    expect(de('[https://www.kitco.com/gold](https://www.kitco.com/gold)')).toBe('kitco.com/gold (nicht geprüft)');
    expectPlain(de('[https://www.kitco.com/gold](https://www.kitco.com/gold)'), 'nicht geprüft');
  });

  it('a markdown link without a scheme', () => {
    expect(en('[Kitco](kitco.com/gold)')).toBe('Kitco (kitco.com/gold, not checked)');
    expect(en('[Kitco](//www.kitco.com/gold)')).toBe('Kitco (kitco.com/gold, not checked)');
    expectPlain(en('[Kitco](kitco.com/gold)'), 'not checked');
  });

  it('reference-style links, full, collapsed and shortcut, and their definitions', () => {
    const md = 'See [Kitco][k], [Gold][] and [Spot].\n\n[k]: https://www.kitco.com/gold "Kitco"\n[gold]: <https://gold.example/price>\n[spot]: https://spot.example';
    const out = en(md);
    expect(out).toContain('Kitco (kitco.com/gold, not checked)');
    expect(out).toContain('Gold (gold.example/price, not checked)');
    expect(out).toContain('Spot (spot.example, not checked)');
    expect(out).not.toMatch(/^\[(k|gold|spot)\]:/im);
    expectPlain(out, 'not checked', 3);
  });

  it('autolinks <https://…>', () => {
    expect(de('Quelle: <https://www.kitco.com/gold>')).toBe('Quelle: kitco.com/gold (nicht geprüft)');
    expectPlain(de('Quelle: <https://www.kitco.com/gold>'), 'nicht geprüft');
  });

  it('bare URLs and www. addresses, trailing punctuation left outside', () => {
    expect(de('Siehe https://www.kitco.com/gold.')).toBe('Siehe kitco.com/gold (nicht geprüft).');
    expect(de('Siehe www.kitco.com/gold, dann')).toBe('Siehe kitco.com/gold (nicht geprüft), dann');
    expect(de('(siehe https://kitco.com/gold)')).toBe('(siehe kitco.com/gold (nicht geprüft))');
    expectPlain(de('Siehe https://www.kitco.com/gold.'), 'nicht geprüft');
    expectPlain(de('Siehe www.kitco.com/gold, dann'), 'nicht geprüft');
  });

  it('HTML anchors, closed and unclosed', () => {
    expect(en('<a href="https://www.kitco.com/gold">Kitco</a>')).toBe('Kitco (kitco.com/gold, not checked)');
    expect(en("<A HREF='https://kitco.com/gold' target=_blank><b>Kitco</b></A>")).toBe('Kitco (kitco.com/gold, not checked)');
    expectPlain(en('<a href="https://www.kitco.com/gold">Kitco</a>'), 'not checked');
    expect(en('Text <a href=https://kitco.com/gold>Kitco')).toBe('Text kitco.com/gold (not checked) Kitco');
    expectPlain(en('Text <a href=https://kitco.com/gold>Kitco'), 'not checked');
  });

  it('images, which would load the address', () => {
    expect(en('![chart](https://kitco.com/chart.png)')).toBe('chart (kitco.com/chart.png, not checked)');
    expect(render(en('![chart](https://kitco.com/chart.png)'))).not.toMatch(/<img\b/i);
  });

  it('inside tables, lists and code, too', () => {
    const md = '| Quelle | Preis |\n|---|---|\n| [Kitco](https://kitco.com/gold) | 2400 |\n\n- https://www.kitco.com/gold\n\n`https://kitco.com/x`';
    const out = de(md);
    expectPlain(out, 'nicht geprüft', 3);
  });

  it('a non-web target keeps its text and loses the target', () => {
    expect(en('[click](javascript:alert(1))')).toBe('click');
    expect(en('[x](data:text/html,hi)')).toBe('x');
    expectPlain(en('[click](javascript:alert(1)) and [Kitco](https://kitco.com)'), 'not checked');
  });
});

describe('defuseUnopenedLinks — the note', () => {
  it('follows the given language', () => {
    expect(de('https://kitco.com')).toBe('kitco.com (nicht geprüft)');
    expect(en('https://kitco.com')).toBe('kitco.com (not checked)');
  });

  it('replaces a note the model wrote itself instead of doubling it', () => {
    expect(de('[Kitco](https://kitco.com/gold) (not checked)')).toBe('Kitco (kitco.com/gold, nicht geprüft)');
    expect(de('https://kitco.com/gold (nicht geprüft)')).toBe('kitco.com/gold (nicht geprüft)');
    expect(en('https://kitco.com/gold (Not Checked) and more')).toBe('kitco.com/gold (not checked) and more');
    expectPlain(de('[Kitco](https://kitco.com/gold) (not checked)'), 'nicht geprüft');
  });

  it('leaves text without links as it is', () => {
    expect(de('kitco.com (not checked) nennt 2400.')).toBe('kitco.com (not checked) nennt 2400.');
    expect(de('Kein Link, nur [eckige] Klammern.')).toBe('Kein Link, nur [eckige] Klammern.');
  });
});

describe('defuseUnopenedLinks — addresses the agent was given', () => {
  const task = '{"task":"Summarise https://www.example.org/report and [the brief](https://brief.example/a)"}';

  it('stay links, in any spelling of the same address', () => {
    expect(en('From https://www.example.org/report: done', task)).toBe('From https://www.example.org/report: done');
    expect(en('[Report](https://example.org/report/)', task)).toBe('[Report](https://example.org/report/)');
    expect(en('<https://brief.example/a>', task)).toBe('<https://brief.example/a>');
  });

  it('while one it was not given in the same output does not', () => {
    const out = en('[Report](https://example.org/report) and [Other](https://example.org/other)', task);
    expect(out).toBe('[Report](https://example.org/report) and Other (example.org/other, not checked)');
    expect(render(out).match(/<a\b/gi)?.length).toBe(1);
  });
});

describe('defuseUnopenedLinks — what the first pass does not recognise is sealed', () => {
  // Each of these went past a filter that only recognised the forms above (review of the first
  // version): the renderer reads more than the patterns do.
  const LEAKS = [
    '[x](//evil.example/(a(b)))',
    '[x](&#104;ttps://evil.example/(a(b)))',
    '[x](https:/\\/evil.example/(a(b)))',
    '[x](https://x.example/(a(b)))',
    '[[y](//evil.example)](https://z.example)',
    '[![i](//evil.example/a.png)](https://z.example)',
    '[![i](https://x.example/i.png)](https://z.example)',
    '<img src="//evil.example/a.png">',
    '<img src=//evil.example/x.png>',
    '<img src="&#104;ttps://evil.example/a.png">',
    '<img src="https://x.example/a.png">',
    '- [x]: //evil.example/a\n\n[x]',
    '![x][y]\n\n- [y]: //evil.example/i.png',
    '> [x]: https://x.example/a\n\n[x]',
    'xwww.x.example',
    '<video poster="https://evil.example/p.png"></video>',
    '<svg><image href="https://evil.example/i.svg"/></svg>',
    '\\[x\\](https://evil.example)',
    '[x\\\\](//evil.example)',
    '[x\\](//evil.example)',
    '> [x]: //evil.example/a\n\n[x]',
    '[x](//evil.example/a((b)))',
    '<map name="m"><area href="https://evil.example/a" shape="default"></map>',
    '<area href=//evil.example>',
  ];

  it.each(LEAKS)('%s renders with no link and no image', (md) => {
    const html = render(en(md));
    expect(html).not.toMatch(/<a\b/i);
    expect(html).not.toMatch(/<(img|video|svg|image|area)\b/i);
  });

  it('keeps ordinary text as it reads', () => {
    expect(render(en('Item [x]: done'))).toContain('Item [x]: done');
    expect(en('Map<a, b> and List<abc>')).not.toBe('Map and ');
    // `<a` opens an anchor only with white space or `>` after it: a generic before a closing tag stays.
    expect(en('Map<a, b> and </a>')).toBe('Map&lt;a, b> and &lt;/a>');
    expect(render(en('Map<a, b> and 1 < 2'))).toContain('Map&lt;a, b&gt; and 1 &lt; 2');
  });

  it('stays fast on a long output of brackets and tags', () => {
    for (const md of ['[\\'.repeat(50_000), '[x\\'.repeat(33_000), '<a>'.repeat(33_000), '<a href=x>'.repeat(20_000), '[a]('.repeat(30_000)]) {
      const start = Date.now();
      defuseUnopenedLinks(md, '', 'en');
      expect(Date.now() - start).toBeLessThan(1500);
    }
  });
});

describe('defuseUnopenedLinks — a given address is matched by its real host', () => {
  it('does not keep an address whose host only looks like the given one', () => {
    const given = 'Read https://kitco.com/gold';
    for (const md of ['[k](https://evil.example.https://kitco.com/gold)', '[k](https://kitco.www.evil.example/gold)', '[k](https://user@kitco.com.evil.example/gold)']) {
      expect(render(en(md, given))).not.toMatch(/<a\b/i);
    }
    expect(en('[k](https://evil.example.https://kitco.com/gold)', given)).not.toMatch(/^k \(kitco\.com\/gold/);
  });

  it('reads a workflow step\'s JSON input and a child\'s escaped context as the agent did', () => {
    const json = JSON.stringify({ task: 'Use https://kitco.com/gold\nthen sum', context: { a: 'see "https://b.example/x?a=1&b=2"' } });
    expect(en('[k](https://kitco.com/gold) and https://b.example/x?a=1&b=2', json)).toBe('[k](https://kitco.com/gold) and https://b.example/x?a=1&b=2');
    expect(en('[k](https://b.example/x?a=1&b=2)', '<context>https://b.example/x?a=1&amp;b=2</context>')).toBe('[k](https://b.example/x?a=1&b=2)');
  });
});

describe('shownAddress — nothing the autolinker could pick up again', () => {
  it('drops user info, embedded schemes and www., and an @', () => {
    expect(shownAddress('https://user:pw@evil.example/x')).toBe('evil.example/x');
    expect(shownAddress('https://a.example/?u=https://www.b.example')).toBe('a.example/?u=b.example');
    expect(shownAddress('https://medium.example/@name.surname')).toBe('medium.example/%40name.surname');
    for (const target of ['https://user@evil.example/x', 'https://a.example/?u=https://www.b.example', 'https://medium.example/@name.surname', 'HTTPS://WWW.KITCO.COM/']) {
      expect(render(`${shownAddress(target)} (not checked)`)).not.toMatch(/<a\b/i);
    }
  });

  it('keeps path and query', () => {
    expect(shownAddress('https://www.kitco.com/gold?unit=oz#chart')).toBe('kitco.com/gold?unit=oz#chart');
    expect(shownAddress('https://kitco.com/')).toBe('kitco.com');
  });
});
