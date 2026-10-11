/**
 * External targets of a bulk run (`http:<host>`, PRD bulk-changes-reversible §4, build
 * plan B): each target is one JSON resource on one host, read with GET and — once a
 * human approved the run — written with PATCH.
 *
 * What makes an external target comparable at all is the field set F: the top-level
 * keys of the target's planned after-state. The run writes exactly F, so it compares
 * and restores exactly F. F is DERIVED from the after-state, never an input a source
 * could set: a larger F only turns more targets into conflicts, a smaller one also
 * writes less.
 *
 * Reading is `externalClient`; writing is `externalWriter`, the target writer of an
 * approved run. Every request passes the run's contract with its real method, and none
 * follows a redirect. There is no DELETE. The write verb is the run's own, fixed in its
 * contract at plan time: PATCH, PUT, or POST to the resource's URL (an edit of an
 * existing target, as bexio does it — never a create). Whether a provider keeps the
 * fields a write does not send is documented by none of them; that is what the one-target
 * probe before a wider approval is for (`BulkLedger.confirmProbe`).
 */
import { effectiveWriteMethod, isOutboundEffectWrite } from './outbound-write.js';
import { BULK_MAX_TARGET_BYTES, BULK_MAX_TARGETS, BULK_MAX_TOTAL_BYTES, BulkSourceError, type SourceRow } from './bulk-plan.js';
import type { BulkInvalidReason } from './bulk-ledger.js';
import type { CapabilityContract } from '../types/capability-contract.js';
import { contractGrants } from '../tools/permission-guard.js';
import { assertHostPolicy, fetchPinned, type HostPolicyContext } from './network-guard.js';
import { urlScanForms } from './url-scan-forms.js';
import { BulkRedirectError, BulkSecretError, BulkWriterHalt, type TargetWriter } from './bulk-apply.js';
import { isMailProviderTarget } from './bulk-mail-targets.js';
import { BULK_HALT_REASONS } from './bulk-ledger.js';

/** An external after-state: a non-empty JSON object of scalar fields. */
export type ExternalImage = Record<string, string | number | boolean | null>;

/** One external target as planned: a canonical URL and its after-state — or why not. */
export type ExternalPlanned =
  | { key: string; after: ExternalImage }
  | { key: string; invalid: BulkInvalidReason };

/** One GET against a request, answered in a fixed vocabulary — no response text leaves. */
export type ExternalRead =
  | { kind: 'ok'; value: unknown }
  /** The target does not exist. A PATCH cannot create it, so it is not a `create`. */
  | { kind: 'not_found' }
  | { kind: 'redirect' }
  | { kind: 'too_large' }
  | { kind: 'not_json' }
  /** A 4xx other than 401/403/404/429: the host will not serve this target. */
  | { kind: 'refused' }
  /** A 5xx, a timeout or a network error. */
  | { kind: 'failed' }
  /** 401/403: the host did not accept the credential the engine attached. */
  | { kind: 'unauthorized' }
  /** The engine did not attach a credential, so it sent nothing. */
  | { kind: 'no_credential' }
  /** The network policy or the address check refused the host; nothing was sent. */
  | { kind: 'blocked' }
  /** The run's contract does not grant this call; nothing was sent. */
  | { kind: 'not_granted' }
  /** The address or the body looked like it carries a secret; nothing was sent. */
  | { kind: 'secret' }
  /** The profile's own rate limit is spent; nothing was sent. */
  | { kind: 'rate_limited' }
  /** 429: wait this long (capped) before the next request to the host. */
  | { kind: 'retry_after'; ms: number };

/** Longest a `Retry-After` is honoured for within one tick (plan §6 Q3(c)). */
export const BULK_RETRY_AFTER_CAP_MS = 60_000;
/** How long an external write waits on a spent profile rate limit before failing the target. */
const PROFILE_LIMIT_WAIT_MS = 1_000;
/** One request's own deadline. */
export const BULK_REQUEST_TIMEOUT_MS = 30_000;

/**
 * A host as the engine keys it: lower case, no trailing dot, and nothing but a host
 * name — no user info, port, path, or IP literal. `null` when `raw` is anything else.
 */
export function canonicalHost(raw: string): string | null {
  const lower = raw.trim().toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(lower)) return null;
  if (/^[0-9.]+$/.test(lower)) return null;
  try {
    return new URL(`https://${lower}/`).hostname === lower ? lower : null;
  } catch {
    return null;
  }
}

