import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Pins the wording of an in-product disclosure string that was retired once and
 * came back once.
 *
 * `config.voice_stt_privacy` (en) said "With whisper.cpp nothing leaves your
 * machine." The claim was retired on 2026-09-04 because it is not true of the
 * engine as shipped (pro registry entry `selfhost-only-inference-leaves`); #1306
 * scoped the sentence to the audio, as the German twin already did. #1305 merged
 * after #1306 and carried the old string back in, which no test here noticed —
 * the pro `retired-claim-guard` noticed, and from then on failed every pro pull
 * request against core main.
 *
 * The source is read as text, like `preset-cards-i18n.test.ts` does, so the test
 * does not depend on a Svelte-aware import of the runes module.
 */
describe('i18n — retired disclosure claims stay retired', () => {
	const src = readFileSync(fileURLToPath(new URL('./i18n.svelte.ts', import.meta.url)), 'utf8');
	const line = src.split('\n').find((l) => l.includes("'config.voice_stt_privacy'"));

	it('has the voice STT privacy key', () => {
		expect(line).toBeDefined();
	});

	it('scopes the whisper.cpp sentence to the audio in English', () => {
		expect(line).toContain('With whisper.cpp the audio stays on your machine.');
		expect(line).not.toContain('nothing leaves your machine');
	});

	it('keeps the German twin scoped to the audio', () => {
		expect(line).toContain('verlässt kein Audio dein System');
	});
});
