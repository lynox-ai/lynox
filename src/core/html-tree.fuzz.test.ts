import { describe, it, expect } from 'vitest';
import { defaultTreeAdapter, serialize, type DefaultTreeAdapterTypes } from 'parse5';
import { BLOCK_ELEMENTS, canonicalHtml, normalizeHtml, parseHtmlFragment, walkHtml, type HtmlNodeRef } from './html-tree.js';

/**
 * The fuzz of Shopify PRD §21.3 over `html-tree.ts`. It mutates seeds, it does not draw markup at
 * random, and every run must also find a difference against each known-wrong version of what it
 * tests (the controls): a run that cannot tell a wrong version from the right one proves nothing.
 *
 * What runs here before A2 lands:
 * - the generator, and a test that the canonical mutation-XSS case is reachable from the seeds;
 * - the reference markup over `walkHtml`, with controls (a)–(c) and (g)–(j) as known-wrong
 *   extractions of the same shape;
 * - property 2 against a stand-in check built on the reference. Both of its assertions hold by
 *   construction until A2's `checkMarkup` replaces the stand-in; what carries information now is
 *   that the generator reaches accepted values, and the control: a check without `not_canonical`
 *   accepts a value whose `canonicalHtml` is not idempotent;
 * - property 3 over `normalizeHtml`, on the seeds and on generated values: tree-preserving
 *   mutations give the same string, one-change mutations a different one, with control (f) and the
 *   `pre` control, each counted only when found by the mutation it is about.
 * After A2: property 1 (`markupOf` against the reference walk) and controls (d) and (e) against
 * `checkMarkup`.
 */

// ── The generator ────────────────────────────────────────────────────────────

// sfc32, seeded through splitmix32. Not an LCG, and no modulo: an index is floor(rng() * n).
function splitmix32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}
function sfc32(seed: number): () => number {
  const sm = splitmix32(seed);
  let a = sm(), b = sm(), c = sm(), d = sm();
  return () => {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}
type Rng = () => number;
const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;

const SEED_ENV = process.env['LYNOX_FUZZ_SEED'];
if (SEED_ENV !== undefined && !(/^\d+$/.test(SEED_ENV) && Number(SEED_ENV) < 2 ** 32)) {
  throw new Error(`LYNOX_FUZZ_SEED must be an integer from 0 to 2^32-1, got ${JSON.stringify(SEED_ENV)}`);
}
const SEED = SEED_ENV === undefined ? 0x5eed2b : Number(SEED_ENV);

const RAW = ['noscript', 'textarea', 'title', 'style', 'xmp', 'noembed', 'plaintext'] as const;

// The seeds: the M6 inputs and what Shopify gave back (run m6-2026-10-26T15-10-53-615Z), and the
// categories of the M6b corpus (§21.2 item 8). The S5 markup joins once A2 has measured it.
const SEEDS: readonly string[] = [
  '<p  class="m6"   data-m6="1">Spaces &amp; entities: &lt;b&gt; &#169; &nbsp;é ü 😀</p>',
  '<p>line<br>break<br/>self-closed<br />spaced</p>',
  '<ul><li>one<ul><li>nested</li></ul></li><li>two</li></ul>',
  '<ul>\n<li>one<ul><li>nested</li></ul>\n</li>\n<li>two</li>\n</ul>',
  '<!-- m6 comment --><p style="color: red">styled</p>',
  '<a href="https://example.com/x?a=1&b=2" target="_blank" rel="noopener">link</a>',
  '<script>window.m6=1</script><iframe src="https://example.com/embed"></iframe>',
  '<P>UPPER</P><unknown-tag>custom</unknown-tag>',
  '<p>unclosed',
  '<p>Text</p>',
  '',
  'plain text without a tag',
  '<p title="a">',
  '<p><b>bold</b> <i>italic</i> <em>em</em> <strong>strong</strong></p>',
  '<h2>Head</h2>\n<p>a&nbsp;b &amp; c</p>\n<ol><li>x</li><li>y</li></ol>',
  '<p><a href="/products/x?a=1&amp;b=2">rel</a> <a href="mailto:info@shop.example">mail</a></p>',
  '<p>Grüße, Äpfel, 😀 – “Zitat”</p>',
  `<p>${'Lorem ipsum dolor sit amet. '.repeat(72)}</p>`,
  '<pre>a  b\n  c</pre><textarea>x  y</textarea>',
  '<noscript><b>n</b></noscript><title>t</title><style>p{}</style><xmp><i>x</i></xmp><noembed>e</noembed>',
  '<svg><script>s</script><style>t</style><foreignObject><p>f</p></foreignObject></svg>',
  '<math><mi>x</mi><annotation-xml encoding="text/html"><p>h</p></annotation-xml></math>',
  '<svg><![CDATA[c]]><a xlink:href="https://evil.example/">x</a></svg>',
  '<image src="x">',
  '<!-- c --></ <img src=x><![CDATA[d]]><?x y?>',
  '<template><img src=x onerror=y><p>t</p></template>',
  '<table><tr><td>a</td></tr></table>',
  '<form><input name="q"></form>',
  '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
  '<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>',
  '<form id=a><div></form><form id=b><input></form>',
];

/** A mutation: pure in its input and the choices it draws. Each names the §21.3 class it covers. */
type Mutation = (rng: Rng, s: string) => string;

const TAG = /<([a-zA-Z][a-zA-Z0-9-]*)/g;
const ATTR = /\s([a-zA-Z:-]+)=("([^"]*)"|'([^']*)'|([^\s>]+))/g;
const at = (rng: Rng, s: string): number => Math.floor(rng() * (s.length + 1));
const matches = (re: RegExp, s: string): RegExpExecArray[] => [...s.matchAll(new RegExp(re.source, 'g'))];

