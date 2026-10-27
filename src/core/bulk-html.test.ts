import { describe, it, expect } from 'vitest';
import {
  checkMarkup, htmlFieldsOfListForm, markupChangesOf, markupOf, plainTextMarkupOf,
  type MarkupCheckInput, type MarkupRefusal,
} from './bulk-html.js';
import { parseFragment, defaultTreeAdapter, html as p5 } from 'parse5';

const STORE = 'shop.example.com';

function check(before: string | null, after: string, more: Partial<MarkupCheckInput> = {}): ReturnType<typeof checkMarkup> {
  return checkMarkup({ before, after, storeHost: STORE, startDomains: [], ...more });
}

function reason(before: string | null, after: string, more: Partial<MarkupCheckInput> = {}): MarkupRefusal | 'ok' {
  const r = check(before, after, more);
  return r.ok ? 'ok' : r.reason;
}

function tree(value: string) {
  return parseFragment(defaultTreeAdapter.createElement('div', p5.NS.HTML, []), value, { scriptingEnabled: true });
}

describe('markupOf', () => {
  it('counts a bare element as a triple of its own, so a bare <script> is not invisible', () => {
    const { triples, occurrences } = markupOf(tree('<script></script>'));
    expect(triples).toEqual([{ namespace: 'html', element: 'script', attribute: null, value: null, inTemplate: false }]);
    expect(occurrences).toEqual([{ kind: 'element', namespace: 'html', name: 'script', attributes: [], text: '', inTemplate: false }]);
  });

  it('walks template contents and marks them', () => {
    const { occurrences } = markupOf(tree('<template><iframe src="https://x.example/"></iframe></template>'));
    expect(occurrences.map((o) => [o.name, o.inTemplate])).toEqual([['template', false], ['iframe', true]]);
  });

  it('carries the body of an SVG script, which the parser holds as text nodes', () => {
    const { occurrences } = markupOf(tree('<svg><script>alert(1)</script></svg>'));
    expect(occurrences.find((o) => o.name === 'script')).toMatchObject({ namespace: 'svg', text: 'alert(1)' });
  });

  it('names prefixed attributes with their prefix and sorts them', () => {
    const { occurrences } = markupOf(tree('<svg><a xlink:href="https://x.example/" id="b"></a></svg>'));
    expect(occurrences.find((o) => o.name === 'a')!.attributes).toEqual([['id', 'b'], ['xlink:href', 'https://x.example/']]);
  });

  it('counts comments, bogus ones included', () => {
    const { occurrences } = markupOf(tree('<!-- a --><?x y>'));
    expect(occurrences.map((o) => [o.kind, o.text])).toEqual([['comment', ' a '], ['comment', '?x y']]);
  });
});

