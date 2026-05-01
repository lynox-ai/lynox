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

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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
  /** Auth type: basic, bearer, header, query */
  type: 'basic' | 'bearer' | 'header' | 'query';
  /** Header name for 'header' type (e.g. 'X-Api-Key'). Default: 'Authorization'. */
  header_name?: string | undefined;
  /** Query parameter name for 'query' type. */
  query_param?: string | undefined;
  /** Instructions for the agent on how to authenticate. */
  instructions?: string | undefined;
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
  /** 'reduce' applies the rules; 'passthrough' is an explicit no-op marker. */
  kind?: 'reduce' | 'passthrough' | undefined;
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
        this.register(profile);
        loaded++;
      } catch (err: unknown) {
        process.stderr.write(`[lynox:api-store] Failed to load ${file}: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    return loaded;
  }

  /** Register a single profile. */
  register(profile: ApiProfile): void {
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
   * Format full profile details for a single API (used by api_setup tool).
   */
  formatProfile(p: ApiProfile): string {
    const lines: string[] = [];
    lines.push(`### ${p.name}`);
    lines.push(p.description);
    lines.push(`Base URL: ${p.base_url}`);

    if (p.auth) {
      const authDesc = p.auth.type === 'basic' ? 'Basic Auth (username:password base64)'
        : p.auth.type === 'bearer' ? 'Bearer Token in Authorization header'
        : p.auth.type === 'header' ? `API key in header: ${p.auth.header_name ?? 'X-Api-Key'}`
        : `API key in query param: ${p.auth.query_param ?? 'key'}`;
      lines.push(`Auth: ${authDesc}`);
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
      for (const g of p.guidelines) lines.push(`- ${g}`);
    }

    if (p.avoid && p.avoid.length > 0) {
      lines.push('');
      lines.push('Avoid:');
      for (const a of p.avoid) lines.push(`- ${a}`);
    }

    if (p.notes && p.notes.length > 0) {
      lines.push('');
      lines.push('Notes:');
      for (const n of p.notes) lines.push(`- ${n}`);
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

    return lines.join('\n');
  }
}
