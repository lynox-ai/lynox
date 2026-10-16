/**
 * The engine side of the egress proxy for shell calls (PRD 152 v2 §4.2, W2).
 *
 * In sidecar mode a shell call has no route but the tenant's egress proxy. For each call the
 * engine mints a credential, registers it with the proxy together with the hosts the call may
 * reach, passes it to the call as its proxy, and afterwards revokes it and reads which
 * connections the proxy refused, so the model can be told instead of retrying spellings.
 *
 * Every failure here leaves the call without a proxy, which means without a network: the
 * sidecar has no other route. Nothing here can widen what a call reaches beyond the set it
 * computes from `network_policy`.
 *
 * Not here yet: hosts from this session's search results and URLs the user typed
 * (provenance, W2b), and a smaller set after the turn took in foreign content (W3).
 */

import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import type { NetworkPolicy } from '../contract/vocab.js';
import { guardedBaselineHostList } from '../core/llm/endpoint-allowlist.js';
import { capTimeout } from './protocol.js';
import { CRED_RE, DENIAL_REASONS, MAX_TTL_S, type DenialReason } from '../egress-proxy/registry.js';
import { isExactHostname } from '../egress-proxy/policy.js';

export const DEFAULT_EGRESS_PROXY_URL = 'http://proxy:3129';
export const DEFAULT_EGRESS_SHELL_PROXY = 'proxy:3128';
/** Each request to the proxy's admin listener; it is on the tenant's internal network. */
export const ADMIN_TIMEOUT_MS = 2_000;
/** The proxy takes at most this many names in a set (`MAX_SET_SIZE` in its policy). */
export const MAX_SHELL_SET = 256;
/** Denial lines shown to the model; the rest are counted. */
export const MAX_DENIAL_LINES = 10;
/** How much of a refused host a denial line shows. */
const MAX_SHOWN_HOST = 100;

/** The proxy variables a call must not bring itself: only the engine's own reach the call. */
export const PROXY_ENV_NAMES = [
  'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy',
  'NODE_USE_ENV_PROXY',
] as const;

/** The policy inputs, as `assertHostPolicy` reads them for the full-control surface. */
export interface ShellPolicyInput {
  readonly networkPolicy: NetworkPolicy | undefined;
  readonly allowedHosts: ReadonlySet<string> | undefined;
  readonly allowedWildcards: readonly string[] | undefined;
  readonly ackHosts: ReadonlySet<string> | undefined;
}

export type ShellSet =
  | { kind: 'all' }
  | { kind: 'hosts'; hosts: string[]; dropped: string[] }
  | { kind: 'none'; why: string };

/**
 * The hosts a shell call may reach: what `network_policy` lets the engine's full-control
 * surface reach (`assertHostPolicy`, src/core/network-guard.ts), in the form the proxy takes.
 * An entry the proxy cannot take is dropped and named, never widened: a `*.example.com`
 * floor entry (the proxy takes exact names only), an IP literal, a name with upper case
 * (`assertHostPolicy` compares a lower-case host to the entry as written, so it is dead there
 * too). The baseline's `localhost` and IP literals are dropped the same way; the proxy refuses
 * private addresses anyway.
 */