const MUTATIONS: Readonly<Record<string, Mutation>> = {
  case(rng, s) {
    const flip = (x: string): string => [...x].map((ch) => (rng() < 0.5 ? ch.toUpperCase() : ch.toLowerCase())).join('');
    if (rng() < 0.5) {
      // An attribute's name or value: `encoding="TEXT/HTML"`, `JAVASCRIPT:`.
      const a = matches(ATTR, s);
      if (a.length > 0) { const x = pick(rng, a); return s.slice(0, x.index) + flip(x[0]) + s.slice(x.index + x[0].length); }
    }
    const m = matches(TAG, s);
    if (m.length === 0) return s.toUpperCase();
    const x = pick(rng, m);
    const name = x[1]!;
    const flipped = flip(name);
    return s.slice(0, x.index + 1) + flipped + s.slice(x.index + 1 + name.length);
  },
  quoting(rng, s) {
    const m = matches(ATTR, s);
    if (m.length === 0) return s;
    const x = pick(rng, m);
    const value = x[3] ?? x[4] ?? x[5] ?? '';
    const form = pick(rng, [`"${value}"`, `'${value}'`, value]);
    return s.slice(0, x.index) + ` ${x[1]}=${form}` + s.slice(x.index + x[0].length);
  },
  duplicateAttr(rng, s) {
    const m = matches(ATTR, s);
    if (m.length === 0) return s.replace(/<([a-z]+)/i, '<$1 title="a" title="b"');
    const x = pick(rng, m);
    return s.slice(0, x.index + x[0].length) + ` ${x[1]}="other${Math.floor(rng() * 10)}"` + s.slice(x.index + x[0].length);
  },
  entityInAttr(rng, s) {
    const m = matches(ATTR, s);
    const payload = pick(rng, ['&#x6a;avascript:alert(1)', 'java&#x09;script:x', 'jav&#x0A;ascript:x', '//evil.example/x', '/\\evil.example', 'https://evil.example/&#0;']);
    if (m.length === 0) return s.replace(/<([a-z]+)/i, `<$1 href="${payload}"`);
    const x = pick(rng, m);
    return s.slice(0, x.index) + ` ${x[1]}="${payload}"` + s.slice(x.index + x[0].length);
  },
  nul(rng, s) {
    const i = at(rng, s);
    return s.slice(0, i) + '\u0000' + s.slice(i);
  },
  unclosed(rng, s) {
    const i = at(rng, s);
    switch (Math.floor(rng() * 4)) {
      case 0: return s.replace(/<\/[a-z]+>/i, '');
      case 1: return s.slice(0, i) + '</p>' + s.slice(i);
      case 2: return s.slice(0, i) + '<!-->' + s.slice(i);
      default: return s.slice(0, i) + '<!-- open' + s.slice(i);
    }
  },
  slashSeparator(_rng, s) {
    return s.replace(/<([a-z]+) ([a-z])/i, '<$1/$2');
  },
  nestedA(rng, s) {
    const i = at(rng, s);
    return s.slice(0, i) + '<a href="/o"><a href="/i">' + s.slice(i) + '</a></a>';
  },
  wrapRaw(rng, s) {
    const el = pick(rng, RAW);
    return el === 'plaintext' ? `<plaintext>${s}` : `<${el}>${s}</${el}>`;
  },
  switchNamespace(rng, s) {
    switch (Math.floor(rng() * 5)) {
      case 0: return `<svg>${s}</svg>`;
      case 1: return `<math>${s}</math>`;
      case 2: return `<svg><foreignObject>${s}</foreignObject></svg>`;
      case 3: return `<math><annotation-xml encoding="text/html">${s}</annotation-xml></math>`;
      default: return `<svg><![CDATA[${s}]]></svg>`;
    }
  },
  rawTextPayload(rng, s) {
    // An attribute value that closes a raw-text parent: the shape of the noscript case.
    const el = pick(rng, RAW);
    const payload = `</${el}><img src=x onerror=y>`;
    const m = matches(ATTR, s);
    if (m.length === 0) return s.replace(/<([a-z]+)/i, `<$1 title="${payload}"`);
    const x = pick(rng, m);
    return s.slice(0, x.index) + ` ${x[1]}="${payload}"` + s.slice(x.index + x[0].length);
  },
};
const MUTATION_NAMES = Object.keys(MUTATIONS);

