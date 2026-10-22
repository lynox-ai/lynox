/**
 * The inbound webhook receiver: `POST /api/webhooks/<token>`, unauthenticated by design. The
 * signature is the whole boundary, and the route token only selects the trigger.
 *
 * Order inside a request:
 * 1. The token is hashed and looked up before any body byte is read. A miss, a trigger that
 *    does not accept deliveries now, or one without what its verifier needs answers the one
 *    refusal and closes the connection unread.
 * 2. The body is read as bytes, capped, before anything parses it.
 * 3. The verifier checks the raw bytes. Nothing is stored before it passes.
 * 4. The verified delivery is recorded in `inbound_events`; recording is the 200.
 *
 * Every refusal answers the same status and body, whether the token is unknown, the trigger is
 * switched off, the body is too large or the signature is wrong. Equal timing is not promised:
 * the token's 256 bits are the defence against guessing, not the answer.
 *
 * Rate limits: an unknown token creates no limiter key; it costs one indexed lookup. Failures at
 * a known token are counted per trigger ({@link FailureBudget}). A verified new delivery is never
 * limited: a 429 there would drive the provider towards deleting its subscription. A verified
 * duplicate answers 200 and is not charged (PRD inbound-webhooks §4.1 [SC-1]): it records and
 * starts nothing, so a replay is bounded by the ledger, and the budget is shared with junk —
 * charging it let anyone with the URL push a provider's genuine retry into a refusal.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConnectionRow } from '../core/connection-store.js';
import type { InboundEventStore } from '../core/inbound-events.js';
import type { WebhookReceiverRow } from '../core/trigger-store.js';
import { presetClientKeys } from '../core/oauth-presets.js';
import {
  connectionShopHost,
  ROUTE_TOKEN_PATTERN,
  SHARED_TOKEN_HEADER,
  SHOPIFY_HMAC_HEADER,
  SHOPIFY_SHOP_HEADER,
  bodyDedupKey,
  extractMappedValues,
  hashRouteToken,
  parseWebhookSpec,
  verifySharedToken,
  verifyShopifyHmac,
} from '../core/webhook-verifiers.js';

const ROUTE_PREFIX = '/api/webhooks/';

/** The route token of a request path, when the path has exactly the route's shape. */
export function webhookRouteToken(pathname: string): string | null {
  if (!pathname.startsWith(ROUTE_PREFIX)) return null;
  const token = pathname.slice(ROUTE_PREFIX.length);
  return ROUTE_TOKEN_PATTERN.test(token) ? token : null;
}

/**
 * Whether the request's own path is the one the route was matched on. The route is matched on
 * the parsed pathname, which resolves `.`, `..`, `%2e` and backslashes; a raw path that needed
 * any of that is not admitted, so the route answers one spelling only.
 */