describe('checkMarkup: the allowlist and the multiset', () => {
  it('passes a rewrite that adds only allowlisted elements and a link on the store', () => {
    expect(reason('<p>Alt</p>', '<h2>Neu</h2><p><strong>Neu</strong> <em>und</em> <a href="/products/x">mehr</a></p><ul><li>a</li></ul><br>')).toBe('ok');
  });

  it('refuses an element outside the allowlist the before-image does not hold', () => {
    expect(reason('<p>Alt</p>', '<p>Neu</p><iframe src="https://shop.example.com/x"></iframe>')).toBe('element_not_allowed');
  });

  it('passes an element outside the allowlist that the before-image holds the same way', () => {
    const iframe = '<iframe src="https://shop.example.com/v"></iframe>';
    expect(reason(`<p>Alt</p>${iframe}`, `<p>Neu</p>${iframe}`)).toBe('ok');
  });

  it('refuses a second copy of a held element (D1: compared as a multiset, not by name)', () => {
    const iframe = '<iframe src="https://shop.example.com/v"></iframe>';
    expect(reason(iframe, `${iframe}${iframe}`)).toBe('element_not_allowed');
    expect(reason(iframe, `${iframe}<iframe src="https://shop.example.com/w"></iframe>`)).toBe('element_not_allowed');
  });

  it('refuses a changed src on a held iframe, on a domain the field already links to', () => {
    expect(reason('<iframe src="https://shop.example.com/v"></iframe>', '<iframe src="https://shop.example.com/w"></iframe>')).toBe('element_not_allowed');
  });

  it('keeps the allowlist to the HTML namespace: an SVG a is outside it', () => {
    expect(reason('<p>x</p>', '<p>x</p><svg><a href="/y">y</a></svg>')).toBe('element_not_allowed');
    // The svg is held: only the a inside it can fall, and it falls as an element, not as a link.
    expect(reason('<svg></svg>', '<svg><a>y</a></svg>')).toBe('element_not_allowed');
  });

  it('refuses a new img whatever its src, and passes a held one', () => {
    const img = '<img src="https://cdn.example.com/a.jpg">';
    expect(reason('<p>x</p>', `<p>x</p>${img}`)).toBe('new_img');
    expect(reason('<p>x</p>', '<p>x</p><image src="/a.jpg">')).toBe('new_img');
    expect(reason(`<p>x</p>${img}`, `<p>y</p>${img}`)).toBe('ok');
  });

  it('refuses a changed body of a held script or style, in every namespace', () => {
    expect(reason('<script>a()</script>', '<script>b()</script>')).toBe('content_changed');
    expect(reason('<style>p{}</style>', '<style>p{color:red}</style>')).toBe('content_changed');
    expect(reason('<svg><script>a()</script></svg>', '<svg><script>b()</script></svg>')).toBe('content_changed');
    expect(reason('<noscript>a</noscript>', '<noscript>b</noscript>')).toBe('content_changed');
  });

  it('refuses a second bare script beside a held one', () => {
    expect(reason('<script></script>', '<script></script><script></script>')).toBe('element_not_allowed');
  });

  it('tells an element inside a template from the same element outside it (N2)', () => {
    expect(reason('<template><b id="x">t</b></template>', '<template><b id="x">t</b></template>')).toBe('ok');
    expect(reason('<template><b id="x">t</b></template>', '<b id="x">t</b>')).toBe('element_not_allowed');
  });

  it('refuses a new or changed comment, a block-editor comment and a bogus one included', () => {
    expect(reason('<p>a</p>', '<p>a</p><!-- x -->')).toBe('comment_added');
    expect(reason('<!-- x --><p>a</p>', '<!-- y --><p>a</p>')).toBe('comment_added');
    expect(reason('<p>a</p>', '<!-- wp:html --><p>a</p><!-- /wp:html -->')).toBe('comment_added');
    expect(reason('<p>a</p>', '<p>a</p><?x <img src=x onerror=1>>')).toBe('comment_added');
    expect(reason('<!-- wp:paragraph --><p>a</p><!-- /wp:paragraph -->', '<!-- wp:paragraph --><p>b</p><!-- /wp:paragraph -->')).toBe('ok');
  });
});

describe('checkMarkup: attributes with their values', () => {
  it('refuses a new attribute on an allowlisted element', () => {
    expect(reason('<p>a</p>', '<p class="x">a</p>')).toBe('attribute_not_allowed');
    expect(reason('<p>a</p>', '<p><a href="/x" title="t">a</a></p>')).toBe('attribute_not_allowed');
  });

  it('passes a held attribute with its value and refuses a changed value', () => {
    expect(reason('<p class="x">a</p>', '<p class="x">b</p>')).toBe('ok');
    expect(reason('<p class="x">a</p>', '<p class="y">b</p>')).toBe('attribute_not_allowed');
  });

  it('refuses an on* attribute even where the element holds the name with another value', () => {
    expect(reason('<p onclick="a()">a</p>', '<p onclick="b()">a</p>')).toBe('attribute_not_allowed');
  });
});