function generate(rng: Rng): string {
  let s = pick(rng, SEEDS);
  const n = 1 + Math.floor(rng() * 4);
  for (let i = 0; i < n; i++) s = MUTATIONS[pick(rng, MUTATION_NAMES)]!(rng, s);
  return s;
}

/** A replay of fixed draws, for the reachability test: each call returns the next value. */
const draws = (...xs: number[]): Rng => () => xs.shift() ?? 0;

describe('the generator', () => {
  it('reaches the canonical noscript case from a seed', () => {
    // <p title="a"> → rawTextPayload, drawing `noscript` (index 0 of RAW) → wrapRaw, drawing it again.
    const seed = '<p title="a">';
    expect(SEEDS).toContain(seed);
    const afterPayload = MUTATIONS['rawTextPayload']!(draws(0, 0), seed);
    const reached = MUTATIONS['wrapRaw']!(draws(0), afterPayload);
    expect(reached).toBe('<noscript><p title="</noscript><img src=x onerror=y>"></noscript>');
    // The tree is the case's: with scripting on, the noscript holds text up to the first
    // `</noscript>`, and what follows it is markup again.
    const els = walkHtml(parseHtmlFragment(reached)).filter((n) => n.kind === 'element').map((n) => n.kind === 'element' && n.name);
    expect(els).toEqual(['noscript', 'img']);
  });
});

// ── The reference markup, over walkHtml ──────────────────────────────────────

/**
 * What a markup extraction gives: a multiset of occurrences and a multiset of triples, as keys.
 * Both carry the template flag: what stands only in a template's content holds nothing outside it.
 */
interface Markup { readonly occurrences: ReadonlyMap<string, number>; readonly triples: ReadonlyMap<string, number> }

/** Known-wrong versions of the extraction, §21.3 controls (a)–(c) and (g)–(j). */
interface Wrong {
  skipTemplate?: true; // (a)
  skipForeign?: true; // (b)
  triplesOnly?: true; // (c)
  ignoreContent?: true; // (g)
  setNotMultiset?: true; // (h)
  contentHtmlOnly?: true; // (i)
  noTemplateFlag?: true; // (j)
}

const HTML_NS = 'http://www.w3.org/1999/xhtml';

function markupOf(nodes: readonly HtmlNodeRef[], wrong: Wrong = {}): Markup {
  const occurrences = new Map<string, number>();
  const triples = new Map<string, number>();
  const addTriple = (k: string): void => { triples.set(k, wrong.setNotMultiset ? 1 : (triples.get(k) ?? 0) + 1); };
  // Depth of the foreign subtree being skipped, for (b).
  let skipBelow = Infinity;
  for (const n of nodes) {
    if (n.depth <= skipBelow) skipBelow = Infinity;
    if (n.depth > skipBelow) continue;
    if (wrong.skipTemplate && n.inTemplate) continue;
    const flag = wrong.noTemplateFlag ? false : n.inTemplate;
    if (n.kind === 'text') continue;
    if (n.kind === 'comment') {
      if (!wrong.triplesOnly) {
        const k = JSON.stringify(['#comment', n.data, flag]);
        occurrences.set(k, wrong.setNotMultiset ? 1 : (occurrences.get(k) ?? 0) + 1);
      }
      continue;
    }
    if (wrong.skipForeign && n.namespace !== HTML_NS) { skipBelow = n.depth; continue; }
    const attrs = n.attrs.map((a) => [a.namespace ?? '', a.name, a.value]).sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1));
    let content = wrong.ignoreContent ? null : n.content;
    if (wrong.contentHtmlOnly && n.namespace !== HTML_NS) content = null;
    if (!wrong.triplesOnly) {
      const k = JSON.stringify([n.namespace, n.name, attrs, content, flag]);
      occurrences.set(k, wrong.setNotMultiset ? 1 : (occurrences.get(k) ?? 0) + 1);
    }
    if (attrs.length === 0 && !wrong.triplesOnly) addTriple(JSON.stringify([n.namespace, n.name, null, null, null, flag]));
    for (const [ans, name, value] of attrs) addTriple(JSON.stringify([n.namespace, n.name, ans, name, value, flag]));
  }
  return { occurrences, triples };
}

const sameMarkup = (a: Markup, b: Markup): boolean =>
  JSON.stringify([...a.occurrences].sort()) === JSON.stringify([...b.occurrences].sort())
  && JSON.stringify([...a.triples].sort()) === JSON.stringify([...b.triples].sort());

