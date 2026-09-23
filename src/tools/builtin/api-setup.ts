/**
 * api_setup tool — create, validate, hot-reload, bootstrap, and refine API profiles.
 *
 * The agent uses this tool to onboard new APIs:
 *  1. `bootstrap` with an OpenAPI spec URL — auto-derives base_url/auth/endpoints.
 *     Returns a draft; the agent enriches it with guidelines/avoid/response_shape
 *     from reading the docs, then calls `create`.
 *  2. For APIs without OpenAPI: research the docs (web_research), then `create` directly.
 *  3. Ask the user for credentials with `ask_secret`.
 *  4. Test the connection with a single `http_request`.
 *  5. When calls teach something new (unexpected schema, rate limit, pitfall),
 *     `refine` the profile additively.
 *
 * Profiles are written to ~/.lynox/apis/<id>.json and hot-reloaded into ApiStore.
 */

import { join } from 'node:path';
import type { ToolEntry, IAgent, SecretStoreLike } from '../../types/index.js';
import { getLynoxDir } from '../../core/config.js';
import type { ApiProfile, ApiStore, ResponseShape, ApiAuth, ApiEndpoint, OAuthGrantRecord, TokenPurge, WrittenSecret } from '../../core/api-store.js';
import { accessTokenKey, refreshTokenKey, purgeRecordedTokens, recordedWrites } from '../../core/api-store.js';
import { classifyRefreshFailure, reclassifyForeignGrant, revokedGrantMessage, tokenFingerprint } from '../../core/oauth-refresh-failure.js';
import { derivePresetEndpoints, presetIds } from '../../core/oauth-presets.js';
import { checkRedirectTarget } from '../../core/oauth-redirect-guard.js';
import { fetchWithValidatedRedirects, readBodyLimited, MAX_REQUESTS_PER_SESSION } from './http.js';
import { resolveGuardedAckHosts } from '../../core/tool-context.js';
import { callForStructuredJson, BudgetError, type ExtractSchema } from '../../core/llm-helper.js';
import { debitInRunHelperCost } from '../../core/metered-request.js';
import { isFeatureEnabled } from '../../core/features.js';
import { describeDisclosure, isEndpointAcked, isVettedEgressHost, isPrivateLanEndpoint } from '../../core/llm/endpoint-allowlist.js';
import { pv } from '../../core/prompt-value.js';
import { isInfraSecret, isProtectedSecretWrite, SECRET_REF_PATTERN } from '../../core/secret-store.js';
import { isPrivateIP } from '../../core/network-guard.js';

/** Cap on the OpenAPI spec body — generous for real-world specs, blocks DoS via huge response. Exported so tests can use it as a single source of truth. */
export const OPENAPI_SPEC_MAX_BYTES = 5 * 1024 * 1024;
const OPENAPI_FETCH_TIMEOUT_MS = 15_000;

/** Cap on the docs-page body pre-Haiku. 250 KB matches PRD-UNIFIED-API-PROFILE-V2. */
const DOCS_BODY_MAX_BYTES = 250 * 1024;
const DOCS_FETCH_TIMEOUT_MS = 15_000;
// OAuth token responses are small JSON; cap the read so a malicious token_url
// can't stream an unbounded body into memory during fetch_token.
const TOKEN_BODY_MAX_BYTES = 64 * 1024;
/**
 * Hard $ budget per extraction call. The helper's default model is now
 * Sonnet 4.6 (matches the engine-wide LLM default) — Haiku was the legacy
 * choice and is retained as the public-demo override via
 * `LYNOX_LLM_HELPER_MODEL`. Sonnet pricing ($3 / M-tok input, $15 / M-tok
 * output) on a worst-case 70 K-token landing page + 4 K capped output
 * lands at ~$0.27; this budget leaves headroom for the linked-section
 * fan-out (A1-ext2) and avoids false-positive 403s on real-world docs
 * pages. Actual single-page extractions still land in the $0.05–$0.15
 * range with Sonnet, $0.01–$0.03 with the Haiku override.
 */
const DOCS_EXTRACT_BUDGET_USD = 0.50;

type ApiSetupAction = 'create' | 'update' | 'delete' | 'list' | 'view' | 'bootstrap' | 'refine' | 'fetch_token' | 'connect';

interface RefinePatch {
  addGuidelines?: string[] | undefined;
  addAvoid?: string[] | undefined;
  addNotes?: string[] | undefined;
  addEndpoints?: ApiEndpoint[] | undefined;
  response_shape?: ResponseShape | undefined;
  rate_limit?: ApiProfile['rate_limit'] | undefined;
}

interface ApiSetupInput {
  action: ApiSetupAction;
  /** API profile data (required for create/update). */
  profile?: ApiProfile | undefined;
  /** Profile ID (required for delete/view/refine/fetch_token). */
  id?: string | undefined;
  /** For fetch_token: vault key name to store the access_token under. Default: derived from id. */
  output_secret_name?: string | undefined;
  /** OpenAPI spec URL — preferred bootstrap source when an OpenAPI 3.x JSON spec exists. */
  openapi_url?: string | undefined;
  /**
   * Human-readable docs landing page URL — bootstrap path for APIs without an
   * OpenAPI spec. Gated behind the `api-setup-v2` feature flag. Fetches the
   * page, runs a single Haiku call to extract auth / rate limits / cost /
   * concurrency / endpoints, and returns a draft v2 profile.
   */
  docs_url?: string | undefined;
  /** Additive patch (required for refine). */
  refine?: RefinePatch | undefined;
}

const REQUIRED_FIELDS: Array<keyof ApiProfile> = ['id', 'name', 'base_url', 'description'];
const VALID_AUTH_TYPES = new Set(['none', 'basic', 'bearer', 'header', 'query', 'oauth2']);
const VALID_BASIC_FORMATS = new Set(['user_pass_split', 'pre_encoded_b64']);
/** Vault key names are UPPER_SNAKE_CASE. Mirrors the bootstrap input schema, applied on the
 *  create/update path too — that schema only ever guarded the Haiku draft. */
const VAULT_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// `graphql` accepted 2026-05-18 as alias for `reduce` with GraphQL-shaped
// include paths (e.g. "data.products.edges[*].node"). The reducer treats
// it identically to `reduce` but the explicit name signals intent to the
// agent (don't confuse with REST passthrough) — staging incident: Shopify
// integration setup hit `Invalid response_shape.kind "graphql"` because
// the schema didn't accept GraphQL as a first-class shape.
const VALID_SHAPE_KINDS = new Set(['reduce', 'passthrough', 'graphql']);
const VALID_REDUCERS = new Set(['avg', 'peak', 'avg+peak', 'count', 'first_n', 'last_n']);
const VALID_OUTPUT_VOLUMES = new Set(['small', 'medium', 'large', 'streaming']);
const VALID_COST_MODELS = new Set(['per_call', 'per_token', 'per_unit']);
const VALID_PROVENANCE_SOURCES = new Set(['openapi', 'docs_url', 'manual']);

function validateProfile(profile: ApiProfile): string | null {
  for (const field of REQUIRED_FIELDS) {
    if (!profile[field] || (typeof profile[field] === 'string' && (profile[field] as string).trim() === '')) {
      return `Missing required field: ${field}`;
    }
  }
  if (!ID_PATTERN.test(profile.id)) {
    return `Invalid id "${profile.id}": must be lowercase alphanumeric with hyphens/underscores, 1-64 chars`;
  }
  try {
    new URL(profile.base_url);
  } catch {
    return `Invalid base_url: "${profile.base_url}" is not a valid URL`;
  }
  if (profile.auth) {
    if (!VALID_AUTH_TYPES.has(profile.auth.type)) {
      return `Invalid auth.type "${profile.auth.type}": must be none, basic, bearer, header, query, or oauth2`;
    }
    if (profile.auth.basic_format !== undefined && !VALID_BASIC_FORMATS.has(profile.auth.basic_format)) {
      return `Invalid auth.basic_format "${profile.auth.basic_format}": must be user_pass_split or pre_encoded_b64`;
    }
    // The two keys a `user_pass_split` profile hands the engine at call time. Validated
    // HERE as well as at the attach, so a bad profile fails loudly at setup — when the
    // operator is present and can fix it — instead of at the first request. Both halves
    // matter: the SHAPE (a vault key name), and the refusal to name an infrastructure
    // secret. The latter is the one that matters: these names come from the profile, which
    // a prompt-injected agent can author, and `resolve()` — unlike `resolveSecretRefs` —
    // has no infra filter of its own.
    for (const [field, key] of [
      ['auth.username_key', profile.auth.username_key],
      ['auth.password_key', profile.auth.password_key],
    ] as const) {
      if (key === undefined) continue;
      if (!VAULT_KEY_PATTERN.test(key)) {
        return `Invalid ${field} "${key}": must be an UPPER_SNAKE_CASE vault key name`;
      }
      if (isInfraSecret(key)) {
        return `Invalid ${field} "${key}": that is an infrastructure secret managed by the platform. It is never attached to an outbound request — use a credential the user supplied for this API.`;
      }
    }
    // A list of names, or nothing. The attach reads `vault_keys` by index, so any
    // other value still hands it a name, and every other reader would have to
    // guess the same way.
    const vaultKeys: unknown = profile.auth.vault_keys;
    if (vaultKeys !== undefined && vaultKeys !== null && !(Array.isArray(vaultKeys) && vaultKeys.every((k) => typeof k === 'string'))) {
      return 'Invalid auth.vault_keys: must be a list of vault key names, e.g. ["MY_API_KEY"]. A stored profile holding something else there is fixed with api_setup update.';
    }
    if (profile.auth.type === 'oauth2' && (!profile.auth.vault_keys || profile.auth.vault_keys.length === 0)) {
      return 'auth.vault_keys is required for auth.type="oauth2" (lists the vault key names the OAuth grant will resolve)';
    }
    // OAuth2 metadata: required when type='oauth2' AND the agent intends to
    // use action=fetch_token. We still allow profiles that just carry the
    // auth.type='oauth2' label without metadata (legacy / human-driven
    // flows), but the metadata-shape gets validated when present.
    if (profile.auth.type === 'oauth2' && profile.auth.oauth) {
      const o = profile.auth.oauth;
      if (o.token_url !== undefined) {
        try { new URL(o.token_url); } catch {
          return `Invalid auth.oauth.token_url: "${o.token_url}" is not a valid URL`;
        }
      }
      if (o.grant_type !== undefined && o.grant_type !== 'client_credentials' && o.grant_type !== 'refresh_token') {
        return `Invalid auth.oauth.grant_type "${o.grant_type}": must be "client_credentials" or "refresh_token"`;
      }
      if (o.body_format !== undefined && o.body_format !== 'form' && o.body_format !== 'json') {
        return `Invalid auth.oauth.body_format "${o.body_format}": must be "form" or "json"`;
      }
      const keyPattern = /^[A-Z][A-Z0-9_]{0,63}$/;
      for (const field of ['client_id_key', 'client_secret_key', 'refresh_token_key'] as const) {
        const v = o[field];
        if (v !== undefined && !keyPattern.test(v)) {
          return `Invalid auth.oauth.${field} "${v}": must be UPPER_SNAKE_CASE, start with a letter, 1-64 chars`;
        }
      }
      // The two fields a HOST is derived from. Checked here for the same reason
      // the username/password keys above are, and the comment there is the whole
      // argument: these values come from the profile, a prompt-injected agent can
      // author them, and this is the point where the operator is still present.
      //
      // The type says `Record<string, string>`, and the type is not a check — a
      // profile arrives as model JSON or as a file. The derivation refuses a
      // non-string later and that refusal is the real boundary; what this adds is
      // that a structurally broken profile never persists to fail far from
      // whoever could fix it.
      if (o.preset_id !== undefined) {
        // The value is NOT repeated back, and the asymmetry with the two
        // refusals below is what gave this away: they name the field and never
        // the value, this one did the opposite. Tool input passes through the
        // secret resolver before the handler runs, and the consent it asks for
        // is per-NAME and remembered — so a name consented to once for some
        // other call is substituted here with no prompt, and a refusal that
        // quotes what arrived would put the resolved value into the model's
        // context. It is a provider id; naming the field is enough to fix it.
        if (new RegExp(SECRET_REF_PATTERN.source).test(o.preset_id)) {
          return 'Invalid auth.oauth.preset_id: a vault reference cannot name a provider. This field selects a built-in provider by name — pass the id itself, never a credential.';
        }
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(o.preset_id)) {
          return 'Invalid auth.oauth.preset_id: must be a lowercase provider id — letters, digits and hyphens, starting with a letter. Use api_setup connect to see which providers this engine knows.';
        }
      }
      const presetParams: unknown = o.preset_params;
      if (presetParams !== undefined) {
        if (typeof presetParams !== 'object' || presetParams === null || Array.isArray(presetParams)) {
          return 'Invalid auth.oauth.preset_params: must be an object of name/value pairs, e.g. {"shop": "acme"}.';
        }
        for (const [name, value] of Object.entries(presetParams)) {
          if (typeof value !== 'string') {
            return `Invalid auth.oauth.preset_params.${name}: must be text. These values are substituted into the provider's address, so only a plain string can be one.`;
          }
          // The third condition, and the only one that is not about shape. Tool
          // input passes through `resolveSecretRefs` before this handler runs, so
          // a parameter written as a vault reference normally arrives here already
          // holding the VALUE — which would make a credential a DNS label in an
          // address the engine hands a browser. What still arrives as a literal
          // reference is the infra-secret case, which that resolver deliberately
          // leaves unsubstituted; refusing it is what this line can still do, and
          // it says the thing the model needs to learn: this field is not a place
          // for a secret at all.
          if (new RegExp(SECRET_REF_PATTERN.source).test(value)) {
            return `Invalid auth.oauth.preset_params.${name}: a vault reference cannot be a provider parameter. This value becomes part of the address the user's browser is sent to — pass the plain value (a shop name, a region), never a credential.`;
          }
        }
      }
    }
  }
  if (profile.rate_limit) {
    const rl = profile.rate_limit;
    if (rl.requests_per_second !== undefined && (rl.requests_per_second < 0 || !Number.isFinite(rl.requests_per_second))) {
      return 'Invalid rate_limit.requests_per_second';
    }
    if (rl.requests_per_minute !== undefined && (rl.requests_per_minute < 0 || !Number.isFinite(rl.requests_per_minute))) {
      return 'Invalid rate_limit.requests_per_minute';
    }
  }
  if (profile.response_shape) {
    const shapeErr = validateShape(profile.response_shape);
    if (shapeErr) return shapeErr;
  }
  if (profile.concurrency) {
    if (typeof profile.concurrency.parallel_ok !== 'boolean') {
      return 'Invalid concurrency.parallel_ok: must be boolean';
    }
    if (profile.concurrency.max_in_flight !== undefined) {
      const m = profile.concurrency.max_in_flight;
      if (!Number.isInteger(m) || m < 1) {
        return 'Invalid concurrency.max_in_flight: must be positive integer';
      }
    }
  }
  if (profile.output_volume !== undefined && !VALID_OUTPUT_VOLUMES.has(profile.output_volume)) {
    return `Invalid output_volume "${profile.output_volume}": must be small, medium, large, or streaming`;
  }
  if (profile.cost) {
    if (!VALID_COST_MODELS.has(profile.cost.model)) {
      return `Invalid cost.model "${profile.cost.model}": must be per_call, per_token, or per_unit`;
    }
    if (!Number.isFinite(profile.cost.rate_usd) || profile.cost.rate_usd < 0) {
      return 'Invalid cost.rate_usd: must be non-negative number';
    }
    if (profile.cost.output_ratio !== undefined && (!Number.isFinite(profile.cost.output_ratio) || profile.cost.output_ratio <= 0)) {
      return 'Invalid cost.output_ratio: must be positive number';
    }
  }
  if (profile.provenance) {
    if (!VALID_PROVENANCE_SOURCES.has(profile.provenance.source)) {
      return `Invalid provenance.source "${profile.provenance.source}": must be openapi, docs_url, or manual`;
    }
    if (profile.provenance.schema_version !== 2) {
      return `Invalid provenance.schema_version "${String(profile.provenance.schema_version)}": only schema_version=2 is supported in v2 profiles`;
    }
  }
  return null;
}

