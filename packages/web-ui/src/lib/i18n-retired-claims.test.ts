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
	// The model catalog renders its own residency notes (LLMSettings.svelte) and is not on
	// the pro guard's watch list, so it is pinned here as well.
	const catalog = readFileSync(
		fileURLToPath(new URL('../../../../src/core/llm/catalog.ts', import.meta.url)),
		'utf8',
	);
	const line = src.split('\n').find((l) => l.includes("'config.voice_stt_privacy'"));
	// The key the settings screen actually renders (VoiceSettings.svelte); the config.* twin
	// above is the unwired phase-0 block. Both are pinned, and the whole file is checked, so
	// a duplicate key further down cannot bring the wording back unnoticed.
	const rendered = src.split('\n').find((l) => l.includes("'voice.stt_privacy'"));

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

	it('scopes the rendered voice settings sentence to the audio, in both languages', () => {
		expect(rendered).toBeDefined();
		expect(rendered).toContain('the audio stays on your machine');
		expect(rendered).toContain('bleibt das Audio auf deinem System');
		expect(rendered).not.toContain('runs everything locally');
		expect(rendered).not.toContain('läuft alles lokal');
	});

	it('carries the retired sentence nowhere in the i18n table or the model catalog', () => {
		for (const text of [src, catalog]) {
			expect(text).not.toContain('nothing leaves your machine');
			expect(text).not.toContain('nothing leaves the host');
			expect(text).not.toContain('runs everything locally');
		}
	});
});
