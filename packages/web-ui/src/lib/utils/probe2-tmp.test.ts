import { it } from 'vitest';
import { Marked, marked } from 'marked';

const seen: unknown[] = [];
const m = new Marked({
	gfm: true,
	breaks: true,
	renderer: {
		text(token) {
			seen.push(JSON.parse(JSON.stringify({ type: token.type, text: (token as { text?: string }).text, escaped: (token as { escaped?: boolean }).escaped, hasTokens: 'tokens' in token, nTokens: (token as { tokens?: unknown[] }).tokens?.length ?? null })));
			// call default behaviour
			return 'tokens' in token && token.tokens ? this.parser.parseInline(token.tokens) : (token as { text: string }).text;
		},
	},
});

it('probe2', () => {
	for (const input of [
		'Subject: Tom &amp; Jerry',
		'Subject: A&nbsp;B and a < b',
		'<code>&amp; &nbsp; <img/src=x onerror=alert(1)>',
		'- item &amp; more',
		'> quoted &amp; text',
	]) {
		seen.length = 0;
		const out = m.parse(input, { async: false });
		console.log('\n### ' + JSON.stringify(input));
		console.log('tokens seen by text():', JSON.stringify(seen));
		console.log('out:', JSON.stringify(out));
		console.log('lexed:', JSON.stringify(marked.lexer(input)).slice(0, 900));
	}
});
