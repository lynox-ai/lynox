// === Read hops ===
//
// How a read that the origin check held treats its redirects, for every tool that reads a page or a
// URL (`web_research` read, `http_request` GET and HEAD).

import type { CallTargetOrigin } from './call-connection.js';

type RedirectHook = (nextUrl: string, method: string, headers?: Record<string, string>) => void;

/** A host for a refusal text: the last two labels, the rest elided, so data in a subdomain is not repeated. */
export function maskedHost(hostname: string): string {
  const labels = hostname.split('.');
  return labels.length <= 2 ? hostname : `…${labels.slice(-2).join('.')}`;
}

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
      throw new Error(`Blocked: the page forwards this read to another host (${host}), and lynox did not follow. Nothing was sent to that host. After content from outside in this conversation, a read like this one does not follow a redirect to another host. lynox does not show you the full address, so do not guess it. Tell the user that the page forwards to ${host} and that lynox did not follow it; if they want that page, they can give you its address.`);
    }
    inner?.(nextUrl, method, headers);
  };
}

/**
 * Whether a read's redirects are held to its host (`crossHostRedirectGuard`): exactly when the
 * origin check stopped at it (`origin` is set), owner-named hosts included. A named host that
 * forwards (`/amp/s/<host>/…`, a login redirect, a download moved to a file host) would carry the
 * address on to a host nobody named. A download that moves to another host after foreign content
 * fails once; the refusal names that host so the owner can give its address.
 */
export function readHopsGuarded(origin: CallTargetOrigin | undefined): boolean {
  return origin !== undefined;
}
