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
 * Whether a read's redirects are held to its host (`crossHostRedirectGuard`): the origin check
 * stopped at it (`origin` is set) and it either went to a host the owner did not name, after a
 * question, or carries a query. A read of an owner-named host without a query follows its
 * redirects as before: a download link that moves to a file host keeps working.
 */
export function readHopsGuarded(url: string, origin: CallTargetOrigin | undefined): boolean {
  return origin !== undefined && (!origin.allKnown || readUrlHasQuery(url));
}

/**
 * Whether a read URL carries a query, the part a server receives as data. The fragment never
 * leaves the browser side, so it is not checked. A URL that does not parse counts as carrying
 * one: the check then refuses it as unreadable instead of letting it through.
 */
export function readUrlHasQuery(url: string): boolean {
  try {
    return new URL(url.trim()).search !== '';
  } catch {
    return true;
  }
}
