/**
 * How an inbound webhook delivery is verified, per provider kind, and the route token that
 * selects its trigger.
 *
 * A trigger names its verifier in `condition_json.webhook`. Verification reads the raw request
 * bytes and nothing parsed from them; no header outside the signature is authentication.
 *
 * - `shopify-hmac`: base64 HMAC-SHA256 of the raw body under the Shopify app's client secret,
 *   compared in constant time with `X-Shopify-Hmac-SHA256`. Shopify's other headers (topic,
 *   webhook id, shop domain) are outside the HMAC.
 * - `shared-token`: a random token the provider sends in `X-Lynox-Webhook-Token`, for providers
 *   that sign nothing. The trigger keeps only its SHA-256. Weaker than a signature: whoever has
 *   seen one request can send any body.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { connectionRowToProfile } from './api-store.js';
import type { ConnectionRow } from './connection-store.js';
import { presetStoreHost } from './oauth-presets.js';
import type { InlinePipelineStep } from '../types/pipeline.js';

export type WebhookVerifierKind = 'shopify-hmac' | 'shared-token';

export interface WebhookSpec {
  verifier: WebhookVerifierKind;
  /** `shared-token` only: SHA-256 (hex) of the token the provider sends. */
  sharedTokenHash?: string | undefined;
  /**
   * Which event fields become workflow parameters: parameter name → JSON pointer (RFC 6901)
   * into the verified body. Read at receive time, because the body is not kept.
   */
  mapping?: Readonly<Record<string, string>> | undefined;
}

/** At most this many parameters a trigger maps out of one event. */
export const MAPPING_MAX_ENTRIES = 16;
/** The longest string value kept for one parameter, in characters. */
export const MAPPED_VALUE_MAX_CHARS = 1024;
const MAPPED_PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** A JSON pointer with at least one reference token, `~` only as `~0` or `~1`. */
const JSON_POINTER = /^(?:\/(?:[^~/]|~[01])*)+$/;
const POINTER_MAX_CHARS = 256;

/** A mapping as `condition_json` holds it, or `null` when it is malformed in any part. */
function parseMapping(raw: unknown): Record<string, string> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAPPING_MAX_ENTRIES) return null;
  const mapping: Record<string, string> = {};
  for (const [name, pointer] of entries) {
    // `__proto__` is a parameter name by shape, but assigning it to an object sets the prototype.
    if (!MAPPED_PARAM_NAME.test(name) || name === '__proto__') return null;
    if (typeof pointer !== 'string' || pointer.length > POINTER_MAX_CHARS || !JSON_POINTER.test(pointer)) return null;
    mapping[name] = pointer;
  }
  return mapping;
}

/** 32 random bytes as base64url, no padding: 256 bits in 43 characters. */
export const ROUTE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const SHOPIFY_HMAC_HEADER = 'x-shopify-hmac-sha256';
export const SHOPIFY_SHOP_HEADER = 'x-shopify-shop-domain';
export const SHARED_TOKEN_HEADER = 'x-lynox-webhook-token';

/** A new route token and the hash a trigger stores in its place. */
export function mintRouteToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashRouteToken(token) };
}

export function hashRouteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * The trigger's verifier from its `condition_json`, or `null` when it names none this engine
 * knows or is malformed. A `shared-token` spec without its hash is malformed.
 */
export function parseWebhookSpec(conditionJson: string): WebhookSpec | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(conditionJson);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const spec: unknown = (parsed as Record<string, unknown>)['webhook'];
  if (typeof spec !== 'object' || spec === null) return null;
  const fields = spec as Record<string, unknown>;
  // A mapping that is there but malformed leaves the trigger without a verifier, so it accepts
  // no delivery: a run never starts with fewer values than its owner set up.
  let mapping: Record<string, string> | undefined;
  if (fields['mapping'] !== undefined) {
    const parsedMapping = parseMapping(fields['mapping']);
    if (parsedMapping === null) return null;
    mapping = parsedMapping;
  }
  const verifier: unknown = fields['verifier'];
  if (verifier === 'shopify-hmac') return { verifier, ...(mapping !== undefined ? { mapping } : {}) };
  if (verifier === 'shared-token') {
    const hash: unknown = fields['shared_token_hash'];
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return null;
    return { verifier, sharedTokenHash: hash, ...(mapping !== undefined ? { mapping } : {}) };
  }
  return null;
}

/**
 * The values a mapping reads out of a verified body, and why the others were not read. A value
 * is a string of at most {@link MAPPED_VALUE_MAX_CHARS} characters, a finite number or a
 * boolean; anything else is left out with its reason, and the run then lacks that parameter.
 * The values are a third party's content (an order's notes, a customer's name): whoever reads
 * them treats them as untrusted.
 */
export interface MappedValues {
  values: Record<string, string | number | boolean>;
  unread: Record<string, string>;
}

export function extractMappedValues(body: Buffer, mapping: Readonly<Record<string, string>>): MappedValues {
  const out: MappedValues = { values: {}, unread: {} };
  // JSON.parse of a deeply nested body costs far more than its size suggests, and it runs on
  // the event loop: a body nested deeper than any event needs is not parsed.
  if (!nestedWithin(body, MAPPED_BODY_MAX_DEPTH)) {
    for (const name of Object.keys(mapping)) out.unread[name] = `the body is nested deeper than ${String(MAPPED_BODY_MAX_DEPTH)} levels`;
    return out;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    for (const name of Object.keys(mapping)) out.unread[name] = 'the body is not JSON';
    return out;
  }
  for (const [name, pointer] of Object.entries(mapping)) {
    const found = resolvePointer(doc, pointer);
    if (!found.found) { out.unread[name] = 'the event has no field there'; continue; }
    const value = found.value;
    if (typeof value === 'string') {
      if (value.length > MAPPED_VALUE_MAX_CHARS) out.unread[name] = `longer than ${String(MAPPED_VALUE_MAX_CHARS)} characters`;
      else out.values[name] = value;
    } else if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      // Parsed into a double, a large id is rounded to another, valid-looking id.
      out.unread[name] = 'a whole number too large to keep exactly';
    } else if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean') {
      out.values[name] = value;
    } else {
      out.unread[name] = value === null ? 'the field is null' : 'the field is not a single value';
    }
  }
  return out;
}

