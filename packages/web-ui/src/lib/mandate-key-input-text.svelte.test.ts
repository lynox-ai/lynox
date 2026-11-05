/**
 * The wording a mandate's helper reads when their input was refused for looking like a key
 * (ux U-150), held verbatim in both languages,
 * for the web UI and for the engine's fallback sentence (English, without the text put back).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { t, setLocale, getLocale } from './i18n.svelte.js';

const DE_L = 'Deine Eingabe wurde nicht gesendet, weil sie etwas enthält, das wie ein Schlüssel, ein Token oder ein Passwort aussieht. In diesem Chat nimmt lynox keine entgegen. Nur der Inhaber dieser Instanz speichert Schlüssel, in einem eigenen Chat; bitte den Inhaber, ihn dort zu speichern. War es kein Schlüssel, schick die Eingabe ohne den Teil, der wie einer aussieht.';
const DE_R = 'Deine Eingabe wurde nicht gesendet, weil sie etwas enthält, das wie ein Schlüssel, ein Token oder ein Passwort aussieht. In diesem Chat nimmt lynox keine entgegen. Nur der Inhaber dieser Instanz speichert Schlüssel, in einem eigenen Chat; bitte den Inhaber, ihn dort zu speichern. War es kein Schlüssel, entferne den Teil, der wie einer aussieht, und schick die Eingabe noch einmal.';
const EN_L = 'Your input was not sent because it contains something that looks like a key, token or password. lynox does not take any in this chat. Only the owner of this instance stores keys, in a chat of their own; ask the owner to store it there. If it was not a key, send your input again without the part that looks like one.';
const EN_R = 'Your input was not sent because it contains something that looks like a key, token or password. lynox does not take any in this chat. Only the owner of this instance stores keys, in a chat of their own; ask the owner to store it there. If it was not a key, remove the part that looks like one and send your input again.';

describe('the refusal of a helper\'s input that looks like a key', () => {
  const initial = getLocale();
  afterEach(() => setLocale(initial));

  it('reads verbatim in German and English, with and without the text put back', () => {
    setLocale('de');
    expect(t('chat.mandate_key_input')).toBe(DE_L);
    expect(t('chat.mandate_key_input_returned')).toBe(DE_R);
    setLocale('en');
    expect(t('chat.mandate_key_input')).toBe(EN_L);
    expect(t('chat.mandate_key_input_returned')).toBe(EN_R);
  });

  it('the engine\'s fallback sentence is the English one without the text put back', () => {
    const src = readFileSync(join(__dirname, '../../../../src/core/secret-store.ts'), 'utf8');
    expect(src).toContain(`export const MANDATE_KEY_INPUT_REFUSAL = '${EN_L}';`);
  });
});