describe('checkMarkup: the domain rule', () => {
  const link = (href: string, more: Partial<MarkupCheckInput> = {}, before = '<p>a</p>'): MarkupRefusal | 'ok' =>
    reason(before, `<p>a <a href="${href}">b</a></p>`, more);

  it('passes a relative path, which resolves to the store host', () => {
    expect(link('/collections/all')).toBe('ok');
    expect(link('https://shop.example.com/x')).toBe('ok');
  });

  it('refuses a host the store, the start list and the field do not name', () => {
    expect(link('https://evil.example/')).toBe('new_link_domain');
    expect(link('//evil.example/x')).toBe('new_link_domain');
    expect(link('https://shop.example.com@evil.example/')).toBe('new_link_domain');
  });

  it('matches a start domain exactly or at a dot boundary only', () => {
    expect(link('https://www.example.ch/', { startDomains: ['example.ch'] })).toBe('ok');
    expect(link('https://example.ch/', { startDomains: ['example.ch'] })).toBe('ok');
    expect(link('https://evilexample.ch/', { startDomains: ['example.ch'] })).toBe('new_link_domain');
  });

  it('passes a domain the before-image of the field already links to', () => {
    expect(link('https://partner.example/b', {}, '<p><a href="https://partner.example/a">x</a></p>')).toBe('ok');
  });

  it('refuses control characters, U+FFFD and the backslash before resolving', () => {
    expect(link('java&#x09;script:alert(1)')).toBe('url_control_char');
    expect(link('/\\evil.example')).toBe('url_control_char');
    expect(link('&#0;https://shop.example.com/')).toBe('url_control_char');
  });

  it('refuses a scheme other than http, https and mailto', () => {
    expect(link('javascript:alert(1)')).toBe('url_scheme');
    expect(link(' javascript:alert(1)')).toBe('url_scheme');
    expect(link('data:text/html,x')).toBe('url_scheme');
  });

  it('checks a mailto by the domain of its one address', () => {
    expect(link('mailto:info@example.ch', { startDomains: ['example.ch'] })).toBe('ok');
    expect(link('mailto:info@evil.example')).toBe('new_link_domain');
    expect(link('mailto:info@example.ch?bcc=x@evil.example', { startDomains: ['example.ch'] })).toBe('url_scheme');
    expect(link('mailto:info@example.ch,x@evil.example', { startDomains: ['example.ch'] })).toBe('url_scheme');
  });
});

describe('checkMarkup: hidden characters', () => {
  it('refuses a hidden character the before-image does not hold, written or as an entity', () => {
    expect(reason('<p>ab</p>', '<p>a​b</p>')).toBe('hidden_char');
    expect(reason('<p>ab</p>', '<p>a&#x200B;b</p>')).toBe('hidden_char');
    expect(reason('<p>ab</p>', '<p>ab</p><!--​-->')).toBe('comment_added');
  });

  it('counts per code point: as often as the before-image holds it passes, once more does not', () => {
    expect(reason('<p>a​b</p>', '<p>neu a​b</p>')).toBe('ok');
    expect(reason('<p>a​b</p>', '<p>a​b​c</p>')).toBe('hidden_char');
  });
});

describe('checkMarkup: the canonical round trip', () => {
  // Measured with parse5 8.0.1 (div context, scripting on): each serialises to a tree that
  // serialises again to something else, and the first one turns an inert img live.
  const unstable = [
    '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
    '<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>',
    '<form id=a><div></form><form id=b><input></form>',
  ];

  it.each(unstable)('refuses a value whose canonical form is not stable: %s', (v) => {
    expect(reason(v, v)).toBe('not_canonical');
  });

  it('passes a value whose canonical form differs from the input but is stable', () => {
    expect(reason('<p>a</p>', '<P CLASS=x>a')).toBe('attribute_not_allowed');
    expect(reason('<p class="x">a</p>', '<P CLASS=x>b')).toBe('ok');
  });
});