const CONTROLS: readonly (readonly [string, Wrong])[] = [
  ['(a) template contents skipped', { skipTemplate: true }],
  ['(b) foreign content skipped', { skipForeign: true }],
  ['(c) triples only, attribute-less elements missed', { triplesOnly: true }],
  ['(g) raw-text content ignored', { ignoreContent: true }],
  ['(h) a set, not a multiset', { setNotMultiset: true }],
  ['(i) script and style content for HTML only', { contentHtmlOnly: true }],
  ['(j) occurrences without the template flag', { noTemplateFlag: true }],
];

const CASES = 4000;

describe(`the extraction controls (seed ${SEED}, ${CASES} cases)`, () => {
  it('finds a difference against every known-wrong extraction, and the reference is a function of the tree', () => {
    const rng = sfc32(SEED);
    const found = new Map<string, string>();
    for (let i = 0; i < CASES; i++) {
      const v = generate(rng);
      const nodes = walkHtml(parseHtmlFragment(v));
      const ref = markupOf(nodes);
      // The reference does not depend on anything but the tree.
      expect(sameMarkup(ref, markupOf(walkHtml(parseHtmlFragment(v)))), v).toBe(true);
      for (const [name, wrong] of CONTROLS) if (!found.has(name) && !sameMarkup(ref, markupOf(nodes, wrong))) found.set(name, v);
    }
    expect(CONTROLS.map(([name]) => [name, found.has(name)])).toEqual(CONTROLS.map(([name]) => [name, true]));
  });
});

// ── Property 2: what an accepted value may hold ──────────────────────────────

const STORE_HOST = 'shop.myshopify.com';
const START_DOMAINS = ['shop.example'];
const ALLOW_BARE: ReadonlySet<string> = new Set(['p', 'br', 'strong', 'em', 'ul', 'ol', 'li', 'h2', 'h3', 'h4', 'a']);

/**
 * The URL rule (Shopify PRD, link targets), written here on its own so that the property does not
 * check the check against itself. A C0 character, U+FFFD or a backslash in the value refuses. The
 * value is resolved as a WHATWG URL against the store; the scheme must be `https:`, `http:` or
 * `mailto:`, and the host must equal an allowed one or lie below it at a dot. A `mailto:` refuses
 * when it carries an authority (`mailto://…`, whose host the address would not show) or holds `?`,
 * `,` or `#` (a second address that is not checked). Otherwise its address is decoded once (a broken
 * `%xx` refuses) and must be one local part of `[A-Za-z0-9._+-]`, exactly one `@` and a domain,
 * which is the host. A host must be dot-separated labels of ASCII letters, digits and `-`, so junk
 * before an allowed suffix (`a@evil.example;b.shop.example`) and a non-ASCII domain refuse (punycode
 * passes). One trailing dot is dropped: `shop.example.` is the same host.
 */
