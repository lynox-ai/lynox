import { describe, it, expect } from 'vitest';
import { canonicalHtml, htmlEqual, normalizeHtml, parseHtmlFragment, walkHtml } from './html-tree.js';

/**
 * The fixed cases of Shopify PRD §21.2 item 5 and §21.7 for `html-tree.ts`. The generated cases
 * are in `html-tree.fuzz.test.ts`.
 */

// M6, run m6-2026-10-26T15-10-53-615Z on the development store: what was sent, and what Shopify
// gave back (protocol `m10-protokoll.md`, "M6 HTML"). Byte for byte as in the run's answers.
const M6_SENT = [
  '<p  class="m6"   data-m6="1">Spaces &amp; entities: &lt;b&gt; &#169; &nbsp;é ü 😀</p>',
  '<p>line<br>break<br/>self-closed<br />spaced</p>',
  '<ul><li>one<ul><li>nested</li></ul></li><li>two</li></ul>',
  '<!-- m6 comment -->',
  '<p style="color: red">styled</p>',
  '<a href="https://example.com/x?a=1&b=2" target="_blank" rel="noopener">link</a>',
  '<script>window.m6=1</script>',
  '<iframe src="https://example.com/embed"></iframe>',
  '<P>UPPER</P><unknown-tag>custom</unknown-tag>',
  '<p>unclosed',
].join('\n');
const M6_BACK = [
  '<p class="m6" data-m6="1">Spaces &amp; entities: &lt;b&gt; ©  é ü 😀</p>',
  '<p>line<br>break<br>self-closed<br>spaced</p>',
  '<ul>',
  '<li>one<ul><li>nested</li></ul>',
  '</li>',
  '<li>two</li>',
  '</ul>',
  '<!-- m6 comment -->',
  '<p style="color: red">styled</p>',
  '<a href="https://example.com/x?a=1&amp;b=2" target="_blank" rel="noopener">link</a>',
  '<script>window.m6=1</script>',
  '<iframe src="https://example.com/embed"></iframe>',
  '<p>UPPER</p><unknown-tag>custom</unknown-tag>',
  '<p>unclosed</p>',
].join('\n');
// M6 of §16.8, the three-input measurement of 26.10.
const M6_THREE: readonly (readonly [string, string])[] = [
  ['<p>Text</p>', '<p>Text</p>'],
  ['plain text without a tag', 'plain text without a tag'],
  ['<p  class="x"  id="y">a&amp;b</p>', '<p class="x" id="y">a&amp;b</p>'],
];

describe('normalizeHtml: what it equates', () => {
  it('equates what M6 sent with what Shopify gave back', () => {
    expect(normalizeHtml(M6_BACK)).toBe(normalizeHtml(M6_SENT));
    for (const [sent, back] of M6_THREE) expect(htmlEqual(sent, back), sent).toBe(true);
  });

  it('equates attribute order, quoting and spacing, and entity spellings', () => {
    expect(htmlEqual('<a href="/x" title="t">a</a>', "<a  title='t' href=/x>a</a>")).toBe(true);
    expect(htmlEqual('<p>&#169; &eacute; &amp;</p>', '<p>© é &amp;</p>')).toBe(true);
    expect(htmlEqual('<p>a  \n\t b</p>', '<p>a b</p>')).toBe(true);
  });

  it('drops whitespace-only text between block boundaries: the M6 list re-layout', () => {
    expect(htmlEqual('<ul><li>a</li><li>b</li></ul>', '<ul>\n<li>a</li>\n<li>b</li>\n</ul>')).toBe(true);
    expect(htmlEqual('<p>a</p><p>b</p>', '<p>a</p>\n<p>b</p>')).toBe(true);
    expect(htmlEqual('<li>one<ul><li>n</li></ul></li>', '<li>one<ul><li>n</li></ul>\n</li>')).toBe(true);
    // The fragment's own start and end are block boundaries.
    expect(htmlEqual('\n<p>a</p>\n', '<p>a</p>')).toBe(true);
  });

  it('is a string per tree, independent of how often it is asked', () => {
    expect(normalizeHtml(M6_SENT)).toBe(normalizeHtml(M6_SENT));
  });

  it('carries every element\'s namespace', () => {
    // An element's namespace follows from where it stands in the parsed tree, so no two values
    // differ by a namespace alone; the encoding still has to carry it, or a consumer comparing
    // subtrees could not tell an SVG `a` from an HTML one.
    const tree = JSON.parse(normalizeHtml('<svg><a></a></svg><a></a>')) as [string, string, string, unknown, [string, string][]][];
    expect([tree[0]![1], tree[0]![4][0]![1], tree[1]![1]]).toEqual(['http://www.w3.org/2000/svg', 'http://www.w3.org/2000/svg', 'http://www.w3.org/1999/xhtml']);
  });
});

