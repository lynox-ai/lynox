// === Owner-known send targets ===
//
// Whether the owner of the instance named a send target, rather than text the model read
// somewhere (a mail, a page, a run's result, a helper's turn). Read per conversation, derived
// from its sources at the moment a call is checked, never collected as a set: nothing a call
// does, an answer to a question included, adds to what counts as known.
//
// Sources:
//  1. the words the owner typed in this thread (`ThreadStore.ownerTypedTexts`): only messages
//     whose author is the owner, and only the typed words, never a loaded context or an upload;
//  2. contacts last written by the owner from a turn that had read nothing from outside
//     (`CRM.contactOrigin`: `_written_by = owner`, `_written_untrusted` empty);
//  3. recipients of an earlier send whose every recipient was owner-known (`mail_sent_log`);
//  plus, for one run only, the instruction of a trigger the owner set up and nobody else changed
//  (`withInstruction`).
//
// Matching is by exact normalized token (`send-target.ts`): a host never matches a subdomain or a
// suffix, an address never a substring. A source that throws says nothing; no source's failure
// makes a target known.

import type { RowSource } from './data-store.js';
import { normalizeHostName, normalizeHostTarget, normalizeMailTarget, type SendTarget } from './send-target.js';

/** `unreadable`: no source knew the target, and at least one could not be read. */
export type OwnerKnownVerdict = 'known' | 'foreign' | 'unreadable';

/** The read-only face every holder gets: there is no way to add a target. */
export interface OwnerKnownReader {
  known(target: SendTarget): OwnerKnownVerdict;
  /**
   * Every host the owner named in the typed words (and the counted instruction), in ASCII form,
   * for the shell's egress set. Contacts and the send log are mail sources and name no host.
   * A source that throws names nothing.
   */
  typedHosts?(): string[];
}

export interface OwnerKnownSources {
  /** The owner's typed words in this conversation's thread. Absent: no thread to read. */
  readonly ownerTexts?: (() => readonly string[]) | undefined;
  /** Where the contact with this address came from; `null` when there is none. */
  readonly contactOrigin?: ((address: string) => RowSource | null) | undefined;
  /** Whether an earlier send whose every recipient was owner-known went to this address. */
  readonly sentToOwnerKnown?: ((address: string) => boolean) | undefined;
}

/** The author tag a contact must carry to count (`principalTag` of the owner). */
const OWNER_TAG = 'owner';

/** Every mail address in a text, normalized; anything that does not normalize is left out. */
const MAIL_IN_TEXT = /[^\s<>()[\]{},;:"'`]+@[^\s<>()[\]{},;:"'`]+/gu;
/** URLs with a scheme, for their host. */
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/giu;
/** A bare host name: labels joined by dots, at least one dot. */
const HOST_IN_TEXT = /(?<![\p{L}\p{N}@.-])[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?(?:\.[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?)+(?![\p{L}\p{N}@-])/gu;

/** Punctuation a sentence puts right after a token, which is not part of it. */
function trimTrailing(token: string): string {
  return token.replace(/[.,;:!?)\]}>'"]+$/u, '');
}

/**
 * The send targets a text names, as exact tokens: each mail address, the host of each URL, and
 * each bare host name that is not part of an address or a URL.
 */
export function targetsInText(text: string): { mail: Set<string>; host: Set<string> } {
  const mail = new Set<string>();
  const host = new Set<string>();
  let rest = text.replace(URL_IN_TEXT, (url) => {
    const target = normalizeHostTarget(trimTrailing(url));
    if (target !== null) host.add(target.value);
    return ' ';
  });
  rest = rest.replace(MAIL_IN_TEXT, (addr) => {
    const target = normalizeMailTarget(trimTrailing(addr));
    if (target !== null) mail.add(target.value);
    return ' ';
  });
  for (const m of rest.matchAll(HOST_IN_TEXT)) {
    const name = normalizeHostName(m[0]);
    if (name !== null) host.add(name);
  }
  return { mail, host };
}

/** Whether `target` is among the tokens of `texts`. */
function namedIn(texts: readonly string[], target: SendTarget): boolean {
  for (const text of texts) {
    const found = targetsInText(text);
    if ((target.kind === 'mail' ? found.mail : found.host).has(target.value)) return true;
  }
  return false;
}

export class OwnerKnownTargets implements OwnerKnownReader {
  private constructor(
    private readonly _sources: OwnerKnownSources,
    private readonly _instruction: string | undefined,
  ) {}

  /** A reader over these sources. Missing sources know nothing. */
  static of(sources: OwnerKnownSources): OwnerKnownTargets {
    return new OwnerKnownTargets(sources, undefined);
  }

  /** A reader that knows nothing: every target is foreign. */
  static none(): OwnerKnownTargets {
    return new OwnerKnownTargets({}, undefined);
  }

  /**
   * The same sources plus the instruction of the trigger whose run this is, for that run only.
   * The caller decides whether the instruction counts (`ownerInstructionCounts`).
   */
  withInstruction(instruction: string | undefined): OwnerKnownTargets {
    return new OwnerKnownTargets(this._sources, instruction);
  }

  known(target: SendTarget): OwnerKnownVerdict {
    let unreadable = false;
    const ask = (fn: () => boolean): boolean => {
      try {
        return fn();
      } catch {
        unreadable = true;
        return false;
      }
    };
    const { ownerTexts, contactOrigin, sentToOwnerKnown } = this._sources;
    if (this._instruction !== undefined && ask(() => namedIn([this._instruction ?? ''], target))) return 'known';
    if (ownerTexts !== undefined && ask(() => namedIn(ownerTexts(), target))) return 'known';
    if (target.kind === 'mail') {
      if (contactOrigin !== undefined && ask(() => {
        const origin = contactOrigin(target.value);
        return origin !== null && origin.writtenBy === OWNER_TAG && !origin.untrusted;
      })) return 'known';
      if (sentToOwnerKnown !== undefined && ask(() => sentToOwnerKnown(target.value))) return 'known';
    }
    return unreadable ? 'unreadable' : 'foreign';
  }

  typedHosts(): string[] {
    const texts: string[] = this._instruction !== undefined ? [this._instruction] : [];
    try {
      if (this._sources.ownerTexts !== undefined) texts.push(...this._sources.ownerTexts());
    } catch {
      // Unreadable: the thread names nothing.
    }
    const hosts = new Set<string>();
    for (const text of texts) for (const host of targetsInText(text).host) hosts.add(host);
    return [...hosts];
  }
}

// Compile guard: the face every holder gets has no way to add a target. A method named `add` (or
// any writer) on it fails the build here.
type NoWriter = 'add' extends keyof OwnerKnownReader ? never : 'set' extends keyof OwnerKnownReader ? never : true;
export const OWNER_KNOWN_READER_HAS_NO_WRITER: NoWriter = true;