export function computeShellSet(input: ShellPolicyInput): ShellSet {
  const policy = input.networkPolicy;
  let candidates: unknown[];
  switch (policy) {
    // As `assertHostPolicy`: no policy at all is `allow-all`.
    case undefined:
    case 'allow-all':
      return { kind: 'all' };
    case 'deny-all':
      return { kind: 'none', why: 'the network policy is deny-all' };
    case 'allow-list':
      candidates = [...(input.allowedHosts ?? [])];
      break;
    case 'guarded':
      // The baseline's loopback names are left out: a shell call has no business there, and the
      // proxy refuses a private address anyway.
      candidates = [...guardedBaselineHostList().filter((h) => h !== 'localhost'), ...(input.allowedHosts ?? []), ...(input.ackHosts ?? [])];
      break;
    default: {
      const _exhaustive: never = policy;
      void _exhaustive;
      return { kind: 'none', why: 'the network policy is not recognised' };
    }
  }
  const hosts = new Set<string>();
  const dropped: string[] = [];
  for (const c of candidates) {
    if (typeof c === 'string' && isExactHostname(c)) hosts.add(c);
    else if (typeof c === 'string' && !guardedBaselineHostList().includes(c)) dropped.push(c);
  }
  for (const w of input.allowedWildcards ?? []) dropped.push(`*.${w}`);
  if (hosts.size > MAX_SHELL_SET) {
    return { kind: 'none', why: `the network policy names more than ${String(MAX_SHELL_SET)} hosts, more than the egress proxy takes` };
  }
  return { kind: 'hosts', hosts: [...hosts].sort(), dropped };
}

/** A fresh credential: 32 random bytes, base64url without padding (43 characters). */
export function mintCredential(): string {
  const cred = randomBytes(32).toString('base64url');
  if (!CRED_RE.test(cred)) throw new Error('egress credential has the wrong shape');
  return cred;
}

/** The proxy URL a call gets. The password is fixed and ignored by the proxy: node's fetch
 *  sends no `Proxy-Authorization` for a URL whose password is empty. */
export function shellProxyUrl(cred: string, shellProxy: string): string {
  return `http://${cred}:x@${shellProxy}`;
}

/** The env a registered call gets. `NODE_USE_ENV_PROXY` makes node (22) use the proxy at all. */
export function proxyEnv(cred: string, shellProxy: string): Record<string, string> {
  const url = shellProxyUrl(cred, shellProxy);
  return {
    HTTPS_PROXY: url, https_proxy: url, HTTP_PROXY: url, http_proxy: url, NODE_USE_ENV_PROXY: '1',
  };
}

/**
 * The forms of the credential a call prints without trying (`env`, `curl -v`, `set -x`). This is
 * hygiene, not a boundary: a call can always print it encoded some other way. What bounds it is
 * that the credential is revoked before the result goes back, and that it reaches only the set.
 */
export function credentialForms(cred: string): string[] {
  const forms = new Set<string>([cred]);
  for (const plain of [`${cred}:x`, `${cred}:`, cred]) {
    forms.add(Buffer.from(plain).toString('base64'));
    forms.add(Buffer.from(plain).toString('base64url'));
  }
  return [...forms];
}

export function redactCredential(text: string, cred: string): string {
  let out = text;
  for (const form of credentialForms(cred)) out = out.split(form).join('[egress credential]');
  return out;
}

const SHELL_PROXY_RE = /^[A-Za-z0-9.-]+:[0-9]{1,5}$/;

export interface AdminResponse { status: number; body: string }
export type AdminCall = (method: 'PUT' | 'DELETE' | 'GET', path: string, body?: string) => Promise<AdminResponse>;

/** A request to the proxy's admin listener, by `node:http` (its address is a private Docker
 *  address). The URL carries the credential, so it is never put into an error message. */