function validateShape(shape: ResponseShape): string | null {
  if (shape.kind !== undefined && !VALID_SHAPE_KINDS.has(shape.kind)) {
    return `Invalid response_shape.kind "${shape.kind}": must be "reduce" or "passthrough"`;
  }
  if (shape.reduce) {
    for (const [path, reducer] of Object.entries(shape.reduce)) {
      if (!VALID_REDUCERS.has(reducer)) {
        return `Invalid reducer "${reducer}" at path "${path}": must be one of avg, peak, avg+peak, count, first_n, last_n`;
      }
    }
  }
  for (const key of ['max_array_items', 'max_string_chars', 'max_chars'] as const) {
    const v = shape[key];
    if (v !== undefined && (!Number.isFinite(v) || v < 0)) {
      return `Invalid response_shape.${key}: must be a non-negative number`;
    }
  }
  return null;
}

function getApisDir(): string {
  return join(getLynoxDir(), 'apis');
}

// ── OpenAPI 3.x parsing (deterministic, narrow) ──────────────────────────────

interface OpenApiDoc {
  openapi?: string;
  info?: { title?: string; description?: string };
  servers?: Array<{ url?: string; description?: string }>;
  paths?: Record<string, Record<string, { summary?: string; description?: string; operationId?: string }>>;
  components?: {
    securitySchemes?: Record<string, {
      type?: string;
      scheme?: string;
      in?: string;
      name?: string;
      bearerFormat?: string;
      description?: string;
    }>;
  };
}

function parseOpenApi(spec: OpenApiDoc, fallbackId: string): ApiProfile {
  const title = spec.info?.title ?? fallbackId;
  const id = slugify(title || fallbackId);
  const description = spec.info?.description?.split('\n')[0]?.slice(0, 300) ?? `${title} API`;

  const serverUrl = spec.servers?.[0]?.url;
  if (!serverUrl) {
    throw new Error('OpenAPI spec has no `servers[]` entry — cannot derive base_url.');
  }

  const auth = deriveAuth(spec);
  const endpoints = derivePathEndpoints(spec);

  const profile: ApiProfile = {
    id,
    name: title,
    base_url: serverUrl,
    description,
  };
  if (auth) profile.auth = auth;
  if (endpoints.length > 0) profile.endpoints = endpoints;
  return profile;
}

function deriveAuth(spec: OpenApiDoc): ApiAuth | undefined {
  const schemes = spec.components?.securitySchemes;
  if (!schemes) return undefined;
  // Prefer first scheme; in real bootstrap flow the agent can refine.
  for (const scheme of Object.values(schemes)) {
    if (!scheme.type) continue;
    if (scheme.type === 'http' && scheme.scheme === 'bearer') {
      const auth: ApiAuth = { type: 'bearer' };
      if (scheme.description) auth.instructions = scheme.description.slice(0, 300);
      return auth;
    }
    if (scheme.type === 'http' && scheme.scheme === 'basic') {
      const auth: ApiAuth = { type: 'basic' };
      if (scheme.description) auth.instructions = scheme.description.slice(0, 300);
      return auth;
    }
    if (scheme.type === 'apiKey') {
      if (scheme.in === 'header') {
        const auth: ApiAuth = { type: 'header', header_name: scheme.name ?? 'X-Api-Key' };
        if (scheme.description) auth.instructions = scheme.description.slice(0, 300);
        return auth;
      }
      if (scheme.in === 'query') {
        const auth: ApiAuth = { type: 'query', query_param: scheme.name ?? 'key' };
        if (scheme.description) auth.instructions = scheme.description.slice(0, 300);
        return auth;
      }
    }
  }
  return undefined;
}

function derivePathEndpoints(spec: OpenApiDoc): ApiEndpoint[] {
  const paths = spec.paths;
  if (!paths) return [];
  const out: ApiEndpoint[] = [];
  const METHODS = ['get', 'post', 'put', 'delete', 'patch'] as const;
  for (const [path, ops] of Object.entries(paths)) {
    if (!ops || typeof ops !== 'object') continue;
    for (const method of METHODS) {
      const op = ops[method];
      if (!op) continue;
      const desc = op.summary ?? op.description?.split('\n')[0] ?? op.operationId ?? '';
      out.push({ method: method.toUpperCase(), path, description: desc.slice(0, 200) });
    }
  }
  return out;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'api';
}

// ── docs_url bootstrap (PRD-UNIFIED-API-PROFILE-V2 Phase B) ──────────────────

/**
 * Strict whitelist of fields Haiku is allowed to populate. Anything outside
 * this shape is dropped silently after extraction (S1 from the PRD).
 *
 * Notably absent:
 *   - id / name / base_url — derived from docs_url, never trusted from the model.
 *   - auth.vault_keys      — must be populated by the agent via `ask_secret`.
 *   - response_shape       — added later via `refine` once real responses land.
 *   - provenance           — written by this tool, not by the model.
 */
const DOCS_EXTRACT_SCHEMA: ExtractSchema = {
  type: 'object',
  properties: {
    description: { type: 'string' },
    auth: {
      type: 'object',
      properties: {
        // `none` is included so docs_url bootstrap can mark public APIs explicitly
        // (HN-Algolia, arXiv, etc.) — otherwise the agent has to fake bearer+vault_keys=[]
        // to dodge the create-action's "no auth specified" warning.
        type: { type: 'string', enum: ['none', 'basic', 'bearer', 'header', 'query', 'oauth2'] as const },
        basic_format: { type: 'string', enum: ['user_pass_split', 'pre_encoded_b64'] as const },
        username_key: { type: 'string', pattern: '^[A-Z][A-Z0-9_]*$' },
        password_key: { type: 'string', pattern: '^[A-Z][A-Z0-9_]*$' },
        header_name: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9-]*$' },
        query_param: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]*$' },
        instructions: { type: 'string' },
      },
      required: ['type'],
    },
    rate_limit: {
      type: 'object',
      properties: {
        requests_per_second: { type: 'number', minimum: 0 },
        requests_per_minute: { type: 'number', minimum: 0 },
        requests_per_hour: { type: 'number', minimum: 0 },
        requests_per_day: { type: 'number', minimum: 0 },
      },
    },
    concurrency: {
      type: 'object',
      properties: {
        parallel_ok: { type: 'boolean' },
        max_in_flight: { type: 'integer', minimum: 1, maximum: 100 },
        batchable_via_endpoint: { type: 'string' },
      },
      required: ['parallel_ok'],
    },
    output_volume: { type: 'string', enum: ['small', 'medium', 'large', 'streaming'] as const },
    cost: {
      type: 'object',
      properties: {
        model: { type: 'string', enum: ['per_call', 'per_token', 'per_unit'] as const },
        rate_usd: { type: 'number', minimum: 0, maximum: 100 },
        output_ratio: { type: 'number', minimum: 0 },
      },
      required: ['model', 'rate_usd'],
    },
    endpoints: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const },
          path: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['method', 'path'],
      },
    },
    guidelines: { type: 'array', maxItems: 20, items: { type: 'string' } },
    avoid: { type: 'array', maxItems: 20, items: { type: 'string' } },
    notes: { type: 'array', maxItems: 20, items: { type: 'string' } },
  },
};

interface DocsExtracted {
  description?: string;
  auth?: {
    type: 'none' | 'basic' | 'bearer' | 'header' | 'query' | 'oauth2';
    basic_format?: 'user_pass_split' | 'pre_encoded_b64';
    username_key?: string;
    password_key?: string;
    header_name?: string;
    query_param?: string;
    instructions?: string;
    /** Untrusted field — always dropped post-extraction. Declared so we can detect injection attempts. */
    vault_keys?: unknown;
  };
  rate_limit?: ApiProfile['rate_limit'];
  concurrency?: ApiProfile['concurrency'];
  output_volume?: ApiProfile['output_volume'];
  cost?: ApiProfile['cost'];
  endpoints?: ApiEndpoint[];
  guidelines?: string[];
  avoid?: string[];
  notes?: string[];
  /** Untrusted — always dropped. */
  id?: unknown;
  name?: unknown;
  base_url?: unknown;
}

const DOCS_EXTRACT_SYSTEM = `You read API documentation pages and extract a structured profile that helps another agent call the API correctly.

Rules:
- Only populate fields you can support with explicit evidence from the docs. Leave a field unset rather than guessing.
- For auth.type: set "none" when the docs explicitly state the API is public / requires no key (HN-Algolia, arXiv, public stats APIs). Use "basic" / "bearer" / "header" / "query" / "oauth2" otherwise.
- If the docs say "no parallel calls", "one request at a time", "per-token concurrency cap = 1", or similar, set concurrency.parallel_ok=false. Otherwise set parallel_ok=true ONLY if the docs explicitly confirm concurrent calls are supported.
- When you set parallel_ok=true OR parallel_ok=false, append one notes[] entry quoting the docs sentence that supports the claim (≤200 chars, use straight quotes).
- For cost: prefer per_call when the docs list a fixed price per request; per_token when pricing is per input/output token; per_unit for other unit-priced models.
- For output_volume: choose 'small' (<1KB), 'medium' (<10KB), 'large' (>10KB), or 'streaming' based on the API's typical response shape.
- Use uppercase HTTP methods for endpoints.method.
- Do NOT populate id, name, base_url, or any auth.vault_keys field. Those are derived from the URL by the caller.
- Keep guidelines / avoid / notes to short sentences (≤200 chars each).`;

/** Registrable origin (scheme + host) derived from a docs URL. Used as the
 *  authoritative base_url; we never trust an extracted value. */
function deriveBaseUrlFromDocs(docsUrl: string): string {
  const u = new URL(docsUrl);
  return `${u.protocol}//${u.host}`;
}

/** Last two labels — coarse stand-in for registrable domain; over-drops on
 *  multi-label TLDs (co.uk) but never under-drops (the security direction). */
function lastTwoLabels(hostname: string): string {
  const labels = hostname.toLowerCase().split('.');
  if (labels.length < 2) return hostname.toLowerCase();
  return labels.slice(-2).join('.');
}

/** Same-domain alt-host candidates referenced in the docs body. Cross-domain
 *  hosts are dropped — surfacing them would let a hostile docs page steer
 *  weak agents at attacker.com. The same-domain check is load-bearing. */
function findApiHostCandidates(html: string, docsUrl: string): string[] {
  let docsHost: string;
  try {
    docsHost = new URL(docsUrl).hostname.toLowerCase();
  } catch {
    return [];
  }
  const docsDomain = lastTwoLabels(docsHost);
  const re = /https?:\/\/((?:api[\w-]*|gateway[\w-]*|graphql[\w-]*|rest[\w-]*|edge[\w-]*)\.[a-z0-9.-]+\.[a-z]{2,})/gi;
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const match of html.matchAll(re)) {
    const host = (match[1] ?? '').toLowerCase();
    if (!host || host === docsHost) continue;
    if (lastTwoLabels(host) !== docsDomain) continue;
    if (seen.has(host)) continue;
    seen.add(host);
    candidates.push(host);
    if (candidates.length >= 3) break;
  }
  return candidates;
}

/** Strip query + fragment so URLs with credentials (e.g. `?api_key=…`) don't
 *  leak into error messages or logs. Falls back to a safe sentinel on parse fail. */
function safeUrlForLogging(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '<unparseable url>';
  }
}

/** Keyword fragments that mark a deeper docs section worth pulling in for
 *  v2 profile extraction. Matched case-insensitively against both the anchor
 *  text and the URL pathname. */
const LINKED_SECTION_KEYWORDS: readonly string[] = [
  'rate limit', 'rate-limit', 'ratelimit',
  'authentication', 'auth',
  'pricing', 'price',
  'errors', 'error code',
  'quota', 'limits',
];

/** Hard cap on linked sub-pages per bootstrap. PRD specifies 1–2 deeper reads. */
const LINKED_SECTION_MAX_COUNT = 2;
/** Don't bother fetching a sub-page if the remaining body budget would leave
 *  it shorter than ~1 KB — the Haiku call won't learn enough to be useful. */