/**
 * A target URL as the run's key, or `null`. HTTPS on exactly `host`, no port, user
 * info, query or fragment; the key is the URL's canonical text, which is what the
 * human sees, what the checksum covers and what is sent. A path holding `*` is
 * refused: the contract pins paths as globs, and `*` there would widen the grant.
 */
export function externalTargetKey(host: string, raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') return null;
  if (url.search !== '' || url.hash !== '' || raw.includes('?') || raw.includes('#')) return null;
  if (canonicalHost(url.hostname) !== host || url.hostname !== host) return null;
  if (url.pathname.includes('*')) return null;
  return url.toString();
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

/** A JSON scalar. An array or object under a merge-patch is replaced whole, and whether
 *  restoring it brings back what it replaced depends on the provider (plan §6 P2). */
export function isScalar(v: unknown): v is string | number | boolean | null {
  return v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
}

/** The fields of `value` named by `fields`. The caller has checked each is present. */
export function project(value: Record<string, unknown>, fields: readonly string[]): ExternalImage {
  const out: ExternalImage = {};
  for (const f of fields) out[f] = value[f] as ExternalImage[string];
  return out;
}

/**
 * What a GET returned, against the after-state it is compared with: the before-image
 * over F, or why the target cannot be planned. The response must be a plain JSON
 * object holding every field of F, each a scalar (plan §6 P2, P3). Presence is
 * `Object.hasOwn`, not a serialised form, in which a missing field and `null` look alike.
 */
export function beforeOverFields(value: unknown, after: ExternalImage | readonly string[]):
  { before: ExternalImage } | { invalid: BulkInvalidReason } {
  if (!isPlainObject(value)) return { invalid: 'before_not_object' };
  const fields = Array.isArray(after) ? after as readonly string[] : Object.keys(after);
  for (const f of fields) {
    // A field PATCH cannot remove, the undo could not restore to missing.
    if (!Object.hasOwn(value, f)) return { invalid: 'field_missing' };
    if (!isScalar(value[f])) return { invalid: 'field_not_scalar' };
  }
  return { before: project(value, fields) };
}

/**
 * Plan external targets from source rows. Reads nothing: the before-images come from
 * the preview effect. `scan` is the egress secret scan — a value in an after-state that
 * looks like a credential is not something a run sends to a host.
 */
export function planExternal(source: readonly SourceRow[], host: string, scan: (text: string) => string | null): ExternalPlanned[] {
  if (source.length > BULK_MAX_TARGETS) throw new BulkSourceError(`The source has more than ${String(BULK_MAX_TARGETS)} targets.`);
  const keyed = source.map((row) => ({ row, key: externalTargetKey(host, row.target) }));
  const seen = new Set<string>();
  for (const k of keyed) {
    const id = k.key ?? k.row.target;
    if (seen.has(id)) throw new BulkSourceError('The source names the same target more than once.');
    seen.add(id);
  }
  let total = 0;
  const charge = (text: string): void => {
    total += Buffer.byteLength(text, 'utf8');
    if (total > BULK_MAX_TOTAL_BYTES) {
      throw new BulkSourceError(`The plan's images exceed ${String(BULK_MAX_TOTAL_BYTES / 1024 / 1024)} MB in total.`);
    }
  };
  return keyed.map(({ row, key }): ExternalPlanned => {
    charge(JSON.stringify(key ?? row.target));
    if (key === null) return { key: row.target, invalid: 'bad_url' };
    // Never a writing target, so never in the run's contract (see bulk-mail-targets.ts).
    if (isMailProviderTarget(key)) return { key, invalid: 'mail_api' };
    if (urlScanForms(key).some((form) => scan(form) !== null)) return { key, invalid: 'secret_in_target' };
    const after = row.after;
    if (!isPlainObject(after) || Object.keys(after).length === 0) return { key, invalid: 'after_not_object' };
    if (!Object.values(after).every(isScalar)) return { key, invalid: 'field_not_scalar' };
    const text = JSON.stringify(after);
    if (Buffer.byteLength(text, 'utf8') > BULK_MAX_TARGET_BYTES) return { key, invalid: 'target_too_large' };
    if (scan(text) !== null) return { key, invalid: 'secret_in_after' };
    charge(text);
    return { key, after: after as ExternalImage };
  });
}

/**
 * The run's contract, minted when it is planned (plan §6 P5) and covered by the approval
 * checksum: `http_request` with GET and PATCH on the run's one host and exactly its
 * target paths. `origin: 'reviewed'` because nothing acts on it before a human approved
 * the run it belongs to. Every request the run sends is checked against it.
 */
/** The verbs an external run may write with. Each targets an existing resource's URL. */
export const BULK_WRITE_METHODS = ['PATCH', 'PUT', 'POST'] as const;
export type BulkWriteMethod = (typeof BULK_WRITE_METHODS)[number];

export function mintBulkContract(host: string, keys: readonly string[], method: BulkWriteMethod = 'PATCH'): CapabilityContract {
  const paths = [...new Set(keys.map((k) => new URL(k).pathname))].sort();
  return {
    version: 1,
    origin: 'reviewed',
    grantedTools: ['http_request'],
    httpMethods: ['GET', method],
    hostPatterns: [host],
    pathPatterns: paths,
    paramConstraints: {},
  };
}

/** A run's write verb: the one method its contract grants besides GET, or null. */
export function writeMethodOf(contract: CapabilityContract): BulkWriteMethod | null {
  const writes = contract.httpMethods.filter((m) => m !== 'GET');
  const [only] = writes;
  return writes.length === 1 && (BULK_WRITE_METHODS as readonly string[]).includes(only!) ? only as BulkWriteMethod : null;
}

/** A stored contract read back; `null` unless it has the shape {@link mintBulkContract} writes. */
export function parseBulkContract(json: string | null): CapabilityContract | null {
  if (json === null) return null;
  try {
    const c = JSON.parse(json) as Partial<CapabilityContract>;
    if (!Array.isArray(c.grantedTools) || !Array.isArray(c.httpMethods) || !Array.isArray(c.hostPatterns) || !Array.isArray(c.pathPatterns)) return null;
    return c as CapabilityContract;
  } catch {
    return null;
  }
}

/**
 * The engine's own budget of external bulk reads per host (plan §6 Q3(c)): at most
 * `perHour` requests in any sliding hour, and one every `minIntervalMs`. Process-wide
 * — {@link BULK_HOST_BUDGET} — so no number of runs, triggers or restarted plans
 * multiplies it, and consumed BEFORE a request goes out, so a request that fails
 * still counts. Keyed by {@link canonicalHost}. It holds whether or not the host's
 * profile sets a limit of its own.
 */
export class BulkHostBudget {
  private readonly sent = new Map<string, number[]>();
  constructor(
    private readonly perHour: number = BULK_MAX_TARGETS,
    private readonly minIntervalMs: number = 200,
  ) {}

  /** Take one request for `host` at `now`: 0 when granted, otherwise how many ms until
   *  one would be. Nothing is consumed when it is not granted. */
  take(host: string, now: number): number {
    const log = (this.sent.get(host) ?? []).filter((t) => t > now - 3_600_000);
    const last = log[log.length - 1];
    let wait = 0;
    if (last !== undefined && now - last < this.minIntervalMs) wait = this.minIntervalMs - (now - last);
    if (log.length >= this.perHour) wait = Math.max(wait, log[0]! + 3_600_000 - now);
    if (wait > 0) {
      this.sent.set(host, log);
      return wait;
    }
    log.push(now);
    this.sent.set(host, log);
    return 0;
  }
}

export const BULK_HOST_BUDGET = new BulkHostBudget();

/** Seconds or an HTTP date → ms from `now`, capped; a missing or bad header waits the cap. */
export function retryAfterMs(header: string | null, now: number): number {
  if (header !== null) {
    const trimmed = header.trim();
    if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed) * 1000, BULK_RETRY_AFTER_CAP_MS);
    const at = Date.parse(trimmed);
    if (!Number.isNaN(at)) return Math.min(Math.max(0, at - now), BULK_RETRY_AFTER_CAP_MS);
  }
  return BULK_RETRY_AFTER_CAP_MS;
}

