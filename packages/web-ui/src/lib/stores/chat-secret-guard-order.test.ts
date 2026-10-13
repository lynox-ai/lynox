import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ChatView is a component and is not mounted in this test setup; what matters is the ORDER in
// which handleSend checks the text and hands it on as the answer to an open question.
describe('ChatView checks typed text for a credential before it answers a prompt', () => {
	const SRC = readFileSync(fileURLToPath(new URL('../components/ChatView.svelte', import.meta.url)), 'utf-8');

	it('the looksLikeSecret check in handleSend comes before answerPrompt', () => {
		const start = SRC.indexOf('async function handleSend()');
		expect(start, 'handleSend found').toBeGreaterThan(-1);
		const end = SRC.indexOf('\n\t}\n', start);
		expect(end, 'end of handleSend found').toBeGreaterThan(start);
		const body = SRC.slice(start, end);
		const check = body.indexOf('if (looksLikeSecret(task)) {');
		const answer = body.indexOf('answerPrompt(task);');
		expect(check, 'handleSend checks').toBeGreaterThan(-1);
		expect(answer, 'and answers').toBeGreaterThan(-1);
		expect(check, 'checks before it answers').toBeLessThan(answer);
	});
});