const HOST_LABELS = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;
function urlHost(value: string): string | null {
  if (/[\u0000-\u001f\ufffd\\]/.test(value)) return null;
  let u: URL;
  try { u = new URL(value, `https://${STORE_HOST}/`); } catch { return null; }
  if (u.protocol === 'https:' || u.protocol === 'http:') return u.hostname.toLowerCase().replace(/\.$/, '');
  if (u.protocol !== 'mailto:' || u.host !== '' || /[?,#]/.test(value)) return null;
  let address: string;
  try { address = decodeURIComponent(u.pathname); } catch { return null; }
  const at = address.split('@');
  if (at.length !== 2 || !/^[A-Za-z0-9._+-]+$/.test(at[0]!)) return null;
  return at[1]!.toLowerCase().replace(/\.$/, '');
}
function urlAllowed(value: string, hosts: readonly string[]): boolean {
  const x = urlHost(value);
  return x !== null && HOST_LABELS.test(x) && hosts.some((h) => x === h || x.endsWith(`.${h}`));
}

/** The hosts a field's before-image already links to, from every URL attribute of the reference walk. */
function linkHosts(nodes: readonly HtmlNodeRef[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.kind !== 'element') continue;
    for (const a of n.attrs) {
      if (!['href', 'src', 'srcset', 'action', 'formaction', 'cite', 'poster', 'data', 'background'].includes(a.name)) continue;
      // Only a web link names a host a later link may reuse; a `mailto:` or `javascript:` names none.
      let u: URL;
      try { u = new URL(a.value, `https://${STORE_HOST}/`); } catch { continue; }
      if (u.protocol === 'https:' || u.protocol === 'http:') out.push(u.hostname.toLowerCase().replace(/\.$/, ''));
    }
  }
  return out;
}

/**
 * Everything the after-state's trees hold beyond the allowlist and the before-image (§21.3
 * property 2). Each tree of the after-state is compared with the before-image's tree of the same
 * kind: the bytes with the bytes, the canonical form with the canonical form (D-7).
 */
function violations(before: string | null, after: string): string[] {
  const out: string[] = [];
  for (const kind of [(v: string) => v, canonicalHtml]) {
    const aNodes = walkHtml(parseHtmlFragment(kind(after)));
    const bNodes = before === null ? [] : walkHtml(parseHtmlFragment(kind(before)));
    const A = markupOf(aNodes), B = markupOf(bNodes);
    const hosts = [STORE_HOST, ...START_DOMAINS, ...linkHosts(bNodes)];
    for (const [k, n] of A.occurrences) {
      if (n <= (B.occurrences.get(k) ?? 0)) continue;
      const [ns, name, attrs, content, inTemplate] = JSON.parse(k) as [string, string, [string, string, string][], string | null, boolean];
      const allowed = ns === HTML_NS && ALLOW_BARE.has(name) && content === null && !inTemplate
        && attrs.every(([ans, an]) => ans === '' && name === 'a' && an === 'href');
      if (!allowed) out.push(`occurrence ${k}`);
    }
    for (const [t, n] of A.triples) {
      if (n <= (B.triples.get(t) ?? 0)) continue;
      const [ns, name, ans, an, value, inTemplate] = JSON.parse(t) as [string, string, string | null, string | null, string | null, boolean];
      if (ns !== HTML_NS || !ALLOW_BARE.has(name) || inTemplate) { out.push(`triple ${t}`); continue; }
      if (an === null) continue;
      if (!(name === 'a' && an === 'href' && ans === '' && urlAllowed(value!, hosts))) out.push(`triple ${t}`);
    }
  }
  return out;
}

const idempotent = (v: string): boolean => { const c = canonicalHtml(v); return canonicalHtml(c) === c; };

/** The stand-in for A2's `checkMarkup` until A2 lands: accept exactly what the reference allows. */
type Check = (before: string | null, after: string) => boolean;
const standIn: Check = (before, after) => violations(before, after).length === 0 && idempotent(after);
const withoutNotCanonical: Check = (before, after) => violations(before, after).length === 0;

const PAIRS = 3000;

function pairs(rng: Rng): [string | null, string][] {
  const out: [string | null, string][] = [];
  for (let i = 0; i < PAIRS; i++) {
    const after = generate(rng);
    const r = rng();
    // A third the same value (nothing added, only `not_canonical` can refuse), a third a seed,
    // a third nothing before.
    out.push([r < 1 / 3 ? after : r < 2 / 3 ? pick(rng, SEEDS) : null, after]);
  }
  return out;
}

describe(`property 2 and canonical idempotence (seed ${SEED}, ${PAIRS} pairs)`, () => {
  it('an accepted value holds nothing outside the allowlist and the before-image, and is canonical-idempotent', () => {
    const all = pairs(sfc32(SEED ^ 0x2));
    let accepted = 0;
    let controlFound: string | null = null;
    for (const [before, after] of all) {
      if (standIn(before, after)) {
        accepted++;
        expect(violations(before, after), after).toEqual([]);
        expect(idempotent(after), after).toBe(true);
      }
      if (controlFound === null && withoutNotCanonical(before, after) && !idempotent(after)) controlFound = after;
    }
    // Enough of both kinds to mean something, and the check without `not_canonical` accepted a
    // value whose canonical form is not idempotent.
    expect(accepted).toBeGreaterThan(PAIRS / 10);
    expect(controlFound, 'control: a check without not_canonical').not.toBeNull();
  });

  it('the URL rule refuses what §21.7 names, and passes the store and a start domain', () => {
    const hosts = [STORE_HOST, ...START_DOMAINS, 'example.ch'];
    for (const bad of ['javascript:alert(1)', 'java\tscript:x', '//evil.example/x', '/\\evil.example', 'https://evil.example/\u0000', 'https://evilexample.ch/', 'mailto:a@evil.example',
      'mailto:x@evil.example,y@shop.example', 'mailto:x@evil.example%2Cy@shop.example', 'mailto:y@shop.example?cc=x@evil.example', 'mailto:y@shop.example?BCC=x@evil.example', 'mailto:info@shop.example?subject=x', 'mailto:a@shop.example,b@example.ch',
      'mailto://x@evil.example/@shop.example', 'mailto://evil.example/a@shop.example', 'mailto:a@shop.example#&cc=x@evil.example',
      'mailto:a%2Cb@shop.example', 'mailto:a%3Fb@shop.example', 'mailto:boss;a@shop.example', 'mailto:boss%3Ba@shop.example',
      'mailto:@shop.example', 'mailto:a%2540b@shop.example', 'mailto:a%ZZ@shop.example', 'mailto:info@m%C3%BCnchen.shop.example',
      'mailto:x@evil.example;y@shop.example', 'mailto:x@evil.example%3By@shop.example', 'mailto:x@evil.example%20@shop.example',
      'mailto:a@evil.example%00@shop.example', 'mailto:a@evil.example;b.shop.example', 'mailto:a@evil.example%3Bb.shop.example',
      'mailto:?to=a@evil.example%3Bb.shop.example', 'mailto:a@evil.example%00.shop.example', 'mailto:a@evil.example%0D%0Ab.shop.example',
      'mailto:a@evil.example%20b.shop.example', 'mailto:a@evil.example%09.shop.example', 'mailto:a@evil.example%7F.shop.example',
      'mailto:%3Ca@evil.example%3E.shop.example', 'mailto:a@evil.example(x.shop.example', 'mailto:x@evil.example%0d%0acc:a@shop.example', 'mailto:a@shop.example@evil.example', 'https://evil.example./x', 'mailto:']) {
      expect(urlAllowed(bad, hosts), bad).toBe(false);
    }
    for (const ok of ['/products/x', 'https://shop.myshopify.com/x', 'https://www.shop.example/y', 'https://example.ch/', 'mailto:info@shop.example', 'mailto:Info+news@SHOP.example', 'mailto:info@xn--mnchen-3ya.shop.example', 'https://shop.example./x']) {
      expect(urlAllowed(ok, hosts), ok).toBe(true);
    }
  });

  it('a before-image link without a web host lends no host to the after-state', () => {
    // A `mailto:` or `javascript:` link has no host to lend; an `ftp:` or `ws:` one has, and must not.
    for (const held of ['mailto:info@shop.example', 'javascript:void(0)', 'ftp://evil.example/f', 'ws://evil.example/s']) {
      const before = `<p><a href="${held}">m</a></p>`;
      for (const href of ['https://evil.example./steal', 'https://evil.example../steal', 'https://evil.example/steal']) {
        expect(violations(before, `${before}<a href="${href}">x</a>`), `${held} ${href}`).not.toEqual([]);
      }
    }
    // A held web link does lend its host.
    expect(violations('<p><a href="https://partner.example/">p</a></p>', '<p><a href="https://partner.example/">p</a><a href="https://partner.example/x">q</a></p>')).toEqual([]);
  });
});

// ── Property 3: normalizeHtml keeps and separates ────────────────────────────

type Frag = DefaultTreeAdapterTypes.DocumentFragment;
type El = DefaultTreeAdapterTypes.Element;
type Child = DefaultTreeAdapterTypes.ChildNode;
type Parent = DefaultTreeAdapterTypes.ParentNode;

// Written out here, not imported: the fuzz's model of which elements keep whitespace and which are
// blocks, by namespace as the tree holds them.
const KEEP_HTML = new Set(['pre', 'textarea', 'listing', 'plaintext', 'noscript', 'xmp', 'noembed', 'noframes', 'iframe', 'title']);
const BLOCK_HTML = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'dialog', 'dd', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr',
  'li', 'main', 'nav', 'ol', 'p', 'section', 'summary', 'ul',
]);
const isEl = (n: Child): n is El => defaultTreeAdapter.isElementNode(n);
const isHtml = (e: El): boolean => e.namespaceURI === HTML_NS;
const keeps = (e: El): boolean => (isHtml(e) && KEEP_HTML.has(e.tagName)) || e.tagName === 'script' || e.tagName === 'style';
const isBlockEl = (n: Child | undefined): boolean => n !== undefined && isEl(n) && isHtml(n) && BLOCK_HTML.has(n.tagName);
// Elements the serialiser writes without children: a child added there is not written out.
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', 'basefont', 'bgsound', 'frame', 'keygen', 'param']);

