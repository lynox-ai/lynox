/**
 * The credentials the egress proxy accepts (PRD 152 v2 §4.2).
 *
 * The engine registers one credential per shell run, with the exact host names that run may
 * reach and a lifetime no longer than the longest shell call. The registry lives in memory
 * only: a proxy restart drops every credential, and every tunnel then fails with 407 until
 * the engine registers again.
 *
 * A credential's denials (the connections the proxy refused it) stay readable for
 * DENIAL_RETENTION_MS after it is deleted or expires, so the engine can read them after
 * the run has ended.
 */

import { MAX_EXEC_TIMEOUT_MS } from '../shell-sidecar/protocol.js';

/** 32 random bytes, base64url without padding. */
export const CRED_RE = /^[A-Za-z0-9_-]{43}$/;
/** A credential lives no longer than the longest shell call, plus a little for the round trip. */
export const MAX_TTL_S = Math.ceil(MAX_EXEC_TIMEOUT_MS / 1000) + 5;
export const DENIAL_RETENTION_MS = 60_000;
/** Bounds the memory one credential can make the proxy hold. Later denials are dropped, the count is kept. */
export const MAX_DENIALS_PER_CRED = 256;
/** Live credentials at once. A tenant runs a handful of shell calls at a time, not hundreds. */
export const MAX_CREDS = 1024;

export type HostSet = ReadonlySet<string> | '*';

export interface Denial {
  host: string;
  port: number;
  /** Epoch milliseconds. */
  at: number;
}

export interface Registration {
  set: HostSet;
  ttlS: number;
  run: string;
  session: string;
}

/** A tunnel the proxy holds open for a credential; the registry closes it when the credential goes. */
export interface TunnelHandle {
  host: string;
  close(): void;
}

interface Entry {
  set: HostSet;
  expiresAt: number;
  run: string;
  session: string;
  denials: Denial[];
  tunnels: Set<TunnelHandle>;
}

interface Retired {
  denials: Denial[];
  until: number;
}

export function hostInSet(set: HostSet, host: string): boolean {
  return set === '*' || set.has(host);
}

export class CredentialRegistry {
  private readonly live = new Map<string, Entry>();
  private readonly retired = new Map<string, Retired>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Register or replace a credential. Replacing keeps its denials and the tunnels whose
   * host the new set still allows; the others are closed. `false` when the registry is full.
   */
  put(cred: string, reg: Registration): boolean {
    this.sweep();
    const at = this.now();
    const prev = this.live.get(cred);
    if (!prev && this.live.size >= MAX_CREDS) return false;
    const denials = prev?.denials ?? this.retired.get(cred)?.denials ?? [];
    const tunnels = prev?.tunnels ?? new Set<TunnelHandle>();
    for (const t of [...tunnels]) {
      if (!hostInSet(reg.set, t.host)) { tunnels.delete(t); t.close(); }
    }
    this.retired.delete(cred);
    this.live.set(cred, { set: reg.set, expiresAt: at + reg.ttlS * 1000, run: reg.run, session: reg.session, denials, tunnels });
    return true;
  }

  /** Revoke a credential and close its tunnels. Unknown credentials are fine. */
  delete(cred: string): void {
    const entry = this.live.get(cred);
    if (!entry) return;
    this.retire(cred, entry, this.now());
  }

  /** The live entry, or `null` when the credential is unknown, deleted or expired. */
  lookup(cred: string): { set: HostSet; run: string; session: string } | null {
    const entry = this.liveEntry(cred);
    return entry ? { set: entry.set, run: entry.run, session: entry.session } : null;
  }

  /** The denials of a live credential, or of one retired less than DENIAL_RETENTION_MS ago; else `null`. */
  denials(cred: string): Denial[] | null {
    const entry = this.liveEntry(cred);
    if (entry) return [...entry.denials];
    const r = this.retired.get(cred);
    if (!r) return null;
    if (this.now() >= r.until) { this.retired.delete(cred); return null; }
    return [...r.denials];
  }

  recordDenial(cred: string, host: string, port: number): void {
    const entry = this.liveEntry(cred);
    if (!entry || entry.denials.length >= MAX_DENIALS_PER_CRED) return;
    entry.denials.push({ host, port, at: this.now() });
  }

  /** Attach a tunnel to a live credential. `false` when it is no longer live. */
  attach(cred: string, tunnel: TunnelHandle): boolean {
    const entry = this.liveEntry(cred);
    if (!entry) return false;
    entry.tunnels.add(tunnel);
    return true;
  }

  detach(cred: string, tunnel: TunnelHandle): void {
    this.live.get(cred)?.tunnels.delete(tunnel);
  }

  tunnelCount(cred: string): number {
    return this.live.get(cred)?.tunnels.size ?? 0;
  }

  /** Expire what is due: close the tunnels of expired credentials and forget old denials. */
  sweep(): void {
    const at = this.now();
    for (const [cred, entry] of [...this.live]) {
      if (at >= entry.expiresAt) this.retire(cred, entry, entry.expiresAt);
    }
    for (const [cred, r] of [...this.retired]) {
      if (at >= r.until) this.retired.delete(cred);
    }
  }

  private liveEntry(cred: string): Entry | null {
    const entry = this.live.get(cred);
    if (!entry) return null;
    if (this.now() >= entry.expiresAt) { this.retire(cred, entry, entry.expiresAt); return null; }
    return entry;
  }

  private retire(cred: string, entry: Entry, endedAt: number): void {
    this.live.delete(cred);
    this.retired.set(cred, { denials: entry.denials, until: endedAt + DENIAL_RETENTION_MS });
    for (const t of entry.tunnels) t.close();
    entry.tunnels.clear();
  }
}