describe('checkMarkup: what the page makes of the value (refuter round 1)', () => {
  // In a fragment a tag open at the end is dropped; in the page the theme's next `>` closes it.
  it.each([
    '<img src=x onerror=alert(1) ',
    '<p>ok</p><img src="https://evil.example/t.png" onerror="alert(1)" ',
    '<a href="javascript:alert(1)" ',
    '<svg onload=alert(1) ',
    '<script ',
    '<p title="',
    '<p>a</p><!-- open',
    '<p>a</p><textarea>',
    '<lynox-end-of-value></lynox-end-of-value><img src=x onerror=1 ',
  ])('refuses a value that leaves markup open at its end: %s', (v) => {
    expect(reason('', v)).toBe('not_canonical');
  });

  it('passes a value that ends in plain markup, an element left open included', () => {
    expect(reason('<p>a</p>', '<p>neu')).toBe('ok');
    expect(reason('<p>a</p>', '<p>neu</p>\n')).toBe('ok');
  });

  it('holds nothing outside a template for what the template holds', () => {
    expect(reason('<template><p onclick="alert(1)">x</p></template>', '<p onclick="alert(1)">x</p>')).toBe('attribute_not_allowed');
    expect(reason('<template><p style="background:url(https://evil.example/t)">x</p></template>', '<p style="background:url(https://evil.example/t)">x</p>')).toBe('attribute_not_allowed');
    expect(reason('<template><a href="javascript:alert(1)">x</a></template>', '<a href="javascript:alert(1)">x</a>')).toBe('url_scheme');
    expect(reason('<template><p onclick="a()">x</p></template>', '<template><p onclick="a()">y</p></template>')).toBe('ok');
  });

  it('holds an attribute value as often as the before-image does, not more', () => {
    expect(reason('<p onclick="track()">a</p>', '<p onclick="track()">a</p><p onclick="track()">b</p>')).toBe('attribute_not_allowed');
    expect(reason('<p onclick="track()">a</p>', '<p onclick="track()">neu</p>')).toBe('ok');
  });

  it('counts every hidden character, also where text may carry one, so cutting the text does not multiply the allowance', () => {
    const cut = Array.from({ length: 20 }, () => `<p>${'a­b'.repeat(30)}</p>`).join('');
    expect(reason('<p>plain</p>', cut)).toBe('hidden_char');
    expect(reason('<p>Silben­trennung</p>', '<p>Neue Silben­trennung</p>')).toBe('ok');
  });

  it('takes a host with a trailing dot as the host', () => {
    expect(reason('<p>a</p>', '<p><a href="https://shop.example.com./x">a</a></p>')).toBe('ok');
  });

  it('does not let a mail address open a web link to its domain, nor the other way', () => {
    expect(reason('<a href="mailto:x@partner.example">m</a>', '<a href="mailto:x@partner.example">m</a><a href="https://partner.example/">w</a>')).toBe('new_link_domain');
    expect(reason('<a href="https://partner.example/">w</a>', '<a href="https://partner.example/">w</a><a href="mailto:x@partner.example">m</a>')).toBe('new_link_domain');
    expect(reason('<a href="mailto:x@partner.example">m</a>', '<a href="mailto:x@partner.example">m</a><a href="mailto:y@partner.example">n</a>')).toBe('ok');
  });

  it('answers a deeply nested value without running out of stack', () => {
    const deep = `<p>${'<strong>'.repeat(5000)}x`;
    expect(() => check('', deep)).not.toThrow();
    expect(() => markupChangesOf('d', '', deep)).not.toThrow();
    expect(() => markupChangesOf('d', '', `<svg>${'<g>'.repeat(200000)}`)).not.toThrow();
  });
});

