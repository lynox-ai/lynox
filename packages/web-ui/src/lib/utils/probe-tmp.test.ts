import { it } from 'vitest';
import { marked } from 'marked';
import { renderPromptMarkdown, PROMPT_EMITTED_TAGS } from './prompt-markdown.js';

const bare = (s: string) => marked.parse(s, { async: false }) as string;

const cases: Array<[string, string]> = [
	['plain amp', 'Subject: Tom & Jerry'],
	['entity amp', 'Subject: Tom &amp; Jerry'],
	['nbsp', 'Subject: A&nbsp;B'],
	['lt entity', 'Subject: &lt;script&gt; talk'],
	['numeric ent', 'Subject: caf&#233; &#x41;'],
	['quotes', `Subject: "quoted" and 'single'`],
	['raw lt', 'Subject: a < b'],
	['url qs', 'See https://x.example/p?a=1&b=2&c=3'],
	['md link qs', '[click](https://x.example/p?a=1&b=2)'],
	['bs escape amp', 'Subject: 50\\% \\& more'],
	['copyright', 'Subject: ACME &copy; 2026'],
	['task list', '- [ ] todo one\n- [x] done two'],
	['footnote', 'text[^1]\n\n[^1]: note body'],
	['del', '~~struck text~~'],
	['autolink', '<https://a.example/?x=1&y=2>'],
	['fence lang', '```json\n{"a":1}\n```'],
	['table align', '| a | b |\n| :-- | --: |\n| 1 | 2 |'],
	['def legit', '[Ticket]: https://support.example/1\n\nfollow-up line'],
	['def-lookalike', '**Note**\n\n[2026-07-27]: server rebooted\n\nnext line'],
	['reflink', 'see [docs][d]\n\n[d]: https://example.com'],
	['heading amp', '## Q&A &amp; more'],
	['code amp', 'inline `a && b &amp; c`'],
	['pre amp', '```\na && b &amp; c\n```'],
	['emphasis nested', 'a **bold & _em_** b'],
];

it('probe', () => {
for (const [name, input] of cases) {
	const n = renderPromptMarkdown(input);
	const o = bare(input);
	const tags = [...new Set([...n.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)[\s/>]/g)].map((m) => m[1]!.toLowerCase()))];
	const unexpected = tags.filter((t) => !PROMPT_EMITTED_TAGS.includes(t));
	console.log(`\n### ${name}`);
	console.log(`IN  : ${JSON.stringify(input)}`);
	console.log(`NEW : ${JSON.stringify(n)}`);
	console.log(`OLD : ${JSON.stringify(o)}`);
	console.log(`DIFF: ${n === o ? 'same' : '*** DIFFERENT ***'}${unexpected.length ? `  UNEXPECTED-TAGS=${unexpected}` : ''}`);
}
});
