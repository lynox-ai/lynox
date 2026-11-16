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
