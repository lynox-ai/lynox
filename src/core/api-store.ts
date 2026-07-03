/**
 * API Store — teaches the agent how to properly use external APIs.
 *
 * Loads API profiles from ~/.lynox/apis/*.json. Each profile describes
 * an API's capabilities, auth method, rate limits, endpoints, guidelines,
 * and common mistakes. This knowledge is injected into the system prompt
 * so the agent knows HOW to use an API before making any requests.
 *
 * Also provides per-API rate limiting via hostname matching.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wrapUntrustedData } from './data-boundary.js';
import type { CustomEndpointAck } from './llm/endpoint-allowlist.js';
import type { ConnectionRow, ConnectionStore } from './connection-store.js';

// ── Errors ──

/**
 * Thrown by `ApiStore.unregister` when the in-memory delete succeeded but
 * the on-disk file delete failed for a non-ENOENT reason. Callers (HTTP
 * handler, agent tool) should map this to a 500-class outcome — the
 * "deleted" profile would otherwise resurrect on the next engine restart.
 */
export class ApiProfileUnlinkError extends Error {
  constructor(public readonly filePath: string, public override readonly cause: unknown) {
    super(`Failed to unlink ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'ApiProfileUnlinkError';
  }
}

// ── Constants ──

// Mirrors the `ID_PATTERN` used in `tools/builtin/api-setup.ts`. Kept here
// so the store can enforce it on every entry path (`register` /
// `loadFromDirectory`) — that's what makes the `unregister` path safe to
// hand the id into `join(apisDir, …)`.
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// ── Types ──

export interface ApiEndpoint {
  method: string;
  path: string;
  description: string;
}

export interface ApiRateLimit {
  requests_per_second?: number | undefined;
  requests_per_minute?: number | undefined;
  requests_per_hour?: number | undefined;
  requests_per_day?: number | undefined;
}

export interface ApiAuth {
  /**
   * Auth type:
   * - `none`     — explicitly public API (no credential needed). Use this for
   *                APIs like HN-Algolia or arXiv so the create-action's "no auth"
   *                heuristic doesn't block the profile.
   * - `basic`    — username + password.
   * - `bearer`   — `Authorization: Bearer <token>`.
   * - `header`   — API key in a custom header (e.g. `X-Api-Key`).
   * - `query`    — API key in a query parameter.
   * - `oauth2`   — managed OAuth refresh-token flow.
   */
  type: 'none' | 'basic' | 'bearer' | 'header' | 'query' | 'oauth2';

  /**
   * OAuth2 metadata — used by `api_setup` action `fetch_token` to drive the
   * token exchange. Eliminates the brittle "agent constructs the
   * /oauth/access_token POST by hand and probably gets the body format
   * wrong" pattern that broke the Shopify integration setup on 2026-05-18.
   *
   * Required when `auth.type === 'oauth2'`.
   */
  oauth?: {
    /** Token endpoint URL. e.g. `https://<shop>.myshopify.com/admin/oauth/access_token`. */
    token_url?: string | undefined;
    /** OAuth grant type. `client_credentials` is the default for app-only flows. */
    grant_type?: 'client_credentials' | 'refresh_token' | undefined;
    /** Vault key name holding the client_id (UPPER_SNAKE_CASE). */
    client_id_key?: string | undefined;
    /** Vault key name holding the client_secret (UPPER_SNAKE_CASE). */
    client_secret_key?: string | undefined;
    /** For `refresh_token` grant: vault key name holding the refresh token. */
    refresh_token_key?: string | undefined;
    /** Optional space-separated scopes (e.g. `read_products write_products`). */
    scope?: string | undefined;
    /** Optional audience (Auth0-style flows). */
    audience?: string | undefined;
    /** Body encoding for the token POST. Most providers want `form`
     *  (application/x-www-form-urlencoded). Shopify wants `json` since 2026.
     *  Default: `form`. */
    body_format?: 'form' | 'json' | undefined;
  } | undefined;
  /**
   * For 'basic': how the credential is stored.
   * - 'user_pass_split' — separate username + password fields combined at call time.
   * - 'pre_encoded_b64' — single secret already Base64-encoded as `user:pass` (DataForSEO pattern).
   */
  basic_format?: 'user_pass_split' | 'pre_encoded_b64' | undefined;
  /** Header name for 'header' type (e.g. 'X-Api-Key'). Default: 'Authorization'. */
  header_name?: string | undefined;
  /** Query parameter name for 'query' type. */
  query_param?: string | undefined;
  /** Instructions for the agent on how to authenticate. */
  instructions?: string | undefined;
  /** Vault key name(s) holding the secret material. Required for `type='oauth2'` (refresh-token slot). */
  vault_keys?: string[] | undefined;
}

export type ShapeReducer = 'avg' | 'peak' | 'avg+peak' | 'count' | 'first_n' | 'last_n';

/**
 * Declarative response shaping for this API.
 *
 * Applied by `http_request` after the response is parsed as JSON.
 * Deterministic, no LLM calls. Goal: keep the agent's context window lean
 * on verbose API responses (DataForSEO, Stripe list endpoints, Plausible
 * time-series) without the agent needing to hand-roll slice logic per call.
 *
 * Error path: on invalid JSON or unknown include path, fall back to the raw
 * parsed JSON (or raw text) and publish `channels.shapeError`. Never fails
 * the tool call.
 */
export interface ResponseShape {
  /** 'reduce' applies the rules; 'passthrough' is an explicit no-op marker;
   *  'graphql' is a `reduce` alias signalling GraphQL-shaped include paths
   *  (e.g. `data.<query>.edges[*].node`). Treat as `reduce` everywhere. */
  kind?: 'reduce' | 'passthrough' | 'graphql' | undefined;
  /**
   * Whitelist of JSON paths to keep. Omit to keep all fields.
   * Path syntax: dot + `[]` for arrays, e.g.
   *   `tasks[].result[].items[].keyword_data.keyword_info.keyword`
   */
  include?: string[] | undefined;
  /**
   * Reducers for nested fields. Key is a JSON path (same syntax as `include`),
   * value is the reducer strategy.
   *
   *  - `avg` / `peak` / `avg+peak`: collapse an array of numbers (or array of
   *    `{value: N}` / `{count: N}`) into a single number summary. Useful for
   *    monthly_searches[] → {avg, peak}.
   *  - `count`: replace an array with just `.length`.
   *  - `first_n` / `last_n`: keep first/last N items (uses `max_array_items` as N, default 3).
   */
  reduce?: Record<string, ShapeReducer> | undefined;
  /** Cap any array (deep, after projection/reduce) to this many items. */
  max_array_items?: number | undefined;
  /** Cap any string (deep, after projection/reduce) to this many chars. */
  max_string_chars?: number | undefined;
  /** Final stringified hard cap. Applied after everything else. */
  max_chars?: number | undefined;
}

export interface ApiProfile {
  id: string;
  name: string;
  base_url: string;
  auth?: ApiAuth | undefined;
  rate_limit?: ApiRateLimit | undefined;
  description: string;
  /** Key endpoints the agent can use. */
  endpoints?: ApiEndpoint[] | undefined;
  /** Best practices — what the agent SHOULD do. */
  guidelines?: string[] | undefined;
  /** Common mistakes — what the agent should AVOID. */
  avoid?: string[] | undefined;
  /** Extra context (e.g. response format hints, pagination, error codes). */
  notes?: string[] | undefined;
  /** Declarative response-shaping rules, applied by `http_request` when responses are JSON. */
  response_shape?: ResponseShape | undefined;

