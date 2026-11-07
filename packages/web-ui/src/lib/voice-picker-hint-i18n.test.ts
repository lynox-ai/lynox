import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The hint under the voice picker. It used to promise that German voices would
 * appear once Mistral ships them; the catalogue has one now, and the pinned TTS
 * model cannot speak it, so the engine reads such a voice with `DEFAULT_VOICE`
 * (`en_paul_neutral`, `src/core/speak/mistral-voxtral-tts.ts`). The picker lists
 * voices by id, so the hint names that id. Wording: ux U-184.
 *
 * Read as text: importing `i18n.svelte.ts` outside Svelte throws on `$state`.
 */
const source = readFileSync(fileURLToPath(new URL('./i18n.svelte.ts', import.meta.url)), 'utf8');

function entry(key: string): string {
  const line = source.split('\n').find((l) => l.includes(`'${key}':`));
  if (!line) throw new Error(`no i18n entry ${key}`);
  return line;
}

describe('the hint under the voice picker says what happens to a voice the model cannot speak', () => {
  it('shows the German hint verbatim', () => {
    expect(entry('config.voice_tts_voice_desc')).toContain(
      "de: 'Die Liste kommt live von Mistral. Kann das eingesetzte Modell die gewählte Stimme nicht sprechen, liest lynox stattdessen mit der Standardstimme en_paul_neutral (Englisch) vor.'",
    );
  });

  it('shows the English hint verbatim', () => {
    expect(entry('config.voice_tts_voice_desc')).toContain(
      "en: 'The list comes live from Mistral. If the model in use cannot speak the chosen voice, lynox reads with the default voice, en_paul_neutral (English), instead.'",
    );
  });
});
