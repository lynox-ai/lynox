/**
 * The control plane's clearance for an exact (Shopify) connection, on the engine side
 * (PRD-SHOPIFY-CONTAINMENT-ERASURE Appendix B, B5 step 6, B6, B7).
 *
 * Before the first store pass of a boot, the engine asks
 * `POST /internal/instances/:id/exact-attach`. Only an answer whose `ok` is the boolean
 * `true` clears. Everything else refuses and backs off for 60 s: a refusal, `busy`, a rate
 * limit, a 5xx, a body without the bit, a timeout of 5 s, an unreachable control plane, and
 * an engine that is not provisioned at all.
 *
 * After an ok, the engine writes its own marker into engine.db and only then counts as
 * cleared. A marker that cannot be written clears nothing. The clearance then holds until
 * the next restart, without a TTL (B6): nothing the control plane checks changes within a boot.
 *
 * Re-assert (B7): when a status sync reads `exact_held: false` and the marker reads as set,
 * the engine asks the route again, so a control plane that lost the record gets it back. An
 * absent field, or a marker that cannot be read, is no statement and triggers nothing.
 */

import { isExactAttachCleared, isExactAttachRefusal, type ExactAttachRefusal } from '../contract/http.js';

/** How long every kind of refusal holds before the engine asks again. */
export const EXACT_ATTACH_BACKOFF_MS = 60_000;
/** The control plane gets this long to answer. */
export const EXACT_ATTACH_TIMEOUT_MS = 5_000;

/** Where the control plane is, as the managed hook reads it. `null`: not a provisioned instance. */
export interface ExactControlPlane {
  url: string;
  instanceId: string;
  secret: string;
}

/** The engine.db marker (`EngineDb.exactMarkerSet` / `setExactMarker`); both throw when they cannot. */
export interface ExactMarker {
  isSet(): boolean;
  set(): void;
}

export type ExactClearanceRefusal =
  | ExactAttachRefusal
  | 'not_provisioned'
  | 'backoff'
  | 'unreachable'
  | 'timeout'
  | 'server_error'
  | 'no_answer'
  | 'marker_unwritable';

export type ExactClearanceResult = { ok: true } | { ok: false; reason: ExactClearanceRefusal };

/** The control plane of this process, read from the managed env; `null` when any part is missing. */
export function controlPlaneFromEnv(env: NodeJS.ProcessEnv = process.env): ExactControlPlane | null {
  const url = env['LYNOX_MANAGED_CONTROL_PLANE_URL'] ?? '';
  const instanceId = env['LYNOX_MANAGED_INSTANCE_ID'] ?? '';
  const secret = env['LYNOX_HTTP_SECRET'] ?? '';
  return url && instanceId && secret ? { url, instanceId, secret } : null;
}

export class ExactClearance {
  private cleared = false;
  private backoffUntil = 0;
  private asking: Promise<ExactClearanceResult> | null = null;
  /** The next re-assert may ask from here on, whatever the last one got back. */
  private reassertNotBefore = 0;

  constructor(
    private readonly cp: ExactControlPlane | null,
    private readonly marker: ExactMarker | null,
    private readonly deps: { fetch?: typeof fetch; now?: () => number } = {},
  ) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /**
   * Whether a refusal from the last ask still holds (B3 step 6a): a request can then be refused
   * before anything else is read for it. A cleared boot is never blocked.
   */
  blockedNow(): boolean {
    return !this.cleared && this.now() < this.backoffUntil;
  }

  /** Whether this boot is cleared. Asks the control plane once, then holds the answer (B6). */
  async ensure(): Promise<ExactClearanceResult> {
    if (this.cleared) return { ok: true };
    if (this.cp === null || this.marker === null) return { ok: false, reason: 'not_provisioned' };
    if (this.now() < this.backoffUntil) return { ok: false, reason: 'backoff' };
    // Concurrent first attaches share one ask.
    this.asking ??= this.askAndRecord().finally(() => { this.asking = null; });
    return this.asking;
  }

  private async askAndRecord(): Promise<ExactClearanceResult> {
    const answer = await this.ask();
    if (!answer.ok) {
      this.backoffUntil = this.now() + EXACT_ATTACH_BACKOFF_MS;
      return answer;
    }
    try {
      this.marker!.set();
    } catch {
      // No marker, no pass (B7): the control plane holds the bit, the engine does not know it does.
      this.backoffUntil = this.now() + EXACT_ATTACH_BACKOFF_MS;
      return { ok: false, reason: 'marker_unwritable' };
    }
    this.cleared = true;
    return { ok: true };
  }

  /** One ask of the control plane, with every failure turned into a refusal. */
  private async ask(): Promise<ExactClearanceResult> {
    const cp = this.cp!;
    let res: Response;
    try {
      res = await (this.deps.fetch ?? fetch)(`${cp.url}/internal/instances/${encodeURIComponent(cp.instanceId)}/exact-attach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-instance-secret': cp.secret },
        body: '{}',
        signal: AbortSignal.timeout(EXACT_ATTACH_TIMEOUT_MS),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      return { ok: false, reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable' };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (isExactAttachCleared(body)) return res.ok ? { ok: true } : { ok: false, reason: 'server_error' };
    const reason = typeof body === 'object' && body !== null ? (body as { reason?: unknown }).reason : undefined;
    if (isExactAttachRefusal(reason)) return { ok: false, reason };
    return { ok: false, reason: res.status >= 500 ? 'server_error' : 'no_answer' };
  }

  /**
   * Called with what a status sync read (`readExactHeld`): `false` while the marker is set
   * asks the route again. `true`, `null` and an unreadable marker do nothing.
   */
  async reassert(held: boolean | null): Promise<void> {
    if (held !== false || this.cp === null || this.marker === null) return;
    let set: boolean;
    try {
      set = this.marker.isSet();
    } catch {
      return;
    }
    if (!set) return;
    if (this.now() < this.backoffUntil || this.now() < this.reassertNotBefore) return;
    // Spaced on an ok as well: a control plane that keeps reporting `false` after it took the
    // record is asked once a minute, not on every status sync. Kept apart from `backoffUntil`,
    // which would block this boot's attaches.
    this.reassertNotBefore = this.now() + EXACT_ATTACH_BACKOFF_MS;
    const answer = await this.ask();
    if (!answer.ok) this.backoffUntil = this.now() + EXACT_ATTACH_BACKOFF_MS;
  }
}