  // ── v2 additions ──

  /** Concurrency model. Drives the routing layer's sub-agent decision (Phase D). */
  concurrency?: {
    /** Can two requests for this API be in flight on the same credential simultaneously? */
    parallel_ok: boolean;
    /** Soft cap on N parallel calls per token, when parallel_ok=true. */
    max_in_flight?: number | undefined;
    /** If parallel_ok=false, can the API batch N items into a single call? Endpoint path or ID. */
    batchable_via_endpoint?: string | undefined;
  } | undefined;

  /**
   * Output volume class. Drives "should we delegate the call to a sub-agent?"
   * - small      <1 KB JSON / <500 tokens — never delegate
   * - medium     <10 KB                   — delegate only if multiple calls
   * - large      >10 KB                   — always delegate (extract in sub-agent)
   * - streaming                           — must be consumed where opened (no delegate)
   */
  output_volume?: 'small' | 'medium' | 'large' | 'streaming' | undefined;

  /** Cost model. Drives budget gates, per-call accounting, and Phase E cost display. */
  cost?: {
    model: 'per_call' | 'per_token' | 'per_unit';
    rate_usd: number;
    /** For per_token, ratio between input and output tokens (often ~3:1). */
    output_ratio?: number | undefined;
  } | undefined;

  /** Provenance — audit + refresh trigger. Presence of `schema_version: 2` marks a v2 profile. */
  provenance?: {
    source: 'openapi' | 'docs_url' | 'manual';
    source_url?: string | undefined;
    /** ISO timestamp of the last successful validate-call. */
    validated_at?: string | undefined;
    schema_version: 2;
  } | undefined;

