import { describe, it, expect } from 'vitest';
import { originRunNotice, originRefusedUnattended, originRefusedMandate, originDenied, originCardMail, type SendOrigin } from './origin-notices.js';

/** The sentences of the check before a send: one origin fragment everywhere, and no other target offered. */

const trigger: SendOrigin = { kind: 'triggerRun', name: 'Bericht', author: 'h@x.ch' };

describe('the run result a trigger\'s owner reads', () => {
  it('names the target, where it comes from and the way through the chat, in each language', () => {
    expect(originRunNotice('Der Trigger "Bericht"', 'x@evil.example', 'mail', trigger, 'de')).toBe(
      'Der Trigger "Bericht" hat nicht an "x@evil.example" gesendet: Diesen Empfänger hast nicht du genannt, er stammt aus dem Trigger "Bericht" von h@x.ch. Ein Lauf ohne dich kann nicht nachfragen. Soll es trotzdem hinaus, bitte lynox im Chat darum, dann fragt lynox dich.');
    expect(originRunNotice('The trigger "Bericht"', 'api.evil.example', 'host', { kind: 'readContent' }, 'en')).toBe(
      'The trigger "Bericht" did not send to "api.evil.example": you did not name this address; it comes from content lynox read. A run without you cannot ask. If it should go out anyway, ask lynox in the chat, and lynox will ask you.');
  });
});

describe('no sentence offers another target, and the model texts forbid trying one', () => {
  it.each([
    originDenied('x@evil.example'),
    originRefusedUnattended('x@evil.example', trigger),
    originRefusedMandate('x@evil.example', trigger, 'mail'),
  ])('%s', (text) => {
    expect(text).toMatch(/do not (try again with|try) another recipient or address/i);
  });

  it('the card line is the same fragment as the question\'s', () => {
    expect(originCardMail(trigger, 'en')).toBe('Recipient comes from the trigger "Bericht" set up by h@x.ch.');
  });
});
