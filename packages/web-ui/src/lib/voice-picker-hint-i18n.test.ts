import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fillTemplate } from './i18n-fill.js';
import { defaultVoice } from './voice-label.js';

/**
 * The hint under the voice picker. It says what happens to a voice the pinned TTS
 * model cannot speak: the engine reads it with `DEFAULT_VOICE` (`en_paul_neutral`,
 * `src/core/speak/mistral-voxtral-tts.ts`). It named that voice by its raw id; it now
 * names it as the picker does, by the provider's name and the language in the
 * interface's language. Wording: U-184, U-332.
 *
 * Read as text: importing `i18n.svelte.ts` outside Svelte throws on `$state`. The
 * sentence is built here the way the picker builds it (`fillTemplate`, the same
 * function `tf` uses, over `defaultVoice`), so the test reads the sentence the screen
 * shows. The last describe checks that the picker really renders it.
 */
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const i18n = read('./i18n.svelte.ts');
const picker = read('./components/VoiceSettings.svelte');

function template(key: string, lang: 'de' | 'en'): string {
  const lines = i18n.split('\n').filter((l) => l.includes(`'${key}':`));
  expect(lines, `exactly one i18n entry ${key}`).toHaveLength(1);
  const m = new RegExp(`${lang}: '([^']*)'`).exec(lines[0] ?? '');
  expect(m, `${key} has a ${lang} text`).not.toBeNull();
  return m?.[1] ?? '';
}

/** The sentence as the picker shows it for `voices` in `lang`. */
function hint(voices: Array<{ id: string; language?: string; description?: string }>, lang: 'de' | 'en'): string {
  const d = defaultVoice(voices, lang);
  return d.name !== undefined
    ? fillTemplate(template('voice.tts_voice_hint', lang), { name: d.name, language: d.language })
    : fillTemplate(template('voice.tts_voice_hint_unnamed', lang), { language: d.language });
}

const LIVE = [{ id: 'en_paul_neutral', language: 'en', description: 'Paul - Neutral' }, { id: 'fr_marie_neutral', language: 'fr', description: 'Marie - Neutral' }];

describe('the hint under the voice picker names the default voice by its name, never its id', () => {
  it('in German', () => {
    expect(hint(LIVE, 'de')).toBe('Die gewählte Stimme gilt für jede Sprache. Kann das eingesetzte Modell sie nicht sprechen, liest lynox stattdessen mit der Standardstimme „Paul - Neutral“ (Englisch) vor.');
  });

  it('in English', () => {
    expect(hint(LIVE, 'en')).toBe('The chosen voice applies to every language. If the model in use cannot speak it, lynox reads aloud with the default voice, “Paul - Neutral” (English), instead.');
  });

  it('without a name for it in the list: the language only, in both languages', () => {
    const unnamed = [{ id: 'en_paul_neutral', language: 'en' }];
    expect(hint(unnamed, 'de')).toBe('Die gewählte Stimme gilt für jede Sprache. Kann das eingesetzte Modell sie nicht sprechen, liest lynox stattdessen mit der Standardstimme (Englisch) vor.');
    expect(hint(unnamed, 'en')).toBe('The chosen voice applies to every language. If the model in use cannot speak it, lynox reads aloud with the default voice (English) instead.');
  });

  it('without the voice in the list at all: the language from its id', () => {
    expect(hint([], 'de')).toContain('mit der Standardstimme (Englisch) vor.');
  });

  it('no sentence names the raw id', () => {
    for (const voices of [LIVE, [], [{ id: 'en_paul_neutral', language: 'en' }]]) {
      for (const lang of ['de', 'en'] as const) expect(hint(voices, lang)).not.toContain('en_paul_neutral');
    }
    expect(i18n).not.toContain('en_paul_neutral');
  });
});

describe('the picker renders that sentence', () => {
  it('VoiceSettings shows the hint under the voice select, built from both keys', () => {
    // Anchored on the voice select's own binding: the hint has to sit after that select
    // and inside the same <label>.
    const select = picker.indexOf('bind:value={config.tts_voice}');
    expect(select).toBeGreaterThan(-1);
    const selectEnd = picker.indexOf('</select>', select);
    const labelEnd = picker.indexOf('</label>', select);
    const shown = picker.indexOf('{fallbackHint}');
    expect(selectEnd).toBeGreaterThan(select);
    expect(shown).toBeGreaterThan(selectEnd);
    expect(shown).toBeLessThan(labelEnd);
    expect(picker).toContain("tf('voice.tts_voice_hint', { name: d.name, language: d.language })");
    expect(picker).toContain("tf('voice.tts_voice_hint_unnamed', { language: d.language })");
  });
});