  /**
   * Wave 5d BYOK liability gate — persisted user acceptance for the profile's
   * non-allowlisted egress hosts (`base_url` / OAuth `token_url` outside the
   * vetted sub-processor list). Set server-side ONLY at save-time from a
   * `confirm_custom_endpoint: true` signal; never trusted from the incoming
   * profile object (that would forge the gate). Absence on a profile with a
   * non-allowlisted egress host = never-accepted → the runtime egress paths
   * (`fetch_token`, `http_request` OAuth2 attach) refuse fail-closed until the
   * profile is re-saved through the disclosure. See `CustomEndpointAck`.
   */
  custom_endpoint_ack?: CustomEndpointAck | undefined;
}

/**
 * Detect a v1 profile (missing `provenance.schema_version`) and inject conservative
 * v2 defaults so consumers can treat the loaded shape uniformly. Logs once per file.
 *
 * - `concurrency` → `{parallel_ok: true}` (v1 profiles were always called serially
 *   anyway; before Phase D's routing layer ships, parallel_ok has no runtime effect).
 * - `output_volume` → left undefined (consumers treat as `medium`).
 * - No provenance is fabricated — that would falsely claim a v2 origin.
 */
function migrateV1Profile(profile: ApiProfile): ApiProfile {
  if (profile.provenance?.schema_version === 2) return profile;

  // JSON-stringify the id so any control chars / ANSI in a hand-edited profile
  // file can't inject fake log lines or terminal sequences via stderr.
  process.stderr.write(
    `[lynox:api-store] profile ${JSON.stringify(profile.id)} is v1; v2 fields default to {concurrency.parallel_ok=true, output_volume=undefined}\n`,
  );

  const out: ApiProfile = { ...profile };
  if (!out.concurrency) {
    out.concurrency = { parallel_ok: true };
  }
  return out;
}

// ── Connection projection (S4b) ──
//
// An api profile is a `kind='api'` Connection row. The full typed `ApiProfile`
// serializes into the opaque `config_json` blob (minus `id`/`name`, promoted to
// columns) so the ConnectionStore stays type-agnostic and no `any` leaks there;
// the typed shape is reconstructed on read HERE, at the api layer.

/** Filename sentinel marking that the one-shot flat-JSON → connections import ran. */
const IMPORT_SENTINEL = '.imported-to-connections';

/**
 * Collect the vault secret NAMES a profile references, for the `vault_keys`
 * name-array column. Denormalized on write so a delete/GDPR path can later purge
 * the referenced secrets without re-parsing `config_json`. Never holds secret
 * material — only names.
 */
function collectVaultKeys(profile: ApiProfile): string[] {
  const keys = new Set<string>();
  for (const k of profile.auth?.vault_keys ?? []) keys.add(k);
  const oauth = profile.auth?.oauth;
  if (oauth) {
    for (const k of [oauth.client_id_key, oauth.client_secret_key, oauth.refresh_token_key]) {
      if (k) keys.add(k);
    }
  }
  return [...keys];
}

/** Map an `ApiProfile` onto a `kind='api'` connection row (outbound, no subject). */
function profileToConnectionRow(profile: ApiProfile): ConnectionRow {
  const { id, name, ...rest } = profile;
  return {
    id,
    kind: 'api',
    name,
    subjectId: null,
    direction: 'outbound',
    configJson: JSON.stringify(rest),
    vaultKeys: collectVaultKeys(profile),
    status: 'active',
  };
}

/** Reconstruct the typed `ApiProfile` from a connection row (inverse of
 *  {@link profileToConnectionRow}). `config_json` is a serialized profile minus
 *  the promoted `id`/`name` columns. */
function connectionRowToProfile(row: ConnectionRow): ApiProfile {
  const rest = JSON.parse(row.configJson) as Omit<ApiProfile, 'id' | 'name'>;
  return { ...rest, id: row.id, name: row.name };
}

// ── Rate Limiter (per-API, in-memory) ──

interface ApiRateBucket {
  tokens: number;
  lastRefill: number;
  limit: number;
  intervalMs: number;
}

class PerApiRateLimiter {
  private readonly buckets = new Map<string, ApiRateBucket[]>();

  register(hostname: string, limits: ApiRateLimit): void {
    const buckets: ApiRateBucket[] = [];
    if (limits.requests_per_second) {
      buckets.push({ tokens: limits.requests_per_second, lastRefill: Date.now(), limit: limits.requests_per_second, intervalMs: 1000 });
    }
    if (limits.requests_per_minute) {
      buckets.push({ tokens: limits.requests_per_minute, lastRefill: Date.now(), limit: limits.requests_per_minute, intervalMs: 60_000 });
    }
    if (limits.requests_per_hour) {
      buckets.push({ tokens: limits.requests_per_hour, lastRefill: Date.now(), limit: limits.requests_per_hour, intervalMs: 3_600_000 });
    }
    if (limits.requests_per_day) {
      buckets.push({ tokens: limits.requests_per_day, lastRefill: Date.now(), limit: limits.requests_per_day, intervalMs: 86_400_000 });
    }
    if (buckets.length > 0) {
      this.buckets.set(hostname, buckets);
    }
  }

  unregister(hostname: string): void {
    this.buckets.delete(hostname);
  }