/** Deeper than any provider's event; a body nested further is not parsed. */
export const MAPPED_BODY_MAX_DEPTH = 64;

/** Whether the JSON text's brackets nest at most `max` deep, strings skipped. One pass over the bytes. */
function nestedWithin(body: Buffer, max: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inString) {
      if (c === 0x5c) i++; // a backslash: the next byte is escaped
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) {
      inString = true;
    } else if (c === 0x7b || c === 0x5b) {
      if (++depth > max) return false;
    } else if (c === 0x7d || c === 0x5d) {
      depth--;
    }
  }
  return true;
}

/** RFC 6901: each token unescaped, an array index in its canonical form, own properties only. */
function resolvePointer(doc: unknown, pointer: string): { found: true; value: unknown } | { found: false } {
  let current = doc;
  for (const raw of pointer.split('/').slice(1)) {
    const token = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(token)) return { found: false };
      const index = Number(token);
      if (index >= current.length) return { found: false };
      current = current[index];
    } else if (typeof current === 'object' && current !== null && Object.prototype.hasOwnProperty.call(current, token)) {
      current = (current as Record<string, unknown>)[token];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}

/** Whether `header` is the base64 HMAC-SHA256 of `body` under `secret`. */
export function verifyShopifyHmac(body: Buffer, header: string | undefined, secret: string): boolean {
  if (header === undefined || secret === '') return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(header, 'base64');
  // Base64 decoding skips characters it does not know, so re-encode and compare the text too:
  // only the canonical form of the right bytes passes.
  if (given.length !== expected.length || given.toString('base64') !== header) return false;
  return timingSafeEqual(given, expected);
}

/** Whether `header` is the token whose SHA-256 the trigger keeps. */
export function verifySharedToken(header: string | undefined, storedHash: string): boolean {
  if (header === undefined || header === '') return false;
  const given = createHash('sha256').update(header, 'utf8').digest();
  const stored = Buffer.from(storedHash, 'hex');
  return stored.length === given.length && timingSafeEqual(given, stored);
}

/**
 * The ledger's dedup key for a verified body: the SHA-256 of its exact bytes, under a scope.
 * Shopify's body carries a resource id, not an event id (`orders/create` and `orders/paid` of
 * one order share it), so an id would turn the second legitimate event into a duplicate.
 *
 * The scope follows who can produce a valid delivery. One Shopify app secret verifies at every
 * Shopify trigger of the instance, so a Shopify body is keyed for the whole instance and starts
 * at most one run there. A shared token belongs to one trigger, and its sender chooses any body:
 * keyed per trigger, so it can neither record the key of a Shopify body nor that of another
 * trigger's sender.
 */
export function bodyDedupKey(kind: WebhookVerifierKind, triggerId: string, body: Buffer): string {
  const digest = createHash('sha256').update(body).digest('hex');
  return kind === 'shopify-hmac' ? `shopify-hmac:sha256:${digest}` : `shared-token:${triggerId}:sha256:${digest}`;
}

/**
 * The shop a Shopify connection serves, or `null` when the row is no Shopify connection or cannot
 * be read. What the receiver checks a delivery's shop header against, and the drain again before
 * the run, since the connection can be connected to another shop in between.
 */
export function connectionShopHost(row: ConnectionRow | undefined): string | null {
  if (row === undefined || row.kind !== 'api') return null;
  try {
    const profile = connectionRowToProfile(row);
    return profile.auth?.type === 'oauth2' && profile.auth.oauth?.preset_id === 'shopify' ? presetStoreHost(profile) : null;
  } catch {
    return null;
  }
}

/**
 * Where a webhook run's step would execute with something an event can choose outside its task
 * text, or `null` when nothing does. Only a step's
 * `task` fences a value as untrusted; a captured call's `input_template` and every other field
 * resolve a placeholder raw into what a tool executes with, so a third party would choose a URL,
 * a path or an argument. Refused there: a mapped param, the whole `params` object, and any
 * reference that is not to `params` at all — an earlier step's output (`{{s1.result}}`), which an
 * event's text can steer. An unmapped param is the owner's own value.
 */
export function mappedValueOutsideTaskText(steps: readonly InlinePipelineStep[], mappedNames: readonly string[]): string | null {
  const mapped = new Set(mappedNames);
  for (const step of steps) {
    const { task: _task, ...rest } = step;
    const text = JSON.stringify(rest);
    for (const m of text.matchAll(/\{\{([^}]+)\}\}/g)) {
      // Split as the resolver does (`getByPath`, on `.` only): `{{params[0].result}}` names the
      // context key `params[0]`, not `params`.
      const segments = m[1]!.trim().split('.').map((x) => x.trim());
      if (segments[0] !== 'params') {
        return `Step "${step.id}" uses "{{${m[1]!.trim()}}}" outside its task text. In a run an event started, an earlier step's output can carry the event's text, and there it would choose what the step executes with. Refer to it only in a step's task text.`;
      }
      const name = segments[1];
      if (name === undefined || mapped.has(name)) {
        return `Step "${step.id}" uses the event value ${name === undefined ? 'params' : `"${name}"`} outside its task text, where a sender of events would choose what the step executes with. A mapped value may only be used in a step's task text.`;
      }
    }
  }
  return null;
}
