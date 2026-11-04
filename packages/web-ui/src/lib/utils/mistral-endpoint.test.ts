import { describe, it, expect } from 'vitest';
import { MISTRAL_API_BASE, isMistralPresetBase } from './mistral-endpoint.js';

describe('the Mistral preset endpoint in the web UI', () => {
	it('writes the EU regional endpoint', () => {
		expect(MISTRAL_API_BASE).toBe('https://api.eu.mistral.ai/v1');
	});

	it('recognises the EU endpoint and the global one a config saved before the move names', () => {
		expect(isMistralPresetBase('https://api.eu.mistral.ai/v1')).toBe(true);
		expect(isMistralPresetBase('https://api.mistral.ai/v1')).toBe(true);
	});

	it('recognises nothing else', () => {
		for (const url of ['https://api.mistral.ai.evil.com/v1', 'https://api.groq.com/openai/v1', '', null, undefined]) {
			expect(isMistralPresetBase(url), String(url)).toBe(false);
		}
	});
});
