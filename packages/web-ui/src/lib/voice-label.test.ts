import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TTS_VOICE, defaultVoice, languageName, voiceLabel } from './voice-label.js';

const picker = readFileSync(fileURLToPath(new URL('./components/VoiceSettings.svelte', import.meta.url)), 'utf8');

describe('a voice is named by its name and its language, in the language of the interface', () => {
  it('names the language, never the code', () => {
    expect(languageName('en', 'de')).toBe('Englisch');
    expect(languageName('en', 'en')).toBe('English');
    expect(languageName('fr', 'de')).toBe('Französisch');
  });

  it('a voice with a name: the name and the language in brackets', () => {
    const paul = { id: 'en_paul_neutral', language: 'en', description: 'Paul - Neutral' };
    expect(voiceLabel(paul, 'de')).toBe('Paul - Neutral (Englisch)');
    expect(voiceLabel(paul, 'en')).toBe('Paul - Neutral (English)');
  });

  it('a voice without a name: the id, and the language in brackets when known', () => {
    expect(voiceLabel({ id: 'voice_481', language: 'de' }, 'de')).toBe('voice_481 (Deutsch)');
    expect(voiceLabel({ id: 'voice_481', description: '  ' }, 'de')).toBe('voice_481');
  });

  it('the default voice: its name and language from the list, else the language from its id', () => {
    expect(defaultVoice([{ id: 'en_paul_neutral', language: 'en', description: 'Paul - Neutral' }], 'de')).toEqual({ name: 'Paul - Neutral', language: 'Englisch' });
    expect(defaultVoice([{ id: 'en_paul_neutral', language: 'en' }], 'en')).toEqual({ language: 'English' });
    // The list's language wins over the id's prefix: should the catalog file the voice
    // under another language, the hint names that one.
    expect(defaultVoice([{ id: 'en_paul_neutral', language: 'fr', description: 'Paul - Neutral' }], 'de')).toEqual({ name: 'Paul - Neutral', language: 'Französisch' });
    expect(defaultVoice([{ id: 'gb_jane_neutral', language: 'en', description: 'Jane - Neutral' }], 'de')).toEqual({ language: 'Englisch' });
  });
});

describe('kept in step with the engine', () => {
  it('the default voice is the engine\'s DEFAULT_VOICE', () => {
    const engine = readFileSync(fileURLToPath(new URL('../../../../src/core/speak/mistral-voxtral-tts.ts', import.meta.url)), 'utf8');
    expect(engine).toContain(`export const DEFAULT_VOICE = '${DEFAULT_TTS_VOICE}';`);
  });

  it('the default voice\'s id starts with a language, which the hint names when the list lacks the voice', () => {
    // Slugs start with a region as often as with a language (`gb_jane_neutral`); a
    // default moved to one of those would put a raw "gb" in the hint.
    const prefix = DEFAULT_TTS_VOICE.split('_')[0] ?? '';
    expect(languageName(prefix, 'en')).not.toBe(prefix);
  });
});

describe('the picker and its summary row name voices this way', () => {
  it('the options and the summary label go through voiceLabel', () => {
    expect(picker).toContain('<option value={v.id}>{voiceLabel(v, getLocale())}</option>');
    expect(picker).toContain('label: voiceLabel(v, getLocale())');
    expect(picker).not.toContain("' (' + v.language + ')'");
  });
});
