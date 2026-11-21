// Why a trigger's run does not do its work (`blocked_reason` from `GET /api/triggers`): a cause the
// engine names, said here in the UI's language with the way out, and with the value it carries
// (a host) apart from the sentence so the view can set it apart. Watch kinds come from U-392; another
// cause adds a kind and a key.

export type BlockedReason = { kind: 'watch_allow_list'; host: string } | { kind: 'watch_deny_all' } | { kind: 'watch_https' };

export type BlockedReasonKey = 'triggers.blocked_reason.watch_allow_list' | 'triggers.blocked_reason.watch_deny_all' | 'triggers.blocked_reason.watch_https';

const KEYS: Readonly<Record<BlockedReason['kind'], BlockedReasonKey>> = {
  watch_allow_list: 'triggers.blocked_reason.watch_allow_list',
  watch_deny_all: 'triggers.blocked_reason.watch_deny_all',
  watch_https: 'triggers.blocked_reason.watch_https',
};

/** The sentence around the value; `host` is null where the sentence names none. */
export function blockedReasonParts(reason: BlockedReason, t: (key: BlockedReasonKey) => string): { before: string; host: string | null; after: string } {
  const text = t(KEYS[reason.kind]);
  if (reason.kind !== 'watch_allow_list') return { before: text, host: null, after: '' };
  const at = text.indexOf('{host}');
  if (at < 0) return { before: text, host: null, after: '' };
  return { before: text.slice(0, at), host: reason.host, after: text.slice(at + '{host}'.length) };
}