/** Every (parent, index, keeps whitespace) in the tree, template contents left out (they are parsed apart). */
function slots(frag: Frag): { parent: Parent; i: number; keep: boolean }[] {
  const out: { parent: Parent; i: number; keep: boolean }[] = [];
  const visit = (p: Parent, keep: boolean): void => {
    p.childNodes.forEach((c, i) => {
      out.push({ parent: p, i, keep });
      if (isEl(c) && c.tagName !== 'template') visit(c, keep || keeps(c));
    });
  };
  visit(frag, false);
  return out;
}

const text = (value: string, parent: Parent): Child => ({ nodeName: '#text', value, parentNode: parent }) as Child;

/** A tree mutation, and what it must do to `normalizeHtml`; null when the tree offers no place for it. */
type TreeMutation = (rng: Rng, frag: Frag) => boolean;

const SAME: Readonly<Record<string, TreeMutation>> = {
  attributeOrder(rng, frag) {
    const xs = slots(frag).map((s) => s.parent.childNodes[s.i]!).filter((c): c is El => isEl(c) && c.attrs.length >= 2);
    if (xs.length === 0) return false;
    pick(rng, xs).attrs.reverse();
    return true;
  },
  longerWhitespace(rng, frag) {
    const xs = slots(frag).filter((s) => !s.keep).map((s) => s.parent.childNodes[s.i]!).filter((c) => defaultTreeAdapter.isTextNode(c) && / /.test(c.value));
    if (xs.length === 0) return false;
    const t = pick(rng, xs) as DefaultTreeAdapterTypes.TextNode;
    t.value = t.value.replace(' ', ' \n\t ');
    return true;
  },
  whitespaceBetweenBlocks(rng, frag) {
    const xs = slots(frag).filter((s) => {
      const p = s.parent.childNodes;
      return !s.keep && s.i > 0 && isBlockEl(p[s.i]) && isBlockEl(p[s.i - 1]);
    });
    if (xs.length === 0) return false;
    const s = pick(rng, xs);
    s.parent.childNodes.splice(s.i, 0, text('\n  ', s.parent));
    return true;
  },
};

