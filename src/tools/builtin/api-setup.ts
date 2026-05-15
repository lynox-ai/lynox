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

import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolEntry, IAgent } from '../../types/index.js';
import { getLynoxDir } from '../../core/config.js';
import type { ApiProfile, ResponseShape, ApiAuth, ApiEndpoint } from '../../core/api-store.js';
import { fetchWithValidatedRedirects, readBodyLimited } from './http.js';
import { callForStructuredJson, BudgetError, type ExtractSchema } from '../../core/llm-helper.js';
import { isFeatureEnabled } from '../../core/features.js';

/** Cap on the OpenAPI spec body — generous for real-world specs, blocks DoS via huge response. */
const OPENAPI_SPEC_MAX_BYTES = 5 * 1024 * 1024;
const OPENAPI_FETCH_TIMEOUT_MS = 15_000;

/** Cap on the docs-page body pre-Haiku. 250 KB matches PRD-UNIFIED-API-PROFILE-V2. */
const DOCS_BODY_MAX_BYTES = 250 * 1024;
const DOCS_FETCH_TIMEOUT_MS = 15_000;
/** Hard $ budget per Haiku extraction. PRD requires ≤ $0.05. */
const DOCS_EXTRACT_BUDGET_USD = 0.05;

type ApiSetupAction = 'create' | 'update' | 'delete' | 'list' | 'view' | 'bootstrap' | 'refine';

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
  /** Profile ID (required for delete/view/refine). */
  id?: string | undefined;
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
const VALID_AUTH_TYPES = new Set(['basic', 'bearer', 'header', 'query', 'oauth2']);
const VALID_BASIC_FORMATS = new Set(['user_pass_split', 'pre_encoded_b64']);
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const VALID_SHAPE_KINDS = new Set(['reduce', 'passthrough']);
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
      return `Invalid auth.type "${profile.auth.type}": must be basic, bearer, header, query, or oauth2`;
    }
    if (profile.auth.basic_format !== undefined && !VALID_BASIC_FORMATS.has(profile.auth.basic_format)) {
      return `Invalid auth.basic_format "${profile.auth.basic_format}": must be user_pass_split or pre_encoded_b64`;
    }
    if (profile.auth.type === 'oauth2' && (!profile.auth.vault_keys || profile.auth.vault_keys.length === 0)) {
      return 'auth.vault_keys is required for auth.type="oauth2" (refresh-token slot)';
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
        type: { type: 'string', enum: ['basic', 'bearer', 'header', 'query', 'oauth2'] as const },
        basic_format: { type: 'string', enum: ['user_pass_split', 'pre_encoded_b64'] as const },
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
    type: 'basic' | 'bearer' | 'header' | 'query' | 'oauth2';
    basic_format?: 'user_pass_split' | 'pre_encoded_b64';
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
      const resp = await fetchWithValidatedRedirects(url, { signal: ac.signal }, agent.toolContext);
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
    return 'Error: docs_url bootstrap is gated behind the `api-setup-v2` feature flag (off by default). Set LYNOX_FEATURE_API_SETUP_V2=1 to enable, or use `openapi_url` if the API has an OpenAPI 3.x spec.';
  }

  emitBootstrapProgress(agent, 'fetching_docs');
  let docsText: string;
  let truncated: boolean;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => { ac.abort(); }, DOCS_FETCH_TIMEOUT_MS);
    try {
      const resp = await fetchWithValidatedRedirects(docsUrl, { signal: ac.signal }, agent.toolContext);
      if (!resp.ok) {
        return `Error: failed to fetch docs page (HTTP ${String(resp.status)} ${resp.statusText}). Check the URL and try again.`;
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
    });
    extracted = result.data;
    costUsd = result.costUsd;
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

  return `Bootstrapped draft profile from ${docsUrl} (extraction cost $${costUsd.toFixed(4)}).

${summary}${injectedNote}${truncatedNote}${linkedNote}

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

// ── Tool definition ───────────────────────────────────────────────────────────

export const apiSetupTool: ToolEntry<ApiSetupInput> = {
  definition: {
    name: 'api_setup',
    description: 'Create, update, delete, list, view, bootstrap, or refine API profiles. Profiles teach you how to correctly use external APIs — endpoints, auth, rate limits, common mistakes, and response shaping.\n\nActions:\n- list / view: read profiles.\n- bootstrap: pass EITHER `openapi_url` (OpenAPI 3.x JSON spec, preferred when available) OR `docs_url` (human-readable docs landing page; gated behind `api-setup-v2` flag; runs a single Haiku extraction to populate v2 fields including concurrency / cost / output_volume). Returns a draft profile; enrich it with extra guidelines/avoid/response_shape (from reading the docs) and then call `create`.\n- create: pass a complete `profile` object.\n- refine: pass `id` + `refine` patch (addGuidelines / addAvoid / addNotes / addEndpoints / response_shape / rate_limit). Use when a call teaches you something new.\n- delete: pass `id`.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'update', 'delete', 'list', 'view', 'bootstrap', 'refine'],
          description: 'Action to perform',
        },
        profile: {
          type: 'object',
          description: 'API profile data. Required: id (lowercase, alphanumeric), name, base_url, description. Optional: auth {type: basic|bearer|header|query|oauth2, basic_format: user_pass_split|pre_encoded_b64, header_name, query_param, vault_keys[]}, rate_limit, endpoints [{method, path, description}], guidelines [], avoid [], notes [], response_shape {kind, include, reduce, max_array_items, max_string_chars, max_chars}, concurrency {parallel_ok, max_in_flight, batchable_via_endpoint}, output_volume (small|medium|large|streaming), cost {model: per_call|per_token|per_unit, rate_usd, output_ratio}, provenance {source: openapi|docs_url|manual, source_url, validated_at, schema_version: 2}.',
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
      },
      required: ['action'],
    },
  },
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
          resp = await fetchWithValidatedRedirects(input.openapi_url, { signal: ac.signal }, agent.toolContext);
        } finally {
          clearTimeout(timer);
        }
        if (!resp.ok) {
          return `Error: failed to fetch OpenAPI spec (HTTP ${String(resp.status)} ${resp.statusText}). Check the URL or pass a direct link to the JSON spec.`;
        }
        const { text, truncated } = await readBodyLimited(resp, OPENAPI_SPEC_MAX_BYTES);
        if (truncated) {
          return `Error: OpenAPI spec body exceeds ${String(OPENAPI_SPEC_MAX_BYTES)} bytes. Point at a smaller spec or split the API into multiple profiles.`;
        }
        spec = JSON.parse(text) as OpenApiDoc;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Error: could not parse OpenAPI spec from ${input.openapi_url} — ${msg}. If the docs site serves HTML, find the raw .json spec URL (often at /openapi.json or /swagger.json).`;
      }

      if (!spec.openapi || !spec.openapi.startsWith('3.')) {
        return `Error: unsupported spec version (openapi: "${String(spec.openapi)}"). This bootstrapper expects OpenAPI 3.x. Swagger 2.0 specs need conversion first, or build the profile manually via "create".`;
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

      mkdirSync(apisDir, { recursive: true, mode: 0o700 });
      const filePath = join(apisDir, `${merged.id}.json`);
      writeFileSync(filePath, JSON.stringify(merged, null, 2), { mode: 0o600 });
      apiStore.register(merged);

      const changed: string[] = [];
      if (input.refine.addGuidelines?.length) changed.push(`+${String(input.refine.addGuidelines.length)} guidelines`);
      if (input.refine.addAvoid?.length) changed.push(`+${String(input.refine.addAvoid.length)} avoid`);
      if (input.refine.addNotes?.length) changed.push(`+${String(input.refine.addNotes.length)} notes`);
      if (input.refine.addEndpoints?.length) changed.push(`+${String(input.refine.addEndpoints.length)} endpoints`);
      if (input.refine.response_shape) changed.push('response_shape updated');
      if (input.refine.rate_limit) changed.push('rate_limit updated');
      return `Refined profile "${merged.id}": ${changed.length > 0 ? changed.join(', ') : 'no changes'}. Saved to ${filePath}.`;
    }

    if (input.action === 'create' || input.action === 'update') {
      if (!input.profile) {
        return 'Error: "profile" object is required for create/update action.';
      }

      const profile = input.profile;
      const error = validateProfile(profile);
      if (error) {
        return `Validation error: ${error}`;
      }

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
        warnings.push('No auth method specified — most APIs require authentication.');
      }
      if (warnings.length > 0) {
        return `Profile is incomplete — research the API docs before creating:\n\n${warnings.map(w => `- ${w}`).join('\n')}\n\nTip: use action="bootstrap" with an OpenAPI URL to auto-derive endpoints + auth.`;
      }

      // Write to disk
      mkdirSync(apisDir, { recursive: true, mode: 0o700 });
      const filePath = join(apisDir, `${profile.id}.json`);
      const isUpdate = existsSync(filePath);
      writeFileSync(filePath, JSON.stringify(profile, null, 2), { mode: 0o600 });

      // Hot-reload into ApiStore
      const apiStore = agent.toolContext?.apiStore;
      if (apiStore) {
        apiStore.register(profile);
      }

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
      parts.push(`Profile saved to ${filePath} and activated immediately.`);
      parts.push('Next steps: use ask_secret to securely collect API credentials if needed, then test with a simple http_request.');
      return parts.join('\n');
    }

    if (input.action === 'delete') {
      const id = input.id ?? input.profile?.id;
      if (!id) {
        return 'Error: "id" is required for delete action.';
      }
      const apiStore = agent.toolContext?.apiStore;
      // Prefer the in-memory + on-disk path so the agent sees the deletion
      // immediately. Fall through to disk-only when the in-memory store
      // has no record — that covers profiles dropped into apisDir after
      // engine boot, plus the standalone-CLI paths where no store is bound.
      if (apiStore?.unregister(id, apisDir)) {
        return `Deleted API profile "${id}".`;
      }
      const filePath = join(apisDir, `${id}.json`);
      if (!existsSync(filePath)) {
        return `API profile "${id}" not found.`;
      }
      unlinkSync(filePath);
      return `Deleted API profile "${id}". Changes take effect on next restart.`;
    }

    return 'Unknown action. Use "list", "view", "bootstrap", "create", "update", "refine", or "delete".';
  },
};
