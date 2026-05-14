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

/** Cap on the OpenAPI spec body — generous for real-world specs, blocks DoS via huge response. */
const OPENAPI_SPEC_MAX_BYTES = 5 * 1024 * 1024;
const OPENAPI_FETCH_TIMEOUT_MS = 15_000;

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
  /** OpenAPI spec URL (required for bootstrap). */
  openapi_url?: string | undefined;
  /** Additive patch (required for refine). */
  refine?: RefinePatch | undefined;
}

const REQUIRED_FIELDS: Array<keyof ApiProfile> = ['id', 'name', 'base_url', 'description'];
const VALID_AUTH_TYPES = new Set(['basic', 'bearer', 'header', 'query']);
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const VALID_SHAPE_KINDS = new Set(['reduce', 'passthrough']);
const VALID_REDUCERS = new Set(['avg', 'peak', 'avg+peak', 'count', 'first_n', 'last_n']);

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
  if (profile.auth && !VALID_AUTH_TYPES.has(profile.auth.type)) {
    return `Invalid auth type "${profile.auth.type}": must be basic, bearer, header, or query`;
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
    description: 'Create, update, delete, list, view, bootstrap, or refine API profiles. Profiles teach you how to correctly use external APIs — endpoints, auth, rate limits, common mistakes, and response shaping.\n\nActions:\n- list / view: read profiles.\n- bootstrap: pass `openapi_url` pointing to an OpenAPI 3.x JSON spec. Returns a draft profile; enrich it with guidelines/avoid/response_shape (from reading docs) and then call `create`.\n- create: pass a complete `profile` object.\n- refine: pass `id` + `refine` patch (addGuidelines / addAvoid / addNotes / addEndpoints / response_shape / rate_limit). Use when a call teaches you something new.\n- delete: pass `id`.',
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
          description: 'API profile data. Required: id (lowercase, alphanumeric), name, base_url, description. Optional: auth {type: basic|bearer|header|query}, rate_limit, endpoints [{method, path, description}], guidelines [], avoid [], notes [], response_shape {kind, include, reduce, max_array_items, max_string_chars, max_chars}.',
        },
        id: {
          type: 'string',
          description: 'Profile ID (for delete/view/refine action).',
        },
        openapi_url: {
          type: 'string',
          description: 'OpenAPI 3.x JSON spec URL. Required for bootstrap action.',
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
      if (!input.openapi_url) {
        return 'Error: "openapi_url" is required for bootstrap action. Pass a URL pointing to the API\'s OpenAPI 3.x JSON spec. If the API has no OpenAPI spec, read the docs via web_research and build a profile manually with action "create".';
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