describe('normalizeHtml: what it keeps apart (§21.7)', () => {
  const apart: readonly (readonly [string, string, string])[] = [
    ['whitespace between inline elements', '<b>a</b> <i>b</i>', '<b>a</b><i>b</i>'],
    ['U+00A0 against a space', 'a&nbsp;b', 'a b'],
    ['whitespace inside pre', '<pre>a  b</pre>', '<pre>a b</pre>'],
    ['whitespace between blocks inside pre', '<pre><p>a</p>\n<p>b</p></pre>', '<pre><p>a</p><p>b</p></pre>'],
    ['whitespace inside textarea', '<textarea>a  b</textarea>', '<textarea>a b</textarea>'],
    ['whitespace inside a raw-text element', '<style>a  b</style>', '<style>a b</style>'],
    ['a changed href', '<a href="https://a.example/x">l</a>', '<a href="https://a.example/y">l</a>'],
    ['an added attribute', '<p>a</p>', '<p class="x">a</p>'],
    ['an added bare element', '<p>a</p>', '<p>a</p><b></b>'],
    ['one non-whitespace character', '<p>abc</p>', '<p>abd</p>'],
    ['the namespace of an element', '<svg><script>x</script></svg>', '<script>x</script>'],
    ['a comment', '<p>a</p><!--x-->', '<p>a</p><!--y-->'],
    ['a template\'s content', '<template><b>x</b></template>', '<template><i>x</i></template>'],
    ['leading space inside a block', '<p> a</p>', '<p>a</p>'],
    ['whitespace between a block and an inline element', '<p>a</p> <b>x</b>', '<p>a</p><b>x</b>'],
    ['whitespace at the start of an inline parent, before a block', '<span> <p>x</p></span>', '<span><p>x</p></span>'],
    ['U+00A0 alone between blocks', '<p>a</p>&nbsp;<p>b</p>', '<p>a</p><p>b</p>'],
    ['whitespace inside an inline element below pre', '<pre><b>a  b</b></pre>', '<pre><b>a b</b></pre>'],
    ['whitespace between foreign elements named like blocks', '<svg><section></section> <section></section></svg>', '<svg><section></section><section></section></svg>'],
  ];
  it.each(apart)('%s', (_name, a, b) => {
    expect(htmlEqual(a, b)).toBe(false);
  });
});

describe('canonicalHtml', () => {
  it('is parse5\'s serialisation: the tree, written out', () => {
    expect(canonicalHtml('<P  class=x>a<br/>b')).toBe('<p class="x">a<br>b</p>');
  });

  // Measured with parse5 8.0.1, div context, scripting on (integrationen-3, re-measured by cp
  // 2026-10-27): the round trip through serialisation changes the tree, so the second pass differs.
  it.each([
    '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
    '<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>',
    '<form id=a><div></form><form id=b><input></form>',
  ])('is not idempotent on %s', (v) => {
    const once = canonicalHtml(v);
    expect(canonicalHtml(once)).not.toBe(once);
  });

  it('is idempotent on the noscript case, whose raw-text content is text', () => {
    const v = '<noscript><p title="</noscript><img src=x onerror=y>">';
    const once = canonicalHtml(v);
    expect(canonicalHtml(once)).toBe(once);
    // With scripting on, noscript is raw text up to the first `</noscript>`: the attribute value
    // a scripting-off reader sees is the noscript's content here, and the img after it is an
    // element. That is the case: the markup check must read this tree, not the scripting-off one.
    const els = walkHtml(parseHtmlFragment(v)).filter((n) => n.kind === 'element');
    expect(els.map((n) => n.kind === 'element' && [n.name, n.content])).toEqual([['noscript', '<p title="'], ['img', null]]);
  });
});

describe('walkHtml', () => {
  it('walks template contents, marked, and foreign content with its namespace', () => {
    const nodes = walkHtml(parseHtmlFragment('<template><img src=x></template><svg><script>s</script></svg>'));
    const els = nodes.filter((n) => n.kind === 'element');
    expect(els.map((n) => [n.name, n.inTemplate])).toEqual([['template', false], ['img', true], ['svg', false], ['script', false]]);
    const svgScript = els[3]!;
    expect(svgScript.kind === 'element' && [svgScript.namespace, svgScript.content]).toEqual(['http://www.w3.org/2000/svg', 's']);
  });

  it('carries the text of raw-text and RCDATA elements as content, and none of others', () => {
    const els = walkHtml(parseHtmlFragment('<style>s</style><textarea>t</textarea><p>p</p>')).filter((n) => n.kind === 'element');
    expect(els.map((n) => n.kind === 'element' && n.content)).toEqual(['s', 't', null]);
  });

  it('walks comments, in template contents too, and counts depth from the fragment', () => {
    const nodes = walkHtml(parseHtmlFragment('<!--a--><p><b>x</b></p><template><!--b--></template>'));
    expect(nodes.map((n) => [n.kind, n.kind === 'element' ? n.name : n.kind === 'comment' ? n.data : n.value, n.depth, n.inTemplate])).toEqual([
      ['comment', 'a', 0, false], ['element', 'p', 0, false], ['element', 'b', 1, false], ['text', 'x', 2, false],
      ['element', 'template', 0, false], ['comment', 'b', 1, true],
    ]);
  });

  it('keeps an attribute without a value, and a foreign attribute\'s namespace', () => {
    const els = walkHtml(parseHtmlFragment('<p hidden>a</p><svg><a xlink:href="u"></a></svg>')).filter((n) => n.kind === 'element');
    expect(els[0]!.kind === 'element' && els[0]!.attrs).toEqual([{ namespace: null, prefix: null, name: 'hidden', value: '' }]);
    const a = els[2]!;
    expect(a.kind === 'element' && a.attrs).toEqual([{ namespace: 'http://www.w3.org/1999/xlink', prefix: 'xlink', name: 'href', value: 'u' }]);
  });
});
