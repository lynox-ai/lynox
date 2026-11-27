// Why a trigger's run does not do its work (`blocked_reason` from `GET /api/triggers`): a cause the
// engine names, said here in the UI's language with the way out, and with the value it carries
// (a host) apart from the sentence so the view can set it apart. Watch kinds come from U-392; another
// cause adds a kind and a key. A failed watch run's stored cause (`watch_fetch`) is said with the
// engine's own sentence for it, without the lead that names the page.

/** Why a watch could not read its page, as the engine stored it with the failed run (`RunCause`). */
export type WatchFetchCause =
  | { readonly kind: 'blocked' | 'refused' | 'unresolved' | 'unreachable' | 'tls' | 'other' }
  | { readonly kind: 'timeout'; readonly seconds: number }
  | { readonly kind: 'http'; readonly status: number }
  | { readonly kind: 'too-large'; readonly megabytes: number };

export type BlockedReason = { kind: 'watch_allow_list'; host: string } | { kind: 'watch_deny_all' } | { kind: 'watch_https' } | { kind: 'watch_fetch'; cause: WatchFetchCause };

type PolicyKind = 'watch_allow_list' | 'watch_deny_all' | 'watch_https';

export type BlockedReasonKey =
  | 'triggers.blocked_reason.watch_allow_list' | 'triggers.blocked_reason.watch_deny_all' | 'triggers.blocked_reason.watch_https'
  | 'triggers.run_cause.watch.blocked' | 'triggers.run_cause.watch.refused' | 'triggers.run_cause.watch.unresolved'
  | 'triggers.run_cause.watch.unreachable' | 'triggers.run_cause.watch.tls' | 'triggers.run_cause.watch.other'
  | 'triggers.run_cause.watch.timeout' | 'triggers.run_cause.watch.http' | 'triggers.run_cause.watch.http_word'
  | 'triggers.run_cause.watch.too_large'
  | 'triggers.run_cause.watch.final' | 'triggers.run_cause.watch.again' | 'triggers.run_cause.watch.redirect'
  | 'triggers.run_cause.http_word.401' | 'triggers.run_cause.http_word.403' | 'triggers.run_cause.http_word.404'
  | 'triggers.run_cause.http_word.410' | 'triggers.run_cause.http_word.429' | 'triggers.run_cause.http_word.redirect'
  | 'triggers.run_cause.http_word.server';

const KEYS: Readonly<Record<PolicyKind, BlockedReasonKey>> = {
  watch_allow_list: 'triggers.blocked_reason.watch_allow_list',
  watch_deny_all: 'triggers.blocked_reason.watch_deny_all',
  watch_https: 'triggers.blocked_reason.watch_https',
};

const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** The word for the HTTP statuses an owner meets most, or none (the engine's `httpStatusWord`). */
function httpWordKey(status: number): BlockedReasonKey | null {
  switch (status) {
    case 401: return 'triggers.run_cause.http_word.401';
    case 403: return 'triggers.run_cause.http_word.403';
    case 404: return 'triggers.run_cause.http_word.404';
    case 410: return 'triggers.run_cause.http_word.410';
    case 429: return 'triggers.run_cause.http_word.429';
    default:
      if (REDIRECTS.has(status)) return 'triggers.run_cause.http_word.redirect';
      return status >= 500 && status <= 599 ? 'triggers.run_cause.http_word.server' : null;
  }
}

/** `text` with each `{name}` slot replaced by its value; the values are numbers and fixed words. */
function fill(text: string, vars: Readonly<Record<string, string>>): string {
  let out = text;
  for (const [name, value] of Object.entries(vars)) out = out.split(`{${name}}`).join(value);
  return out;
}

/**
 * Why a watch could not read its page, then what happens next: the engine's sentence for the cause
 * (`watchFetchFailed`) without the lead that names the page, which the card shows on its own line.
 */
export function watchFetchReason(cause: WatchFetchCause, t: (key: BlockedReasonKey) => string): string {
  const reason = ((): string => {
    switch (cause.kind) {
      case 'blocked': return t('triggers.run_cause.watch.blocked');
      case 'refused': return t('triggers.run_cause.watch.refused');
      case 'unresolved': return t('triggers.run_cause.watch.unresolved');
      case 'unreachable': return t('triggers.run_cause.watch.unreachable');
      case 'tls': return t('triggers.run_cause.watch.tls');
      case 'other': return t('triggers.run_cause.watch.other');
      case 'timeout': return fill(t('triggers.run_cause.watch.timeout'), { seconds: String(cause.seconds) });
      case 'too-large': return fill(t('triggers.run_cause.watch.too_large'), { megabytes: String(cause.megabytes) });
      case 'http': {
        const word = httpWordKey(cause.status);
        return word === null
          ? fill(t('triggers.run_cause.watch.http'), { status: String(cause.status) })
          : fill(t('triggers.run_cause.watch.http_word'), { status: String(cause.status), word: t(word) });
      }
      default: return '';
    }
  })();
  if (reason === '') return '';
  if (cause.kind === 'http' && REDIRECTS.has(cause.status)) return `${reason} ${t('triggers.run_cause.watch.redirect')}`;
  const permanent = cause.kind === 'blocked' || cause.kind === 'refused' || cause.kind === 'too-large'
    || (cause.kind === 'http' && (cause.status === 404 || cause.status === 410));
  return `${reason} ${t(permanent ? 'triggers.run_cause.watch.final' : 'triggers.run_cause.watch.again')}`;
}

/**
 * Whether the reason holds the next run: the network policy refuses the watch now, so a run would
 * read nothing. The cause a failed run stored does not; the next run may read the page.
 */
export function holdsNextRun(reason: BlockedReason | undefined): boolean {
  return reason !== undefined && reason.kind !== 'watch_fetch';
}

/** The sentence around the value; `host` is null where the sentence names none, all empty for a kind this view does not know. */
export function blockedReasonParts(reason: BlockedReason, t: (key: BlockedReasonKey) => string): { before: string; host: string | null; after: string } {
  if (reason.kind === 'watch_fetch') return { before: watchFetchReason(reason.cause, t), host: null, after: '' };
  // A kind this view does not know says nothing, rather than a key or "undefined".
  if (!Object.hasOwn(KEYS, reason.kind)) return { before: '', host: null, after: '' };
  const text = t(KEYS[reason.kind]);
  if (reason.kind !== 'watch_allow_list') return { before: text, host: null, after: '' };
  const at = text.indexOf('{host}');
  if (at < 0) return { before: text, host: null, after: '' };
  return { before: text.slice(0, at), host: reason.host, after: text.slice(at + '{host}'.length) };
}

/**
 * A host as the pieces a line may break between: after each run of dots. Each piece is shown as one
 * block, so a label that fits on a line is not split (at a hyphen, say); only a label longer than
 * the line breaks inside. Every dot is kept: the pieces join to the host exactly, since the
 * allow-list compares it exactly (`shop.example.` is not `shop.example`, `a..b` is not `a.b`).
 */
export function hostLabels(host: string): string[] {
  return host.match(/[^.]*\.+|[^.]+/g) ?? [];
}