const LINKED_SECTION_MIN_BUDGET = 1024;

interface LinkedSection {
  url: string;
  anchor: string;
}

/** Scan a landing-page HTML body for same-host links whose anchor text or
 *  pathname mentions one of the LINKED_SECTION_KEYWORDS. Returns up to
 *  LINKED_SECTION_MAX_COUNT deduplicated candidates, highest keyword-hit count
 *  first. Pure function — no network IO, safe to run on truncated bodies.
 *
 *  Trust boundary: same-host means "same host as the user-supplied docs URL".
 *  If the user passes an attacker-controlled docs URL, this function can fan
 *  out to that attacker's other paths by design — the user opted in by
 *  supplying the URL. The filter only blocks lateral movement to a *different*
 *  domain (e.g. an attacker docs page linking to `evil.com/leak`). */
function findLinkedSections(html: string, baseUrl: string): LinkedSection[] {
  let base: URL;
  let baseCanonical: string;
  try {
    base = new URL(baseUrl);
    // Canonicalise the input so a candidate with a different fragment / trailing
    // detail still matches and is deduped against the URL we already fetched.
    const baseForDedup = new URL(baseUrl);
    baseForDedup.hash = '';
    baseCanonical = baseForDedup.toString();
  } catch {
    return [];
  }

  const anchorRegex = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi;
  const seen = new Set<string>();
  const candidates: Array<LinkedSection & { score: number }> = [];

  for (const match of html.matchAll(anchorRegex)) {
    const href = match[1] ?? '';
    const rawAnchor = match[2] ?? '';
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) continue;

    let parsed: URL;
    try {
      parsed = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    // Same-host only. Use `hostname` (not `host`) so `example.com` and
    // `example.com:443` compare equal — explicit default ports must not
    // silently drop legitimate same-effective-host links.
    if (parsed.hostname !== base.hostname) continue;
    parsed.hash = '';
    const normalized = parsed.toString();
    if (normalized === baseCanonical) continue;
    if (seen.has(normalized)) continue;

    const anchorText = rawAnchor.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    const haystack = `${anchorText} ${parsed.pathname.toLowerCase()}`;
    let score = 0;
    for (const kw of LINKED_SECTION_KEYWORDS) {
      if (haystack.includes(kw)) score += 1;
    }
    if (score === 0) continue;

    seen.add(normalized);
    candidates.push({ url: normalized, anchor: anchorText.slice(0, 80), score });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, LINKED_SECTION_MAX_COUNT).map(c => ({ url: c.url, anchor: c.anchor }));
}

/** Fetch one linked docs section honouring the remaining body budget. Returns
 *  the empty string on any failure — sub-page reads are best-effort. */
async function fetchLinkedSection(url: string, agent: IAgent, remainingBudget: number): Promise<string> {
  if (remainingBudget < LINKED_SECTION_MIN_BUDGET) return '';
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => { ac.abort(); }, DOCS_FETCH_TIMEOUT_MS);
    try {
      const { response: resp } = await fetchWithValidatedRedirects(url, { signal: ac.signal }, { surface: 'discovery' }, agent.toolContext);
      // Bootstrap fetches go around the http_request tool, so the session
      // limit didn't see them pre-1.5.0. Charge each successful fetch so a
      // pathological docs_url can't laundromat its way past the budget.
      agent.sessionCounters.httpRequests++;
      if (!resp.ok) return '';
      const { text } = await readBodyLimited(resp, remainingBudget);
      return text;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return '';
  }
}

/**
 * Strip every field outside the extraction whitelist and force the trusted
 * values that come from the caller (base_url, vault_keys, provenance, id, name).
 * Returns a draft ApiProfile ready for the agent to enrich and then `create`.
 */
function buildDraftFromExtraction(
  extracted: DocsExtracted,
  docsUrl: string,
  injectedFields: string[],
): ApiProfile {
  const baseUrl = deriveBaseUrlFromDocs(docsUrl);
  const host = new URL(baseUrl).hostname;
  const idCandidate = slugify(host.replace(/^api\.|^docs\./, '').replace(/\.[^.]+$/, ''));

  const draft: ApiProfile = {
    id: idCandidate,
    name: host,
    base_url: baseUrl,
    description: typeof extracted.description === 'string'
      ? extracted.description.slice(0, 300)
      : `${host} API`,
  };

  if (extracted.auth) {
    const auth: ApiAuth = { type: extracted.auth.type };
    if (extracted.auth.basic_format) auth.basic_format = extracted.auth.basic_format;
    if (extracted.auth.header_name) auth.header_name = extracted.auth.header_name;
    if (extracted.auth.query_param) auth.query_param = extracted.auth.query_param;
    if (extracted.auth.instructions) {
      // Prefix with a provenance marker so an attacker-controlled docs page can't
      // smuggle "ignore previous instructions" into the agent's later context via
      // formatProfile's "Auth note:" rendering.
      auth.instructions = `[from docs page] ${extracted.auth.instructions.slice(0, 300)}`;
    }
    // vault_keys deliberately omitted — agent must populate via ask_secret.
    draft.auth = auth;
  }

  if (extracted.rate_limit) draft.rate_limit = extracted.rate_limit;
  if (extracted.concurrency) draft.concurrency = extracted.concurrency;
  if (extracted.output_volume) draft.output_volume = extracted.output_volume;
  if (extracted.cost) draft.cost = extracted.cost;

  if (extracted.endpoints?.length) {
    draft.endpoints = extracted.endpoints.map(ep => ({
      method: ep.method.toUpperCase(),
      path: ep.path.startsWith('/') ? ep.path : `/${ep.path}`,
      description: (ep.description ?? '').slice(0, 200),
    }));
  }
  // Schema already caps arrays at maxItems=20, so the post-validation arrays are
  // bounded; only the per-string slice is load-bearing here.
  if (extracted.guidelines?.length) draft.guidelines = extracted.guidelines.map(s => s.slice(0, 200));
  if (extracted.avoid?.length) draft.avoid = extracted.avoid.map(s => s.slice(0, 200));
  if (extracted.notes?.length) draft.notes = extracted.notes.map(s => s.slice(0, 200));

  if (injectedFields.length > 0) {
    const warning = `bootstrap dropped fields outside whitelist: ${injectedFields.join(', ')}`;
    draft.notes = [...(draft.notes ?? []), warning];
  }

  draft.provenance = {
    source: 'docs_url',
    source_url: docsUrl,
    schema_version: 2,
  };
  return draft;
}

/** Inspect raw extracted output and report any forbidden fields the model tried to set. */
function findInjectedFields(extracted: DocsExtracted): string[] {
  const injected: string[] = [];
  if (extracted.id !== undefined) injected.push('id');
  if (extracted.name !== undefined) injected.push('name');
  if (extracted.base_url !== undefined) injected.push('base_url');
  if (extracted.auth?.vault_keys !== undefined) injected.push('auth.vault_keys');
  return injected;
}

/** Compose a short human-readable sentence summarising the draft for the agent. */
function buildNlSummary(draft: ApiProfile, docsUrl: string): string {
  const parts: string[] = [`${draft.name}: ${draft.description}`];
  if (draft.auth) {
    const authBits: string[] = [`auth=${draft.auth.type}`];
    if (draft.auth.basic_format) authBits.push(`basic_format=${draft.auth.basic_format}`);
    parts.push(authBits.join(' '));
  }
  if (draft.rate_limit) {
    const rl: string[] = [];
    if (draft.rate_limit.requests_per_second) rl.push(`${String(draft.rate_limit.requests_per_second)}/s`);
    if (draft.rate_limit.requests_per_minute) rl.push(`${String(draft.rate_limit.requests_per_minute)}/min`);
    if (draft.rate_limit.requests_per_hour) rl.push(`${String(draft.rate_limit.requests_per_hour)}/h`);
    if (draft.rate_limit.requests_per_day) rl.push(`${String(draft.rate_limit.requests_per_day)}/day`);
    if (rl.length > 0) parts.push(`rate=${rl.join(',')}`);
  }
  if (draft.concurrency) parts.push(`parallel_ok=${String(draft.concurrency.parallel_ok)}`);
  if (draft.output_volume) parts.push(`output_volume=${draft.output_volume}`);
  if (draft.cost) parts.push(`cost=${draft.cost.model} $${String(draft.cost.rate_usd)}`);
  parts.push(`source=${docsUrl}`);
  return parts.join(' · ');
}

/** Surface a sub-phase update on the streamHandler so the activity bar can
 *  swap its generic "api_setup" label for "Reading API docs..." etc. No-op
 *  when no handler is attached (CLI / headless runs).
 *
 *  Defensive try/catch + caught Promise.rejection: a misbehaving stream
 *  handler must never turn a successful bootstrap into an error string nor
 *  produce an unhandledRejection. The progress event is fire-and-forget
 *  UX polish — its failure path should be silent. */
function emitBootstrapProgress(agent: IAgent, phase: 'fetching_docs' | 'extracting' | 'finalizing'): void {
  const handler = agent.toolContext.streamHandler;
  if (!handler) return;
  try {
    const result = handler({
      type: 'tool_progress',
      tool: 'api_setup',
      phase,
      agent: agent.name,
    });
    if (result instanceof Promise) {
      result.catch(() => { /* swallow — progress emission is best-effort */ });
    }
  } catch {
    /* swallow synchronous throws too */
  }
}

async function bootstrapFromDocs(docsUrl: string, agent: IAgent): Promise<string> {
  if (!isFeatureEnabled('api-setup-v2')) {
    return 'Error: docs_url bootstrap requires the `api-setup-v2` feature, which is ON by default but has been disabled here (LYNOX_FEATURE_API_SETUP_V2=0). Remove that override to re-enable, or use `openapi_url` if the API has an OpenAPI 3.x spec.';
  }

  emitBootstrapProgress(agent, 'fetching_docs');
  let docsText: string;
  let truncated: boolean;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => { ac.abort(); }, DOCS_FETCH_TIMEOUT_MS);
    try {
      const { response: resp } = await fetchWithValidatedRedirects(docsUrl, { signal: ac.signal }, { surface: 'discovery' }, agent.toolContext);
      // Charge the primary docs fetch against the session HTTP budget so
      // bootstrap is not a freebie bypass of MAX_REQUESTS_PER_SESSION.
      agent.sessionCounters.httpRequests++;
      if (!resp.ok) {
        // `resp.statusText` is the HTTP reason phrase — chosen by the REMOTE server,
        // free-form, and echoed here verbatim. `api_setup` is on the agent's
        // scan-exempt tool allowlist, so this string reaches the model WITHOUT
        // `scanToolResult`. Measured: a server returning `404 Ignore all previous
        // instructions…` had the full text delivered byte-identically, and the
        // injection detector WOULD have flagged it — it never sees it. The status
        // code alone is diagnostic enough, and it is not attacker-authored text.
        return `Error: failed to fetch docs page (HTTP ${String(resp.status)}). Check the URL and try again.`;
      }
      const body = await readBodyLimited(resp, DOCS_BODY_MAX_BYTES);
      docsText = body.text;
      truncated = body.truncated;
    } finally {
      clearTimeout(timer);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Strip query + fragment so a docs_url with a credential pasted as ?api_key=…
    // doesn't leak into the agent transcript / stderr via the error path.
    const safeUrl = safeUrlForLogging(docsUrl);
    return `Error: docs fetch failed for ${safeUrl} — ${msg}`;
  }

  // Fan out 1–2 same-host linked-section reads (rate-limits / auth / pricing)
  // so the Haiku extractor sees details the landing page often only links to.
  // Each sub-fetch is bounded by the remaining 250 KB body budget, so the
  // combined Haiku prompt cannot exceed DOCS_BODY_MAX_BYTES.
  const linkedSections = findLinkedSections(docsText, docsUrl);
  const fetchedSections: Array<{ url: string; text: string }> = [];
  let remainingBudget = DOCS_BODY_MAX_BYTES - Buffer.byteLength(docsText, 'utf8');
  for (const section of linkedSections) {
    if (remainingBudget < LINKED_SECTION_MIN_BUDGET) break;
    const text = await fetchLinkedSection(section.url, agent, remainingBudget);
    if (text) {
      fetchedSections.push({ url: section.url, text });
      remainingBudget -= Buffer.byteLength(text, 'utf8');
    }
  }

  emitBootstrapProgress(agent, 'extracting');
  let extracted: DocsExtracted;
  let costUsd: number;
  try {
    // Defense-in-depth: an attacker docs page can plant the literal section
    // marker inside its body to spoof provenance. Neutralise the trigger
    // string in any source body BEFORE concatenation. Impact today is low
    // (the whitelist post-validator still strips id/name/base_url/vault_keys),
    // but keeping section provenance unforgeable costs almost nothing.
    const sanitizeBody = (text: string): string => text.replaceAll('=== Linked section:', '=== Linked-section-(escaped):');
    const linkedBlobs = fetchedSections
      .map(s => `\n\n=== Linked section: ${s.url} ===\n\n${sanitizeBody(s.text)}`)
      .join('');
    const result = await callForStructuredJson<DocsExtracted>({
      system: DOCS_EXTRACT_SYSTEM,
      user: `Docs URL: ${docsUrl}\n\n---\n\n${sanitizeBody(docsText)}${linkedBlobs}`,
      schema: DOCS_EXTRACT_SCHEMA,
      budgetUsd: DOCS_EXTRACT_BUDGET_USD,
      // Inherit the parent agent's provider snapshot so a Mistral / OpenAI
      // user's docs-bootstrap call hits the same endpoint they configured
      // (avoids the stale-global `_activeProvider` + ANTHROPIC_API_KEY
      // leak path in `createLLMClient()` — see PR #568 for the analogous
      // spawn.ts fix).
      agent,
      // Honour the operator model blocklist: without this a managed trial that
      // blocks premium Anthropic ids would still run the Sonnet default here on
      // the CP pool key. Note what this does NOT say: the fast-tier fallback
      // happens only when the blocklist rejects the resolved id. With no
      // blocklist — the ordinary case — this extraction runs
      // `MODEL_MAP.balanced`. An earlier version of this comment read as though
      // fast were the norm, and that reading survived into the billing label
      // one line below (see `result.tier`).
      ...(agent.toolContext.userConfig?.blocked_model_ids !== undefined
        ? { blockedModelIds: agent.toolContext.userConfig.blocked_model_ids }
        : {}),
    });
    extracted = result.data;
    costUsd = result.costUsd;
    // This pool-key extraction runs on a separate stream inside the (already
    // gated) tool run — account its spend to the local session cap + the tenant
    // balance so it isn't invisible to billing. No-op on self-host / BYOK.
    //
    // The tier comes from the helper, not from here. This call site used to pass
    // a literal `'fast'` while `callForStructuredJson` defaults to
    // `MODEL_MAP.balanced` — so a real customer's $0.3848 Sonnet extraction was
    // reported to the control plane as Haiku spend, and every per-tier breakdown
    // understated `balanced` by exactly the helper calls it could not see.
    debitInRunHelperCost(agent.toolContext.meteredHost, agent.sessionCounters, costUsd, result.tier);
  } catch (err: unknown) {
    if (err instanceof BudgetError) {
      return `Error: extraction budget exceeded (estimated $${err.estimatedCostUsd.toFixed(4)} > $${DOCS_EXTRACT_BUDGET_USD.toFixed(2)}). Try a smaller / more focused docs URL.`;
    }
    const msg = err instanceof Error ? err.message : String(err);
    return `Error: docs extraction failed — ${msg}`;
  }

  emitBootstrapProgress(agent, 'finalizing');
  const injectedFields = findInjectedFields(extracted);
  const draft = buildDraftFromExtraction(extracted, docsUrl, injectedFields);

  if (truncated) {
    draft.notes = [
      ...(draft.notes ?? []),
      `docs page exceeded ${String(DOCS_BODY_MAX_BYTES)} bytes and was truncated — verify rate limits and pricing manually before relying on this profile`,
    ];
  }

  // Surface same-domain alt-host candidates (api.foo.com vs docs.foo.com).
  // Cross-domain candidates are dropped in findApiHostCandidates to avoid
  // an attacker docs page steering vault auth at a foreign host.
  const apiHostCandidates = findApiHostCandidates(docsText, docsUrl);
  if (apiHostCandidates.length > 0) {
    draft.notes = [
      ...(draft.notes ?? []),
      `same-domain alt host(s) observed in docs: ${apiHostCandidates.join(', ')} — verify against authoritative source before swapping base_url`,
    ];
  }

  const summary = buildNlSummary(draft, docsUrl);
  const draftJson = JSON.stringify(draft, null, 2);
  const injectedNote = injectedFields.length > 0
    ? `\nSecurity note: dropped ${String(injectedFields.length)} field(s) the docs page tried to inject (${injectedFields.join(', ')}). base_url is always derived from the docs host, never extracted.`
    : '';
  const truncatedNote = truncated
    ? `\nDocs body was truncated at ${String(DOCS_BODY_MAX_BYTES)} bytes — verify rate limits and pricing before trusting this draft.`
    : '';
  const linkedNote = fetchedSections.length > 0
    ? `\nIncluded ${String(fetchedSections.length)} linked section(s): ${fetchedSections.map(s => s.url).join(', ')}`
    : '';
  const hostHintNote = apiHostCandidates.length > 0
    ? `\nbase_url note: docs host is ${new URL(docsUrl).hostname}; same-domain alt host(s) referenced in the body: ${apiHostCandidates.join(', ')}. Verify before swapping — these are observations from the docs page, not validated endpoints.`
    : '';

  return `Bootstrapped draft profile from ${docsUrl} (extraction cost $${costUsd.toFixed(4)}).

${summary}${injectedNote}${truncatedNote}${linkedNote}${hostHintNote}

DRAFT JSON (review, fill auth.vault_keys via ask_secret, then call action="create"):
\`\`\`json
${draftJson}
\`\`\`

Next steps:
1. Inspect the draft. Add or remove guidelines / avoid / notes based on what you learn from a test call.
2. Use \`ask_secret\` to collect credentials (a single secret name like ${draft.id.toUpperCase()}_API_KEY usually suffices; OAuth needs a refresh-token slot).
3. Fire one test \`http_request\` against the most innocent endpoint to confirm the auth scheme.
4. Call \`api_setup\` action="create" with the finished profile.`;
}

