/**
 * Code fences in sanitized message HTML, found and replaced on the PARSED FRAGMENT.
 *
 * The same rule as `markdown-render.ts`: never run a string rewrite over sanitized HTML. A
 * pattern over the serialized string sees text where the browser sees structure, and how a
 * browser serializes an attribute value is not something this code controls. Here a fence is
 * an element, its language is read from its class, and its code is its text content: markup
 * inside a fence is never carried into what replaces it.
 */

/** One fence: the language from `language-<lang>` and the code as plain text. */
export interface CodeFence {
	readonly lang: string;
	readonly code: string;
}

/** A parsed message whose fences can be rendered and swapped in, then serialized once. */
export interface FencedHtml {
	readonly fences: readonly CodeFence[];
	/** Replace fence `i` with `results[i]` (HTML built by this app), serialize the whole once. */
	render(results: readonly string[]): string;
}

const LANG_CLASS = /^language-(\w+)$/;

/**
 * Parse `html` (already sanitized) and collect its fences: a `<pre>` whose only element child
 * is a `<code class="language-…">`, the shape marked emits for a fenced block.
 */
export function parseFences(html: string, doc: Document): FencedHtml {
	return { fences: collect(html, doc).fences, render: (results) => {
		// A fresh parse per render: the component renders twice (now, then after the rich-block
		// debounce), and a fragment whose fences were already swapped has none left to swap.
		const { root, nodes } = collect(html, doc);
		nodes.forEach((pre, i) => {
			const result = results[i];
			if (result === undefined) return;
			const holder = doc.createElement('template');
			holder.innerHTML = result;
			pre.replaceWith(...Array.from(holder.content.childNodes));
		});
		return serialize(root.content);
	} };
}

/** The fragment's markup, written out node by node. `template.innerHTML` would do the same in a
 *  browser; not every DOM implementation reflects edits to `content` there. */
function serialize(fragment: DocumentFragment): string {
	let out = '';
	for (const n of Array.from(fragment.childNodes)) {
		if (n.nodeType === 1) out += (n as Element).outerHTML;
		else if (n.nodeType === 3) out += (n.textContent ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
		else if (n.nodeType === 8) out += `<!--${n.textContent ?? ''}-->`;
	}
	return out;
}

function collect(html: string, doc: Document): { root: HTMLTemplateElement; nodes: Element[]; fences: CodeFence[] } {
	// A <template> parses into inert content: nothing in it loads or runs.
	const root = doc.createElement('template');
	root.innerHTML = html;
	const nodes: Element[] = [];
	const fences: CodeFence[] = [];
	for (const pre of Array.from(root.content.querySelectorAll('pre'))) {
		const code = pre.firstElementChild;
		if (!code || pre.children.length !== 1 || code.tagName !== 'CODE') continue;
		const m = LANG_CLASS.exec(code.getAttribute('class') ?? '');
		if (!m) continue;
		nodes.push(pre);
		fences.push({ lang: m[1]!, code: code.textContent ?? '' });
	}
	return { root, nodes, fences };
}