export function adminCaller(baseUrl: string, secret: string): AdminCall {
  const base = new URL(baseUrl);
  if (base.protocol !== 'http:') throw new Error('LYNOX_EGRESS_PROXY_URL must be an http:// URL');
  return (method, path, body) => new Promise((resolve, reject) => {
    const req = request({
      host: base.hostname,
      port: base.port === '' ? 80 : Number(base.port),
      method,
      path,
      headers: {
        authorization: `Bearer ${secret}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }),
      },
      timeout: ADMIN_TIMEOUT_MS,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size <= 256 * 1024) chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => reject(new Error('egress proxy: the answer broke off')));
    });
    req.on('timeout', () => req.destroy(new Error('egress proxy: no answer in time')));
    req.on('error', (err) => reject(new Error(err.message.startsWith('egress proxy:') ? err.message : 'egress proxy: not reachable')));
    req.end(body);
  });
}

const REASON_TEXT: Record<DenialReason, string> = {
  'not-in-set': 'not reachable from shell commands under the current network policy. Ask the owner instead of trying other spellings',
  'plain-http': 'only HTTPS is allowed; use https://',
  'port': 'only HTTPS on port 443 is allowed',
  'bad-target': 'not a host the proxy can connect to',
  'ssrf': 'a private or internal address',
  'sni-mismatch': 'the TLS server name did not match the host',
  'no-sni': 'the TLS connection named no server',
  'bad-hello': 'the TLS connection did not start properly',
  'hello-timeout': 'the TLS connection did not start in time',
};

function shownHost(raw: string): string {
  // For plain http and a bad target the proxy keeps the raw target; show only its host.
  let host = raw;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      host = new URL(raw).hostname;
    } catch { /* keep the raw form, cleaned below */ }
  }
  host = host.replace(/[^\x21-\x7e]/g, '?');
  return host.length > MAX_SHOWN_HOST ? `${host.slice(0, MAX_SHOWN_HOST)}…` : host;
}

/** The lines the model reads about refused connections, from the proxy's `GET /denials` body.
 *  Anything that is not exactly the denial shape is left out, not passed through. */
export function denialLines(body: string): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return ['- the egress proxy sent a list of refused connections that could not be read'];
  }
  if (!Array.isArray(raw)) return ['- the egress proxy sent a list of refused connections that could not be read'];
  const seen = new Map<string, string>();
  for (const d of raw) {
    if (d === null || typeof d !== 'object') continue;
    const { host, port, reason } = d as Record<string, unknown>;
    if (typeof host !== 'string' || typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) continue;
    if (typeof reason !== 'string' || !(DENIAL_REASONS as readonly string[]).includes(reason)) continue;
    const shown = shownHost(host);
    const key = `${shown}\0${String(port)}\0${reason}`;
    if (!seen.has(key)) {
      const target = port === 0 ? JSON.stringify(shown) : `${JSON.stringify(shown)} port ${String(port)}`;
      seen.set(key, `- refused ${target}: ${REASON_TEXT[reason as DenialReason]}.`);
    }
  }
  const lines = [...seen.values()];
  if (lines.length <= MAX_DENIAL_LINES) return lines;
  return [...lines.slice(0, MAX_DENIAL_LINES), `- and ${String(lines.length - MAX_DENIAL_LINES)} more`];
}

/** One call's use of the proxy. */
export interface ShellEgress {
  /** What the call's env gets: the proxy variables, or nothing (no network). */
  readonly env: Readonly<Record<string, string>>;
  /** Removes the credential from text the call produced. */
  redact(text: string): string;
  /** Revokes the credential and returns the network lines for the call's result ('' for none). */
  finish(): Promise<string>;
}

export interface OpenEgressOptions {
  readonly policy: ShellPolicyInput;
  readonly timeoutMs: number | undefined;
  readonly run: string | undefined;
  readonly session: string | undefined;
  /** From {@link egressConfigFromEnv}. */
  readonly config: EgressConfig;
  /** For tests: the admin listener. */
  readonly admin?: AdminCall;
}

/** How the engine reaches the proxy. `secret` unset or empty = no egress proxy configured. */
export interface EgressConfig {
  readonly secret: string | undefined;
  readonly adminUrl: string | undefined;
  readonly shellProxy: string | undefined;
}

export function egressConfigFromEnv(): EgressConfig {
  return {
    secret: process.env['LYNOX_EGRESS_PROXY_SECRET'],
    adminUrl: process.env['LYNOX_EGRESS_PROXY_URL'],
    shellProxy: process.env['LYNOX_EGRESS_SHELL_PROXY'],
  };
}

const HEADER = 'Network (egress proxy):';

function noted(notes: string[]): string {
  return notes.length === 0 ? '' : `${HEADER}\n${notes.join('\n')}`;
}

/**
 * The call's result with the engine's network lines. They go FIRST: a long result is cut from
 * the end before the model reads it, and the lines must survive that.
 */
export function withNetworkLines(lines: string, text: string): string {
  return lines === '' ? text : `${lines}\n\n${text}`;
}

function offline(notes: string[]): ShellEgress {
  return { env: {}, redact: (t) => t, finish: () => Promise.resolve(noted(notes)) };
}

/**
 * Open the proxy for one shell call. Null when no egress proxy is configured
 * (`LYNOX_EGRESS_PROXY_SECRET` unset): the call then has no network, as before W2.
 */
export async function openShellEgress(opts: OpenEgressOptions): Promise<ShellEgress | null> {
  const secret = opts.config.secret;
  if (secret === undefined || secret === '') return null;
  const shellProxy = opts.config.shellProxy || DEFAULT_EGRESS_SHELL_PROXY;
  if (!SHELL_PROXY_RE.test(shellProxy)) {
    return offline(['- this command had no network: LYNOX_EGRESS_SHELL_PROXY is not host:port.']);
  }
  const set = computeShellSet(opts.policy);
  const notes: string[] = [];
  if (set.kind === 'none') return offline([`- this command had no network: ${set.why}.`]);
  if (set.kind === 'hosts' && set.dropped.length > 0) {
    const shown = set.dropped.slice(0, MAX_DENIAL_LINES).map((d) => JSON.stringify(shownHost(d))).join(', ');
    const more = set.dropped.length > MAX_DENIAL_LINES ? ` and ${String(set.dropped.length - MAX_DENIAL_LINES)} more` : '';
    notes.push(`- not reachable from shell commands, because the egress proxy takes exact host names only: ${shown}${more}.`);
  }
  let admin: AdminCall;
  try {
    admin = opts.admin ?? adminCaller(opts.config.adminUrl || DEFAULT_EGRESS_PROXY_URL, secret);
  } catch {
    return offline([...notes, '- this command had no network: LYNOX_EGRESS_PROXY_URL is not an http:// URL.']);
  }
  const cred = mintCredential();
  const ttl = Math.min(Math.ceil(capTimeout(opts.timeoutMs) / 1000) + 5, MAX_TTL_S);
  const body = JSON.stringify({
    set: set.kind === 'all' ? '*' : set.hosts,
    ttl_s: ttl,
    run: (opts.run ?? '').slice(0, 128) || 'none',
    session: (opts.session ?? '').slice(0, 128) || 'none',
  });
  let registered = false;
  let failure = '';
  try {
    const res = await admin('PUT', `/cred/${cred}`, body);
    if (res.status === 204) registered = true;
    else failure = `the egress proxy refused to register it (HTTP ${String(res.status)})`;
  } catch (err) {
    failure = `the egress proxy could not be reached (${err instanceof Error ? err.message.replace(/^egress proxy: /, '') : 'error'})`;
  }
  const finish = async (): Promise<string> => {
    const lines = [...notes];
    // Revoke first: the credential is dead before anything else happens. Unconditionally — a
    // PUT that failed here may still have landed. Its denials stay readable for a minute.
    try {
      await admin('DELETE', `/cred/${cred}`);
    } catch { /* the TTL ends it */ }
    if (registered) {
      try {
        const res = await admin('GET', `/denials/${cred}`);
        if (res.status === 200) lines.push(...denialLines(res.body));
        else if (res.status === 404) lines.push('- the egress proxy lost this command\'s credential (restarted?); its connections were refused.');
        else lines.push(`- the egress proxy did not say which connections it refused (HTTP ${String(res.status)}).`);
      } catch {
        lines.push('- the egress proxy did not say which connections it refused (not reachable).');
      }
    } else {
      lines.push(`- this command had no network: ${failure}.`);
    }
    return noted(lines);
  };
  return {
    env: registered ? proxyEnv(cred, shellProxy) : {},
    redact: (t) => redactCredential(t, cred),
    finish,
  };
}
