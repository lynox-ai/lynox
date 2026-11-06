import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ChatView is not mounted in this test setup; that it hands the status of a failed voice
// request to these helpers is read from its source.
describe('ChatView hands a failed voice request\'s status to these helpers', () => {
	const SRC = readFileSync(fileURLToPath(new URL('./ChatView.svelte', import.meta.url)), 'utf-8');

	it('a transcription answered with an error status', () => {
		const start = SRC.indexOf('/transcribe`');
		const branch = SRC.indexOf('if (!res.ok || !res.body) {', start);
		expect(start, 'the transcribe request found').toBeGreaterThan(-1);
		expect(branch, 'its failure branch found').toBeGreaterThan(start);
		const body = SRC.slice(branch, SRC.indexOf('return;', branch));
		expect(body).toContain('transcribeFailureText(res.status)');
	});

	it('read-aloud answered with an error status', () => {
		expect(SRC).toContain("case 'http':        return speakHttpFailureText(err.status);");
	});
});
