import { describe, it, expect } from 'vitest';
import { checkMarkup, markupAddedByHost, markupChangesOf, TEXT_CARRIERS } from './bulk-html.js';
import {
  withinReadingBounds, MARKUP_MAX_BYTES, MARKUP_MAX_CARRIER_NESTING, MARKUP_MAX_DEPTH, MARKUP_MAX_NODES, READ_AGAIN_CARRIERS,
} from './html-tree.js';
import { BULK_MAX_TARGET_BYTES } from './bulk-plan.js';
import { html as p5, parseFragment, defaultTreeAdapter } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';

// The markup check reads a value's tree once per text carrier above each node. A value larger or
// nested deeper than the bounds is refused before it is read, and the list the approval view shows
// says it could not list the field instead of reading it.

const HOST = 'shop.example.com';
const check = (after: string, before: string | null = null) => checkMarkup({ before, after, storeHost: HOST, startDomains: [] });

/** The names this module treats as text carriers, and the contexts a value may open. Which pair
 *  nests is read off the parser's own tree, independent of the check, so no test names it. */
const CARRIERS = ['script', 'style', 'noscript', 'xmp', 'noembed', 'noframes', 'iframe', 'plaintext', 'textarea', 'title'];
const CONTEXTS = ['', ...Object.keys(p5.NS).map((ns) => `<${ns.toLowerCase()}>`)];
const nested = (context: string, carrier: string, n: number): string => context + `<${carrier}>`.repeat(n);
/** The most carriers of that name the parser puts above one another for a value. */
const carrierNesting = (value: string, carrier: string): number => {
  const div = defaultTreeAdapter.createElement('div', p5.NS.HTML, []);
  let most = 0;
  const stack: [DefaultTreeAdapterTypes.Node, number][] = [[parseFragment(div, value), 0]];
  while (stack.length > 0) {
    const [n, above] = stack.pop()!;
    const here = above + ('tagName' in n && n.tagName === carrier ? 1 : 0);
    most = Math.max(most, here);
    for (const c of 'childNodes' in n ? n.childNodes : []) stack.push([c, here]);
  }
  return most;
};
const nesting = ((): [string, string] => {
  for (const context of CONTEXTS) {
    for (const carrier of CARRIERS) if (carrierNesting(nested(context, carrier, 3), carrier) === 3) return [context, carrier];
  }
  throw new Error('no carrier nests in the parser');
})();
const carriers = (n: number): string => nested(nesting[0], nesting[1], n);

/** Elements nested `n` deep, none a carrier, closed. */
const deep = (n: number): string => '<span>'.repeat(n) + '</span>'.repeat(n);

const timed = <T>(f: () => T): [T, number] => {
  const start = performance.now();
  const out = f();
  return [out, performance.now() - start];
};

describe('the bounds the markup check reads within', () => {
  it('are the byte bound of a bulk target, and fixed depth, nesting and node bounds', () => {
    expect(MARKUP_MAX_BYTES).toBe(BULK_MAX_TARGET_BYTES);
    expect(MARKUP_MAX_DEPTH).toBe(512);
    expect(MARKUP_MAX_CARRIER_NESTING).toBe(8);
    expect(MARKUP_MAX_NODES).toBe(50_000);
  });

  it('count every carrier the markup extraction reads again', () => {
    expect([...READ_AGAIN_CARRIERS].sort()).toEqual([...TEXT_CARRIERS].sort());
  });

  it('end at the nodes the parser builds, elements, comments and text alike', () => {
    // The parser builds two nodes of its own for a fragment; they count too.
    const own = MARKUP_MAX_NODES - 2;
    expect(withinReadingBounds('<br>'.repeat(own))).toBe(true);
    expect(withinReadingBounds('<br>'.repeat(own + 1))).toBe(false);
    expect(withinReadingBounds('<!---->'.repeat(own))).toBe(true);
    expect(withinReadingBounds('<!---->'.repeat(own + 1))).toBe(false);
    expect(withinReadingBounds('x<br>'.repeat(own / 2))).toBe(true);
    expect(withinReadingBounds('x<br>'.repeat(own / 2) + 'x')).toBe(false);
  });

  it('end at the element depth, not one level earlier', () => {
    expect(withinReadingBounds(deep(MARKUP_MAX_DEPTH))).toBe(true);
    expect(withinReadingBounds(deep(MARKUP_MAX_DEPTH + 1))).toBe(false);
  });

  it('end at the nesting of text carriers, not one level earlier', () => {
    expect(withinReadingBounds(carriers(MARKUP_MAX_CARRIER_NESTING))).toBe(true);
    expect(withinReadingBounds(carriers(MARKUP_MAX_CARRIER_NESTING + 1))).toBe(false);
    // Side by side, carriers do not add up: only those above one another count.
    const closed = `${carriers(MARKUP_MAX_CARRIER_NESTING)}x${`</${nesting[1]}>`.repeat(MARKUP_MAX_CARRIER_NESTING)}`;
    expect(withinReadingBounds(closed + closed)).toBe(true);
    expect(withinReadingBounds(`${carriers(1)}${closed}`)).toBe(false);
  });

  it('end at the bytes, counted in UTF-8', () => {
    expect(withinReadingBounds('a'.repeat(MARKUP_MAX_BYTES))).toBe(true);
    expect(withinReadingBounds('a'.repeat(MARKUP_MAX_BYTES + 1))).toBe(false);
    expect(withinReadingBounds('ä'.repeat(MARKUP_MAX_BYTES / 2))).toBe(true);
    expect(withinReadingBounds(`${'ä'.repeat(MARKUP_MAX_BYTES / 2)}a`)).toBe(false);
  });
});

