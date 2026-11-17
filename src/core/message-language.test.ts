import { describe, it, expect } from 'vitest';
import { messageLanguage } from './message-language.js';

describe('messageLanguage', () => {
  it('reads English messages as English, also with German names and places in them', () => {
    expect(messageLanguage('Please make exactly these three tool calls, one after the other, without asking.')).toBe('en');
    expect(messageLanguage('Summarize the open invoices from Keller AG in Zürich.')).toBe('en');
    expect(messageLanguage('Orders go out on Mondays to Müller AG, and we pay within 30 days.')).toBe('en');
  });

  it('reads German messages as German', () => {
    expect(messageLanguage('Welche Rechnungen sind diesen Monat noch offen?')).toBe('de');
    expect(messageLanguage('Plane einen Massenlauf für meinen Shopify-Shop: bessere SEO-Titel für alle aktiven Produkte.')).toBe('de');
    expect(messageLanguage('Schreib mir bitte eine kurze Offerte für die Keller AG.')).toBe('de');
  });

  it('does not count a quoted passage, inline code or a link', () => {
    expect(messageLanguage('The customer wrote: „Ich will jede Änderung zuerst in einer Vorschau sehen, bevor ich sie freigebe.“ What should I answer?')).toBe('en');
    expect(messageLanguage('Der Kunde schrieb: "We only want to see the preview before we approve it." Was antworte ich ihm?')).toBe('de');
    expect(messageLanguage('Was bedeutet `the value is not set for this key` in der Meldung von https://example.com/the/api/for/you?')).toBe('de');
  });

  it('leaves undecided what the words do not settle: another language, a short reply, a mixed message', () => {
    expect(messageLanguage('Bonjour, pouvez-vous préparer une offre pour la société Dupont ?')).toBeNull();
    expect(messageLanguage('ok, mach')).toBeNull();
    expect(messageLanguage('ok, run it')).toBeNull();
    expect(messageLanguage('Call the open-meteo API for Zürich und sag mir, ob es morgen regnet.')).toBeNull();
    expect(messageLanguage('')).toBeNull();
  });

  it('leaves every other offered language undecided, not English', () => {
    for (const message of [
      'On a besoin de toi, il me faut une réponse avant vendredi.',
      'Non mi piace, a me sembra che il prezzo sia troppo alto e no.',
      'No me gusta, a mi me parece que el precio es muy alto.',
      'Dit is een test en het is belangrijk voor ons bedrijf.',
      'Eu não sei se a reunião do projeto é amanhã, me diga.',
      'Jag bor i Stockholm och jag har en bil i garaget.',
    ]) expect(messageLanguage(message), message).toBeNull();
  });

  it('leaves undecided a message whose opening instruction is in the other language than the pasted text', () => {
    expect(messageLanguage('Bitte beantworte diese Mail kurz:\n\nHi, could you send us the updated price list for the spring season? We would like to place an order by Friday and need the new numbers for that.')).toBeNull();
    expect(messageLanguage('Fass das zusammen: The quarterly report shows that revenue grew by 4 % and that the costs of the new warehouse were higher than planned.')).toBeNull();
    expect(messageLanguage('Summarize this for me: Der Quartalsbericht zeigt, dass der Umsatz um 4 % gewachsen ist und die Kosten für das neue Lager höher waren als geplant.')).toBeNull();
    // Control: an opening in the same language decides as before.
    expect(messageLanguage('Please make exactly these three tool calls, one after the other, without asking: 1) api_setup with action list.')).toBe('en');
  });

  it('counts words spelled alike in both languages for neither side', () => {
    // "in", "an", "will", "am", "also", "so", "was", "die", "es", "da": none of them may decide.
    expect(messageLanguage('in an will am also so was die es da')).toBeNull();
  });
});