export function isCanonicalRequestPath(rawUrl: string, parsedPathname: string): boolean {
  return rawUrl.split(/[?#]/, 1)[0] === parsedPathname;
}

/**
 * A request URL fit for a log line: everything after `webhooks` and a separator (`/`, `\`, or
 * either percent-encoded) up to the query or fragment is replaced, whether or not it has a
 * token's shape — a token with one character wrong is still most of a token, and a dot segment
 * in front of it must not carry it past the redaction.
 */
export function redactWebhookPath(url: string): string {
  return url.replace(/webhooks(?:[/\\]|%2f|%5c)[^?#]*/gi, 'webhooks/<redacted>');
}

/** Delivery headers kept as evidence on the ledger row. The signature is not among them. */
const EVIDENCE_HEADERS = [
  'content-type',
  'x-shopify-topic',
  'x-shopify-webhook-id',
  'x-shopify-event-id',
  'x-shopify-shop-domain',
  'x-shopify-triggered-at',
  'x-shopify-api-version',
] as const;
const EVIDENCE_MAX_CHARS = 256;

/** The reason a verified delivery from another shop is recorded with. */
export const SHOP_MISMATCH_REASON = 'The delivery names another shop than the trigger\'s connection.';
/** How many events a trigger holds waiting to run before a new one is dropped. */
export const MAX_WAITING_EVENTS = 500;
export const QUEUE_FULL_REASON = `The trigger already had ${String(MAX_WAITING_EVENTS)} events waiting to run, so this one was not kept.`;

/**
 * Failures per trigger in a fixed window. In memory and per process, like the per-IP limiter.
 * A spent budget refuses nothing: a failure is refused either way, and a verified delivery,
 * new or a duplicate, is answered 200 whatever the count. A failure's body is still read and
 * verified, because before verification nothing tells junk from a genuine delivery. Each
 * request is bounded by the body cap. The count is what the failure alarm (PRD §5.4) reads.
 */
export class FailureBudget {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Count one failure for `triggerId`; true while the window still has room for it. */
  charge(triggerId: string): boolean {
    const now = this.now();
    let entry = this.windows.get(triggerId);
    if (entry === undefined || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(triggerId, entry);
    }
    entry.count++;
    return entry.count <= this.limit;
  }

  /** Drop windows that have ended. */
  sweep(): void {
    const now = this.now();
    for (const [id, entry] of this.windows) if (entry.resetAt <= now) this.windows.delete(id);
  }

  /** How many triggers have a window open (tests). */
  get size(): number {
    return this.windows.size;
  }
}

export interface WebhookReceiverDeps {
  findReceiver(routeTokenHash: string): WebhookReceiverRow | undefined;
  connection(id: string): ConnectionRow | undefined;
  secret(name: string): string | null;
  ledger: InboundEventStore;
}

export interface WebhookReceiverOptions {
  /** Largest body read; a larger one is refused before verification. */
  maxBodyBytes?: number | undefined;
  failureLimit?: number | undefined;
  failureWindowMs?: number | undefined;
  now?: (() => number) | undefined;
}

/** How a trigger's verifier is fed: what it needs, resolved before any body byte is read. */
type Verification = (
  | { kind: 'shopify-hmac'; secret: string; shopHost: string }
  | { kind: 'shared-token'; tokenHash: string }
) & { mapping?: Readonly<Record<string, string>> | undefined };

export class WebhookReceiver {
  readonly maxBodyBytes: number;
  readonly failures: FailureBudget;

  constructor(private readonly deps: WebhookReceiverDeps, opts: WebhookReceiverOptions = {}) {
    this.maxBodyBytes = opts.maxBodyBytes ?? 1024 * 1024;
    this.failures = new FailureBudget(opts.failureLimit ?? 30, opts.failureWindowMs ?? 15 * 60_000, opts.now);
  }

  async handle(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
    if (req.method !== 'POST') { refuse(req, res); return; }
    const trigger = this.deps.findReceiver(hashRouteToken(token));
    if (trigger === undefined) { refuse(req, res); return; }
    const verification = this.verificationFor(trigger);
    if (verification === null) { refuse(req, res); return; }

    const declared = Number(req.headers['content-length'] ?? '0');
    if (!Number.isFinite(declared) || declared > this.maxBodyBytes) {
      this.failures.charge(trigger.id);
      refuse(req, res);
      return;
    }
    const body = await readCapped(req, this.maxBodyBytes);
    if (body === null) {
      this.failures.charge(trigger.id);
      refuse(req, res);
      return;
    }

    const verified = verification.kind === 'shopify-hmac'
      ? verifyShopifyHmac(body, singleHeader(req.headers[SHOPIFY_HMAC_HEADER]), verification.secret)
      : verifySharedToken(singleHeader(req.headers[SHARED_TOKEN_HEADER]), verification.tokenHash);
    if (!verified) {
      this.failures.charge(trigger.id);
      refuse(req, res);
      return;
    }

    // One app secret can serve several shops, so a verified body can come from another shop
    // than the trigger's connection. The shop header is outside the HMAC: this catches a
    // misdelivery, not a sender who rewrites the header, so the run must not take its shop
    // binding from here. A mismatch is recorded, so a redelivery stays a duplicate, and runs
    // nothing.
    const shopMismatch = verification.kind === 'shopify-hmac'
      && (singleHeader(req.headers[SHOPIFY_SHOP_HEADER]) ?? '').toLowerCase() !== verification.shopHost;
    const dedupKey = bodyDedupKey(verification.kind, trigger.id, body);
    const duplicate = this.deps.ledger.has(dedupKey);
    // A trigger holds at most so many events waiting to run (sec-core F2): a leaked route token or
    // a busy shop would otherwise grow the ledger without bound and spend the owner's budget. One
    // over the cap is recorded dropped, without values but with its dedup key, so a redelivery
    // once the queue has drained stays a duplicate and runs nothing.
    const full = !shopMismatch && !duplicate && this.deps.ledger.countWaiting(trigger.id) >= MAX_WAITING_EVENTS;
    // Read only for a delivery that will be kept with them: a new one for this trigger's shop.
    // A duplicate, a misdelivery or one over the cap would be parsed for nothing.
    const values = verification.mapping !== undefined && !shopMismatch && !full && !duplicate
      ? extractMappedValues(body, verification.mapping)
      : undefined;
    // A duplicate records nothing and is answered like the first delivery, not charged ([SC-1]).
    this.deps.ledger.record({
      triggerId: trigger.id,
      dedupKey,
      headers: evidenceHeaders(req),
      state: shopMismatch || full ? 'dropped' : 'received',
      reason: shopMismatch ? SHOP_MISMATCH_REASON : full ? QUEUE_FULL_REASON : undefined,
      // Read here, from the verified bytes, because the body is not kept. The ledger keeps them
      // only on a `received` event.
      values,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  }

  /**
   * What the trigger's verifier needs, or `null` when something is missing — no verifier this
   * engine knows, a Shopify trigger without its connection (removed, not an API profile, not on
   * the Shopify preset) or without the app's client secret. All of them refuse like an unknown
   * token.
   */
  private verificationFor(trigger: WebhookReceiverRow): Verification | null {
    const spec = parseWebhookSpec(trigger.conditionJson);
    if (spec === null) return null;
    if (spec.verifier === 'shared-token') {
      return spec.sharedTokenHash === undefined ? null : { kind: 'shared-token', tokenHash: spec.sharedTokenHash, mapping: spec.mapping };
    }
    if (trigger.sourceConnectionId === null) return null;
    const shopHost = connectionShopHost(this.deps.connection(trigger.sourceConnectionId));
    if (shopHost === null) return null;
    const secret = this.deps.secret(presetClientKeys('shopify').secret);
    if (secret === null || secret === '') return null;
    return { kind: 'shopify-hmac', secret, shopHost, mapping: spec.mapping };
  }
}

/** The one refusal: same status and body for every reason, and the connection is closed. */
function refuse(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(401, { 'Content-Type': 'application/json', 'Connection': 'close' });
  // Whatever of the body is still unread stays unread.
  res.end('{"error":"Unauthorized"}', () => { req.destroy(); });
}

/**
 * The body as bytes, or `null` once it passes `maxBytes` (reading stops there) or when the
 * sender goes away before its end.
 */
function readCapped(req: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let done = false;
    const onData = (chunk: Buffer): void => {
      if (done) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        done = true;
        req.off('data', onData);
        req.pause();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', () => { if (!done) { done = true; resolve(null); } });
  });
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? undefined : value;
}

function evidenceHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of EVIDENCE_HEADERS) {
    const value = singleHeader(req.headers[name]);
    if (value !== undefined) out[name] = value.slice(0, EVIDENCE_MAX_CHARS);
  }
  return out;
}
