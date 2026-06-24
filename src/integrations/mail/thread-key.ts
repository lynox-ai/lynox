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