// ── Refine merge ─────────────────────────────────────────────────────────────

function applyRefine(existing: ApiProfile, patch: RefinePatch): ApiProfile {
  const merged: ApiProfile = { ...existing };

  if (patch.addGuidelines?.length) {
    merged.guidelines = [...(existing.guidelines ?? []), ...patch.addGuidelines];
  }
  if (patch.addAvoid?.length) {
    merged.avoid = [...(existing.avoid ?? []), ...patch.addAvoid];
  }
  if (patch.addNotes?.length) {
    merged.notes = [...(existing.notes ?? []), ...patch.addNotes];
  }
  if (patch.addEndpoints?.length) {
    const byKey = new Map<string, ApiEndpoint>();
    for (const ep of [...(existing.endpoints ?? []), ...patch.addEndpoints]) {
      byKey.set(`${ep.method.toUpperCase()} ${ep.path}`, ep);
    }
    merged.endpoints = [...byKey.values()];
  }
  if (patch.response_shape !== undefined) {
    merged.response_shape = patch.response_shape;
  }
  if (patch.rate_limit !== undefined) {
    merged.rate_limit = patch.rate_limit;
  }
  return merged;
}

/**
 * The tail of the delete message: what left the vault with the profile, and
 * what stayed — neither half silent. See `purgeRecordedTokens` for which is
 * which. The kept names are the user's call, so the text says to ask.
 */
function purgeMessage(purge: TokenPurge): string {
  const parts: string[] = [];
  if (purge.removed.length > 0) parts.push(` Removed the tokens its exchanges wrote: ${purge.removed.join(', ')}.`);
  if (purge.notRemovable.length > 0) parts.push(` Could NOT remove ${purge.notRemovable.join(', ')} — this vault has no working delete here.`);
  if (purge.kept.length > 0) parts.push(` Still in the vault: ${purge.kept.join(', ')}. The user or another profile may need them — ask the user before removing any.`);
  return parts.join('');
}

/**
 * Persist the engine-owned grant record — and, after a successful exchange, the
 * token expiry — onto the FRESHEST copy of the profile: an exchange takes
 * seconds, and saving the copy read before it would roll back a concurrent
 * update. A profile deleted meanwhile stays deleted: tool calls run
 * concurrently, and re-saving the copy read before the exchange would bring
 * back a profile the model was just told is gone. A failed or refused save is
 * swallowed on purpose. The vault already reflects the exchange and the request
 * budget is already charged; turning a completed exchange into a reported
 * failure would make the model mint again, while losing the record only returns
 * this path to the state it had before the record existed.
 *
 * Returns `'gone'` when the profile no longer exists, so a caller that just
 * wrote tokens for it can take them out again.
 */
function persistGrant(
  apiStore: ApiStore | null | undefined,
  id: string,
  apisDir: string,
  update: (current: OAuthGrantRecord | undefined) => OAuthGrantRecord,
  tokenExpiresAt?: number,
): 'saved' | 'gone' | 'not-saved' {
  if (!apiStore) return 'not-saved';
  const fresh = apiStore.get(id);
  if (!fresh) return 'gone';
  const next: ApiProfile = tokenExpiresAt === undefined
    ? { ...fresh }
    : { ...fresh, auth: { ...fresh.auth, oauth: { ...fresh.auth?.oauth, token_expires_at: tokenExpiresAt } } } as ApiProfile;
  next.oauth_grant = update(fresh.oauth_grant);
  try {
    return apiStore.save(next, apisDir).ok ? 'saved' : 'not-saved';
  } catch {
    // See the docstring: the exchange is complete either way.
    return 'not-saved';
  }
}

/**
 * The record's writes after an exchange: what it held, with each name this
 * exchange wrote replaced by the value it wrote now. A name keeps one entry —
 * the fingerprint of the latest value is the only one a delete may match. One
 * exchange never writes a name twice: its output name may not be a refresh slot.
 */
function mergeWrites(current: OAuthGrantRecord | undefined, writes: WrittenSecret[]): WrittenSecret[] {
  const rewritten = new Set(writes.map((w) => w.name));
  const kept = recordedWrites({ id: '', name: '', base_url: '', description: '', oauth_grant: current })
    .filter((w) => !rewritten.has(w.name));
  return [...kept, ...writes];
}

/**
 * Is a vault name filled? Asked through the same indirection `fetch_token`
 * uses, so the value never reaches the model or this function's caller — only
 * the yes or no does.
 */
function vaultHolds(agent: IAgent, name: string): boolean {
  const store = agent.secretStore;
  if (!store) return false;
  const probe = { _: `secret:${name}` };
  const probed = store.resolveSecretRefs(probe) as { _: string };
  return probed._ !== `secret:${name}`;
}

/**
 * The reply for an exchange that finished after its profile was deleted: the
 * delete already ran, so nothing is left to hold a record of what the exchange
 * wrote — it is taken out again now, where it can be, and the reply says what
 * was and what was not.
 */