const APART: Readonly<Record<string, TreeMutation>> = {
  oneCharacter(rng, frag) {
    const xs = slots(frag).map((s) => s.parent.childNodes[s.i]!).filter((c) => defaultTreeAdapter.isTextNode(c) && /[^\t\n\f\r ]/.test(c.value));
    if (xs.length === 0) return false;
    const t = pick(rng, xs) as DefaultTreeAdapterTypes.TextNode;
    const i = t.value.search(/[^\t\n\f\r ]/);
    t.value = t.value.slice(0, i) + (t.value[i] === 'q' ? 'z' : 'q') + t.value.slice(i + 1);
    return true;
  },
  addedElement(rng, frag) {
    const xs = [frag as Parent, ...slots(frag).filter((s) => !s.keep).map((s) => s.parent.childNodes[s.i]!).filter((c): c is El => isEl(c) && isHtml(c) && !keeps(c) && !VOID.has(c.tagName) && c.tagName !== 'template')];
    const p = pick(rng, xs);
    p.childNodes.push(defaultTreeAdapter.createElement('b', HTML_NS as never, []) as Child);
    return true;
  },
  changedAttribute(rng, frag) {
    const xs = slots(frag).map((s) => s.parent.childNodes[s.i]!).filter((c): c is El => isEl(c) && c.attrs.length > 0);
    if (xs.length === 0) return false;
    const a = pick(rng, pick(rng, xs).attrs);
    a.value += 'z';
    return true;
  },
  addedAttribute(rng, frag) {
    const xs = slots(frag).map((s) => s.parent.childNodes[s.i]!).filter((c): c is El => isEl(c) && !c.attrs.some((a) => a.name === 'data-z'));
    if (xs.length === 0) return false;
    pick(rng, xs).attrs.push({ name: 'data-z', value: '1' });
    return true;
  },
  nbspForSpace(rng, frag) {
    const xs = slots(frag).filter((s) => !s.keep).map((s) => s.parent.childNodes[s.i]!).filter((c) => defaultTreeAdapter.isTextNode(c) && / /.test(c.value));
    if (xs.length === 0) return false;
    const t = pick(rng, xs) as DefaultTreeAdapterTypes.TextNode;
    t.value = t.value.replace(' ', '\u00a0');
    return true;
  },
  spaceBetweenInlineRemoved(rng, frag) {
    const xs = slots(frag).filter((s) => {
      const p = s.parent.childNodes;
      const c = p[s.i]!;
      return !s.keep && defaultTreeAdapter.isTextNode(c) && /^[\t\n\f\r ]+$/.test(c.value)
        && s.i > 0 && s.i < p.length - 1 && isEl(p[s.i - 1]!) && isEl(p[s.i + 1]!)
        && !isBlockEl(p[s.i - 1]) && !isBlockEl(p[s.i + 1]);
    });
    if (xs.length === 0) return false;
    const s = pick(rng, xs);
    s.parent.childNodes.splice(s.i, 1);
    return true;
  },
  whitespaceInPre(rng, frag) {
    const xs = slots(frag).filter((s) => s.keep).map((s) => s.parent.childNodes[s.i]!).filter((c) => defaultTreeAdapter.isTextNode(c) && /[ \n]/.test(c.value));
    if (xs.length === 0) return false;
    const t = pick(rng, xs) as DefaultTreeAdapterTypes.TextNode;
    t.value = t.value.replace(/[ \n]/, '  ');
    return true;
  },
};

/** Values whose tree survives a round trip, so a tree mutation written out is the tree read back. */
const roundTrips = (s: string): boolean => idempotent(s) && normalizeHtml(s) === normalizeHtml(canonicalHtml(s));
const STABLE_SEEDS = SEEDS.filter(roundTrips)
  .concat(['<p><b>a</b> <i>b</i></p>', '<pre><p>a</p>\n<p>b</p></pre>', '<ul><li>a</li><li>b</li></ul><p>c</p><p>d</p>',
    // Foreign elements named like HTML ones that keep whitespace (theirs collapses), and an HTML
    // `pre` that breaks out of MathML (its whitespace counts).
    '<svg><noscript>plain text without a tag</noscript></svg>', '<math><plaintext>a b</plaintext><pre>c d</pre></math>',
    // Blocks beyond the common ones: whitespace between them drops.
    '<h1>a</h1> <h1>b</h1>', '<hr> <hr>', '<form></form> <dl></dl>']);
