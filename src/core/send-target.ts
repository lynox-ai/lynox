// === Send targets ===
//
// Where a tool call sends something: a mail address or a host. A tool declares its targets
// (`ToolEntry.sendTargets`) so a later check can ask whether the person who owns the
// instance named that target, rather than text the model read somewhere else.
//
// Targets are compared as exact tokens, never as substrings: `x@firma.ch` is not
// `max@firma.ch`, `a.ch` is not `firma.ch`, and `x.firma.ch` is not `firma.ch`. Every value
// is normalized the same way before it is compared: lower case, an international domain in
// its ASCII (punycode) form, no trailing dot on a host.

import { domainToASCII } from 'node:url';

export interface SendTarget {
  readonly kind: 'mail' | 'host';
  readonly value: string;
}

/**
 * Thrown by a `sendTargets` declaration when a target it would send to cannot be normalized.
 * A call whose targets are unknown counts as sending to an unknown, that is foreign, target.
 */
export class UnknownSendTargetError extends Error {
  constructor(what: string) {
    super(`send target could not be read: ${what}`);
    this.name = 'UnknownSendTargetError';
  }
}

/** Characters a host name may hold before it is mapped: letters of any script, digits, `-`, `.`. */
const HOST_NAME_CHARS = /^[\p{L}\p{N}\p{M}.-]+$/u;

/**
 * A host name as the network sees it: lower case, ASCII (punycode) for an international
 * name, no trailing dot. `null` for anything that is not a host name.
 */
export function normalizeHostName(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase().replace(/\.+$/, '');
  if (trimmed === '' || !HOST_NAME_CHARS.test(trimmed)) return null;
  const ascii = domainToASCII(trimmed);
  return ascii === '' ? null : ascii;
}

/** A mail address as one token: trimmed, lower case, its domain in ASCII form. */
export function normalizeMailTarget(raw: string): SendTarget | null {
  const addr = raw.trim().toLowerCase();
  const at = addr.lastIndexOf('@');
  if (at <= 0 || at === addr.length - 1) return null;
  const local = addr.slice(0, at);
  if (/[\s<>@]/.test(local)) return null;
  const domain = normalizeHostName(addr.slice(at + 1));
  if (domain === null) return null;
  return { kind: 'mail', value: `${local}@${domain}` };
}

/** The host a URL sends to. A host that names a stored secret, or a URL that does not parse, is `null`. */
export function normalizeHostTarget(url: string): SendTarget | null {
  // The authority as written, before any secret reference is resolved: a host built from
  // a secret is not a host anyone typed.
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url.trim())?.[1];
  if (authority === undefined || /secret:/i.test(authority)) return null;
  let hostname: string;
  try {
    hostname = new URL(url.trim()).hostname;
  } catch {
    return null;
  }
  if (hostname.startsWith('[')) return { kind: 'host', value: hostname.toLowerCase() };
  const host = normalizeHostName(hostname);
  return host === null ? null : { kind: 'host', value: host };
}

/** Normalize every address, or throw: one unreadable address makes the whole call's targets unknown. */
export function mailTargets(addresses: readonly string[]): SendTarget[] {
  return addresses.map((a) => {
    const target = normalizeMailTarget(a);
    if (target === null) throw new UnknownSendTargetError('mail address');
    return target;
  });
}

/** The host of a URL as a one-element list, or throw. */
export function hostTargets(url: string): SendTarget[] {
  const target = normalizeHostTarget(url);
  if (target === null) throw new UnknownSendTargetError('host');
  return [target];
}