function deletedMeanwhile(
  apiStore: ApiStore,
  profile: ApiProfile,
  writes: WrittenSecret[],
  secretStore: SecretStoreLike,
): string {
  const purge = purgeRecordedTokens(apiStore, { ...profile, oauth_grant: { written: writes } }, secretStore);
  return `Token exchange completed, but api_profile "${profile.id}" was deleted while it ran.${purgeMessage(purge)}`;
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const apiSetupTool: ToolEntry<ApiSetupInput> = {
  definition: {
    name: 'api_setup',
    description: 'Create, update, delete, list, view, bootstrap, refine, or fetch_token API profiles. Profiles teach you how to correctly use external APIs — endpoints, auth, rate limits, common mistakes, and response shaping.\n\nActions:\n- list / view: read profiles.\n- bootstrap: draft a profile from an OpenAPI spec (`openapi_url`) or a docs page (`docs_url`), then enrich it and call `create`.\n- create: pass a complete `profile` object.\n- refine: pass `id` + a `refine` patch (addGuidelines / addAvoid / addNotes / addEndpoints / response_shape / rate_limit) when a call teaches you something new.\n- delete: pass `id`.\n- connect: pass `id` for a link the USER clicks to authorize — show it INSTEAD of asking for a pasted token.\n- fetch_token: pass `id` to run the profile\'s OAuth grant and store the access_token — use INSTEAD of building the token POST by hand.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'update', 'delete', 'list', 'view', 'bootstrap', 'refine', 'fetch_token', 'connect'],
          description: 'Action to perform',
        },
        profile: {
          type: 'object',
          description: 'API profile data. Required: id (lowercase, alphanumeric), name, base_url, description. Optional: auth {type: none|basic|bearer|header|query|oauth2 (use "none" for public APIs like HN-Algolia or arXiv), basic_format: user_pass_split|pre_encoded_b64, username_key, password_key, header_name, query_param, vault_keys[]}, rate_limit, endpoints [{method, path, description}], guidelines [], avoid [], notes [], response_shape {kind, include, reduce, max_array_items, max_string_chars, max_chars}, concurrency {parallel_ok, max_in_flight, batchable_via_endpoint}, output_volume (small|medium|large|streaming), cost {model: per_call|per_token|per_unit, rate_usd, output_ratio}, provenance {source: openapi|docs_url|manual, source_url, validated_at, schema_version: 2}.',
        },
        id: {
          type: 'string',
          description: 'Profile ID (for delete/view/refine action).',
        },
        openapi_url: {
          type: 'string',
          description: 'OpenAPI 3.x JSON spec URL. Use this for bootstrap when an OpenAPI spec is available — most accurate path.',
        },
        docs_url: {
          type: 'string',
          description: 'Human-readable docs landing page URL. Use for bootstrap when the API has no OpenAPI spec. Gated behind feature flag `api-setup-v2`. Runs one Haiku extraction (≤ $0.05) to populate auth / rate_limit / concurrency / cost / output_volume from the page.',
        },
        refine: {
          type: 'object',
          description: 'Additive patch for refine action: {addGuidelines[], addAvoid[], addNotes[], addEndpoints[], response_shape, rate_limit}.',
        },
        output_secret_name: {
          type: 'string',
          description: 'For fetch_token action: vault key name to store the resulting access_token under. UPPER_SNAKE_CASE. Default: `${id.toUpperCase()}_ACCESS_TOKEN`.',
        },
      },
      required: ['action'],
    },
  },
  detailedGuidance:
    'connect: pass `id`. Returns a link; SHOW it to the user and let them click it. The engine builds the link and stores what comes back — never ask the user to paste a token for a profile that can connect, and never assemble the link yourself.\n' +
    'bootstrap: pass EITHER `openapi_url` (OpenAPI 3.x JSON spec, preferred when available) OR `docs_url` (human-readable docs landing page; gated behind `api-setup-v2` flag; runs a single Haiku extraction to populate v2 fields including concurrency / cost / output_volume). It returns a DRAFT profile — enrich it with extra guidelines/avoid/response_shape from reading the docs, then call `create`.\n' +
    'fetch_token: drives the OAuth client_credentials (or refresh_token) grant using the profile\'s `auth.oauth` metadata — resolves client_id / client_secret from the vault, POSTs to `token_url`, stores the resulting access_token in the vault as `${id.toUpperCase()}_ACCESS_TOKEN`. AFTER fetch_token: every http_request to this profile\'s hostname gets `Authorization: Bearer …` auto-attached by the engine — do NOT set the Authorization header yourself and do NOT reference `secret:<id>_ACCESS_TOKEN` manually. Just call http_request with URL + body; auth is handled.' +
    ' basic + basic_format="user_pass_split": name the two vault keys in `username_key` and `password_key` (or list them in `vault_keys`, username first). The ENGINE combines and Base64-encodes them onto every http_request to this host — do NOT set an Authorization header and do NOT try to encode anything; you never hold the plaintext, only `secret:` references, so you cannot. Use `pre_encoded_b64` only when the credential genuinely arrives already Base64-encoded.' +
    ' bearer / header: name the vault key holding the token in `vault_keys` (first entry; for `header` also set `header_name`, default X-Api-Key). The ENGINE attaches it to every http_request to this host — do NOT set the header yourself and do NOT pass `secret:NAME` in one. Hand-setting it is not merely redundant: the value resolves before the egress scanner runs, so a token shaped like a known credential (a JWT, `ghp_…`, `sk-…`) gets the request blocked as exfiltration. Store the value with ask_secret, then just call http_request.',
  handler: async (input: ApiSetupInput, agent: IAgent): Promise<string> => {
    const apisDir = getApisDir();

    if (input.action === 'list') {
      const apiStore = agent.toolContext?.apiStore;
      if (!apiStore || apiStore.size === 0) {
        return 'No API profiles registered. Use action "bootstrap" with an OpenAPI URL, or "create" with a profile object.';
      }
      const profiles = apiStore.getAll();
      const lines = profiles.map(p => {
        const limits: string[] = [];
        if (p.rate_limit?.requests_per_second) limits.push(`${String(p.rate_limit.requests_per_second)}/s`);
        if (p.rate_limit?.requests_per_minute) limits.push(`${String(p.rate_limit.requests_per_minute)}/min`);
        const limitStr = limits.length > 0 ? ` [${limits.join(', ')}]` : '';
        const shapeStr = p.response_shape && p.response_shape.kind !== 'passthrough' ? ' {shape}' : '';
        return `- ${p.id}: ${p.name} (${p.base_url})${limitStr}${shapeStr}`;
      });
      return `Registered APIs (${String(profiles.length)}):\n${lines.join('\n')}`;
    }

    if (input.action === 'view') {
      if (!input.id) {
        return 'Error: "id" is required for view action.';
      }
      const apiStore = agent.toolContext?.apiStore;
      if (!apiStore) {
        return 'No API profiles registered.';
      }
      const profile = apiStore.get(input.id);
      if (!profile) {
        return `API profile "${input.id}" not found. Use action "list" to see available profiles.`;
      }
      return apiStore.formatProfile(profile);
    }

    if (input.action === 'bootstrap') {
      if (input.docs_url) {
        return bootstrapFromDocs(input.docs_url, agent);
      }
      if (!input.openapi_url) {
        return 'Error: bootstrap requires either "openapi_url" (OpenAPI 3.x JSON spec, preferred) or "docs_url" (human-readable docs page; gated behind feature flag `api-setup-v2`). If neither is available, read the docs via web_research and build a profile manually with action "create".';
      }
      let spec: OpenApiDoc;
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => { ac.abort(); }, OPENAPI_FETCH_TIMEOUT_MS);
        let resp: Response;
        try {
          ({ response: resp } = await fetchWithValidatedRedirects(input.openapi_url, { signal: ac.signal }, { surface: 'discovery' }, agent.toolContext));
          // Charge OpenAPI bootstrap fetches against the session budget too.
          agent.sessionCounters.httpRequests++;
        } finally {
          clearTimeout(timer);
        }
        if (!resp.ok) {
          // Same server-controlled reason phrase as the docs-page path above —
          // dropped for the same reason (scan-exempt tool, verbatim echo).
          return `Error: failed to fetch OpenAPI spec (HTTP ${String(resp.status)}). Check the URL or pass a direct link to the JSON spec.`;
        }
        const { text, truncated } = await readBodyLimited(resp, OPENAPI_SPEC_MAX_BYTES);
        if (truncated) {
          // Common offender: GitHub's full OpenAPI spec (~13 MB) — too large to
          // parse here, but the human-readable docs path works fine. Steer the
          // agent to docs_url + manual refinement rather than "split the API".
          return `Error: OpenAPI spec body exceeds ${String(OPENAPI_SPEC_MAX_BYTES)} bytes. Try one of:\n  1. Re-run \`api_setup\` action="bootstrap" with \`docs_url\` pointing at the human-readable docs landing page — the helper LLM extracts a v2 profile from prose.\n  2. Use \`api_setup\` action="create" with a hand-written profile covering only the endpoints you need.`;
        }
        spec = JSON.parse(text) as OpenApiDoc;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Error: could not parse OpenAPI spec from ${input.openapi_url} — ${msg}. If the docs site serves HTML, find the raw .json spec URL (often at /openapi.json or /swagger.json).`;
      }

      // `typeof` guard, not just truthiness: a remote spec of `{"openapi": 3}` is
      // truthy but has no `.startsWith`, so the version check threw a TypeError
      // PAST this handler's try/catch (it closes above) and the agent got a stack
      // shape instead of the guidance below. A misconfigured server produces that
      // without any malice. The echoed value is bounded for the same reason the
      // reason phrase was dropped — it is remote-authored text.
      // Guard `spec` itself, not just its field: `JSON.parse('null')` is null and
      // `JSON.parse('"hi"')` is a string, so a 200 with either body dereferenced
      // null/undefined here — PAST this handler's try/catch, which closes above.
      // That route matters beyond ergonomics: the dispatcher's catch path returns
      // `cause.message` WITHOUT `scanToolResult`, so a throw is the one way out of
      // this tool that the scan does not see. A misconfigured server produces it
      // with no malice.
      if (typeof spec !== 'object' || spec === null || typeof spec.openapi !== 'string') {
        return `Error: spec has no string "openapi" version field. This bootstrapper expects OpenAPI 3.x. Swagger 2.0 specs need conversion first, or build the profile manually via "create".`;
      }
      if (!spec.openapi.startsWith('3.')) {
        // Render the real value (bounded) — reporting `typeof` would tell the agent
        // the server declared a version of "number", and send it looking for a field
        // that says no such thing.
        return `Error: unsupported spec version (openapi: "${spec.openapi.slice(0, 40)}"). This bootstrapper expects OpenAPI 3.x. Swagger 2.0 specs need conversion first, or build the profile manually via "create".`;
      }

      let draft: ApiProfile;
      try {
        draft = parseOpenApi(spec, slugify(input.openapi_url));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Error: OpenAPI spec valid but profile could not be derived — ${msg}`;
      }

      // Return draft as a fenced JSON block the agent can copy into `create`.
      const draftJson = JSON.stringify(draft, null, 2);
      const endpointCount = draft.endpoints?.length ?? 0;
      return `Bootstrapped draft profile for "${draft.name}" from ${input.openapi_url}:

- id: ${draft.id}
- base_url: ${draft.base_url}
- auth: ${draft.auth ? draft.auth.type : '(none detected — check docs)'}
- endpoints: ${String(endpointCount)}

DRAFT JSON (review, enrich with guidelines/avoid/response_shape, then call action="create"):
\`\`\`json
${draftJson}
\`\`\`

Next steps before calling create:
1. Read a few endpoint docs and add 3-6 \`guidelines\` (correct methods, required params, pagination rules).
2. Add 2-4 \`avoid\` entries for common mistakes (wrong auth scheme, rate-limit pitfalls, deprecated endpoints).
3. Add a \`response_shape\` if responses are verbose. Typical pattern for paginated list APIs: \`{kind:"reduce", max_array_items: 5, max_string_chars: 500, reduce: {"<array_path>": "count"}}\`. For time-series: reduce to \`"avg+peak"\`.
4. Fill in \`rate_limit\` if documented.
5. Call \`api_setup\` action="create" with the completed profile.`;
    }

    if (input.action === 'refine') {
      if (!input.id) return 'Error: "id" is required for refine action.';
      if (!input.refine) return 'Error: "refine" patch is required for refine action.';
      const apiStore = agent.toolContext?.apiStore;
      if (!apiStore) return 'No API profiles registered.';
      const existing = apiStore.get(input.id);
      if (!existing) return `API profile "${input.id}" not found.`;

      if (input.refine.response_shape) {
        const shapeErr = validateShape(input.refine.response_shape);
        if (shapeErr) return `Validation error: ${shapeErr}`;
      }

      const merged = applyRefine(existing, input.refine);
      const err = validateProfile(merged);
      if (err) return `Validation error after refine: ${err}`;

      // Persist + register (S4b: engine.db `connections` when wired, else flat JSON).
      const mergedSave = apiStore.save(merged, apisDir);
      if (!mergedSave.ok) return `Error: ${mergedSave.reason}`;

      const changed: string[] = [];
      if (input.refine.addGuidelines?.length) changed.push(`+${String(input.refine.addGuidelines.length)} guidelines`);
      if (input.refine.addAvoid?.length) changed.push(`+${String(input.refine.addAvoid.length)} avoid`);
      if (input.refine.addNotes?.length) changed.push(`+${String(input.refine.addNotes.length)} notes`);
      if (input.refine.addEndpoints?.length) changed.push(`+${String(input.refine.addEndpoints.length)} endpoints`);
      if (input.refine.response_shape) changed.push('response_shape updated');
      if (input.refine.rate_limit) changed.push('rate_limit updated');
      return `Refined profile "${merged.id}": ${changed.length > 0 ? changed.join(', ') : 'no changes'}. Saved.`;
    }

    if (input.action === 'create' || input.action === 'update') {
      if (!input.profile) {
        return 'Error: "profile" object is required for create/update action.';
      }

      // Shallow-copy the input: the ack-stamping below assigns/strips the
      // top-level `custom_endpoint_ack` field, and mutating the caller's object
      // in place is a surprising side effect (it also leaks a stamped ack back
      // onto a reused profile reference). A shallow copy suffices — we only ever
      // replace the whole top-level field, never mutate a nested value.
      const profile = { ...input.profile };
      const error = validateProfile(profile);
      if (error) {
        return `Validation error: ${error}`;
      }

      // Wave 5d BYOK liability gate: a profile pointed at a host outside
      // lynox's vetted sub-processor list cannot be saved without explicit
      // user acceptance. This must cover EVERY host the profile can drive a
      // credentialed request to — not just base_url (http_request) but also the
      // OAuth token_url, because fetch_token POSTs the vault client_secret
      // there. Gating base_url alone let a profile pair an allowlisted base_url
      // with an arbitrary token_url and egress the client_secret past the
      // allowlist. validateProfile() has already verified base_url and (for
      // oauth2 profiles) token_url parse as URLs, so isVettedEgressHost()
      // returns false here only for genuinely non-vetted hosts.
      const egressUrls: string[] = [profile.base_url];
      if (profile.auth?.type === 'oauth2' && profile.auth.oauth?.token_url) {
        egressUrls.push(profile.auth.oauth.token_url);
      }
      // A preset profile authorizes at a host nobody typed into it — the register
      // derives it — so without this the disclosure would name `base_url` and the
      // connect route would then ask for an acceptance of a host the save never
      // offered. That refusal's advice ("save it again and accept") would be
      // unfollowable, which is the exact shape the comment below remembers from
      // the `*.openai.azure.com` incident.
      // And when it CANNOT be derived, that is said rather than skipped. The
      // first version dropped the host silently on any derivation failure, which
      // made the completeness of a security disclosure depend on whether an
      // unrelated parameter happened to validate — with no trace in either
      // direction. Refusing the save instead was the other candidate and is
      // worse: a provider retired from the register would make every profile
      // naming it unsaveable, including the update that would remove the field.
      let presetNote: string | undefined;
      const redirectUrls: string[] = [];
      if (profile.auth?.type === 'oauth2' && profile.auth.oauth?.preset_id) {
        const presetId = profile.auth.oauth.preset_id;
        const derived = derivePresetEndpoints(presetId, profile.auth.oauth.preset_params);
        if (!('kind' in derived)) {
          egressUrls.push(derived.authorizeUrl, derived.tokenUrl);
          // …and the SAME host again, on its own list, because a second act is
          // being asked about. The token exchange sends data there, which is the
          // egress question; the connect link sends the USER there, which is
          // not. One host, two consents, and they are stamped separately —
          // see `CustomEndpointAck.redirect_hosts`.
          redirectUrls.push(derived.authorizeUrl);
        } else if (derived.kind === 'unknown-preset') {
          // The id is NOT repeated back here, and that is the one place in this
          // note where the omission is deliberate: `auth.oauth.preset_id` is a
          // model-authored field, tool input passes through the secret resolver
          // before this handler runs, and a resolved value that happens to look
          // like a provider id would be echoed into the model's context and into
          // a human's prompt. When the id IS known the two arms below do name it
          // — that string equals one of ours, so it discloses nothing.
          const known = presetIds();
          presetNote = known.length > 0
            ? `No authorization address could be derived: this profile names a provider this engine does not have built in, so there is nothing here to disclose or accept. It knows: ${known.join(', ')}.`
            : 'No authorization address could be derived: this engine has no built-in providers yet, so there is nothing here to disclose or accept.';
        } else if (derived.kind === 'bad-preset') {
          presetNote = `No authorization address could be derived: the built-in provider "${presetId}" is defined wrongly in this engine — ${derived.detail}. Nothing on this profile fixes that; report it.`;
        } else if (derived.kind === 'missing-param') {
          presetNote = `No authorization address could be derived: the provider "${presetId}" needs ${derived.param.describe} (auth.oauth.preset_params.${derived.param.name}), which this profile does not supply. Set it with api_setup update — the host is disclosed then.`;
        } else {
          // Supplied and REFUSED, which is a different sentence: telling someone
          // to set a value they already set is the advice that sends them round
          // a loop. The value itself is not repeated back.
          presetNote = `No authorization address could be derived: the value this profile supplies for ${derived.param.describe} (auth.oauth.preset_params.${derived.param.name}) is not one the provider "${presetId}" accepts. Correct it with api_setup update — the host is disclosed then.`;
        }
      }
      // isVettedEgressHost, not isAllowlistedEndpoint: the credential attach in
      // http.ts asks the same function, and the two MUST agree. While this asked the
      // broader one, an `*.openai.azure.com` profile saved with no prompt and no ack,
      // and the attach then refused it with advice ("re-save and accept when
      // prompted") that could never be followed — the prompt was unreachable and the
      // else-branch below deleted any ack that did exist.
      const nonVetted = egressUrls.filter((u) => !isVettedEgressHost(u));
      // Two questions, one prompt, and the redirect half is asked even when the
      // host IS vetted. That is not thoroughness: it is what keeps the refusal
      // at connect time followable. If this only ran for non-vetted hosts, a
      // preset pointing at a vetted one would save with no prompt, the redirect
      // would refuse for want of an acceptance, and its advice — save again and
      // accept — would point at a prompt that never appears. That dead end is
      // the one this file already carries a scar from.
      if (nonVetted.length > 0 || redirectUrls.length > 0) {
        // Controller-responsibility acceptance MUST be a real OUT-OF-BAND human
        // confirmation — NEVER an agent-supplied tool argument. A prompt-injected
        // agent (malicious mail/page/doc) that could self-approve would repoint an
        // existing oauth2 profile's base_url at an attacker host, accept, and then
        // exfiltrate the managed access_token via a later http_request (the token
        // auto-attaches by hostname). So we ask the human out-of-band via
        // `promptUser` (PromptStore ask_user) — the agent cannot supply this
        // answer — and fail CLOSED when no interactive prompt exists. Disclose
        // EVERY non-vetted egress host so the single accept is informed.
        // Each act gets its own sentence. The egress half says what the ENGINE
        // will send and where; the redirect half says what will happen to the
        // PERSON reading it. A consent whose text does not describe the act is
        // not a consent for that act, and for a while this text described only
        // the first one while the second was being authorized by it.
        const redirectHostNames = Array.from(new Set(
          redirectUrls
            .map((u) => { try { return new URL(u).hostname; } catch { return null; } })
            .filter((h): h is string => h !== null),
        ));
        const disclosureParts = [
          nonVetted.length > 0
            ? `This engine will send data${profile.auth?.type === 'oauth2' ? ' — and, for its OAuth token, the managed access_token —' : ''} to host(s) outside lynox's listed sub-processors:\n\n${nonVetted.map((u) => describeDisclosure(u)).join('\n\n')}`
            : undefined,
          redirectHostNames.length > 0
            ? `You will be sent to ${redirectHostNames.join(' and ')} in your own browser to authorize this profile. You sign in there, to that provider — not to lynox — and what comes back is stored here for this profile.`
            : undefined,
          presetNote,
        ].filter((part): part is string => part !== undefined && part !== '');
        const disclosure = disclosureParts.join('\n\n');
        if (!agent.promptUser) {
          return `Blocked: profile "${profile.id}" needs an explicit human acceptance before it can be saved, and no interactive prompt is available (autonomous/background mode).\n\n${disclosure}`;
        }
        const answer = await agent.promptUser(
          pv`⚠ api_setup: saving "${profile.name}" needs your acceptance.\n\n${disclosure}\n\nAccept and save this profile?`,
          ['Allow', 'Deny', '\x00'],
        );
        if (!['y', 'yes', 'allow'].includes(answer.toLowerCase())) {
          return `Blocked: profile "${profile.id}" not saved — user declined.`;
        }
      }

      // Persist the acceptance onto the profile so the RUNTIME egress paths
      // (fetch_token, http_request OAuth2 attach) can re-verify it fail-closed
      // after a reload/migration — where the transient in-run confirmation is
      // long gone. Set server-side ONLY; an ack carried in the incoming
      // `profile` object is never trusted (that would forge the gate), so we
      // overwrite it unconditionally here. Bound to the specific hosts so a
      // later `token_url`/`base_url` swap to a different non-vetted host does
      // not inherit this ack — it re-gates.
      if (nonVetted.length > 0 || redirectUrls.length > 0) {
        // Reachable only after the human accepted above (else returned).
        const hostsOf = (urls: readonly string[]): string[] => Array.from(new Set(
          urls
            .map((u) => { try { return new URL(u).hostname; } catch { return null; } })
            .filter((h): h is string => h !== null),
        ));
        // Two lists from two sources, never one list used twice. `hosts` still
        // answers only the data question, so nothing that reads it starts
        // meaning something wider; `redirect_hosts` is fed from the derived
        // authorize URL alone, so an acceptance earned by a `base_url` cannot
        // authorize a redirect even when the two hostnames coincide.
        const redirectHosts = hostsOf(redirectUrls);
        profile.custom_endpoint_ack = {
          accepted: true,
          hosts: hostsOf(nonVetted),
          ...(redirectHosts.length > 0 ? { redirect_hosts: redirectHosts } : {}),
          accepted_at: new Date().toISOString(),
        };
      } else {
        // Every egress host is vetted — no ack should ride along; strip a forged one.
        delete profile.custom_endpoint_ack;
      }

      // The grant record is the engine's, never the caller's — the same rule as the
      // ack above. A create/update able to write it could clear a revocation or
      // forge the client stamp. Whatever arrived is dropped and the stored record
      // rides along unchanged, so a view → edit → update round trip neither trips
      // over it nor erases it. Discarding rather than refusing is deliberate: the
      // round trip would otherwise fail every time the model echoes the field back.
      const storedGrant = agent.toolContext?.apiStore?.get(profile.id)?.oauth_grant;
      // Said in the reply when it mattered: a model that "cleared" a revocation by
      // echoing an edited record must not read a plain success and pass that on.
      const grantDiscarded = input.profile.oauth_grant !== undefined
        && JSON.stringify(input.profile.oauth_grant) !== JSON.stringify(storedGrant);
      if (storedGrant) profile.oauth_grant = storedGrant;
      else delete profile.oauth_grant;

      // Enforce research: warn if profile is too thin
      const warnings: string[] = [];
      if (!profile.endpoints || profile.endpoints.length === 0) {
        warnings.push('No endpoints listed — bootstrap from an OpenAPI URL or research the docs (web_research) and add key endpoints.');
      }
      if (!profile.guidelines || profile.guidelines.length === 0) {
        warnings.push('No guidelines — add best practices (correct HTTP methods, required headers, pagination, etc.).');
      }
      if (!profile.avoid || profile.avoid.length === 0) {
        warnings.push('No "avoid" rules — add common mistakes to prevent (wrong methods, missing params, rate limit pitfalls).');
      }
      if (!profile.auth) {
        warnings.push('No auth method specified — set `auth.type` to "none" if the API is intentionally public (HN-Algolia, arXiv, public stats APIs), otherwise specify "basic" / "bearer" / "header" / "query" / "oauth2".');
      }
      if (warnings.length > 0) {
        return `Profile is incomplete — research the API docs before creating:\n\n${warnings.map(w => `- ${w}`).join('\n')}\n\nTip: use action="bootstrap" with an OpenAPI URL to auto-derive endpoints + auth.`;
      }

      // Persist + register (S4b: engine.db `connections` when wired, else flat JSON).
      const apiStore = agent.toolContext?.apiStore;
      if (!apiStore) {
        return 'Error: API store unavailable — cannot persist the profile. Restart the engine and retry.';
      }
      const saved = apiStore.save(profile, apisDir);
      // A refusal used to arrive here as `isNew`, so the tool answered "Created
      // … saved and activated immediately" for a profile that was never stored.
      // Fail-closed in effect, false-confident in report — and the only trace was
      // a stderr line no model ever reads.
      if (!saved.ok) return `Error: ${saved.reason}`;
      const isUpdate = !saved.isNew;

      const verb = isUpdate ? 'Updated' : 'Created';
      const parts: string[] = [
        `${verb} API profile "${profile.name}" (${profile.id}).`,
        `Base URL: ${profile.base_url}`,
      ];
      if (profile.auth) parts.push(`Auth: ${profile.auth.type}`);
      if (profile.rate_limit) {
        const rl: string[] = [];
        if (profile.rate_limit.requests_per_second) rl.push(`${String(profile.rate_limit.requests_per_second)}/s`);
        if (profile.rate_limit.requests_per_minute) rl.push(`${String(profile.rate_limit.requests_per_minute)}/min`);
        if (profile.rate_limit.requests_per_hour) rl.push(`${String(profile.rate_limit.requests_per_hour)}/h`);
        if (profile.rate_limit.requests_per_day) rl.push(`${String(profile.rate_limit.requests_per_day)}/day`);
        if (rl.length > 0) parts.push(`Rate limits: ${rl.join(', ')}`);
      }
      if (profile.endpoints) parts.push(`Endpoints: ${String(profile.endpoints.length)}`);
      if (profile.guidelines) parts.push(`Guidelines: ${String(profile.guidelines.length)}`);
      if (profile.avoid) parts.push(`Avoid rules: ${String(profile.avoid.length)}`);
      if (profile.response_shape && profile.response_shape.kind !== 'passthrough') {
        parts.push('Response shape: active');
      }
      parts.push('Profile saved and activated immediately.');
      if (grantDiscarded) {
        parts.push('The oauth_grant sent with this call was ignored: the engine keeps that record itself, and it is unchanged.');
      }
      // Said here as well, because the disclosure above only runs when some host
      // was non-vetted. A profile whose base_url is vetted saves with no prompt
      // at all, and that is the case where the missing authorize host would
      // otherwise leave no trace anywhere.
      if (presetNote) parts.push(presetNote);
      parts.push('Next steps: use ask_secret to securely collect API credentials if needed, then test with a simple http_request.');
      return parts.join('\n');
    }

    if (input.action === 'connect') {
      const id = input.id ?? input.profile?.id;
      if (!id) return 'Error: "id" is required for connect action.';
      const apiStore = agent.toolContext?.apiStore;
      if (!apiStore) return 'Error: API store unavailable — cannot build a connect link. Restart the engine and retry.';
      const profile = apiStore.get(id);
      if (!profile) return `Error: API profile "${id}" not found. Create it first with action=create.`;
      if (profile.auth?.type !== 'oauth2') {
        return `Error: profile "${id}" has auth.type="${profile.auth?.type ?? 'none'}", not "oauth2". Connecting sends the user to a provider to authorize; a profile that carries a static credential does not need it.`;
      }
      // The link is built from the server's own origin, never assembled by the
      // model: a link the model writes is a link the model chooses. Without an
      // HTTP server there is nothing to send the user to.
      // ORIGIN is the engine's public address, not a sign that the server is up:
      // the env registry makes it required on every tier and the installer writes
      // it unconditionally. So its ABSENCE is what this can answer — that there is
      // no address to bring the user back to. Whether the route answers is the
      // route's own business, and W1b gives it a check of its own.
      const origin = process.env['ORIGIN'];
      if (!origin) {
        return 'Error: this engine has no public address configured (ORIGIN), so there is nowhere to send the user back to. Set it, or collect the credentials with ask_secret and use action=fetch_token.';
      }
      // Parsed, not merely found. The provider host below is parsed, compared for
      // identity and checked for userinfo; the host the user is sent to FIRST had
      // a presence test and one stripped trailing slash. It is operator input
      // rather than model input, which is why the answer is a refusal and not a
      // repair — a link a person is told to click is the wrong place to guess
      // what a malformed address meant.
      //
      // None of these refusals echo the value. A misconfigured ORIGIN can hold
      // anything somebody pasted, including a credential, and this string goes
      // into the model's context.
      let base: URL;
      try {
        base = new URL(origin);
      } catch {
        return 'Error: ORIGIN is not a valid address, so no link can be built from it. Set it to this engine\'s full public address including the scheme, e.g. https://lynox.example.com.';
      }
      // The same three questions the redirect guard asks, and deliberately the
      // same three: this message says "inside the operator's own network", and
      // while it checked only loopback and numeric private ranges it refused
      // `http://nas.local:3000` — an ordinary self-hosted address that this
      // repo's own predicate, two imports away, calls private. A feature with
      // two definitions of one phrase has the ending the redirect guard's own
      // docstring describes.
      const originHost = base.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
      const originIsInsideNetwork = originHost === 'localhost'
        || isPrivateIP(originHost)
        || isPrivateLanEndpoint(`https://${base.hostname.replace(/\.$/, '')}/`);
      if (base.protocol !== 'https:' && !(base.protocol === 'http:' && originIsInsideNetwork)) {
        return 'Error: ORIGIN must be an https address. The provider sends the authorization back to it, and plain http exposes that in transit; http is accepted only for an address inside the operator\'s own network.';
      }
      if (base.username !== '' || base.password !== '') {
        return 'Error: ORIGIN carries a username or password in the address. Remove it — this address is shown to the user and handed to the provider.';
      }
      if (base.search !== '' || base.hash !== '') {
        return 'Error: ORIGIN carries a query or a fragment. Set it to the bare public address of this engine — scheme, host, port, and a path prefix only if it is served under one.';
      }
      // Derived here only to answer BEFORE sending the user anywhere; the route
      // derives again at use, and that derivation is the boundary.
      const endpoints = derivePresetEndpoints(profile.auth.oauth?.preset_id ?? '', profile.auth.oauth?.preset_params);
      if ('kind' in endpoints) {
        const ids = presetIds();
        const known = ids.length > 0 ? `Known providers: ${ids.join(', ')}.` : 'No providers are built in yet, so nothing can be connected this way today.';
        if (endpoints.kind === 'unknown-preset') {
          return `Error: profile "${id}" names no built-in provider, so there is no authorization page to send the user to. ${known} Set auth.oauth.preset_id with api_setup update, or keep using a credential the user pastes with ask_secret.`;
        }
        if (endpoints.kind === 'bad-preset') {
          // A defect in a compiled preset. Neither the model nor the user can
          // fix it, so neither is told to try.
          return `Error: the built-in provider profile "${id}" names is defined wrongly in this engine — ${endpoints.detail}. There is nothing to set on the profile; collect the credentials with ask_secret and use action=fetch_token, and report the provider as broken.`;
        }
        if (endpoints.kind === 'missing-param') {
          return `Error: profile "${id}" is missing what its provider needs: ${endpoints.param.describe} (auth.oauth.preset_params.${endpoints.param.name}). Ask the user for it and set it with api_setup update.`;
        }
        return `Error: the value profile "${id}" supplies for ${endpoints.param.describe} (auth.oauth.preset_params.${endpoints.param.name}) is not one its provider accepts. Ask the user to correct it and set it with api_setup update.`;
      }
      // The same question the start route asks, from the same function — so a
      // link is not handed out that the route will then refuse. While only the
      // route asked it, the model was told to show a link and the user arrived
      // at a 403, which is the dead end this feature keeps re-learning.
      const redirect = checkRedirectTarget(endpoints, profile.custom_endpoint_ack);
      if (redirect) {
        return redirect.kind === 'inside-network'
          ? `Error: profile "${id}" would send the user to ${endpoints.host}, which is inside this engine's own network. That is not the provider, and there is no acceptance that would make it one — the profile has to name a built-in provider.`
          : `Error: nobody has agreed to be sent to ${endpoints.host} for profile "${id}" yet, and this link would be refused. Save the profile again with api_setup update and let the user accept where they will be sent, then connect.`;
      }
      const clientIdKey = profile.auth.oauth?.client_id_key;
      const clientSecretKey = profile.auth.oauth?.client_secret_key;
      // Only what is missing, because a reply that names a filled slot sends the
      // model to collect a value the user already gave — and the user then has to
      // decide which half of the sentence is about them.
      const unnamed = [!clientIdKey ? 'auth.oauth.client_id_key' : null, !clientSecretKey ? 'auth.oauth.client_secret_key' : null].filter((n): n is string => n !== null);
      const unfilled = [clientIdKey, clientSecretKey].filter((k): k is string => typeof k === 'string' && !vaultHolds(agent, k));
      if (unnamed.length > 0 || unfilled.length > 0) {
        if (unnamed.length > 0) {
          return `Error: profile "${id}" cannot authorize yet — it does not name ${unnamed.join(' or ')}. Set the vault key name(s) with api_setup update, then collect the value with ask_secret.`;
        }
        return `Error: profile "${id}" cannot authorize yet — the vault has no value for ${unfilled.join(' and ')}. Call ask_secret for ${unfilled.length === 1 ? 'it' : 'each'}, then connect.`;
      }
      // Built from the parsed object, never by string surgery on the raw value.
      // The path prefix is kept deliberately: an engine served under one needs
      // it, and `origin` alone would silently produce a link to nothing.
      const link = `${base.origin}${base.pathname.replace(/\/+$/, '')}/api/oauth/connect/${encodeURIComponent(id)}`;
      const grant = profile.oauth_grant;
      // Three replies, one link. What differs is what the user is walking into,
      // and saying it here is cheaper than a surprise on the provider's page.
      if (grant?.state === 'revoked') {
        return `The provider ended this authorization, so "${id}" has to be authorized again. Show the user this link and let them click it: ${link}\n\nThe old access is gone either way; connecting again is what brings it back.`;
      }
      if (grant?.origin === 'callback' && (grant.state === 'connected' || grant.state === 'no-refresh')) {
        return `"${id}" is already connected. Show the user this link only if they want to authorize again: ${link}\n\nA new authorization replaces the stored token, so anything running against the old one stops working the moment it is used.`;
      }
      return `Show the user this link and let them click it: ${link}\n\nIt opens ${endpoints.host}, where they authorize this engine. They come back to this instance, and the connection is stored for you — do not ask them to paste a token, and do not build this link yourself.`;
    }

    if (input.action === 'delete') {
      const id = input.id ?? input.profile?.id;
      if (!id) {
        return 'Error: "id" is required for delete action.';
      }
      const apiStore = agent.toolContext?.apiStore;
      if (!apiStore) {
        return 'Error: API store unavailable — cannot delete the profile. Restart the engine and retry.';
      }
      // Read before the delete: what the vault holds for this profile is decided
      // by the profile, and afterwards there is no profile to ask.
      const existing = apiStore.get(id);
      // Delete from the backing store + memory (S4b: engine.db `connections` when
      // wired, else the flat-JSON directory). The agent sees the deletion
      // immediately; the inbound `triggers.source_connection_id` FK nulls out.
      let removed: boolean;
      try {
        removed = apiStore.remove(id, apisDir);
      } catch (err) {
        // remove() throws ApiProfileUnlinkError only on the flat-JSON fallback
        // when a non-ENOENT unlink fails — the profile is already gone from
        // memory. Surface it so the agent doesn't retry blindly. The tokens stay:
        // a profile that resurrects on restart should come back working.
        return `Error: deleted "${id}" from memory but on-disk file removal failed (${err instanceof Error ? err.message : String(err)}). Restart may resurrect the profile.`;
      }
      if (!removed) return `API profile "${id}" not found.`;
      // Only for a profile that was REGISTERED. `remove` also succeeds for a row
      // that sat in the store unregistered — the boot refuses the second of a
      // `-`/`_` pair — and a record read from such a row is not one this
      // process's exchanges wrote.
      if (!existing) return `Deleted API profile "${id}".`;
      if (!agent.secretStore) return `Deleted API profile "${id}". No vault is available here, so no token was checked or removed.`;
      return `Deleted API profile "${id}".${purgeMessage(purgeRecordedTokens(apiStore, existing, agent.secretStore))}`;
    }

    if (input.action === 'fetch_token') {
      if (!input.id) return 'Error: "id" is required for fetch_token action.';
      const apiStore = agent.toolContext?.apiStore;
      const profile = apiStore?.get(input.id);
      if (!profile) return `Error: API profile "${input.id}" not found. Create it first with action=create.`;
      if (profile.auth?.type !== 'oauth2') {
        return `Error: profile "${input.id}" has auth.type="${profile.auth?.type ?? 'none'}", not "oauth2". fetch_token only applies to oauth2 profiles. If you need OAuth here, update the profile's auth to type="oauth2" with the oauth metadata block.`;
      }
      const oauth = profile.auth.oauth;
      if (!oauth?.token_url) {
        return `Error: profile "${input.id}" auth.oauth is missing token_url. Update the profile with the OAuth token endpoint (e.g. https://<shop>.myshopify.com/admin/oauth/access_token).`;
      }
      // Wave 5d runtime egress gate. fetch_token POSTs the vault client_secret
      // to token_url. The save-time allowlist gate covers profiles created via
      // this tool, but a profile can re-enter the store WITHOUT passing it —
      // loadFromDirectory at boot, or a JSON written into the apis dir — so
      // re-verify here fail-closed: a non-vetted token_url is refused unless
      // the profile carries a persisted acceptance covering that exact host.
      // Refuse BEFORE resolving any vault secret so nothing leaks on the way out.
      if (!isVettedEgressHost(oauth.token_url) && !isEndpointAcked(profile.custom_endpoint_ack, oauth.token_url)) {
        let host = oauth.token_url;
        try { host = new URL(oauth.token_url).hostname; } catch { /* keep raw value */ }
        return `Error: profile "${input.id}" token_url points at a non-vetted sub-processor (${host}) with no recorded acceptance — fetch_token is refused because it would POST the client_secret to an unaccepted host. Re-save the profile via api_setup({ action: 'update', ... }); you'll be prompted to accept controller-responsibility, which records the acceptance and unblocks fetch_token.`;
      }
      const grantType = oauth.grant_type ?? 'client_credentials';
      const bodyFormat = oauth.body_format ?? 'form';
      const clientIdKey = oauth.client_id_key;
      const clientSecretKey = oauth.client_secret_key;
      if (!clientIdKey || !clientSecretKey) {
        return `Error: profile "${input.id}" auth.oauth is missing client_id_key or client_secret_key. Update the profile with the vault key names that hold the OAuth credentials.`;
      }
      const secretStore = agent.secretStore;
      if (!secretStore) {
        return 'Error: no secret store wired in this context — cannot resolve OAuth credentials.';
      }
      // Resolve directly from the store rather than via `secret:NAME` refs
      // in the body — agent shouldn't see the values, and we need to
      // build the request body ourselves anyway.
      const resolveOne = (name: string): string | null => {
        // SecretStoreLike doesn't expose `resolve()` on the interface; use
        // the same indirection as resolveSecretRefs (extract + resolve via
        // a single-key probe).
        const probe = { _: `secret:${name}` };
        const probed = secretStore.resolveSecretRefs(probe) as { _: string };
        return probed._ === `secret:${name}` ? null : probed._;
      };
      const clientId = resolveOne(clientIdKey);
      const clientSecret = resolveOne(clientSecretKey);
      const missing: string[] = [];
      if (clientId === null) missing.push(clientIdKey);
      if (clientSecret === null) missing.push(clientSecretKey);
      // The profile drives the slot, exactly as the attach does (`http.ts`,
      // `accessTokenKey`): an explicit `refresh_token_key` wins, otherwise the
      // derived name — the same one `fetch_token` writes. Without the fallback
      // the token was stored under a name nothing read, because no engine path
      // ever set the field and only a model-authored profile edit could.
      const refreshKey = oauth.refresh_token_key ?? refreshTokenKey(input.id);
      // The same guard the attach applies to its derived key (`http.ts`) and the
      // write applies below. It covers BOTH shapes: a derived name that lands in a
      // protected prefix, and an explicit `refresh_token_key` naming one — the
      // profile is model-authorable, and this value is POSTed to `token_url`.
      if (grantType === 'refresh_token' && isProtectedSecretWrite(refreshKey)) {
        return `Error: profile "${input.id}" resolves its refresh token from "${refreshKey}", which is a protected credential slot — refusing to send it to ${new URL(oauth.token_url).hostname}. Point auth.oauth.refresh_token_key at a slot that belongs to this API.`;
      }
      // Resolved once: the token this exchange presents is also the one a failure
      // is judged against — the rotation check and the revocation fingerprint
      // below must both refer to exactly what went out.
      const presentedRefresh = grantType === 'refresh_token' ? resolveOne(refreshKey) : null;
      if (grantType === 'refresh_token' && presentedRefresh === null) missing.push(refreshKey);
      if (missing.length > 0) {
        return `Error: vault is missing the OAuth credentials for profile "${input.id}": ${missing.map((n) => `"${n}"`).join(', ')}. Call \`ask_secret\` for each missing name first, then retry fetch_token.`;
      }
      // A revocation verdict stands until the refresh token changes. Posting the
      // very token the provider already rejected only repeats the rejection, and
      // a 401 loop would do exactly that. A DIFFERENT token in the slot is the
      // user's way back, so the verdict steps aside for it — and is cleared once
      // an exchange succeeds.
      const grant = profile.oauth_grant;
      if (presentedRefresh !== null && grant?.state === 'revoked'
          && grant.revoked_fp === tokenFingerprint(presentedRefresh)) {
        return revokedGrantMessage(input.id, refreshKey, grant.revoked_at);
      }
      // Where the access token will go, checked BEFORE the POST: a refusal after it
      // would throw away a freshly minted token, and with a provider that rotates,
      // the refresh token the POST just spent along with it.
      const outputName = input.output_secret_name ?? accessTokenKey(input.id);
      if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(outputName)) {
        return `Error: output_secret_name "${outputName}" is not valid UPPER_SNAKE_CASE.`;
      }
      // `secretStore.set` below overwrites without asking, and the agent chooses
      // the name, so one injected `fetch_token` could otherwise replace a mail
      // credential or a feed address with an OAuth token — and the only symptom
      // would be the feature quietly failing afterwards. `validateProfile` refuses
      // an infrastructure secret as a basic-auth key name too, but against the
      // mirror risk: that one is about handing a platform secret OUT to a host,
      // this one about writing over it. The check covers both halves of what a
      // tenant cannot recover, the infrastructure secrets and the slot holding
      // their own provider key.
      if (isProtectedSecretWrite(outputName)) {
        return `Error: output_secret_name "${outputName}" would overwrite a credential the tenant cannot recover (a platform secret, or the slot holding their own provider key) — pick a name for this API's own token.`;
      }
      // Never a slot the refresh token lives in: the access token would be written
      // over it, and the grant would go with it. Both slots, because a profile can
      // read from one of its own naming AND still have rotations written to the
      // derived one.
      //
      // The advice is "leave it out", not "pick another name": the attach reads the
      // derived access name and nothing else, so any other chosen name clears this
      // refusal and leaves a token no request can use. Two shapes the default does
      // not fix get their own answer — a profile that reads its refresh token from
      // that very name, and an id whose derived access name is itself protected —
      // because in both, following "leave it out" walks into the next refusal.
      if (outputName === refreshKey || outputName === refreshTokenKey(input.id)) {
        const clash = `Error: output_secret_name "${outputName}" is where this profile keeps its refresh token — the access token would be written over it.`;
        const derivedAccess = accessTokenKey(input.id);
        if (isProtectedSecretWrite(derivedAccess)) {
          return `${clash} The name this profile would otherwise use, "${derivedAccess}", is a protected slot, so its id leaves no name for the access token: rename the api_profile so its derived names do not collide.`;
        }
        // On `refreshKey`, not on the output name: the sentence below asserts that
        // the profile's refresh slot IS the name the access token needs, and that
        // is true for every shape where it holds — including one that arrives with
        // an explicit output name and would otherwise be told to leave it out, only
        // to land here on the next call.
        if (refreshKey === derivedAccess) {
          const move = grantType === 'refresh_token'
            ? `Point auth.oauth.refresh_token_key at a slot that holds only the refresh token — api_setup update — and store the token there with ask_secret.`
            : `Remove auth.oauth.refresh_token_key with api_setup update: a client-credentials profile does not read one.`;
          return `${clash} Leaving output_secret_name out does not help: this profile reads its refresh token from "${refreshKey}", the name its access token needs. ${move}`;
        }
        return `${clash} Leave output_secret_name out, so the access token goes to "${derivedAccess}", the slot http_request reads.`;
      }
      if (!secretStore.set) {
        return 'Error: secret store has no write path in this context — cannot persist the access_token.';
      }
      // fetch_token drives a real outbound POST; honour the same per-session HTTP
      // ceiling http_request enforces. It already increments httpRequests after a
      // successful fetch (below), so without this pre-check it could charge past
      // the limit rather than being bounded by it.
      if (agent.sessionCounters.httpRequests >= MAX_REQUESTS_PER_SESSION) {
        return `Error: session HTTP request limit (${MAX_REQUESTS_PER_SESSION}) reached — fetch_token cannot run. Start a new session or reduce request volume.`;
      }
      // Honour the per-API rate buckets too (http_request enforces these via
      // checkRateLimit). Without this a fetch_token loop against a profiled token
      // host bypasses the profile's own declared hourly/daily ceiling. Creds are
      // already validated above, so consuming a token here maps 1:1 to the POST.
      // checkRateLimit both checks AND consumes; a token host with no registered
      // rate_limit has no buckets, so this is a no-op for such hosts.
      const tokenHost = (() => { try { return new URL(oauth.token_url).hostname; } catch { return null; } })();
      if (tokenHost) {
        const rlBlock = apiStore?.checkRateLimit(tokenHost);
        if (rlBlock) return `Error: ${rlBlock}`;
      }
      const params: Record<string, string> = {
        grant_type: grantType,
        client_id: clientId!,
        client_secret: clientSecret!,
      };
      if (oauth.scope) params['scope'] = oauth.scope;
      if (oauth.audience) params['audience'] = oauth.audience;
      if (presentedRefresh !== null) params['refresh_token'] = presentedRefresh;
      const headers: Record<string, string> = { 'Accept': 'application/json' };
      let body: string;
      if (bodyFormat === 'json') {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(params);
      } else {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        body = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
      }
      let response: Response;
      let respText: string;
      const ac = new AbortController();
      const timer = setTimeout(() => { ac.abort(); }, DOCS_FETCH_TIMEOUT_MS);
      // Wall-clock guarantee: an AbortController.signal aborts fetch() but NOT
      // response.body.getReader() once headers have arrived, so a malicious
      // token_url that returns headers then drips the body (≤ TOKEN_BODY_MAX_BYTES,
      // 1 byte/30s) would hang readBodyLimited indefinitely. Race BOTH the fetch
      // and the body read against this (mirrors http_request's HARD_CAP).
      let wallTimer: ReturnType<typeof setTimeout> | undefined;
      const wallTimeout = new Promise<never>((_, reject) => {
        wallTimer = setTimeout(() => {
          ac.abort();
          reject(new Error(`token exchange timed out after ${DOCS_FETCH_TIMEOUT_MS}ms`));
        }, DOCS_FETCH_TIMEOUT_MS + 1000);
      });
      try {
        // Pass agent.toolContext so the SAME egress controls the docs/http paths
        // enforce apply here too: network_policy (deny-all / allow-list) + HTTPS
        // enforcement. Without it the client_secret in `body` would POST to an
        // arbitrary attacker-supplied token_url regardless of the tenant's
        // network policy — a credential-exfil channel.
        ({ response } = await Promise.race([
          // fetch_token is a full-control credentialed egress (posts the
          // client_secret to token_url) — gated under `guarded`. The token_url
          // host is in this profile's own custom_endpoint_ack (base_url +
          // token_url were both accepted at save), so the accepted-host union
          // admits it; a token_url no profile accepted stays blocked.
          fetchWithValidatedRedirects(oauth.token_url, {
            method: 'POST',
            headers,
            body,
            signal: ac.signal,
          }, { surface: 'full-control', ackHosts: resolveGuardedAckHosts(agent.toolContext) }, agent.toolContext),
          wallTimeout,
        ]));
        // Charge the token exchange against the session HTTP budget so
        // fetch_token is not a freebie bypass of MAX_REQUESTS_PER_SESSION.
        agent.sessionCounters.httpRequests++;
        // Bounded read — a malicious token_url can't stream an unbounded body
        // into memory (the response is small JSON; we only need the access_token).
        const read = await Promise.race([
          readBodyLimited(response, TOKEN_BODY_MAX_BYTES),
          wallTimeout,
        ]);
        respText = read.text;
      } catch (err) {
        return `Error: token exchange to ${oauth.token_url} failed: ${err instanceof Error ? err.message : String(err)}.`;
      } finally {
        clearTimeout(timer);
        clearTimeout(wallTimer);
      }
      if (!response.ok) {
        // Trim verbose HTML error pages — keep the first ~500 chars so the
        // agent can diagnose without flooding context.
        const snippet = respText.length > 500 ? respText.slice(0, 500) + '…[truncated]' : respText;
        const responseBody = `Response body:\n${snippet}`;
        const notOurs = 'This is the external provider\'s answer — NOT a lynox tool limitation. Do NOT recommend self-host or tier changes for this kind of failure.';
        // Which of three things failed decides what happens to the grant: a
        // revocation ends it, a client problem leaves it intact, and anything
        // else changes nothing. Before this, all three read as "check your
        // credentials", and a revoked grant looked like a token that had merely
        // expired — the model was told to fetch again, forever.
        let kind = classifyRefreshFailure(response.status, respText);
        // Only a refresh token is a grant the user gave and the provider can take
        // back. A client-credentials exchange answering `invalid_grant` refuses
        // the client itself, so it is read as a client problem.
        if (kind === 'grant-revoked' && presentedRefresh === null) kind = 'client-misconfigured';
        // The stamp speaks only for the token it was taken with. A refresh token
        // stored since — by the user after re-creating the app, by anyone — is
        // judged as unstamped; otherwise a dead token from a new client would read
        // as a mismatch and hide a real revocation.
        const presentedFp = presentedRefresh === null ? undefined : tokenFingerprint(presentedRefresh);
        const stampApplies = grant?.minted_for !== undefined && grant.minted_for === presentedFp;
        kind = reclassifyForeignGrant(
          kind,
          stampApplies ? grant?.minted_by : undefined,
          clientId === null ? undefined : tokenFingerprint(clientId),
        );
        // A second writer in THIS process can rotate the token while the request
        // is out: tool calls run concurrently, so two exchanges for one profile can
        // overlap, and the provider then rejects the one that lost as spent. If
        // the slot no longer holds what went out, the rejection says nothing about
        // what it holds now, so it is no revocation. This reads the process's own view of the vault; a writer in
        // another process is not seen here — the attach's fingerprint check is
        // what lets a restart that loads the newer token past such a verdict.
        // The re-read shows only THAT the slot changed, not who changed it: a
        // concurrent exchange, or a token stored by hand meanwhile. The reply says
        // no more than that. An emptied slot is its own case — the token was
        // removed, possibly with the profile.
        if (kind === 'grant-revoked') {
          const nowHeld = resolveOne(refreshKey);
          if (nowHeld === null) {
            return `Token exchange failed with HTTP ${response.status}, but the refresh token it sent is no longer in the vault under "${refreshKey}", so this answer says nothing about the grant. Nothing was recorded. Check with api_setup list that api_profile "${input.id}" still exists before anything else. ${responseBody}`;
          }
          if (nowHeld !== presentedRefresh) {
            return `Token exchange failed with HTTP ${response.status}, but the refresh token under "${refreshKey}" was replaced while the request was out — by another exchange running at the same time, or by a token stored meanwhile — so this answer says nothing about the token stored now. Nothing was recorded. Retry the API request; if it is refused or answers 401, call fetch_token once. ${responseBody}`;
          }
        }
        // A profile that names its own refresh slot reads from there, while every
        // exchange stores a rotated token under the derived name. The token that
        // just failed may simply be the one the last rotation replaced, so no
        // verdict can be recorded; the reply names the split instead.
        if (kind === 'grant-revoked' && refreshKey !== refreshTokenKey(input.id)) {
          return `Token exchange failed with HTTP ${response.status}: the provider rejected the refresh token read from "${refreshKey}". This profile reads its refresh token from "${refreshKey}", but fetch_token stores a rotated one under "${refreshTokenKey(input.id)}", so the rejected token may just be an old one. Nothing was recorded. Remove auth.oauth.refresh_token_key from the profile with api_setup update, so both are the same slot, then call fetch_token again. ${responseBody}`;
        }
        if (kind === 'grant-revoked' && presentedFp !== undefined) {
          persistGrant(apiStore, input.id, apisDir, (current) => ({
            ...current,
            state: 'revoked',
            revoked_fp: presentedFp,
            revoked_at: new Date().toISOString(),
          }));
          return `${revokedGrantMessage(input.id, refreshKey, undefined)}\n\n${responseBody}`;
        }
        if (kind === 'client-misconfigured') {
          return `Token exchange failed with HTTP ${response.status}: the provider rejected this API's client configuration, not the user's grant. The stored grant is kept, and retrying unchanged will not help. ${responseBody}\n\n${notOurs} Check: client_id / client_secret values, app install state on the target store, scope grants, organization-vs-store linkage.`;
        }
        return `Token exchange failed with HTTP ${response.status} — a temporary provider or network condition, or an answer the engine does not classify. Nothing was changed; retry later. ${responseBody}\n\n${notOurs}`;
      }
      let parsed: { access_token?: string; expires_in?: number; refresh_token?: string; scope?: string; token_type?: string };
      try {
        parsed = JSON.parse(respText) as typeof parsed;
      } catch {
        return `Token exchange returned HTTP ${response.status} but the body wasn't valid JSON. First 500 chars:\n${respText.slice(0, 500)}`;
      }
      const accessToken = parsed.access_token;
      if (!accessToken || typeof accessToken !== 'string') {
        return `Token exchange returned HTTP ${response.status} but no \`access_token\` in the response. Parsed body: ${JSON.stringify(parsed).slice(0, 300)}.`;
      }
      // A refresh token counts as new only if it differs from the one this exchange
      // sent. A provider that does not rotate can answer with the very token it was
      // sent; writing that again and putting it on the record would make the
      // user's own grant look like the exchange's, and a delete would take it.
      const refreshName = refreshTokenKey(input.id);
      const rotated = typeof parsed.refresh_token === 'string' && parsed.refresh_token !== '' && parsed.refresh_token !== presentedRefresh
        ? parsed.refresh_token
        : null;
      secretStore.set(outputName, accessToken);
      // Stash refresh_token too if the response carries a new one (for later refresh_token grants).
      if (rotated !== null) {
        // Derived from the profile id rather than chosen — but `ID_PATTERN` permits ids like
        // `google-oauth` or `mail-account-x`, so the derived name lands inside a protected
        // prefix just as easily as a chosen one. Guarding only the caller-supplied name would
        // close the door and leave the window.
        if (isProtectedSecretWrite(refreshName)) {
          // The access token is written already; it goes on the record like any
          // other write, or no later delete could take it.
          const accessWrite: WrittenSecret[] = [{ name: outputName, fp: tokenFingerprint(accessToken) }];
          const saved = persistGrant(apiStore, input.id, apisDir, (current) => ({
            ...current,
            written: mergeWrites(current, accessWrite),
          }));
          if (saved === 'gone' && apiStore) return deletedMeanwhile(apiStore, profile, accessWrite, secretStore);
          return `Token exchange OK, but the refresh token was NOT stored: "${refreshName}" would overwrite a credential the tenant cannot recover. Rename the api_profile so its derived key does not collide.`;
        }
        secretStore.set(refreshName, rotated);
      }
      // Persist the expiry, absolute and in milliseconds. Until now `expires_in`
      // was formatted into the reply below and then dropped, so nothing on this
      // path could know when a token died — which is why neither a lazy refresh
      // nor a scheduled one was buildable: both need something to plan against.
      //
      // On the profile rather than in the vault deliberately. A vault write would
      // put a non-secret timestamp into a store whose NAMES are enumerated into
      // the model's briefing (`engine-init.ts`), and the value is not a
      // credential. The failure mode of the extra write is also mild here: if the
      // save does not happen, the state is what it is today — no expiry known —
      // whereas the same second write for the refresh key would have reproduced
      // the very orphan this change removes, which is why THAT one is derived at
      // read time instead.
      // Bounded: `expires_in` comes from the token endpoint, and an absurd value
      // is not merely wrong — `1e308 * 1000` is `Infinity`, which `JSON.stringify`
      // writes as `null` into both backing stores, i.e. a null in a `number |
      // undefined` field that a future scheduler would read as "already expired".
      // One year is far past any real token and still a finite integer.
      const MAX_TOKEN_LIFETIME_S = 366 * 24 * 60 * 60;
      const lifetimeS = parsed.expires_in;
      const tokenExpiresAt = typeof lifetimeS === 'number' && Number.isSafeInteger(lifetimeS)
        && lifetimeS > 0 && lifetimeS <= MAX_TOKEN_LIFETIME_S
        ? Date.now() + lifetimeS * 1000
        : undefined;
      // The grant record rides in the same save as the expiry. The client that
      // just succeeded is stamped as the one the stored refresh token belongs to —
      // the comparison `reclassifyForeignGrant` needs on the next `invalid_grant`.
      // A success also ends a revocation verdict: a token that works is not
      // revoked. Every value this exchange wrote joins the record with its
      // fingerprint when the save goes through (see `persistGrant`), and that is
      // what a later delete removes — and all it removes.
      const writes: WrittenSecret[] = [{ name: outputName, fp: tokenFingerprint(accessToken) }];
      if (rotated !== null) writes.push({ name: refreshName, fp: tokenFingerprint(rotated) });
      // The refresh token now in play: a new one if the answer carried it,
      // otherwise the one that just worked — which is also what an answer that
      // hands it back unchanged names. The stamp names that token, so it says
      // nothing about any token stored after it.
      const liveRefresh = rotated ?? presentedRefresh;
      const outcome = persistGrant(apiStore, input.id, apisDir, (current) => {
        const next: OAuthGrantRecord = { ...current };
        if (liveRefresh !== null && clientId !== null) {
          next.minted_by = tokenFingerprint(clientId);
          next.minted_for = tokenFingerprint(liveRefresh);
        }
        delete next.state;
        delete next.revoked_fp;
        delete next.revoked_at;
        next.written = mergeWrites(current, writes);
        return next;
      }, tokenExpiresAt);
      // Deleted while the exchange was out: there is no profile to hold the
      // record, and the delete already ran — so the tokens this exchange wrote
      // would sit in the vault with nothing left to remove them.
      if (outcome === 'gone' && apiStore) return deletedMeanwhile(apiStore, profile, writes, secretStore);
      const expiresIn = typeof parsed.expires_in === 'number' ? `${parsed.expires_in}s` : 'unknown';
      return `Token exchange OK. access_token stored as \`${outputName}\` (expires_in: ${expiresIn}). The engine will auto-attach this as \`Authorization: Bearer …\` for any http_request that maps to api_profile "${input.id}" — do NOT pass an Authorization header yourself, and do NOT reference \`secret:${outputName}\` manually. Just call http_request with the URL + body; auth is handled. ${rotated !== null ? `Refresh token stored as \`${refreshName}\`.` : ''}`;
    }

    return 'Unknown action. Use "list", "view", "bootstrap", "create", "update", "refine", "delete", or "fetch_token".';
  },
};