describe('a value beyond the bounds', () => {
  // As measured before the bounds: 8000 nested carriers took 15 s and 1 GB to list.
  const measured = carriers(8000);

  it('is listed as unread, within a bound set before measuring', () => {
    const [change, ms] = timed(() => markupChangesOf('description', null, measured));
    // Errs toward warning: an undo of it still says it may write back a script.
    expect(change).toEqual({ field: 'description', added: [], removed: [], addsOutsideAllowlist: true, unread: true });
    expect(ms).toBeLessThan(1000);
  });

  it('is listed as unread where carriers nest within the depth, before the quadratic read', () => {
    // Within the element depth, each carrier would read all the text below it again: measured
    // without the nesting bound, 1.9 s and 400 MB; with it, under 50 ms.
    const value = carriers(MARKUP_MAX_DEPTH - 12) + 'x'.repeat(256 * 1024);
    const [change, ms] = timed(() => markupChangesOf('description', null, value));
    expect(change.unread).toBe(true);
    expect(ms).toBeLessThan(1000);
  });

  it('is refused by the check, within the same bound', () => {
    const [result, ms] = timed(() => check(measured));
    expect(result).toEqual({ ok: false, reason: 'not_canonical', detail: 'The value or its before-image is larger or nested deeper than this check reads.' });
    expect(ms).toBeLessThan(1000);
  });

  it('is refused where only the depth exceeds', () => {
    expect(check(deep(MARKUP_MAX_DEPTH + 1))).toMatchObject({ ok: false, reason: 'not_canonical' });
    expect(markupChangesOf('description', '<p>a</p>', deep(MARKUP_MAX_DEPTH + 1)).unread).toBe(true);
  });

  it('is refused where only the before-image exceeds, which the shop wrote', () => {
    expect(check('<p>a</p>', measured)).toEqual({ ok: false, reason: 'not_canonical', detail: 'The value or its before-image is larger or nested deeper than this check reads.' });
    expect(check('<p>a</p>', '<p>b</p>')).toEqual({ ok: true });
    expect(markupChangesOf('description', measured, '<p>a</p>').unread).toBe(true);
  });

  it('counts as added markup where the shop reads one back', () => {
    const [got, ms] = timed(() => markupAddedByHost({ sent: '<p>a</p>', back: measured, storeHost: HOST, startDomains: [] }));
    expect(got).toMatchObject({ ok: false, reason: 'not_canonical' });
    expect(ms).toBeLessThan(1000);
    expect(markupAddedByHost({ sent: measured, back: '<p>a</p>', storeHost: HOST, startDomains: [] })).toMatchObject({ ok: false, reason: 'not_canonical' });
    expect(markupAddedByHost({ sent: '<p>a</p>', back: '<p>a</p>', storeHost: HOST, startDomains: [] })).toEqual({ ok: true });
    // The bytes sent read back unchanged add nothing, whatever their size.
    expect(markupAddedByHost({ sent: measured, back: measured, storeHost: HOST, startDomains: [] })).toEqual({ ok: true });
    // Closed and of allowed elements only, so nothing but the depth refuses it.
    const pairs = MARKUP_MAX_DEPTH / 2 + 1;
    const lists = '<ul><li>'.repeat(pairs) + 'x' + '</li></ul>'.repeat(pairs);
    expect(markupAddedByHost({ sent: '<p>a</p>', back: lists, storeHost: HOST, startDomains: [] })).toEqual({
      ok: false, reason: 'not_canonical', detail: 'The value read back or the value sent is larger or nested deeper than this check reads.',
    });
  });
});

describe('a value within the bounds', () => {
  it('is read at the element depth, and passes', () => {
    // The text counts as a level below its element: here it sits at the bound itself.
    const pairs = (MARKUP_MAX_DEPTH - 2) / 2;
    const lists = '<ul><li>'.repeat(pairs) + '<strong>x</strong>' + '</li></ul>'.repeat(pairs);
    expect(withinReadingBounds(lists)).toBe(true);
    expect(withinReadingBounds(`<div>${lists}</div>`)).toBe(false);
    expect(check(lists, lists)).toEqual({ ok: true });
    const change = markupChangesOf('description', null, lists);
    expect(change.unread).toBeUndefined();
  });

  it('is listed at the carrier nesting and the byte bound', () => {
    // Every carrier above the most text it can hold, the rest of the depth below them.
    const head = `${carriers(MARKUP_MAX_CARRIER_NESTING)}${'<g>'.repeat(MARKUP_MAX_DEPTH - MARKUP_MAX_CARRIER_NESTING - 2)}`;
    const value = head + 'x'.repeat(MARKUP_MAX_BYTES - Buffer.byteLength(head));
    expect(Buffer.byteLength(value)).toBe(MARKUP_MAX_BYTES);
    expect(withinReadingBounds(value)).toBe(true);
    const [change, ms] = timed(() => markupChangesOf('description', null, value));
    expect(change.unread).toBeUndefined();
    expect(change.added.length).toBeGreaterThan(MARKUP_MAX_CARRIER_NESTING);
    expect(ms).toBeLessThan(5000);
    const [result, checkMs] = timed(() => check(value));
    expect(result).not.toEqual({ ok: false, reason: 'not_canonical', detail: 'The value or its before-image is larger or nested deeper than this check reads.' });
    expect(checkMs).toBeLessThan(5000);
  });
});
