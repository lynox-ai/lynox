/**
 * How the proxy names a host or a refused target in its own log.
 *
 * A host the shell asks for is chosen by the command the model wrote, and so is the target of a
 * request that is not a CONNECT, path and query included. Either can carry what a run read (a
 * subdomain, a query string). The log is read by whoever runs the host, and the proxy has no way
 * to tell whether the instance it serves holds a store connection, so it never writes such text
 * whole:
 *
 * - a host the credential's set names exactly was chosen by whoever registered the set, and is
 *   written whole;
 * - an IPv4 literal is written whole: four octets, and the address is what the operator checks;
 * - any other name is written as its last two labels and the count of the rest
 *   (`*.example.com (+3 labels)`), and a label longer than 20 characters as `(long label)`;
 * - a refused target that is not a CONNECT is written as its scheme (`http` or `https`, any other
 *   as `(other scheme)`) and that host form, never its path, query or user part.
 *
 * This bounds what one line can carry; it does not close the log as a channel. A run that sends
 * many refused requests still writes a few chosen characters per line (two short labels, a count,
 * an address).
 *
 * The denial the registry keeps for the engine is not this: it goes back to the run that asked.
 */

import { isIPv4 } from 'node:net';
import { isExactHostname, parseAuthority } from './policy.js';
import type { HostSet } from './registry.js';

/** The longest label written as it is. */
export const MAX_LOGGED_LABEL = 20;

const label = (l: string): string => (l.length <= MAX_LOGGED_LABEL ? l : '(long label)');

/** A host for the log: whole when the set names it or it is an IPv4 literal, else its last two labels. */
export function hostForLog(set: HostSet, host: string): string {
  if ((set !== '*' && set.has(host)) || isIPv4(host)) return host;
  const labels = host.split('.');
  const kept = labels.slice(-2).map(label).join('.');
  return labels.length <= 2 ? kept : `*.${kept} (+${String(labels.length - 2)} labels)`;
}

/**
 * A refused request-line target for the log: `<scheme>://<host form>` for an absolute URL, the host
 * form for an authority, otherwise only that it could not be read. Only validated host names and
 * IPv4 literals are written; the rest of the target never is.
 */
export function targetForLog(set: HostSet, target: string): string {
  const url = /^([a-z][a-z0-9+.-]{0,15}):\/\/([^/?#]*)/i.exec(target);
  if (url) {
    const scheme = /^https?$/i.test(url[1]!) ? url[1]!.toLowerCase() : '(other scheme)';
    // The authority may carry a user part (`user:pass@host`) and a port; neither is written.
    const authority = url[2]!.slice(url[2]!.lastIndexOf('@') + 1);
    const host = authority.replace(/:[0-9]*$/, '').toLowerCase();
    return isIPv4(host) || isExactHostname(host) ? `${scheme}://${hostForLog(set, host)}` : `${scheme}://(unreadable host)`;
  }
  const parsed = parseAuthority(target);
  return parsed.ok ? hostForLog(set, parsed.value.host) : '(unreadable target)';
}
