import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyMail, type LLMCaller } from './index.js';
import { FORWARDED_REASON_DE, isForwardedByPerson } from './forwarded.js';

/** A model that archives everything: the worst case this check exists for. */
const archivesAll: LLMCaller = async () =>
  JSON.stringify({ bucket: 'auto_handled', confidence: 0.95, one_line_why_de: 'Nur zur Info' });

const base = {
  accountAddress: 'me@acme.example',
  accountDisplayName: 'Me (Acme)',
  fromDisplayName: undefined,
};

interface Fixture { id: string; expectedBucket: string; fromAddress: string; subject: string; body: string }
const corpus = (JSON.parse(readFileSync(join(import.meta.dirname, '../../../../tests/eval/inbox-classifier-fixtures.json'), 'utf8')) as { fixtures: Fixture[] }).fixtures;

describe('a mail that matches the forward patterns from a person is not left archived', () => {
  it('shows it even when the model archives it, and says why', async () => {
    const out = await classifyMail(
      { ...base, subject: 'Fwd: Feedback zum Entwurf', fromAddress: 'a.mustermann@example.com', body: 'FYI' },
      archivesAll,
    );
    expect(out.bucket).toBe('requires_user');
    expect(out.failReason).toBe('forwarded_by_person');
    // The model's reason for archiving is not what the user reads.
    expect(out.reasonDe).toBe(FORWARDED_REASON_DE);
  });

  it('does not take an Outlook reply for a forward', () => {
    // Outlook writes this marker above a quoted reply too, so on its own it does not count.
    expect(isForwardedByPerson({ subject: 'AW: Angebot', fromAddress: 'a.mustermann@example.com', body: 'Passt.\n-----Ursprüngliche Nachricht-----\nVon: me@acme.example' })).toBe(false);
  });

  it('leaves a mail that is not a forward to the model', async () => {
    const out = await classifyMail(
      { ...base, subject: 'Dein Newsletter', fromAddress: 'a.mustermann@example.com', body: 'Neuigkeiten der Woche' },
      archivesAll,
    );
    expect(out.bucket).toBe('auto_handled');
    expect(out.failReason).toBeNull();
  });

  it('recognises a forward by its subject alone', () => {
    expect(isForwardedByPerson({ subject: 'WG: Rechnung', fromAddress: 'a.mustermann@example.com', body: 'bitte schauen' })).toBe(true);
  });

  it('recognises a forward by its body header alone', () => {
    expect(isForwardedByPerson({
      subject: 'Rechnung', fromAddress: 'a.mustermann@example.com',
      body: 'FYI\n---------- Forwarded message ---------\nFrom: billing@acme.example',
    })).toBe(true);
  });

  it('does not count a forward a system sent', () => {
    expect(isForwardedByPerson({ subject: 'Fwd: Rechnung', fromAddress: 'no-reply@acme.example', body: 'FYI' })).toBe(false);
    // control: the same mail from a person
    expect(isForwardedByPerson({ subject: 'Fwd: Rechnung', fromAddress: 'a.mustermann@acme.example', body: 'FYI' })).toBe(true);
  });

  // The whole eval corpus against a model that archives everything: what the check moves is
  // exactly the forwards. Of those, the ones labelled requires_user can no longer be lost (the
  // two the eval lost in real runs among them), and the ones labelled auto_handled are what it
  // costs: each now shown instead of archived.
  it('moves exactly the corpus forwards, 440 and 430 among them, and names what it costs', async () => {
    const moved: Fixture[] = [];
    for (const f of corpus) {
      const out = await classifyMail({ ...base, subject: f.subject, fromAddress: f.fromAddress, body: f.body }, archivesAll);
      if (out.failReason === 'forwarded_by_person') moved.push(f);
    }
    expect(moved.length).toBe(corpus.filter((f) => f.id.startsWith('forwarded-thread-')).length);
    expect(moved.every((f) => f.id.startsWith('forwarded-thread-'))).toBe(true);
    // The two the eval lost in real runs; implied by the two lines above, named because they are why.
    expect(moved.map((f) => f.id)).toEqual(expect.arrayContaining(['forwarded-thread-de-440', 'forwarded-thread-en-430']));
    expect(moved.filter((f) => f.expectedBucket === 'auto_handled').map((f) => f.id).sort()).toEqual([
      'forwarded-thread-de-442', 'forwarded-thread-de-450', 'forwarded-thread-de-452',
      'forwarded-thread-en-434', 'forwarded-thread-en-445', 'forwarded-thread-en-458',
    ]);
  });
});
