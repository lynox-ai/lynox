import { it } from 'vitest';
import { renderPromptMarkdown } from './prompt-markdown.js';

it('probe3', () => {
	const inputs = [
		'Subject: Tom &amp; Jerry',
		'Subject: A&nbsp;B',
		'Subject: 5 &lt; 6',
		'plain & amp',
		'**To:** a@b.c\n**Subject:** Tom &amp; Jerry\n\n> body &amp; more',
	];
	for (const i of inputs) {
		console.log(JSON.stringify(i), '=>', JSON.stringify(renderPromptMarkdown(i)));
	}
});
