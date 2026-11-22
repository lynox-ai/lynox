import { describe, expect, it } from 'vitest';
import { OwnerKnownTargets, targetsInText, type OwnerKnownReader } from './owner-known-targets.js';
import type { RowSource } from './data-store.js';
import type { SendTarget } from './send-target.js';

/**
 * Whether the owner named a send target: read from the conversation's sources at check time,
 * matched as exact normalized tokens, and never known because a source failed.
 */

const mail = (value: string): SendTarget => ({ kind: 'mail', value });
const host = (value: string): SendTarget => ({ kind: 'host', value });
const typed = (...texts: string[]): OwnerKnownTargets => OwnerKnownTargets.of({ ownerTexts: () => texts });
const ownerContact: RowSource = { writtenBy: 'owner', untrusted: false, grants: [] };

describe('targets in the owner\'s words are exact tokens', () => {
  it('an address is not a part of another, and a host is neither a suffix nor a subdomain', () => {
    const reader = typed('Bitte an max@firma.ch und firma.ch schicken.');
    expect(reader.known(mail('max@firma.ch'))).toBe('known');
    expect(reader.known(mail('x@firma.ch'))).toBe('foreign');
    expect(reader.known(mail('ax@firma.ch'))).toBe('foreign');
    expect(reader.known(host('firma.ch'))).toBe('known');
    expect(reader.known(host('a.ch'))).toBe('foreign');
    expect(reader.known(host('x.firma.ch'))).toBe('foreign');
    expect(reader.known(host('evil-firma.ch'))).toBe('foreign');
  });

  it('a host named only inside an address does not count as a host', () => {
    expect(typed('mail anna@firma.ch').known(host('firma.ch'))).toBe('foreign');
  });

  it('reads the host of a URL, and of a bare name, in the ASCII form of an international domain', () => {
    expect(typed('post to https://api.müller.ch/v1').known(host('api.xn--mller-kva.ch'))).toBe('known');
    expect(typed('müller.ch').known(host('xn--mller-kva.ch'))).toBe('known');
    expect(typed('xn--mller-kva.ch').known(host('xn--mller-kva.ch'))).toBe('known');
    expect(typed('Anna@Müller.CH').known(mail('anna@xn--mller-kva.ch'))).toBe('known');
  });

  it('drops a sentence\'s trailing punctuation, not a token\'s own characters', () => {
    expect(targetsInText('an anna@firma.ch, dann https://api.firma.ch/x.').mail).toEqual(new Set(['anna@firma.ch']));
    expect(targetsInText('an anna@firma.ch, dann https://api.firma.ch/x.').host).toEqual(new Set(['api.firma.ch']));
  });
});

describe('the sources', () => {
  it('knows nothing without a source: unknown is foreign', () => {
    expect(OwnerKnownTargets.none().known(mail('anna@firma.ch'))).toBe('foreign');
    expect(OwnerKnownTargets.of({}).known(host('firma.ch'))).toBe('foreign');
  });

  it('a contact counts only when the owner wrote it last and no write to it came after outside content', () => {
    const reader = (origin: RowSource | null): OwnerKnownReader => OwnerKnownTargets.of({ contactOrigin: () => origin });
    expect(reader(ownerContact).known(mail('anna@firma.ch'))).toBe('known');
    expect(reader({ ...ownerContact, writtenBy: 'mandate:h@x.ch' }).known(mail('anna@firma.ch'))).toBe('foreign');
    expect(reader({ ...ownerContact, writtenBy: 'trigger:t-1' }).known(mail('anna@firma.ch'))).toBe('foreign');
    expect(reader({ ...ownerContact, writtenBy: null }).known(mail('anna@firma.ch'))).toBe('foreign');
    expect(reader({ ...ownerContact, untrusted: true }).known(mail('anna@firma.ch'))).toBe('foreign');
    expect(reader(null).known(mail('anna@firma.ch'))).toBe('foreign');
    // A contact is an address, never a host.
    expect(reader(ownerContact).known(host('firma.ch'))).toBe('foreign');
  });

  it('a recipient of an owner-known send counts', () => {
    const reader = OwnerKnownTargets.of({ sentToOwnerKnown: (a) => a === 'anna@firma.ch' });
    expect(reader.known(mail('anna@firma.ch'))).toBe('known');
    expect(reader.known(mail('bob@firma.ch'))).toBe('foreign');
  });

  it('a trigger\'s instruction counts for the reader made with it, and for no other', () => {
    const base = OwnerKnownTargets.of({});
    const run = base.withInstruction('Bericht jeden Montag an buchhaltung@firma.ch');
    expect(run.known(mail('buchhaltung@firma.ch'))).toBe('known');
    expect(base.known(mail('buchhaltung@firma.ch'))).toBe('foreign');
    expect(run.withInstruction(undefined).known(mail('buchhaltung@firma.ch'))).toBe('foreign');
  });
});

describe('a source that cannot be read never makes a target known', () => {
  const boom = (): never => { throw new Error('store closed'); };

  it.each([
    ['thread', OwnerKnownTargets.of({ ownerTexts: boom })],
    ['contacts', OwnerKnownTargets.of({ contactOrigin: boom })],
    ['sent log', OwnerKnownTargets.of({ sentToOwnerKnown: boom })],
  ])('%s throws: unreadable, not known', (_name, reader) => {
    expect(reader.known(mail('anna@firma.ch'))).toBe('unreadable');
  });

  it('another source that knows the target still answers known', () => {
    const reader = OwnerKnownTargets.of({ ownerTexts: () => ['anna@firma.ch'], contactOrigin: boom });
    expect(reader.known(mail('anna@firma.ch'))).toBe('known');
  });
});

describe('the reader has no way to add a target', () => {
  it('exposes known() and nothing that writes', () => {
    const reader: OwnerKnownReader = typed('anna@firma.ch');
    const members = Object.getOwnPropertyNames(Object.getPrototypeOf(reader)).filter((n) => n !== 'constructor').sort();
    expect(members).toEqual(['known', 'withInstruction']);
    // `withInstruction` returns a new reader; the one it was called on is unchanged.
    (reader as OwnerKnownTargets).withInstruction('bob@firma.ch');
    expect(reader.known(mail('bob@firma.ch'))).toBe('foreign');
  });
});