const GENERATED = 600;
/** The seeds, and as many generated values (property 3 holds "for every input", not for the seeds alone). */
function stableInputs(rng: Rng): string[] {
  const out = [...STABLE_SEEDS];
  for (let i = 0; i < GENERATED * 4 && out.length < STABLE_SEEDS.length + GENERATED; i++) {
    const v = generate(rng);
    if (roundTrips(v)) out.push(v);
  }
  return out;
}

/** Write the mutated tree out; null when that text does not read back as the same tree. */
function written(frag: Frag): string | null {
  const s = serialize(frag);
  return canonicalHtml(s) === s ? s : null;
}

// The known-wrong normalisations, control (f) and the `pre` control.
const nbspAsSpace = (v: string): string => normalizeHtml(v.replace(/\u00a0|&nbsp;/g, ' '));
function dropInlineWhitespace(v: string): string {
  const frag = parseHtmlFragment(v);
  for (const s of slots(frag).reverse()) {
    const c = s.parent.childNodes[s.i]!;
    if (!s.keep && defaultTreeAdapter.isTextNode(c) && /^[\t\n\f\r ]+$/.test(c.value)) s.parent.childNodes.splice(s.i, 1);
  }
  return normalizeHtml(serialize(frag));
}
function collapseInPre(v: string): string {
  const frag = parseHtmlFragment(v);
  for (const s of slots(frag)) {
    const c = s.parent.childNodes[s.i]!;
    if (s.keep && defaultTreeAdapter.isTextNode(c)) c.value = c.value.replace(/[\t\n\f\r ]+/g, ' ');
  }
  return normalizeHtml(serialize(frag));
}
/** Each known-wrong normalisation, and the one mutation whose finding counts for it. */
const WRONG_NORMALIZE: readonly (readonly [string, (v: string) => string, string])[] = [
  ['(f) U+00A0 collapsed with spaces', nbspAsSpace, 'nbspForSpace'],
  ['(f) whitespace between inline elements dropped', dropInlineWhitespace, 'spaceBetweenInlineRemoved'],
  ['pre: whitespace collapsed below pre', collapseInPre, 'whitespaceInPre'],
];

const SAMPLES = 1500;

describe(`property 3: normalizeHtml (seed ${SEED}, ${SAMPLES} samples per mutation)`, () => {
  it('a tree-preserving mutation keeps the string, a one-change mutation changes it, and every control is found', () => {
    const rng = sfc32(SEED ^ 0x3);
    const STABLE = stableInputs(rng);
    expect(STABLE.length - STABLE_SEEDS.length, 'generated inputs').toBeGreaterThan(GENERATED / 2);
    const used = new Map<string, number>();
    const found = new Set<string>();
    for (const [kind, table] of [['same', SAME], ['apart', APART]] as const) {
      for (const [name, mutate] of Object.entries(table)) {
        for (let i = 0; i < SAMPLES; i++) {
          const seed = pick(rng, STABLE);
          const frag = parseHtmlFragment(canonicalHtml(seed));
          if (!mutate(rng, frag)) continue;
          const out = written(frag);
          if (out === null) continue;
          used.set(name, (used.get(name) ?? 0) + 1);
          const equal = normalizeHtml(out) === normalizeHtml(seed);
          expect(equal, `${kind} ${name}: ${JSON.stringify(seed)} → ${JSON.stringify(out)}`).toBe(kind === 'same');
          if (kind === 'apart') for (const [w, f, by] of WRONG_NORMALIZE) if (by === name && !found.has(w) && f(out) === f(seed)) found.add(w);
        }
      }
    }
    for (const name of [...Object.keys(SAME), ...Object.keys(APART)]) expect(used.get(name) ?? 0, name).toBeGreaterThan(20);
    expect(WRONG_NORMALIZE.map(([w]) => [w, found.has(w)])).toEqual(WRONG_NORMALIZE.map(([w]) => [w, true]));
  });

  it('the model\'s block list is the implementation\'s, in both directions', () => {
    // Written apart above and compared here: a name missing on either side, or added on either side,
    // fails this rather than waiting for a generated value that happens to stand next to it.
    expect([...BLOCK_HTML].sort()).toEqual([...BLOCK_ELEMENTS].sort());
  });

  it('the string-level spellings of one tree give one string', () => {
    for (const seed of STABLE_SEEDS) {
      const c = canonicalHtml(seed);
      for (const variant of [c.replace(/="([^"'<>]*)"/g, "='$1'"), c.replace(/&amp;/g, '&#38;'), c.replace(/é/g, '&eacute;')]) {
        // Only where the spelling did not change the tree (inside raw text it would).
        if (JSON.stringify(walkHtml(parseHtmlFragment(variant))) !== JSON.stringify(walkHtml(parseHtmlFragment(c)))) continue;
        expect(normalizeHtml(variant), variant).toBe(normalizeHtml(seed));
      }
    }
  });
});