export interface ExternalClientDeps {
  contract: CapabilityContract;
  hostPolicy: HostPolicyContext | undefined;
  /** Hosts a human accepted, consulted only under the `guarded` policy. */
  ackHosts: ReadonlySet<string> | undefined;
  /** Attaches the host's stored credential into `headers`; true only when it did. */
  attach: (url: string, headers: Record<string, string>) => Promise<boolean>;
  /** The profile's own rate limit: null when a request may go, else it may not. */
  rateLimit: (hostname: string) => string | null;
  /**
   * The secret-pattern scan `http_request` runs on what it sends (`detectSecretInContent`):
   * non-null when `text` looks like it carries a secret. Required, so no caller can build a
   * client that sends unscanned. `http_request`'s separate GET check is not run here: a bulk
   * target has no query or fragment (`externalTargetKey`) and its host is the contract's.
   */
  scan: (text: string) => string | null;
  now?: () => number;
}

export interface ExternalClient {
  get(url: string, signal?: AbortSignal): Promise<ExternalRead>;
  /** PATCH `body` as JSON. `ok` carries no value: success is the status alone. */
  /** Write `body` as JSON with the run's verb. `ok` carries no value: success is the status alone. */
  write(url: string, method: BulkWriteMethod, body: unknown, signal?: AbortSignal, onSend?: () => void): Promise<ExternalRead>;
  /** Requests that went out — each is one billable call on a per-call profile. */
  readonly sent: number;
}

