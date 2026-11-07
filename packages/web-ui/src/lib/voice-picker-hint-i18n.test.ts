import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The hint under the voice picker. It said "the chosen voice is used for every
 * language", which stops being true once the engine reads a voice the pinned TTS
 * model cannot speak with `DEFAULT_VOICE` (`en_paul_neutral`,
 * `src/core/speak/mistral-voxtral-tts.ts`). The picker lists voices by id, so the
 * hint names that id. Wording: ux U-184.
 *
 * Read as text: importing `i18n.svelte.ts` outside Svelte throws on `$state`. The
 * second describe checks that the picker really renders this key, because a
 * verbatim test on a key nobody renders proves nothing about the screen.
 */
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const i18n = read('./i18n.svelte.ts');
const picker = read('./components/VoiceSettings.svelte');

function entry(key: string): string {
  const lines = i18n.split('\n').filter((l) => l.includes(`'${key}':`));
  expect(lines, `exactly one i18n entry ${key}`).toHaveLength(1);
  return lines[0] ?? '';
}

describe('the hint under the voice picker says what happens to a voice the model cannot speak', () => {
  it('shows the German hint verbatim', () => {
    expect(entry('voice.tts_voice_hint')).toContain(
      "de: 'Die gewählte Stimme gilt für jede Sprache. Kann das eingesetzte Modell sie nicht sprechen, liest lynox stattdessen mit der Standardstimme en_paul_neutral (Englisch) vor.'",
    );
  });

  it('shows the English hint verbatim', () => {
    expect(entry('voice.tts_voice_hint')).toContain(
      "en: 'The chosen voice applies to every language. If the model in use cannot speak it, lynox reads with the default voice, en_paul_neutral (English), instead.'",
    );
  });
});

describe('the picker renders that key', () => {
  it('VoiceSettings shows voice.tts_voice_hint under the voice select', () => {
    const select = picker.indexOf("t('voice.default')");
    const hint = picker.indexOf("t('voice.tts_voice_hint')");
    expect(select).toBeGreaterThan(-1);
    expect(hint).toBeGreaterThan(select);
  });
});
