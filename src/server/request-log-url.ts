// === The request URL as the request log may write it ===
//
// The log line keeps the path and the names of the query parameters, and replaces every query
// value. A value can carry something a reader of the container log should not hold, and a list
// of parameters to redact misses the next one without a sound, so all values go. Should a value
// ever be needed in the log, it is let through here by name, with the reason.

import { redactWebhookPath } from './webhook-receiver.js';

const REDACTED = '<redacted>';

/** A parameter name the log keeps as written; anything else in that place is redacted too. */
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_.\-[\]]{0,63}$/;

/**
 * `rawUrl` fit for the request log: the webhook route token taken out of the path
 * (`redactWebhookPath`), every query value replaced, the fragment dropped. An entry without `=`
 * is a value on its own and is replaced whole.
 */
export function requestLogUrl(rawUrl: string): string {
  const withoutFragment = rawUrl.split('#', 1)[0] ?? '';
  const q = withoutFragment.indexOf('?');
  const path = redactWebhookPath(q === -1 ? withoutFragment : withoutFragment.slice(0, q));
  if (q === -1) return path;
  const entries = withoutFragment.slice(q + 1).split('&').filter((entry) => entry !== '');
  const kept = entries.map((entry) => {
    const eq = entry.indexOf('=');
    if (eq === -1) return REDACTED;
    const name = entry.slice(0, eq);
    return `${PARAM_NAME.test(name) ? name : REDACTED}=${REDACTED}`;
  });
  return kept.length === 0 ? path : `${path}?${kept.join('&')}`;
}