/**
 * GET for bulk runs. Every guard runs before anything is sent, in this order: the mail-API
 * refusal, the run's contract, the network policy, the secret-pattern scan of the address and body, the
 * credential, the profile's rate limit. No redirect is
 * followed (plan §4 F7): a 3xx is an answer, never a hop.
 */
export function externalClient(deps: ExternalClientDeps): ExternalClient {
  const now = deps.now ?? Date.now;
  let sent = 0;
  const send = async (method: 'GET' | BulkWriteMethod, url: string, body: unknown, signal: AbortSignal | undefined, onSend?: () => void): Promise<ExternalRead> => {
    // Whatever the plan or the approval decided: nothing is sent to a mail API, and a write
    // halts the run (`blocked`). Reads too — a run that may not write one has no use for them.
    // Before the contract: `contractGrants` refuses a mail target as well, and checked second
    // this would halt as `contract`, which names the wrong reason.
    if (isMailProviderTarget(url)) return { kind: 'blocked' };
    const payload = method !== 'GET' ? JSON.stringify(body) : undefined;
    // The records decide the body, and a top-level `_method` field in it is read by some
    // servers as the request's method: the contract is checked against what such a server does.
    const gated = effectiveWriteMethod(method, { 'content-type': 'application/json' }, url, payload);
    if (gated === null || !contractGrants('http_request', { url, method: gated }, deps.contract)) return { kind: 'not_granted' };
    // A path that sends to a third party or issues something bindingly is asked on its own,
    // every time (`outbound-write.ts`); a bulk run has no one to ask, so no grant covers it.
    if (isOutboundEffectWrite(url, gated)) return { kind: 'not_granted' };
    const hostname = new URL(url).hostname;
    try {
      assertHostPolicy(url, { surface: 'full-control', ackHosts: deps.ackHosts }, deps.hostPolicy);
    } catch {
      return { kind: 'blocked' };
    }
    // The one place every bulk request leaves the engine, reads and writes alike. The plan scans
    // the after-image when it is made; this also covers the address, and a body the plan never
    // saw (an undo writes back what the host held). Before the credential is attached: the
    // header it adds carries a secret by design and is the profile's, not the request's.
    if (urlScanForms(url).some((form) => deps.scan(form) !== null) || (payload !== undefined && deps.scan(payload) !== null)) {
      return { kind: 'secret' };
    }
    const headers: Record<string, string> = { accept: 'application/json' };
    if (method !== 'GET') headers['content-type'] = 'application/json';
    if (!(await deps.attach(url, headers))) return { kind: 'no_credential' };
    if (deps.rateLimit(hostname) !== null) return { kind: 'rate_limited' };
    const timeout = AbortSignal.timeout(BULK_REQUEST_TIMEOUT_MS);
    let res: Response;
    onSend?.();
    sent++;
    try {
      res = await fetchPinned(url, {
        method, headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        ...(payload !== undefined ? { body: payload } : {}),
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.startsWith('Blocked:')) return { kind: 'blocked' };
      return { kind: 'failed' };
    }
    // The body streams after the headers: a reset or a timeout there is a failed read
    // like one before them, never an exception out of the effect.
    try {
      return await readResponse(res, now(), method === 'GET');
    } catch {
      return { kind: 'failed' };
    }
  };
  return {
    get sent() { return sent; },
    get: (url, signal) => send('GET', url, undefined, signal),
    write: (url, method, body, signal, onSend) => send(method, url, body, signal, onSend),
  };
}

async function readResponse(res: Response, now: number, parse: boolean): Promise<ExternalRead> {
  const status = res.status;
  const answer = ((): ExternalRead | null => {
    if (status >= 300 && status < 400) return { kind: 'redirect' };
    if (status === 401 || status === 403) return { kind: 'unauthorized' };
    if (status === 404 || status === 410) return { kind: 'not_found' };
    if (status === 429) return { kind: 'retry_after', ms: retryAfterMs(res.headers.get('retry-after'), now) };
    if (status >= 400 && status < 500) return { kind: 'refused' };
    if (status < 200 || status >= 300) return { kind: 'failed' };
    return null;
  })();
  if (answer !== null || !parse) {
    await res.body?.cancel().catch(() => {});
    return answer ?? { kind: 'ok', value: undefined };
  }
  const body = await readCapped(res, BULK_MAX_TARGET_BYTES);
  if (body === null) return { kind: 'too_large' };
  try {
    return { kind: 'ok', value: JSON.parse(body) as unknown };
  } catch {
    return { kind: 'not_json' };
  }
}

/** The body as text, or null past `max` bytes — stopped there, not read to the end.
 *  Not `readBodyCapped`: that one reports the cap as a thrown error, which here would be
 *  indistinguishable from a stream that broke. */
async function readCapped(res: Response, max: number): Promise<string | null> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The target writer of an approved external run (build plan B §1.4, §2.3). `read` GETs the
 * target and projects it onto the fields the run writes; a target that no longer has that
 * shape, or is gone, is `foreign` — a conflict, never overwritten. `write` sends exactly
 * the after-state's fields with the run's verb, then reads the target back: what the host
 * kept is what an undo must expect. Never a DELETE: an external target this run did not create is not removed.
 *
 * A missing credential, a refused one, a blocked host or a call outside the contract halts
 * the run (`BulkWriterHalt`); a redirect fails the target (`BulkRedirectError`), and so does a
 * request that looks like it carries a secret (`BulkSecretError`). One wait
 * per request: a 429 for its `Retry-After` (capped), a spent profile rate limit for a
 * second. Anything else that is not a success fails the target.
 */
export function externalWriter(client: ExternalClient, opts: {
  method?: BulkWriteMethod;
  sleep?: (ms: number) => Promise<void>;
} = {}): TargetWriter {
  const method = opts.method ?? 'PATCH';
  const sleep = opts.sleep ?? (async (ms: number): Promise<void> => { await new Promise((r) => setTimeout(r, ms)); });
  const call = async (once: () => Promise<ExternalRead>): Promise<ExternalRead> => {
    let got = await once();
    if (got.kind === 'retry_after' || got.kind === 'rate_limited') {
      // A profile limit says nothing about when it frees up: a short wait, then the target
      // fails and the run's failure rules decide, rather than a minute per request.
      await sleep(got.kind === 'retry_after' ? got.ms : PROFILE_LIMIT_WAIT_MS);
      got = await once();
    }
    switch (got.kind) {
      case 'no_credential': throw new BulkWriterHalt(BULK_HALT_REASONS.credential);
      case 'unauthorized': throw new BulkWriterHalt(BULK_HALT_REASONS.unauthorized);
      case 'blocked': throw new BulkWriterHalt(BULK_HALT_REASONS.blocked);
      case 'not_granted': throw new BulkWriterHalt(BULK_HALT_REASONS.contract);
      case 'secret': throw new BulkSecretError();
      case 'redirect': throw new BulkRedirectError();
      default: return got;
    }
  };
  const readOver = async (key: string, fields: readonly string[]): Promise<ExternalImage | 'foreign'> => {
    const got = await call(() => client.get(key));
    if (got.kind === 'not_found') return 'foreign';
    if (got.kind !== 'ok') throw new Error('read failed');
    const over = beforeOverFields(got.value, fields);
    return 'before' in over ? over.before : 'foreign';
  };
  return {
    readsBack: true,
    reportsSend: true,
    async read(key, fields) {
      if (fields === null) return 'foreign';
      const image = await readOver(key, fields);
      return image === 'foreign' ? 'foreign' : { absent: false, value: image };
    },
    async write(key, after, onSend) {
      if (after.absent || !isPlainObject(after.value)) throw new Error('an external target is only ever edited, never removed');
      const fields = Object.keys(after.value);
      const got = await call(() => client.write(key, method, after.value, undefined, onSend));
      if (got.kind !== 'ok') throw new Error('write failed');
      // Read back once. When that fails the write stands; the undo then expects what was
      // sent, and a host that changed it answers as a conflict.
      // Even a halt here does not unwrite the target: it is recorded, and the next one halts.
      try {
        const back = await readOver(key, fields);
        if (back !== 'foreign') return { result: 'written', actual: { value: back, estimated: false } };
      } catch { /* estimated below */ }
      return { result: 'written', actual: { value: after.value, estimated: true } };
    },
  };
}