  /**
   * Check if a request to this hostname is allowed.
   * Returns null if allowed, or a reason string if blocked.
   */
  check(hostname: string): string | null {
    const buckets = this.buckets.get(hostname);
    if (!buckets) return null; // No limits registered for this host

    const now = Date.now();
    for (const bucket of buckets) {
      // Refill tokens
      const elapsed = now - bucket.lastRefill;
      if (elapsed >= bucket.intervalMs) {
        bucket.tokens = bucket.limit;
        bucket.lastRefill = now;
      }

      if (bucket.tokens <= 0) {
        const windowLabel = bucket.intervalMs >= 86_400_000 ? 'daily'
          : bucket.intervalMs >= 3_600_000 ? 'hourly'
          : bucket.intervalMs >= 60_000 ? 'per-minute'
          : 'per-second';
        return `API rate limit reached for ${hostname} (${String(bucket.limit)} ${windowLabel}). Wait before retrying.`;
      }
    }

    // Consume a token from each bucket
    for (const bucket of buckets) {
      bucket.tokens--;
    }
    return null;
  }
}

// ── Store ──

export class ApiStore {
  private readonly profiles = new Map<string, ApiProfile>();
  private readonly hostToProfile = new Map<string, string>(); // hostname → profile id
  readonly rateLimiter = new PerApiRateLimiter();

  /**
   * The engine.db backing store (S4b). When wired, `connections` is the single
   * source of truth for api profiles and this in-memory store is a projection
   * of it — `save`/`remove` persist through here, `loadFromConnections`
   * rebuilds the Maps from it. Null only in the degraded no-engine.db path,
   * where persistence falls back to the flat-JSON directory (legacy behaviour).
   */
  private connStore: ConnectionStore | null = null;

  /** Wire the engine.db backing store so future `save`/`remove` persist there. */
  setConnectionStore(store: ConnectionStore): void {
    this.connStore = store;
  }

