import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getLocale, setLocale } from '../i18n.svelte.js';
import { speakHttpFailureText, transcribeFailureText } from './voice-failure.js';

let locale: ReturnType<typeof getLocale>;
beforeEach(() => { locale = getLocale(); });
afterEach(() => { setLocale(locale); });

describe('the toast for a voice route\'s 402 says the AI budget is reached', () => {
	it('dictation, in German and English', () => {
		setLocale('de');
		expect(transcribeFailureText(402)).toBe('Diktieren geht gerade nicht: Dein KI-Budget ist erreicht.');
		setLocale('en');
		expect(transcribeFailureText(402)).toBe('Dictation is unavailable right now: your AI budget is reached.');
	});

	it('read-aloud, in German and English', () => {
		setLocale('de');
		expect(speakHttpFailureText(402)).toBe('Vorlesen geht gerade nicht: Dein KI-Budget ist erreicht.');
		setLocale('en');
		expect(speakHttpFailureText(402)).toBe('Read-aloud is unavailable right now: your AI budget is reached.');
	});

	it('other statuses keep their texts', () => {
		setLocale('de');
		expect(transcribeFailureText(503)).toBe('Transkription nicht verfügbar. Whisper ist auf dem Server nicht installiert.');
		expect(transcribeFailureText(500)).toBe('Transkription fehlgeschlagen. Versuche es nochmal.');
		expect(speakHttpFailureText(500)).toBe('Vorlesen fehlgeschlagen — Server-Fehler 500');
	});
});
