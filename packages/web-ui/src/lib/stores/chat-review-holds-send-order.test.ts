import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The store half — an open review holds the send, and `sendBlockedByReview()` says so — is
// tested by behaviour in chat-review-holds-send.svelte.test.ts.
// ChatView is a component and is not mounted in this test setup; what matters there is the
// ORDER in which it asks and clears. Read from the source, per send path.
describe('ChatView asks before it clears the input', () => {
	const SRC = readFileSync(fileURLToPath(new URL('../components/ChatView.svelte', import.meta.url)), 'utf-8');

	it('the typed send asks sendBlockedByReview before inputText is cleared for sendMessage', () => {
		const start = SRC.indexOf('async function handleSend()');
		const send = SRC.indexOf('await sendMessage(task ||', start);
		expect(start, 'handleSend found').toBeGreaterThan(-1);
		expect(send, 'its sendMessage call found').toBeGreaterThan(start);
		const body = SRC.slice(start, send);
		const ask = body.lastIndexOf('if (sendBlockedByReview()) return;');
		const clear = body.lastIndexOf("inputText = '';");
		expect(ask, 'handleSend asks').toBeGreaterThan(-1);
		expect(clear, 'and clears').toBeGreaterThan(-1);
		expect(ask, 'asks before the clear that precedes sendMessage').toBeLessThan(clear);
	});

	it('the voice auto-send asks too, and falls back to putting the transcript in the input', () => {
		expect(SRC).toContain('if (isVoiceAutoSendEnabled() && !sendBlockedByReview()) {');
	});
});
