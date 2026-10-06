import { describe, it, expect } from 'vitest';
import { parseHTML } from 'linkedom';

import { parseFences } from './code-fences.js';

// How a DOM serializes an attribute value differs between implementations (linkedom, used here,
// writes `<` and `>` in attribute values as they are). The tests therefore read the resulting
// DOM, never the output string: a fence is found as an element and replaced as an element,
// whatever text its attributes hold.

const { document } = parseHTML('<html><body></body></html>');
const dom = (html: string): DocumentFragment => {
	const t = document.createElement('template');
	t.innerHTML = html;
	return t.content;
};

/** A fence whose span carries markup-looking text in its title, as serialized by this DOM. */
const TITLE_WITH_MARKUP = (() => {
	const t = document.createElement('template');
	t.innerHTML = '<pre><code class="language-js"><span title="&lt;/code&gt;&lt;/pre&gt;&lt;b id=extra&gt;">x</span></code></pre>';
	return t.innerHTML;
})();

describe('parseFences', () => {
	it('⭐ finds a fence as an element: its attribute text stays attribute text', () => {
		// A pattern over the serialized string reads this fence differently from the DOM. Kept
		// here to show the fixture tells the two apart.
		const asString = /<pre><code class="language-(\w+)">([\s\S]*?)<\/code><\/pre>/.exec(TITLE_WITH_MARKUP);
		expect(asString?.[2]).not.toBe(dom(TITLE_WITH_MARKUP).querySelector('code')?.innerHTML);

		const parsed = parseFences(TITLE_WITH_MARKUP, document);
		expect(parsed.fences).toEqual([{ lang: 'js', code: 'x' }]);

		const out = dom(parsed.render(['<div id="hl">highlighted</div>']));
		expect(out.querySelector('#extra')).toBeNull();
		expect(out.querySelector('#hl')?.textContent).toBe('highlighted');
		expect(out.querySelector('pre')).toBeNull();
	});

	it('replaces an ordinary fence and leaves the text around it as it was', () => {
		const parsed = parseFences('<p id="a">before</p><pre><code class="language-js">const a = 1 &lt; 2;</code></pre><p id="b">after</p>', document);
		expect(parsed.fences).toEqual([{ lang: 'js', code: 'const a = 1 < 2;' }]);
		const out = dom(parsed.render(['<div id="hl">X</div>']));
		expect(out.querySelector('#a')?.textContent).toBe('before');
		expect(out.querySelector('#b')?.textContent).toBe('after');
		expect(out.querySelector('#hl')).not.toBeNull();
		expect(out.querySelector('pre')).toBeNull();
	});

	it('inserts a result verbatim: a `$&` in it is text, not a reference to the fence', () => {
		const parsed = parseFences('<pre><code class="language-json">{}</code></pre>', document);
		const out = dom(parsed.render(['<div id="rep">$&amp;</div>']));
		expect(out.querySelector('#rep')?.textContent).toBe('$&');
	});

	it('leaves a pre that is not a fence alone: no language class, or more than the code inside', () => {
		const html = '<pre><code>plain</code></pre><pre><code class="language-js">a</code><b>b</b></pre>';
		expect(parseFences(html, document).fences).toEqual([]);
	});

	it('renders again from the message, so a later render with other results shows those', () => {
		// The component renders now with a placeholder, and again once a rich block is ready.
		const parsed = parseFences('<p>t</p><pre><code class="language-mermaid">a</code></pre>', document);
		expect(dom(parsed.render(['<i id="r">placeholder</i>'])).querySelector('#r')?.textContent).toBe('placeholder');
		expect(dom(parsed.render(['<i id="r">diagram</i>'])).querySelector('#r')?.textContent).toBe('diagram');
	});

	it('reads the language from the whole class, not a part of it', () => {
		expect(parseFences('<pre><code class="xlanguage-js">a</code></pre>', document).fences).toEqual([]);
	});
});