describe('plainTextMarkupOf', () => {
  it('refuses a < or > the before-image does not hold', () => {
    expect(plainTextMarkupOf('Shirt', 'Shirt <b>neu</b>')).toMatchObject({ ok: false, reason: 'markup_in_text' });
    expect(plainTextMarkupOf('Shirt', 'Shirt >')).toMatchObject({ ok: false, reason: 'markup_in_text' });
    expect(plainTextMarkupOf('Shirt', 'Shirt <')).toMatchObject({ ok: false, reason: 'markup_in_text' });
  });

  it('refuses a tag opening even where the before-image holds as many < and >', () => {
    expect(plainTextMarkupOf('USB-C <> HDMI', 'USB-C <img src=x onerror=1> HDMI')).toMatchObject({ ok: false });
  });

  it('refuses a tag the before-image does not hold as written, though it holds another', () => {
    expect(plainTextMarkupOf('Size <b> 10', '<img src=x onerror=alert(1)>')).toMatchObject({ ok: false, reason: 'markup_in_text' });
    expect(plainTextMarkupOf('Size <b> 10', 'Grösse <b> 10')).toEqual({ ok: true });
  });

  it('passes what the before-image already holds, and inch marks', () => {
    expect(plainTextMarkupOf('Set <3 Teile', 'Neues Set <3 Teile')).toEqual({ ok: true });
    expect(plainTextMarkupOf('Monitor', '27" Monitor')).toEqual({ ok: true });
    expect(plainTextMarkupOf(null, 'Monitor')).toEqual({ ok: true });
  });
});

describe('markupChangesOf', () => {
  it('names an added link with its full value and a removed image', () => {
    const c = markupChangesOf('description', '<p>a</p><img src="/a.jpg">', '<p>a <a href="https://x.example/p?q=1">b</a></p>');
    expect(c.added).toEqual([{ kind: 'element', namespace: 'html', element: 'a', attributes: [['href', 'https://x.example/p?q=1']], text: null, inTemplate: false }]);
    expect(c.removed.map((i) => [i.element, i.attributes])).toEqual([['img', [['src', '/a.jpg']]]]);
  });

  it('leaves out a bare p that comes or goes', () => {
    expect(markupChangesOf('d', '<p>a</p><p>b</p>', '<p>a</p>')).toEqual({ field: 'd', added: [], removed: [] });
    expect(markupChangesOf('d', '<p>a</p>', '<p>a</p><p>b</p>')).toEqual({ field: 'd', added: [], removed: [] });
  });

  it('names an allowlisted element with an attribute, and one inside a template', () => {
    expect(markupChangesOf('d', '<p>a</p>', '<p class="x">a</p>').added.map((i) => [i.element, i.attributes])).toEqual([['p', [['class', 'x']]]]);
    expect(markupChangesOf('d', '<p>a</p>', '<p>a</p><template><p>b</p></template>').added.map((i) => [i.element, i.inTemplate]))
      .toEqual([['template', false], ['p', true]]);
  });

  it('names a removed link and a removed image', () => {
    const c = markupChangesOf('d', '<p><a href="/x">a</a></p><img src="/i.jpg">', '<p>a</p>');
    expect(c.removed.map((i) => i.element)).toEqual(['a', 'img']);
  });

  it('leaves bare allowlisted elements out and keeps a comment in', () => {
    const c = markupChangesOf('description', '<p>a</p>', '<p>a</p><p><strong>b</strong></p><!-- c -->');
    expect(c.added).toEqual([{ kind: 'comment', namespace: '', element: '', attributes: [], text: ' c ', inTemplate: false }]);
    expect(c.removed).toEqual([]);
  });
});

describe('htmlFieldsOfListForm', () => {
  it('declares the description fields per list form and none without one', () => {
    expect(htmlFieldsOfListForm('shopify')).toEqual(['descriptionHtml']);
    expect(htmlFieldsOfListForm('woocommerce')).toEqual(['description', 'short_description']);
    expect(htmlFieldsOfListForm(null)).toEqual([]);
  });
});

describe('checkMarkup never throws', () => {
  it('answers every input with a result', () => {
    for (const v of ['', '<', '<!--', '\u0000', '<svg><![CDATA[x]]>', '<table><td>', '<a href="http://[::1">x</a>']) {
      expect(() => check('', v)).not.toThrow();
    }
  });
});
