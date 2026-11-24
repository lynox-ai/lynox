// === Mail thread-key derivation ===
//
// Pure envelope → stable thread key. Lives in the mail layer because it
// operates on a `MailEnvelope` and is needed by BOTH the inbox classifier
// (inbound) and `mail_reply`'s outbound-reconcile (so the inbox item a chat
// reply answers can be matched even when the mail carries no Message-ID).
// Keeping it here means the mail tools never import inbox internals — the
// dependency direction stays inbox → mail.
//
// Previously duplicated in inbox/watcher-hook.ts + inbox/cold-start-adapter.ts
// + inbox/body-refresh.ts ("duplicated on purpose"); now single-sourced.

import type { MailEnvelope } from './provider.js';

/**
 * Derive a stable thread key for an envelope. Prefers the provider's own
 * `threadKey`, then a Message-ID-based key (globally unique), and finally
 * `folder:uid` — account-relative but stable within a folder for the life of
 * the UIDVALIDITY, which is enough to match a freshly-fetched original back to
 * the inbox item that was classified from the same message.
 */
export function resolveThreadKey(env: MailEnvelope): string {
  if (env.threadKey) return env.threadKey;
  if (env.messageId) return `imap:${env.messageId}`;
  return `imap:${env.folder}:${String(env.uid)}`;
}

/** How many Message-IDs of a References header are read, and how many parents are tried. */
export const MAX_PARENT_IDS = 20;
// A References header past this length is cut before it is scanned; real chains stay far below.
const MAX_REFERENCES_CHARS = 16_384;
const MESSAGE_ID_RE = /<[^<>\s]{1,512}>/g;
const ONE_MESSAGE_ID_RE = /^<[^<>\s]{1,512}>$/;

/**
 * The Message-IDs of a References header, oldest first, keeping only the newest
 * `MAX_PARENT_IDS`. The header comes from the sender, so it is bounded before it is scanned.
 */
export function parseReferenceIds(raw: string | undefined): string[] {
  if (!raw) return [];
  const text = raw.length > MAX_REFERENCES_CHARS ? raw.slice(-MAX_REFERENCES_CHARS) : raw;
  const ids = text.match(MESSAGE_ID_RE) ?? [];
  return ids.slice(-MAX_PARENT_IDS);
}

/**
 * Whether the provider grouped this mail into a thread itself (a Gmail thread, a Graph
 * conversation, an IMAP server's thread id). An IMAP server without thread ids leaves the key
 * at the mail's own Message-ID, and then only the reply headers say which thread it belongs to.
 */
export function hasProviderThread(env: MailEnvelope): boolean {
  return env.threadKey !== undefined && env.threadKey !== '' && env.threadKey !== env.messageId;
}

/**
 * The Message-IDs a mail names as its parents, nearest first: In-Reply-To, then References from
 * the newest back. Only ids in Message-ID form (`<…>`) count; its own Message-ID is left out, and
 * at most `MAX_PARENT_IDS` are returned.
 */
export function parentMessageIds(env: MailEnvelope): string[] {
  const out: string[] = [];
  const add = (id: string | undefined): void => {
    if (!id || !ONE_MESSAGE_ID_RE.test(id) || id === env.messageId || out.includes(id) || out.length >= MAX_PARENT_IDS) return;
    out.push(id);
  };
  add(env.inReplyTo?.trim());
  const refs = env.references ?? [];
  for (let i = refs.length - 1; i >= 0; i--) add(refs[i]);
  return out;
}
