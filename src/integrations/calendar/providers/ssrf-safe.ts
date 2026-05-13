// === SSRF guard for user-supplied calendar URLs ===
//
// Both CalDAV `server_url` and ICS-Feed `ics_url` come from user input. Without
// a guard, an attacker (or prompt-injected agent) could point the engine at
// the cloud-metadata service (169.254.169.254), a sidecar Vault on
// 127.0.0.1:8200, a Redis on 10.0.x.x, or a `file://` reader. We:
//
//   1. Reject non-http/https schemes outright.
//   2. DNS-resolve the host and reject loopback / link-local / RFC1918 /
//      ULA targets. Returns ALL records so a DNS-rebinding attacker can't
//      flip post-validation by returning a private IP on the second call —
//      but the connect-time race remains; the only full-coverage fix is
//      DNS pinning at fetch-time. Phase 1c ships the pre-flight check and
//      documents the residual race in the threat-model.
//
// Self-hosted users on a LAN can opt out via `LYNOX_CALENDAR_ALLOW_PRIVATE=1`
// (e.g. for a Nextcloud at 10.0.1.5).
//
// PRD-CALENDAR-INTEGRATION §S2 / §Risks #2.

import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import { CalendarError } from '../provider.js';

const ALLOW_PRIVATE_ENV = 'LYNOX_CALENDAR_ALLOW_PRIVATE';
const IPV4_MAPPED_RE = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/;

/**
 * Throws `CalendarError('network', ...)` when the URL fails the SSRF policy.
 * Returns silently on accepted URLs.
 */
export async function assertSafeUrl(rawUrl: string, context: string): Promise<void> {
  if (process.env[ALLOW_PRIVATE_ENV] === '1') return;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new CalendarError('malformed_event', `${context}: invalid URL`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CalendarError('network', `${context}: only http(s) URLs are allowed (got ${parsed.protocol})`);
  }

  const rawHost = parsed.hostname;
  if (!rawHost) {
    throw new CalendarError('network', `${context}: URL has no host`);
  }
  // `URL.hostname` returns IPv6 literals wrapped in brackets (e.g. `[::1]`).
  // `net.isIP()` only recognizes the bare form, so strip the brackets before
  // the IP-literal check — otherwise valid IPv6 literals fall through to
  // DNS lookup and surface as `DNS lookup failed for [::1]`.
  const host = rawHost.startsWith('[') && rawHost.endsWith(']')
    ? rawHost.slice(1, -1)
    : rawHost;

  // If the host is already an IP literal, check it directly. Otherwise
  // resolve. node:dns.lookup returns the system-default protocol-mixed
  // record set; `all: true` gives us every result so we can reject a host
  // whose A records mix public + private addresses.
  const ipLiteral = isIP(host);
  let addresses: ReadonlyArray<{ address: string; family: number }>;
  if (ipLiteral) {
    addresses = [{ address: host, family: ipLiteral }];
  } else {
    try {
      addresses = await dns.lookup(host, { all: true });
    } catch (err) {
      throw new CalendarError('network', `${context}: DNS lookup failed for ${host}`, err);
    }
  }

  for (const a of addresses) {
    if (isBlockedAddress(a.address)) {
      throw new CalendarError(
        'network',
        `${context}: target ${host} resolves to a private/loopback address (${a.address}). ` +
        `If you're on a LAN/self-host and this is intentional, set ${ALLOW_PRIVATE_ENV}=1 to bypass.`,
      );
    }
  }
}

/** Return true when the IP literal is in any private/loopback/link-local range. */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedIPv4(ip);
  if (family === 6) return isBlockedIPv6(ip);
  return false;
}

function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  // 0.0.0.0/8 — current network (and the magic "any" address).
  if (a === 0) return true;
  // 10.0.0.0/8 — RFC1918.
  if (a === 10) return true;
  // 127.0.0.0/8 — loopback.
  if (a === 127) return true;
  // 169.254.0.0/16 — link-local + cloud metadata.
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 — RFC1918.
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 — RFC1918.
  if (a === 192 && b === 168) return true;
  // 100.64.0.0/10 — RFC6598 carrier-grade NAT.
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isBlockedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // Unspecified ::, loopback ::1.
  if (lower === '::' || lower === '::1') return true;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — extract embedded IPv4 and re-check.
  const mapped = lower.match(IPV4_MAPPED_RE);
  if (mapped?.[1]) return isBlockedIPv4(mapped[1]);
  // fe80::/10 — link-local.
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true;
  // fc00::/7 — unique-local addresses.
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  return false;
}
