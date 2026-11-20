// === Read hops ===
//
// How a read that the origin check held treats its redirects, for every tool that reads a page or a
// URL (`web_research` read, `http_request` GET and HEAD, `api_setup` bootstrap).

import type { CallTargetOrigin } from './call-connection.js';

type RedirectHook = (nextUrl: string, method: string, headers?: Record<string, string>) => void;

/** A label as a host name usually has it: letters, digits and inner hyphens (punycode included). */
const PLAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A host for a refusal text: the last two labels, the rest elided, so data in a subdomain is not
 * repeated. The server that redirects chooses that host, and a URL keeps characters in a host name
 * that no registered name has (`,` `;` `!` `"` `_` `(` …), enough for a line of instructions without
 * spaces. The refusal is engine text, outside the fence around what a page says, so a host whose
 * shown labels are not plain is not named at all (`null`). That includes an IPv6 address and a name
 * that ends in a dot.
 *
 * Not closed, by design: a plain name still carries words joined by hyphens, up to two labels of 63
 * characters (`tell-the-user-to.example`), and the hop is refused before its host is resolved, so
 * that name need not exist. Naming the host is what lets the owner give its address.
 */
export function maskedHost(hostname: string): string | null {
  const shown = hostname.split('.').slice(-2);
  if (!shown.every((label) => PLAIN_LABEL.test(label))) return null;
  return hostname.split('.').length <= 2 ? shown.join('.') : `…${shown.join('.')}`;
}

/** How the refusal of a cross-host hop begins, so a caller that rewrites refusals can pass it on. */
export const CROSS_HOST_REFUSAL = 'Blocked: the page forwards this read to another host';

/**
 * A read the origin check held (`readHopsGuarded`) follows no redirect to another host: the owner
 * was asked about, or knew, the host the model wrote, and a hop would carry the address on to a host
 * nobody saw. To read the other host, the model writes that address itself, and it goes through the
 * same check. A hop on the same host is followed. Other reads keep `inner` unchanged.
 */
export function crossHostRedirectGuard(checkedUrl: string, checked: boolean, inner: RedirectHook | undefined): RedirectHook | undefined {
  if (!checked) return inner;
  const from = new URL(checkedUrl.trim()).hostname;
  return (nextUrl, method, headers) => {
    const to = new URL(nextUrl).hostname;
    if (to !== from) {
      const host = maskedHost(to);
      const rule = 'Nothing was sent to that host. After content from outside in this conversation, a read like this one does not follow a redirect to another host.';
      if (host === null) {
        throw new Error(`${CROSS_HOST_REFUSAL}, and lynox did not follow. ${rule} lynox does not show you that host's name, because it is not written the way host names usually are, so do not guess it. Tell the user that the page forwards to another host and that lynox did not follow it; if they want that page, they can give you its address.`);
      }
      throw new Error(`${CROSS_HOST_REFUSAL} (${host}), and lynox did not follow. ${rule} lynox does not show you the full address, so do not guess it. Tell the user that the page forwards to ${host} and that lynox did not follow it; if they want that page, they can give you its address.`);
    }
    inner?.(nextUrl, method, headers);
  };
}

/**
 * Whether a read's redirects are held to its host (`crossHostRedirectGuard`): exactly when the
 * origin check stopped at it (`origin` is set), owner-named hosts included. A named host that
 * forwards (`/amp/s/<host>/…`, a login redirect, a download moved to a file host) would carry the
 * address on to a host nobody named. A download that moves to another host after foreign content
 * fails once; the refusal names that host, when its name is plain, so the owner can give its address.
 */
export function readHopsGuarded(origin: CallTargetOrigin | undefined): boolean {
  return origin !== undefined;
}