  /** Load all profiles from a directory. Files must be *.json. */
  loadFromDirectory(dir: string): number {
    if (!existsSync(dir)) return 0;

    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    let loaded = 0;

    for (const file of files) {
      try {
        const raw = readFileSync(join(dir, file), 'utf-8');
        const profile = JSON.parse(raw) as ApiProfile;
        if (!profile.id || !profile.name || !profile.base_url || !profile.description) {
          process.stderr.write(`[lynox:api-store] Skipping ${file}: missing required fields (id, name, base_url, description)\n`);
          continue;
        }
        const migrated = migrateV1Profile(profile);
        this.register(migrated);
        loaded++;
      } catch (err: unknown) {
        process.stderr.write(`[lynox:api-store] Failed to load ${file}: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    return loaded;
  }

  /**
   * Load all `kind='api'` profiles from the engine.db `connections` table (S4b).
   * The projection read: each row is reconstructed into a typed `ApiProfile` and
   * registered in-memory. Does NOT persist (the rows are already the source of
   * truth) — mirrors {@link loadFromDirectory}'s validate-then-register loop.
   */
  loadFromConnections(store: ConnectionStore): number {
    let loaded = 0;
    for (const row of store.getByKind('api')) {
      try {
        const profile = connectionRowToProfile(row);
        if (!profile.id || !profile.name || !profile.base_url || !profile.description) {
          process.stderr.write(`[lynox:api-store] Skipping connection ${row.id}: missing required fields (id, name, base_url, description)\n`);
          continue;
        }
        this.register(migrateV1Profile(profile));
        loaded++;
      } catch (err: unknown) {
        process.stderr.write(`[lynox:api-store] Failed to load connection ${JSON.stringify(row.id)}: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    return loaded;
  }

  /**
   * One-shot migration of the legacy flat-JSON profiles into `connections` (S4b
   * single-authority cutover). Idempotent, guarded three ways so it never
   * double-imports or clobbers post-cutover data:
   * - a `.imported-to-connections` sentinel in the dir (durable "already ran"),
   * - a skip when `connections` already holds api rows (re-provision / racy boot),
   * - files are left in place (never deleted here).
   *
   * The write is ATOMIC (one `upsertMany` transaction): a transient DB failure
   * rolls the whole batch back and leaves the sentinel unwritten, so the import
   * retries cleanly next boot rather than silently dropping the un-imported
   * profiles. Malformed/invalid files are permanent skips (logged), decided
   * BEFORE the transaction.
   *
   * Returns the number of profiles imported (0 if nothing to do). The retained
   * flat files are a PRE-CUTOVER snapshot (a pre-S4b image reboot re-reads them):
   * they are frozen at the cutover instant — post-cutover creates/edits/deletes
   * live only in `connections`, so a revert restores the pre-cutover state, not
   * the latest. They are no longer an edit surface (hand-edits are ignored;
   * author via `api_setup`).
   */
  importFromDirectoryIfNeeded(dir: string, store: ConnectionStore): number {
    const sentinel = join(dir, IMPORT_SENTINEL);
    if (existsSync(sentinel)) return 0;
    if (!existsSync(dir)) return 0; // fresh install — no legacy profiles ever existed
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    if (files.length === 0) return 0; // nothing to import; re-checked cheaply next boot
    // Files exist but connections already has api rows → those are authoritative;
    // mark imported (stop re-scanning) without clobbering them.
    if (store.count('api') > 0) {
      this._writeImportSentinel(sentinel);
      return 0;
    }
    // Parse + validate every file FIRST — a malformed or bad-id file is a
    // permanent skip (logged, never retried); only well-formed rows enter the
    // atomic write.
    const rows: ConnectionRow[] = [];
    for (const file of files) {
      let raw: string;
      try {
        raw = readFileSync(join(dir, file), 'utf-8');
      } catch (err: unknown) {
        // A file READ failure (EACCES/EBUSY/EMFILE) is likely transient — abort
        // the whole import so it retries next boot, rather than permanently
        // dropping this profile (the flat file is no longer read post-cutover).
        // Same retry-safe stance as the upsert-transaction failure below.
        process.stderr.write(`[lynox:api-store] Import aborted — could not read ${file}, will retry next boot: ${err instanceof Error ? err.message : String(err)}\n`);
        return 0; // sentinel unwritten
      }
      try {
        const profile = JSON.parse(raw) as ApiProfile;
        if (!profile.id || !profile.name || !profile.base_url || !profile.description) {
          process.stderr.write(`[lynox:api-store] Skipping ${file} on import: missing required fields\n`);
          continue;
        }
        if (!PROFILE_ID_PATTERN.test(profile.id)) {
          process.stderr.write(`[lynox:api-store] Skipping ${file} on import: invalid id ${JSON.stringify(profile.id)}\n`);
          continue;
        }
        rows.push(profileToConnectionRow(migrateV1Profile(profile)));
      } catch (err: unknown) {
        // Malformed content (bad JSON) is a permanent skip — retrying won't help.
        process.stderr.write(`[lynox:api-store] Skipping ${file} on import: malformed JSON: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    try {
      store.upsertMany(rows); // atomic — all-or-nothing
    } catch (err: unknown) {
      // Transient failure: nothing committed, sentinel unwritten → retry next boot.
      process.stderr.write(`[lynox:api-store] Import transaction failed, will retry next boot: ${err instanceof Error ? err.message : String(err)}\n`);
      return 0;
    }
    this._writeImportSentinel(sentinel);
    process.stderr.write(`[lynox:api-store] Imported ${String(rows.length)} api profile(s) into connections (flat JSON retained as a pre-cutover backup)\n`);
    return rows.length;
  }

  private _writeImportSentinel(path: string): void {
    try {
      writeFileSync(path, `${new Date().toISOString()}\n`, { mode: 0o600 });
    } catch {
      // A missing sentinel only costs a re-scan next boot (guarded by the
      // connections-count check) — never fatal.
    }
  }

  /** Register a single profile. Skips silently if the id is malformed. */
  register(profile: ApiProfile): void {
    if (!PROFILE_ID_PATTERN.test(profile.id)) {
      // Refuse the id at the gate so the in-memory Map's invariant holds
      // — every key is a safe filename component. `unregister` can then
      // hand the id directly to `join(apisDir, …)` without a second check.
      process.stderr.write(`[lynox:api-store] Skipping profile with invalid id "${profile.id}" (must match ${PROFILE_ID_PATTERN.source})\n`);
      return;
    }
    this.profiles.set(profile.id, profile);

    // Map hostname for rate limit lookups
    try {
      const hostname = new URL(profile.base_url).hostname;
      this.hostToProfile.set(hostname, profile.id);
      if (profile.rate_limit) {
        this.rateLimiter.register(hostname, profile.rate_limit);
      }
    } catch {
      // Invalid URL — skip hostname mapping
    }
  }

  /**
   * Unregister a profile and remove its on-disk JSON.
   *
   * Returns `false` if no profile with that id was registered, so callers
   * can fall through to a disk-only delete for orphans dropped into
   * `apisDir` after engine boot. Throws `ApiProfileUnlinkError` if the
   * in-memory delete succeeded but the on-disk unlink failed for any
   * reason other than ENOENT — the HTTP handler maps that to a 500 so
   * the user doesn't see "Profile not found" while the file survives
   * and would resurrect on the next engine restart.
   *
   * Two invariants worth flagging because they're not obvious from the
   * call site:
   * - The hostname → id index is dropped only when it still points at
   *   the id being removed. A profile that re-claimed the hostname mid-
   *   session must keep its mapping.
   * - The rate-limit bucket is cleared so a future re-registration with
   *   *no* `rate_limit` doesn't inherit stale throttling from this profile.
   */
  unregister(id: string, apisDir?: string): boolean {
    // Belt-and-suspenders — `register` already refuses bad ids, but this
    // is the line that hands `id` to `join(apisDir, …)`. Keeping the
    // local check means a future regression in `register` can't open a
    // path-traversal here.
    if (!PROFILE_ID_PATTERN.test(id)) return false;

    const profile = this.profiles.get(id);
    if (!profile) return false;

    this.profiles.delete(id);

    try {
      const hostname = new URL(profile.base_url).hostname;
      if (this.hostToProfile.get(hostname) === id) {
        this.hostToProfile.delete(hostname);
        this.rateLimiter.unregister(hostname);
      }
    } catch {
      // Invalid base_url — no hostname mapping or bucket to clean.
    }

    if (apisDir) {
      const filePath = join(apisDir, `${id}.json`);
      try {
        unlinkSync(filePath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          throw new ApiProfileUnlinkError(filePath, err);
        }
      }
    }

    return true;
  }

  /**
   * Persist a profile: register it in-memory AND write it to the backing store.
   * Routes to engine.db `connections` when a ConnectionStore is wired (S4b
   * single-authority); otherwise falls back to the flat-JSON directory (the
   * degraded no-engine.db path — behaviour-identical to the pre-S4b writes).
   *
   * Returns `true` when this created a NEW profile, `false` when it updated an
   * existing one — the caller uses it for the "Created/Updated" verb, replacing
   * the old `existsSync(file)` probe.
   */
  save(profile: ApiProfile, apisDir?: string): boolean {
    const isNew = !this.profiles.has(profile.id);
    this.register(profile); // in-memory (guards the id — a malformed id is refused)
    if (!this.profiles.has(profile.id)) {
      // register() refused the id; do not persist a bad row.
      return isNew;
    }
    if (this.connStore) {
      this.connStore.upsert(profileToConnectionRow(profile));
    } else if (apisDir) {
      mkdirSync(apisDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(apisDir, `${profile.id}.json`), JSON.stringify(profile, null, 2), { mode: 0o600 });
    }
    return isNew;
  }

  /**
   * Remove a profile from memory AND the backing store. Routes to engine.db
   * `connections` when wired (in-memory unregister — no file); otherwise the
   * flat-JSON path. Returns whether the profile existed (in memory or the store).
   * May throw {@link ApiProfileUnlinkError} on the flat-JSON path if a non-ENOENT
   * unlink fails.
   */
  remove(id: string, apisDir?: string): boolean {
    if (this.connStore) {
      const inMemory = this.unregister(id); // no apisDir → in-memory only, no file unlink
      // Kind-scoped so a cross-kind id collision (once mail/google/push land)
      // can never delete a neighbour's connection.
      const inStore = this.connStore.remove(id, 'api');
      return inMemory || inStore;
    }
    // Degraded (flat-JSON) path: unregister removes a registered profile + its
    // file. If the id wasn't registered, fall through to a disk-only unlink so an
    // orphan file dropped into apisDir after boot stays deletable (pre-S4b behaviour).
    if (this.unregister(id, apisDir)) return true;
    if (apisDir && PROFILE_ID_PATTERN.test(id)) {
      const filePath = join(apisDir, `${id}.json`);
      if (existsSync(filePath)) {
        try {
          unlinkSync(filePath);
          return true;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw new ApiProfileUnlinkError(filePath, err);
          }
        }
      }
    }
    return false;
  }

  /** Get all registered profiles. */
  getAll(): ApiProfile[] {
    return [...this.profiles.values()];
  }

  /** Get a profile by ID. */
  get(id: string): ApiProfile | undefined {
    return this.profiles.get(id);
  }

  /** Find profile by hostname (used by http_request for rate limiting). */
  getByHostname(hostname: string): ApiProfile | undefined {
    const id = this.hostToProfile.get(hostname);
    return id ? this.profiles.get(id) : undefined;
  }

  /** Check per-API rate limit for a hostname. Returns null if OK, or reason string. */
  checkRateLimit(hostname: string): string | null {
    return this.rateLimiter.check(hostname);
  }

  /** How many profiles are loaded. */
  get size(): number {
    return this.profiles.size;
  }

  /**
   * Format all profiles as system prompt context (compact summary).
   * Injected into the agent's briefing. Full details available via `api_setup` tool.
   */
  formatForSystemPrompt(): string {
    if (this.profiles.size === 0) return '';

    const lines = [...this.profiles.values()].map(p => {
      const auth = p.auth ? ` [${p.auth.type}]` : '';
      const endpoints = p.endpoints?.length ? `, ${String(p.endpoints.length)} endpoints` : '';
      const shape = p.response_shape && p.response_shape.kind !== 'passthrough' ? ', shape' : '';
      return `- ${p.name}: ${p.description} (${p.base_url}${auth}${endpoints}${shape})`;
    });

    return `<api_profiles>
Registered APIs (use \`api_setup\` action=view with the id to get full details BEFORE calling the API):
${lines.join('\n')}

Maintain these profiles as you learn. If an API call returns an unexpected schema, hits a rate limit,
or teaches you a new pitfall, update the profile via \`api_setup\` action=refine. For new APIs,
prefer \`api_setup\` action=bootstrap with an OpenAPI URL; only hand-write a profile when no spec exists.
</api_profiles>`;
  }

  /**
   * Format the curated "suggested APIs" catalog as a compact system-prompt block.
   *
   * The catalog (`data/suggested-apis.json` at the package root) is NOT a set
   * of pre-loaded profiles — it's a list of free public APIs the agent can
   * offer to bootstrap on demand via `api_setup` action=bootstrap. The block
   * also encodes the auth-flow constraints the agent must respect (e.g. no
   * oauth2 authorization-code redirect flow today) and a do-not-suggest list
   * (payment providers, infra providers) so the agent doesn't proactively
   * propose risky setups.
   *
   * Returns an empty string when:
   * - LYNOX_SKIP_SUGGESTED_APIS=1 is set (opt-out)
   * - the catalog file is missing (silent — e.g. dev tree without data/)
   * - the catalog JSON is malformed (silent — never throw at boot)
   */
  formatSuggestedApisForSystemPrompt(): string {
    if (process.env['LYNOX_SKIP_SUGGESTED_APIS'] === '1') return '';

    // From src/core/api-store.ts (dev) or dist/core/api-store.js (built),
    // `../../data/suggested-apis.json` resolves to the package root where
    // `data/` is shipped via package.json `files`.
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const catalogPath = join(thisDir, '..', '..', 'data', 'suggested-apis.json');

    let raw: string;
    try {
      raw = readFileSync(catalogPath, 'utf-8');
    } catch {
      return '';
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return '';
    }

    if (!parsed || typeof parsed !== 'object') return '';
    const cat = parsed as Record<string, unknown>;
    const apis = Array.isArray(cat['suggested_apis']) ? cat['suggested_apis'] : [];
    if (apis.length === 0) return '';

    const supported = Array.isArray(cat['supported_auth_flows']) ? cat['supported_auth_flows'] as unknown[] : [];
    const notSupported = Array.isArray(cat['not_supported_auth_flows']) ? cat['not_supported_auth_flows'] as unknown[] : [];
    const doNot = Array.isArray(cat['do_not_proactively_suggest']) ? cat['do_not_proactively_suggest'] as unknown[] : [];

    const lines: string[] = ['<api_bootstrap_hints>'];
    lines.push('You have the `api_setup` tool to bootstrap external APIs from their docs URL.');
    lines.push('The actual endpoint schema, rate limits, and auth shape are extracted from the live docs at bootstrap time — do NOT hand-write a profile from memory; always pass `docs_url` (or `openapi_url`) to `api_setup` action=bootstrap.');
    lines.push('');

    if (supported.length > 0) {
      lines.push('Supported auth flows:');
      for (const s of supported) lines.push(`- ${String(s)}`);
      lines.push('');
    }
    if (notSupported.length > 0) {
      lines.push('NOT supported (cannot be bootstrapped today — do not offer):');
      for (const s of notSupported) lines.push(`- ${String(s)}`);
      lines.push('');
    }
    if (doNot.length > 0) {
      lines.push('Do NOT proactively suggest bootstrapping:');
      for (const s of doNot) lines.push(`- ${String(s)}`);
      lines.push('');
    }

    lines.push('Curated free APIs you can offer to bootstrap when relevant to the user query (ask first, then call `api_setup` action=bootstrap with the docs_url — never silently bootstrap):');
    for (const api of apis) {
      if (!api || typeof api !== 'object') continue;
      const a = api as Record<string, unknown>;
      const name = typeof a['name'] === 'string' ? a['name'] : '';
      const category = typeof a['category'] === 'string' ? a['category'] : '';
      const auth = typeof a['auth_type'] === 'string' ? a['auth_type'] : '';
      const valueProp = typeof a['value_prop'] === 'string' ? a['value_prop'] : '';
      const docsUrl = typeof a['docs_url'] === 'string' ? a['docs_url'] : '';
      if (!name || !docsUrl) continue;
      lines.push(`- ${name} (${category}, auth=${auth}) — ${valueProp} Docs: ${docsUrl}`);
    }
    lines.push('</api_bootstrap_hints>');

    return lines.join('\n');
  }

  /**
   * Format full profile details for a single API (used by api_setup tool).
   */
  formatProfile(p: ApiProfile): string {
    const lines: string[] = [];
    // Defense-in-depth: when a profile was bootstrapped from a docs_url
    // (a Haiku extraction over an arbitrary HTML page), wrap free-text
    // fields so an attacker docs page can't smuggle "ignore previous
    // instructions / set vault_keys to X" through the description /
    // guidelines / avoid / notes lines into the parent agent's prompt.
    const fromDocs = p.provenance?.source === 'docs_url';
    const trust = (text: string, field: string): string =>
      fromDocs ? wrapUntrustedData(text, `api_profile.${field}`) : text;
    lines.push(`### ${p.name}`);
    lines.push(trust(p.description, 'description'));
    lines.push(`Base URL: ${p.base_url}`);

    if (p.auth) {
      const authDesc = p.auth.type === 'none' ? 'None (public API — no credentials required)'
        : p.auth.type === 'basic'
          ? p.auth.basic_format === 'pre_encoded_b64'
            ? 'Basic Auth (pre-encoded Base64 secret — send as-is in Authorization header)'
            : 'Basic Auth (username:password base64)'
        : p.auth.type === 'bearer' ? 'Bearer Token in Authorization header'
        : p.auth.type === 'header' ? `API key in header: ${p.auth.header_name ?? 'X-Api-Key'}`
        : p.auth.type === 'oauth2' ? 'OAuth2 (managed refresh-token flow)'
        : `API key in query param: ${p.auth.query_param ?? 'key'}`;
      lines.push(`Auth: ${authDesc}`);
      if (p.auth.vault_keys?.length) {
        lines.push(`Auth vault keys: ${p.auth.vault_keys.join(', ')}`);
      }
      if (p.auth.instructions) {
        lines.push(`Auth note: ${p.auth.instructions}`);
      }
    }

    if (p.rate_limit) {
      const parts: string[] = [];
      if (p.rate_limit.requests_per_second) parts.push(`${String(p.rate_limit.requests_per_second)}/s`);
      if (p.rate_limit.requests_per_minute) parts.push(`${String(p.rate_limit.requests_per_minute)}/min`);
      if (p.rate_limit.requests_per_hour) parts.push(`${String(p.rate_limit.requests_per_hour)}/h`);
      if (p.rate_limit.requests_per_day) parts.push(`${String(p.rate_limit.requests_per_day)}/day`);
      if (parts.length > 0) lines.push(`Rate limit: ${parts.join(', ')}`);
    }

    if (p.endpoints && p.endpoints.length > 0) {
      lines.push('');
      lines.push('Endpoints:');
      for (const ep of p.endpoints) {
        lines.push(`- ${ep.method} ${ep.path} — ${ep.description}`);
      }
    }

    if (p.guidelines && p.guidelines.length > 0) {
      lines.push('');
      lines.push('Guidelines:');
      for (const g of p.guidelines) lines.push(`- ${trust(g, 'guidelines')}`);
    }

    if (p.avoid && p.avoid.length > 0) {
      lines.push('');
      lines.push('Avoid:');
      for (const a of p.avoid) lines.push(`- ${trust(a, 'avoid')}`);
    }

    if (p.notes && p.notes.length > 0) {
      lines.push('');
      lines.push('Notes:');
      for (const n of p.notes) lines.push(`- ${trust(n, 'notes')}`);
    }

    if (p.response_shape) {
      lines.push('');
      const kind = p.response_shape.kind ?? 'reduce';
      lines.push(`Response shape: ${kind}`);
      if (p.response_shape.include?.length) {
        lines.push(`  include: ${String(p.response_shape.include.length)} paths`);
      }
      if (p.response_shape.reduce) {
        const reducerCount = Object.keys(p.response_shape.reduce).length;
        lines.push(`  reduce: ${String(reducerCount)} fields`);
      }
      if (p.response_shape.max_array_items !== undefined) {
        lines.push(`  max_array_items: ${String(p.response_shape.max_array_items)}`);
      }
      if (p.response_shape.max_chars !== undefined) {
        lines.push(`  max_chars: ${String(p.response_shape.max_chars)}`);
      }
    }

    if (p.concurrency) {
      lines.push('');
      lines.push(`Concurrency: parallel_ok=${String(p.concurrency.parallel_ok)}`);
      if (p.concurrency.max_in_flight !== undefined) {
        lines.push(`  max_in_flight: ${String(p.concurrency.max_in_flight)}`);
      }
      if (p.concurrency.batchable_via_endpoint) {
        lines.push(`  batchable_via_endpoint: ${p.concurrency.batchable_via_endpoint}`);
      }
    }

    if (p.output_volume) {
      lines.push(`Output volume: ${p.output_volume}`);
    }

    if (p.cost) {
      const ratio = p.cost.output_ratio !== undefined ? ` (output_ratio=${String(p.cost.output_ratio)})` : '';
      lines.push(`Cost: ${p.cost.model} @ $${String(p.cost.rate_usd)}${ratio}`);
    }

    if (p.provenance) {
      const parts: string[] = [`source=${p.provenance.source}`];
      if (p.provenance.source_url) parts.push(`url=${p.provenance.source_url}`);
      if (p.provenance.validated_at) parts.push(`validated_at=${p.provenance.validated_at}`);
      parts.push(`schema_version=${String(p.provenance.schema_version)}`);
      lines.push(`Provenance: ${parts.join(', ')}`);
    }

    return lines.join('\n');
  }
}
