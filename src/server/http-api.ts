/**
 * Engine HTTP API Server
 *
 * Exposes the Engine singleton over REST + SSE for the PWA Gateway.
 * Each process serves exactly one user (process-per-user model).
 *
 */

import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { readFileSync, accessSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { freemem, totalmem, loadavg } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHmac, timingSafeEqual, randomUUID, randomBytes } from 'node:crypto';
import { Engine } from '../core/engine.js';
import { MemoryFacade } from '../core/memory-facade.js';
import { stripUntrustedSeparators, sanitizeAttachmentFilename, sanitizeUploadFilename } from '../core/sanitize.js';
import { extractDocumentText, DocumentExtractError } from '../core/document-extract.js';
import { ingestDocumentText, pickDocumentScope } from '../core/document-ingest.js';
import { ensureHttpSecret } from '../core/engine-init.js';
import { fireBeforeRunGate, reportMeteredCost } from '../core/metered-request.js';
import { backfillMetadata as inboxBackfillMetadata } from '../integrations/inbox/backfill-metadata.js';
import type { Lang } from '../core/speak.js';
import { loadConfig } from '../core/config.js';
import { readEnvAlias } from '../core/env.js';
import { resolveChatContext, LOADED_CONTEXT_END, type ChatContextRef } from '../core/chat-context.js';
import { getActiveProvider } from '../core/llm-client.js';
import { getRerankerCapability } from '../integrations/search/search-reranker.js';
import { resolveProviderApiKey, mayFallBackToStoredKey, PROVIDER_KEY_SLOTS } from '../core/llm/provider-keys.js';
import { endpointNeedsCredential, getCatalogEntryByKey, resolveCatalogKey, mainChatTierLabels, mainChatTierLabelsFromTierSet } from '../core/llm/catalog.js';
import type { LLMProvider } from '../types/models.js';
import { SessionStore } from '../core/session-store.js';
import { RunAbortedError } from '../core/agent.js';
import { WEB_UI_SYSTEM_PROMPT_SUFFIX } from '../core/prompts.js';
import { projectMessages } from '../core/render-projection.js';
import { maskSecretPatterns, isInfraSecret } from '../core/secret-store.js';
import type { StreamEvent, PromptMeta, CapabilityLocks, SecretOutcome, MailConnectPromptData, MailConnectOutcome, EntityRecord } from '../types/index.js';
import { MODEL_MAP, effectiveContextWindow, resolveNativeContextWindow, FALLBACK_CAPABILITY, getModelId, modelCapability, normalizeTier, normalizeThreadModelSource, resolveBalancedModel, SERVED_BALANCED_SONNET_IDS } from '../types/index.js';
import { isHostedInstance, cpSuppliesLLMKey, normalizeBillingTier } from './billing-tier.js';
import { WallClockBudget } from './wall-clock-budget.js';
import { resolveClientIp } from './client-ip.js';
import { LynoxUserConfigSchema } from '../types/schemas.js';
import { evaluateEndpointBootGate, describeDisclosure } from '../core/llm/endpoint-allowlist.js';
import { redactConfigForResponse } from '../core/secret-fields.js';

// ── Types ────────────────────────────────────────────────────────────────────

// PendingPrompt/PendingSecretPrompt interfaces removed — replaced by PromptStore (SQLite-backed)

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  body: unknown,
) => Promise<void>;

interface DynamicRoute {
  method: string;
  /**
   * Auth scope this route belongs to. The dispatch loop reads scope off the
   * matched route — replaces the old `requiresAdmin(method, pathname)`
   * path-matching enumeration so every new admin route is declared once,
   * at registration. See `addDynamic` / `parseDynamicRoute`.
   */
  scope: AuthScope;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

interface ProviderStatus {
  indicator: 'none' | 'not-configured' | 'minor' | 'major' | 'critical' | 'unknown';
  description: string;
  provider?: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_BODY_BYTES = 30 * 1024 * 1024; // 30 MB

/** Reject out-of-range port numbers before they reach the socket layer. */
function isValidMailPort(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}
const PKG_VERSION: string = (() => {
  try {
    const raw = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf-8');
    return (JSON.parse(raw) as { version: string }).version;
  } catch { return 'unknown'; }
})();

// Two-tier auth: when LYNOX_HTTP_ADMIN_SECRET is set, admin-scoped routes
// require the admin token; user-scoped routes accept either. When only
// LYNOX_HTTP_SECRET is set (single-token mode), it grants admin implicitly.
//
// Each route declares its scope at registration via `addStatic` /
// `addDynamic` (or as the first arg to `parseDynamicRoute`) — the dispatch
// loop reads scope off the matched route. This replaces the old
// `requiresAdmin(method, pathname)` path-prefix enumeration, which had the
// fragility that adding a new admin route required updating TWO places (the
// route registration AND the path matcher), and the second was easy to
// forget — turning a destructive route into a user-scope footgun.
type AuthScope = 'admin' | 'user';
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 120;
const RATE_MAX_LOOPBACK = 600; // Higher limit for Web UI proxy on same host
const PROMPT_TIMEOUT_MS = 24 * 60 * 60_000; // 24 hours — prompts persist in SQLite, survive reconnects
const ORPHAN_PROMPT_WATCHDOG_MS = 10 * 60_000; // 10 min — orphaned-stream + pending-prompt slot free guard
/** Run wall-clock: max wall-time a run may spend ACTIVELY COMPUTING. Human
 *  think-time on a pending prompt is paused out of this budget (#77), so this
 *  is a compute-only ceiling, not elapsed-time. Overridable for tests/ops via
 *  LYNOX_RUN_WALL_CLOCK_MS. */
const DEFAULT_RUN_WALL_CLOCK_MS = 30 * 60_000; // 30 min
function resolveRunWallClockMs(): number {
  const raw = process.env['LYNOX_RUN_WALL_CLOCK_MS'];
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_RUN_WALL_CLOCK_MS;
}
/** Hard per-request input cap for POST /api/speak to bound Mistral cost + latency. */
const SPEAK_MAX_TEXT_CHARS = 10_000;
/** Mistral Voxtral TTS rate (2026-04): $0.016 per 1 000 characters. No usage headers exposed — billed client-side. */
const SPEAK_USD_PER_CHAR = 0.016 / 1000;
/** Usage Dashboard summary cache: 30 s per (period, windowStart). Long enough to dedupe tab re-opens, short enough to feel live. */
const USAGE_SUMMARY_TTL_MS = 30_000;
const ALLOWED_ORIGINS = (process.env['LYNOX_ALLOWED_ORIGINS'] ?? '').split(',').filter(Boolean);
const ALLOWED_IPS = (process.env['LYNOX_ALLOWED_IPS'] ?? '').split(',').filter(Boolean);
const TLS_CERT = process.env['LYNOX_TLS_CERT'] ?? '';
const TLS_KEY = process.env['LYNOX_TLS_KEY'] ?? '';
/** IANA timezone allowlist. Covers all current zones (`America/Argentina/Buenos_Aires`, `Etc/GMT+12`, …) without admitting newlines, brackets or quotes that could break out of the per-turn `[Now: …]` marker on the prompt boundary. */
const TZ_PATTERN = /^[A-Za-z0-9_+\-/]+$/;
const TZ_MAX_LENGTH = 64;
/**
 * UUID format gate for client-supplied threadId on POST /api/sessions —
 * without it, an attacker could POST oversized / arbitrary strings to
 * pollute the in-memory sessionStore Map + the SQLite primary key
 * namespace (DoS / hygiene; SQLi is neutralised by parameterised
 * statements). Matches the shape `randomUUID()` produces (lowercase hex).
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Agent-opened escalation threads use `escalation-<key>` ids (see core/escalation.ts),
// which are legitimate RESUMABLE chat threads but are NOT UUIDs — so the resume
// (`POST /api/sessions`) must accept them alongside UUIDs. Injection-safe charset
// (alphanumeric + hyphen, bounded); these ids are used verbatim as the SQLite TEXT PK,
// never lowercased (unlike UUIDs), so they match the stored thread row exactly.
const ESCALATION_ID_REGEX = /^escalation-[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/**
 * Three deployment modes the engine has to keep distinct. The billing tier
 * arrives via `LYNOX_BILLING_TIER` (canonical; legacy `LYNOX_MANAGED_MODE`
 * still read via the env alias):
 *
 *  1. **Self-host** — no `LYNOX_HTTP_ADMIN_SECRET`, no billing-tier env.
 *     Cookie auth is promoted to admin scope at L~1049, so all gates below
 *     are no-ops for cookie users. The user *is* the admin.
 *
 *  2. **Managed BYOK / starter** — billing tier `starter` (canonical `hosted`).
 *     Customer brings their own key via the SetupBanner. Provider +
 *     api_base_url + cost-caps stay configurable (it's their key, their bill).
 *     Only the secret-store write needs the BYOK whitelist.
 *
 *  3. **Managed pool** — billing tier `managed|managed_pro|eu`.
 *     CP delivers the LLM. Provider, cost caps, MCP servers, OAuth ids,
 *     search/backup config, etc. are all CP-managed. Only UI preferences
 *     are user-writable.
 *
 * Managed defense-in-depth: the deny-list + config-lock gates below key on the
 * billing tier (`requiresAdminSplitGate`/`requiresConfigLockGate`), independent
 * of cookie scope, so they hold however the cookie resolves. Sensitive
 * data-export / destructive / lifecycle routes additionally carry
 * `denyOnManagedInstance`, and `/api/vault/*` + `/api/auth/token` self-guard
 * inline. Any new data-export, destructive, or lifecycle route MUST add the
 * appropriate gate — never rely on cookie scope alone to keep it out of a
 * managed customer's reach.
 *
 * Two predicates so a single tier never accidentally pulls in the wrong gate:
 *   - `requiresAdminSplitGate()` → true for both BYOK and pool (secret writes
 *     need the whitelist; keyed on billing tier, not cookie scope).
 *   - `requiresConfigLockGate()` → true ONLY for pool (BYOK keeps full config
 *     control because the customer pays for and operates their own LLM).
 */
// Tier predicates derive from the canonical billing-tier mirror (./billing-tier.js):
//   - admin-split gate  → isHostedInstance (true for every CP tier incl. BYOK)
//   - config-lock gate  → cpSuppliesLLMKey (managed pool only)
// The mirror normalizes legacy `starter`/`eu`, so these gates work whether an
// instance reports the old or the renamed (`hosted`) tier.

/**
 * Managed-pool effective defaults for fields that are NOT in the user-config
 * file but ARE locked by the engine. The Web UI reads provider via
 * `/api/secrets/status` (which defaults `provider: 'anthropic'` when absent
 * from the config file) and re-sends it on every save, so a strict diff
 * against `loadConfig()` would 403 every save. Treat these resends as no-ops
 * by overlaying the managed defaults before the comparison.
 *
 * `eu` tier hides the SetupBanner outright (UI ~L55-59) so the only practical
 * caller of this code path is the `managed`/`managed_pro` SetupBanner, where
 * provider is always 'anthropic'.
 */
const MANAGED_EFFECTIVE_DEFAULTS: Record<string, unknown> = {
  provider: 'anthropic',
};

/**
 * Secret-writability policy for managed-tier cookie users (auth-scope = user
 * per ~L1049 `adminSecret ? 'user' : 'admin'`). Self-host has no admin secret
 * so cookie users are promoted to admin and this gate never applies.
 *
 * **Default = user-writable.** This is the lynox product promise: a managed
 * customer can connect their own Shopify / Stripe / DataForSEO / Hetzner /
 * arbitrary tool credentials without filing a support ticket. The previous
 * allowlist (`BYOK_USER_WRITABLE_SECRETS` — only LLM provider keys) violated
 * that promise — every integration the agent wanted to use needed admin
 * provisioning. Inverted 2026-05-18 after rafael's QA: see
 * [[feedback_canary_pinning]] + [[project_managed_user_secrets_promise]].
 *
 * **Deny-list — admin-only patterns** (cookie users get 403 for these):
 *  - `LYNOX_*`        engine-internal infra (HTTP_SECRET, VAULT_KEY, BUGSINK_DSN, etc.)
 *  - `MANAGED_*`      CP-managed control-plane secrets
 *  - `MAIL_ACCOUNT_*` channel-managed via Mail settings UI (writes race the
 *                     dedicated mail-account form — they have their own path)
 *  - `GOOGLE_OAUTH_*` channel-managed via Google OAuth flow
 *  - `SMTP_*`/`IMAP_*` engine in/outbound mail server credentials
 *
 * Everything else passes: SHOPIFY_*, STRIPE_*, DATAFORSEO_*, BREVO_*,
 * HETZNER_*, ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.
 */
// Single source of truth: `INFRA_SECRET_PATTERNS` / `isInfraSecret` in
// secret-store.ts. The same set is used there to keep these names out of the
// agent's session briefing + tool-input secret resolution (exfil guard), so
// the write deny-list and the agent-invisible set can never drift apart.
function isAdminOnlySecret(name: string): boolean {
  return isInfraSecret(name);
}

/**
 * Config fields a managed-tier user can change via PUT /api/config. Everything
 * else (cost caps, OAuth client ids, search/embedding/backup config, etc.) is
 * CP-managed — letting a customer flip those would allow billing-drain,
 * search/OAuth hijacking, and so on. Allowlist (not blocklist) so future
 * config fields fail closed.
 */
const MANAGED_USER_WRITABLE_CONFIG = new Set([
  'display_name',
  'experience',
  'thinking_mode',
  'effort_level',
  'changeset_review',
  'memory_auto_scope',
  'greeting',
  'memory_extraction',
  'knowledge_graph_enabled',
  'tts_voice',
  // GDPR compliance: a managed customer must be able to opt out of error
  // telemetry even when the CP supplies the Bugsink DSN. `bugsink_dsn` itself
  // stays locked (CP-managed endpoint), only the on/off toggle is user.
  'bugsink_enabled',
  // Sprint Settings-Refactor user-preference surfaces — none of these are
  // billing- or security-tier fields, so locking them out on managed left
  // the corresponding UI controls (context-window radios on LLM Advanced,
  // LiteLLM bookmarks, Tool-Toggles checkboxes) silently 403-ing on managed
  // tenants while appearing interactive. Each field can only reduce surface
  // or shape the user's own session — never widen blast radius.
  'max_context_window_tokens',  // LLM Advanced radios (200k / 500k / 1M) — caps the agent trim budget, no cost / capability impact on CP.
  // Sonnet-variant picker (LLM Advanced): which served Sonnet the `balanced`
  // tier resolves to (4.6 ↔ 5). A user-preference — same Anthropic provider,
  // ~same per-token price, debit auto-metered — so it shapes the user's own
  // session and never widens blast radius. The PUT handler additionally
  // validates the value against SERVED_BALANCED_SONNET_IDS (400 otherwise), so
  // an invalid/non-Sonnet id can never reach config even though the field is
  // user-writable.
  'balanced_model',
  // Main-chat model picker (standard mode): the band the main conversation runs
  // in (fast/balanced/deep → the provider's concrete model). Shapes the user's
  // own session and NEVER widens blast radius because the engine clamps it to
  // the CP-emitted `max_tier` ceiling (engine.ts ctor + reloadUserConfig). The
  // PUT handler additionally validates the value via `normalizeTier` (400
  // otherwise), so an unrecognised tier can never reach config.
  'default_tier',
  'custom_endpoints',           // LLM-settings bookmarks — UI sugar over api_base_url, engine still consumes api_base_url.
  'disabled_tools',             // Tool-Toggles — strictly narrows excludeTools, never widens.
  'context_cost_log',           // Diagnostic: opt-in content-free per-turn composition log to the instance's own data dir. Shapes only the user's own session, writes no content, never widens blast radius.
  // P3-FOLLOWUP-HOTFIX: provider switching between curated managed providers
  // (Anthropic + Mistral; future: openai-native). The value-range guard at
  // `enforceManagedProviderConstraints()` below caps the allowed set —
  // free-text endpoints (`provider='custom'` or `provider='openai'` with a
  // non-Mistral host) get rejected with a clear 403, never blanket-allowed.
  'provider',
  'api_base_url',
  'openai_model_id',
  'llm_mode',
  // Provider-agnostic routing (PR-4 follow-up). A managed tenant may switch
  // routing mode + assign a per-tier Tier-Set. The raw value is accepted here,
  // but `applyManagedTierSetConstraints` (config.ts, run at config-load on
  // cp_supplied tenants) is the security gate: it drops any off-allowlist
  // provider, strips tenant-supplied keys/base_urls, and sources the CP env
  // keys — so a tenant cannot point a slot at a free-text endpoint or inject a
  // key. Persisting the raw value is inert; the load-time transform sanitizes.
  'routing_mode',
  'tier_set',
]);

/**
 * On Managed, `provider` is constrained to a curated set so a customer
 * cannot point the engine at a free-text endpoint we'd then proxy traffic to.
 * Anthropic: always allowed (CP-pinned default). `openai` provider is allowed
 * ONLY when paired with the Mistral preset (`api_base_url ==='https://api.mistral.ai/v1'`).
 * `custom` / `vertex` are blocked on Managed (free-text or GCP-OAuth surfaces
 * the CP doesn't manage). Returns null when accepted, a 403-reason string
 * otherwise.
 */
// The curated providers a Managed tenant may select. NOTE: 'openai' here is
// NOT "use OpenAI" — it is the OpenAI-compatible PROTOCOL slot that the
// curated **Mistral** preset rides (Mistral speaks the OpenAI wire format).
// It is only accepted when paired with a Mistral host (below), so the real
// curated set is { Anthropic, Mistral }. There is no path to actual OpenAI
// or any other free-text endpoint on Managed.
const MANAGED_CURATED_PROVIDERS = new Set<string>(['anthropic', 'openai']);
const MANAGED_OPENAI_MISTRAL_HOSTS = new Set<string>([
  'https://api.mistral.ai/v1',
  'https://api.mistral.ai',
]);
// Every api_base_url a managed tenant may set: the curated Mistral preset hosts
// (for the openai-compat protocol slot) PLUS Anthropic's canonical host (the
// Anthropic provider default — normally sent empty/unset). Any other non-empty
// value is an attacker-controlled endpoint. Section 2 below enforces this
// allowlist for EVERY provider, not just openai.
const MANAGED_CURATED_HOSTS = new Set<string>([
  ...MANAGED_OPENAI_MISTRAL_HOSTS,
  'https://api.anthropic.com',
]);

function enforceManagedProviderConstraints(update: Record<string, unknown>): string | null {
  // 1. provider field present — must be in the curated allowlist (anthropic
  //    or openai-with-Mistral-host). 'custom' and 'vertex' are blocked outright.
  if ('provider' in update) {
    const provider = update['provider'];
    if (typeof provider !== 'string' || !MANAGED_CURATED_PROVIDERS.has(provider)) {
      return `Managed instance: provider '${String(provider)}' is not in the curated allowlist (Anthropic, Mistral preset).`;
    }
    if (provider === 'openai') {
      const baseUrl = update['api_base_url'];
      if (typeof baseUrl !== 'string' || !MANAGED_OPENAI_MISTRAL_HOSTS.has(baseUrl)) {
        return `Managed instance: provider 'openai' is only allowed with the curated Mistral preset api_base_url; got '${String(baseUrl)}'.`;
      }
    }
  }
  // 2. api_base_url present with ANY provider (or none) — a non-empty custom URL
  //    is only accepted when it is a curated host. Runs UNCONDITIONALLY on any
  //    api_base_url write (an earlier revision validated it only when no provider
  //    field was present, which left the field unguarded for a curated provider
  //    carrying an explicit endpoint). On managed the engine may only reach a
  //    curated endpoint regardless of provider. Empty/unset = the provider default.
  if ('api_base_url' in update) {
    const baseUrl = update['api_base_url'];
    if (typeof baseUrl === 'string' && baseUrl.length > 0 && !MANAGED_CURATED_HOSTS.has(baseUrl)) {
      return `Managed instance: cannot set api_base_url to '${baseUrl}' — only the curated Anthropic/Mistral endpoints are allowed.`;
    }
  }
  // 3. tier_set (hybrid routing) carries a per-slot api_base_url — the SAME
  //    endpoint surface as the top-level field. `applyManagedTierSetConstraints`
  //    (config.ts, run at loadConfig() on cp_supplied tenants) already strips slot
  //    base_urls + keys at READ time, and the engine's `_enforceEndpointAllowlist`
  //    backstop checks ONLY the top-level url (never slots) — so validate slots
  //    here too, at WRITE time, rather than resting entirely on the load-time
  //    sanitizer. Guarded surface == executed surface.
  const tierSet = update['tier_set'];
  if (tierSet && typeof tierSet === 'object') {
    for (const [tier, slot] of Object.entries(tierSet as Record<string, unknown>)) {
      if (!slot || typeof slot !== 'object') continue;
      const slotUrl = (slot as Record<string, unknown>)['api_base_url'];
      if (typeof slotUrl === 'string' && slotUrl.length > 0 && !MANAGED_CURATED_HOSTS.has(slotUrl)) {
        return `Managed instance: tier_set slot '${tier}' api_base_url '${slotUrl}' is not a curated Anthropic/Mistral endpoint.`;
      }
    }
  }
  return null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

function errorResponse(res: ServerResponse, status: number, message: string): void {
  jsonResponse(res, status, { error: message });
}

/**
 * Deny a request on a control-plane-managed instance. These routes export data
 * off-box or run instance-wide data lifecycle that the control plane owns, so
 * they must never be reachable by a managed customer — this billing-tier guard
 * is that boundary, enforced independently of route scope. Mirrors the inline
 * guard already on /api/vault/* + /api/auth/token.
 *
 * This is a deny-list: any NEW route that exports data off-box or mutates
 * instance-wide state MUST add this guard.
 */
function denyOnManagedInstance(res: ServerResponse, what: string): boolean {
  if (readEnvAlias('LYNOX_BILLING_TIER')) {
    errorResponse(res, 403, `Managed instance: ${what} is system-controlled`);
    return true;
  }
  return false;
}

/**
 * True if an uploaded non-image file is a binary document rather than text.
 * Decoding a binary (Word/PDF/Excel) as UTF-8 and shoving it into the model
 * context injects garbage and burns tokens; the upload path should reject it
 * with a clear message instead. Per-format text extraction (mammoth for .docx,
 * a PDF parser, …) is a separate feature.
 */
export function looksBinaryUpload(buf: Buffer): boolean {
  if (buf.length >= 4) {
    const [b0, b1, b2, b3] = buf;
    // "PK" + a real ZIP record signature (local-file 03 04, central-dir 01 02,
    // EOCD 05 06, spanned 07 08) — requiring b2/b3 avoids rejecting plain text
    // that merely starts with the letters "PK" (e.g. "PKW", a firm named "PK").
    if (b0 === 0x50 && b1 === 0x4b &&
        ((b2 === 0x03 && b3 === 0x04) || (b2 === 0x01 && b3 === 0x02) ||
         (b2 === 0x05 && b3 === 0x06) || (b2 === 0x07 && b3 === 0x08))) return true; // zip / OOXML (.docx/.xlsx/.pptx)
    if (b0 === 0x25 && b1 === 0x50 && b2 === 0x44 && b3 === 0x46) return true; // "%PDF"
    if (b0 === 0xd0 && b1 === 0xcf && b2 === 0x11 && b3 === 0xe0) return true; // OLE compound (legacy .doc/.xls/.ppt)
  }
  // Generic heuristic: a NUL byte, or a high ratio of control bytes in the head,
  // means it isn't text. Sample the first 4KB to stay O(1) on large uploads.
  const sample = buf.subarray(0, 4096);
  if (sample.length === 0) return false;
  let suspicious = 0;
  for (const b of sample) {
    if (b === 0) return true;
    if (b < 0x09 || (b > 0x0d && b < 0x20)) suspicious++;
  }
  return suspicious / sample.length > 0.1;
}

/** Type-guard that sends 503 if the service is null/undefined. Caller must `return` after a false result. */
function requireService<T>(res: ServerResponse, service: T | null | undefined, name: string): service is NonNullable<T> {
  if (service === null || service === undefined) errorResponse(res, 503, `${name} not available`);
  return service !== null && service !== undefined;
}

/**
 * Constant-time secret comparison that does NOT leak length via early return.
 * Use this in auth paths instead of `a.length === b.length && timingSafeEqual(a, b)`
 * — the latter short-circuits on length mismatch in a way that an attacker can
 * measure to learn the server-side secret length.
 *
 * Strategy: zero-pad the input to the expected length, run timingSafeEqual on
 * equal-width buffers, then AND in the length-equality check. The total work
 * is the same regardless of input length.
 */
function constantTimeEqual(candidate: Buffer, expected: Buffer): boolean {
  const fixed = Buffer.alloc(expected.length);
  candidate.copy(fixed); // truncates if longer, zero-pads if shorter
  return timingSafeEqual(fixed, expected) && candidate.length === expected.length;
}

/** Cookie auth is user-scope → secret writes need the BYOK whitelist. Covers BYOK starter + managed pool. */
function requiresAdminSplitGate(value: string | undefined): boolean {
  return isHostedInstance(value);
}

/**
 * Predict whether an ask_secret call for the given name will be rejected by
 * the vault PUT (managed tier + name matches an admin-only infrastructure
 * pattern). Almost all agent-issued secrets pass — the predicate now fires
 * only for the narrow set of LYNOX_/MANAGED_/MAIL_ACCOUNT_/
 * GOOGLE_OAUTH_/SMTP_/IMAP_ infrastructure names.
 *
 * Exported so the session.promptSecret wire can short-circuit the UI prompt
 * for the rare admin-only cases AND unit tests can lock the predicate
 * without spinning up an SSE run. Reads the billing-tier env (canonical
 * `LYNOX_BILLING_TIER`, legacy `LYNOX_MANAGED_MODE`) at call time so test
 * setups can stub the env per case.
 */
export function predictManagedBlocked(name: string): boolean {
  return requiresAdminSplitGate(readEnvAlias('LYNOX_BILLING_TIER')) && isAdminOnlySecret(name);
}

/** Provider / cost-caps / integrations are CP-managed → PUT /api/config needs the field allowlist. Pool tiers only. */
function requiresConfigLockGate(value: string | undefined): boolean {
  return cpSuppliesLLMKey(value);
}

async function parseBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        req.destroy();
        reject(new Error('Body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw ? JSON.parse(raw) as unknown : null);
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Read raw bytes AND parsed JSON. Used by webhook routes that need to verify
 * HMAC signatures over the exact bytes sent by the provider — re-serializing
 * via JSON.stringify cannot reproduce those bytes byte-for-byte.
 */
async function parseBodyWithRaw(req: IncomingMessage, maxBytes: number): Promise<{ raw: string; parsed: unknown }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        req.destroy();
        reject(new Error('Body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) { resolve({ raw: '', parsed: null }); return; }
      try {
        resolve({ raw, parsed: JSON.parse(raw) as unknown });
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function parseDynamicRoute(scope: AuthScope, method: string, path: string, handler: RouteHandler): DynamicRoute {
  const paramNames: string[] = [];
  const pattern = path.replace(/:([^/]+)/g, (_match, name: string) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  return { method, scope, pattern: new RegExp(`^${pattern}$`), paramNames, handler };
}

// ── Server Class ─────────────────────────────────────────────────────────────

export class LynoxHTTPApi {
  private engine: Engine | null = null;
  private server: Server | null = null;
  private webUiHandler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null = null;
  private readonly sessionStore = new SessionStore();
  // Pending prompts now stored in PromptStore (SQLite) — no in-memory Maps
  // Per-session run tracking. `streamAlive=false` after the SSE connection
  // closes; if a pending prompt is then blocking the previous run, a fresh
  // /run can take it over instead of 409-looping forever (Bug 3).
  private readonly runningSessions = new Map<string, { streamAlive: boolean; takeover: () => void; lastEventAt: number }>();
  private readonly rateCounts = new Map<string, { count: number; resetAt: number }>();
  private readonly staticRoutes = new Map<string, RouteHandler>();
  /**
   * Parallel scope map for static routes. Kept separate from
   * `staticRoutes` so the existing `Map<string, RouteHandler>` shape stays
   * stable for all existing call sites — see `addStatic` which writes
   * both. Lookup happens once per request in the dispatch path.
   */
  private readonly staticRouteScopes = new Map<string, AuthScope>();
  private readonly dynamicRoutes: DynamicRoute[] = [];
  private rateGcTimer: ReturnType<typeof setInterval> | null = null;
  private providerStatusCache: { data: ProviderStatus; expiresAt: number } | null = null;
  private healthCache: { data: Record<string, unknown>; expiresAt: number } | null = null;
  // 30 s TTL per (period, windowStart) key. Usage Dashboard typically re-opens
  // the tab with the same window multiple times in quick succession — this
  // keeps repeated SQLite scans off the hot path without stale-data risk, since
  // the period window itself rolls forward and evicts old entries.
  private readonly _usageSummaryCache = new Map<string, { summary: import('../core/run-history.js').UsageSummary; expiresAt: number }>();
  /** Test-only: drop cached usage summaries between tests so 30s TTL doesn't bleed mocks across cases. */
  public _clearUsageCache(): void { this._usageSummaryCache.clear(); }
  private pushChannel: import('../integrations/push/web-push-channel.js').WebPushNotificationChannel | null = null;
  // OAuth state previously lived as `_googleOAuthState` + `_googleRedirectUri`
  // instance fields, which:
  //   1. raced when two OAuth attempts started in parallel (second overwrote first)
  //   2. wasn't tied to the requesting user-agent, so any caller who knew the
  //      state could complete the callback
  // The state now travels in an HMAC-signed cookie set on /api/google/auth and
  // verified on /api/google/callback (sameSite=lax for the cross-site OAuth
  // dance, HttpOnly, Path scoped to the callback, 10-minute TTL).

  /** Whether the Web UI handler is loaded (determines default port and bind behavior). */
  hasWebUi(): boolean { return this.webUiHandler !== null; }

  // ── Route registration helpers ─────────────────────────────────────────────
  // Replaces direct `staticRoutes.set` / `dynamicRoutes.push` calls so every
  // route declares its scope at the registration site. The dispatcher reads
  // scope off the matched route; there's no separate `requiresAdmin(method,
  // pathname)` enumeration to drift out of sync.

  /** Register a fixed-path route. Scope MUST be set per route. */
  private addStatic(scope: AuthScope, key: string, handler: RouteHandler): void {
    this.staticRoutes.set(key, handler);
    this.staticRouteScopes.set(key, scope);
  }

  /** Register a parameterised route (`/api/x/:id`). Scope MUST be set per route. */
  private addDynamic(scope: AuthScope, method: string, path: string, handler: RouteHandler): void {
    this.dynamicRoutes.push(parseDynamicRoute(scope, method, path, handler));
  }

  /**
   * Look up the matched route's scope. Returns `null` if no route matches —
   * the dispatcher uses this to decide whether to 404 or 403.
   *
   * Trailing-slash variants of admin paths return the canonical scope even
   * though the dispatcher's own router 404s them today. Reason: if a
   * future router normalisation makes `POST /api/mail/accounts/` route to
   * the same handler as `POST /api/mail/accounts`, the admin gate must
   * still fire. The previous path-prefix enumeration had this guarantee
   * by accident (it tested `pathname === '…/'`); we keep it here by
   * intent.
   */
  private _lookupRouteScope(method: string, pathname: string): AuthScope | null {
    const dispatchMethods = method === 'HEAD' ? ['HEAD', 'GET'] : [method];
    const candidates: string[] = [pathname];
    if (pathname.endsWith('/') && pathname.length > 1) {
      candidates.push(pathname.slice(0, -1));
    }
    for (const candidate of candidates) {
      const key = `${method} ${candidate}`;
      const staticScope = this.staticRouteScopes.get(key)
        ?? (method === 'HEAD' ? this.staticRouteScopes.get(`GET ${candidate}`) : undefined);
      if (staticScope !== undefined) return staticScope;
      for (const route of this.dynamicRoutes) {
        if (!dispatchMethods.includes(route.method)) continue;
        if (route.pattern.test(candidate)) return route.scope;
      }
    }
    return null;
  }

  /** Collect system + process metrics for the health endpoint. Cached 10s. */
  private async _collectHealthMetrics(): Promise<Record<string, unknown>> {
    const now = Date.now();
    if (this.healthCache && this.healthCache.expiresAt > now) return this.healthCache.data;

    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    const load = loadavg();

    let diskTotalGb: number | undefined;
    let diskUsedGb: number | undefined;
    try {
      const stats = await statfs('/');
      const totalBytes = stats.blocks * stats.bsize;
      const freeBytes = stats.bavail * stats.bsize;
      diskTotalGb = Math.round((totalBytes / (1024 ** 3)) * 10) / 10;
      diskUsedGb = Math.round(((totalBytes - freeBytes) / (1024 ** 3)) * 10) / 10;
    } catch { /* disk metrics unavailable (e.g. read-only root without statfs) */ }

    const threadStore = this.engine?.getThreadStore();
    const threadCount = threadStore ? threadStore.listThreads({ limit: 200 }).length : 0;

    // BUILD_SHA is baked into the production Dockerfile via --build-arg.
    // Empty in dev images and any locally-built container that didn't pass
    // the arg, so we expose it as `build_sha: null` in those cases — null
    // means "version-only verification, no SHA gate". UpdateManager reads
    // this for non-semver rollouts (`:staging`, `:latest`) where PKG_VERSION
    // alone can't distinguish two builds.
    // Trim guards against whitespace-only env values (a CI typo or a
    // misconfigured docker-compose file) that would otherwise surface as a
    // non-null garbage SHA and force every rollout into the rollback path.
    const buildSha = (process.env['BUILD_SHA'] ?? '').trim();
    const data: Record<string, unknown> = {
      status: 'ok',
      version: PKG_VERSION,
      build_sha: buildSha.length > 0 ? buildSha : null,
      uptime_s: Math.floor(process.uptime()),
      process: {
        memory_used_mb: Math.round(mem.heapUsed / (1024 * 1024)),
        memory_rss_mb: Math.round(mem.rss / (1024 * 1024)),
        cpu_user_ms: Math.round(cpu.user / 1000),
        cpu_system_ms: Math.round(cpu.system / 1000),
      },
      system: {
        memory_total_mb: Math.round(totalmem() / (1024 * 1024)),
        memory_free_mb: Math.round(freemem() / (1024 * 1024)),
        load_avg_1m: Math.round(load[0]! * 100) / 100,
        load_avg_5m: Math.round(load[1]! * 100) / 100,
        ...(diskTotalGb !== undefined ? { disk_total_gb: diskTotalGb, disk_used_gb: diskUsedGb } : {}),
      },
      engine: {
        active_sessions: this.runningSessions.size,
        total_threads: threadCount,
      },
    };

    this.healthCache = { data, expiresAt: now + 10_000 };
    return data;
  }

  async init(): Promise<void> {
    const config = loadConfig();
    this.engine = new Engine({
      model: config.default_tier,
      language: config.language,
      context: { id: 'http-api', name: 'lynox', source: 'pwa', workspaceDir: '' },
    });
    await this.engine.init();
    this.engine.startWorkerLoop();
    this._registerRoutes();
    await this._initPushChannel();
    await this._tryLoadWebUiHandler();
  }

  private async _initPushChannel(): Promise<void> {
    try {
      const { WebPushNotificationChannel } = await import('../integrations/push/web-push-channel.js');
      const { getLynoxDir } = await import('../core/config.js');
      const dataDir = getLynoxDir();
      this.pushChannel = new WebPushNotificationChannel(dataDir);
      this.engine!.getNotificationRouter().register(this.pushChannel);
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[http-api] push notifications unavailable: ${detail}\n`);
    }
  }

  // ── Web UI handler (optional) ─────────────────────────────────────────

  private async _tryLoadWebUiHandler(): Promise<void> {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const candidates: string[] = [];

    // 1. Explicit path via env var (Docker / custom deploy)
    if (process.env['LYNOX_WEBUI_HANDLER']) {
      candidates.push(process.env['LYNOX_WEBUI_HANDLER']);
    }
    // 2. Docker layout: /app/dist/server/ → /app/web-ui/handler.js
    candidates.push(join(thisDir, '../../web-ui/handler.js'));
    // 3. Monorepo dev (after build): src/server/ → packages/web-ui/build/handler.js
    candidates.push(join(thisDir, '../../packages/web-ui/build/handler.js'));

    for (const candidate of candidates) {
      try {
        const abs = resolve(candidate);
        accessSync(abs); // fast existence check before dynamic import
        // The SvelteKit handler snapshots process.env at module-init time
        // (server.init() → set_private_env). LYNOX_HTTP_SECRET MUST be set
        // BEFORE the import() below, or the Web UI auth gate sees no secret
        // and disables itself while the engine API still enforces — the
        // "Sitzung abgelaufen" wall on a fresh npx first run. Idempotent: a
        // no-op when the secret is already set (Docker exports it pre-spawn).
        ensureHttpSecret();
        const mod = await import(pathToFileURL(abs).href) as { handler?: unknown };
        if (typeof mod.handler === 'function') {
          this.webUiHandler = mod.handler as (req: IncomingMessage, res: ServerResponse) => Promise<void>;
          process.stderr.write(`Web UI loaded from ${abs}\n`);
          return;
        }
      } catch { /* try next */ }
    }
    // No handler found — engine-only mode (not an error)
  }

  // ── Session cookie verification (shared auth with Web UI) ─────────────
  //
  // The Web UI mints the cookie via packages/web-ui/src/lib/server/auth.ts
  // (`createSessionToken`). Both sides MUST use the same TTL or the cookie
  // dies silently from the user's perspective: SvelteKit's `load`
  // validates the cookie as fresh (loads /app), but every `/api/*` call
  // 401s and the user sees the session-expired banner with the engine
  // showing as healthy. Keep `SESSION_MAX_AGE_S` aligned with
  // `packages/web-ui/src/lib/server/auth.ts`.
  //
  // Rolling refresh: once the cookie's timestamp is older than
  // SESSION_REFRESH_AFTER_S we mint a fresh one on the next successful
  // verify and emit it via Set-Cookie. Keeps active users immune to Safari
  // ITP eviction (the cookie's stored age stays low enough not to be a
  // pruning candidate).

  private static readonly SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;
  private static readonly SESSION_REFRESH_AFTER_S = 24 * 60 * 60;
  private static readonly SESSION_COOKIE_NAME = 'lynox_session';

  /** Returns the cookie's issued-at unix-sec on success, null on any failure.
   *  Caller uses the timestamp to decide whether to roll a fresh cookie. */
  private _verifySessionCookie(req: IncomingMessage, secret: string): number | null {
    const cookieHeader = req.headers['cookie'];
    if (!cookieHeader) return null;

    const match = cookieHeader.match(/(?:^|;\s*)lynox_session=([^;]+)/);
    if (!match?.[1]) return null;

    const token = decodeURIComponent(match[1]);
    const parts = token.split('.');
    if (parts.length < 2 || parts.length > 3) return null;

    const sig = parts[parts.length - 1]!;
    const payload = parts.slice(0, -1).join('.');
    // Timestamp: last element before sig (supports old ts.hmac and new nonce.ts.hmac)
    const tsStr = parts.length === 3 ? parts[1]! : parts[0]!;

    const timestamp = parseInt(tsStr, 10);
    if (Number.isNaN(timestamp)) return null;
    if (Math.floor(Date.now() / 1000) - timestamp > LynoxHTTPApi.SESSION_MAX_AGE_S) return null;

    try {
      const key = createHmac('sha256', 'lynox-session').update(secret).digest();
      const expected = createHmac('sha256', key).update(payload).digest('hex');
      const sigBuf = Buffer.from(sig, 'hex');
      const expBuf = Buffer.from(expected, 'hex');
      // Always run timingSafeEqual against equal-length buffers — the length
      // mismatch early-return previously short-circuited the comparison in
      // a way that leaked sig length to an attacker measuring response time.
      const fixed = Buffer.alloc(expBuf.length);
      sigBuf.copy(fixed); // truncates or zero-pads to expBuf.length
      const matched = timingSafeEqual(fixed, expBuf);
      return matched && sigBuf.length === expBuf.length ? timestamp : null;
    } catch {
      return null;
    }
  }

  /**
   * Append a Set-Cookie value, preserving any cookies already queued on
   * this response. Direct `res.setHeader('Set-Cookie', x)` would clobber
   * an earlier rolling-refresh or OAuth cookie minted in the same request.
   */
  private static _appendSetCookie(res: ServerResponse, value: string): void {
    const existing = res.getHeader('Set-Cookie');
    if (Array.isArray(existing)) {
      res.setHeader('Set-Cookie', [...existing, value]);
    } else if (typeof existing === 'string') {
      res.setHeader('Set-Cookie', [existing, value]);
    } else {
      res.setHeader('Set-Cookie', value);
    }
  }

  /**
   * Mint a fresh `lynox_session` cookie if the just-verified one has
   * crossed SESSION_REFRESH_AFTER_S. Format matches the Web UI's
   * `createSessionToken`: `<nonce>.<ts>.<hmac>`.
   *
   * `trustProxy` mirrors the gate used for `x-forwarded-for` (managed
   * deployments behind Traefik) — without it, an unprotected self-hosted
   * instance could be tricked by a client-supplied `X-Forwarded-Proto:
   * http` header to drop the `Secure` attribute, enabling MITM cookie
   * theft. When the proxy isn't trusted we still detect TLS via
   * `socket.encrypted` for direct-termination deployments.
   */
  private _maybeRefreshSessionCookie(
    req: IncomingMessage,
    res: ServerResponse,
    secret: string,
    cookieIssuedAt: number,
    trustProxy: boolean,
  ): void {
    const ageSec = Math.floor(Date.now() / 1000) - cookieIssuedAt;
    if (ageSec < LynoxHTTPApi.SESSION_REFRESH_AFTER_S) return;

    const key = createHmac('sha256', 'lynox-session').update(secret).digest();
    const nonce = randomBytes(8).toString('hex');
    const ts = Math.floor(Date.now() / 1000).toString();
    const payload = `${nonce}.${ts}`;
    const hmac = createHmac('sha256', key).update(payload).digest('hex');
    const token = `${payload}.${hmac}`;

    let isTls = false;
    if (req.socket && 'encrypted' in req.socket && req.socket.encrypted === true) {
      isTls = true;
    } else if (trustProxy) {
      const forwardedProto = req.headers['x-forwarded-proto'];
      const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
      if (proto === 'https') isTls = true;
    }

    const attrs = [
      `${LynoxHTTPApi.SESSION_COOKIE_NAME}=${token}`,
      'Path=/',
      'HttpOnly',
      // Lax (not Strict) — see web-ui setSessionCookie comment. Strict made
      // top-level cross-site GETs to /login NOT carry the cookie; the load()
      // redirect therefore couldn't catch a still-valid session on first
      // paint, and the user only got bounced to /app after submitting the OTP
      // form (looked like a bypass even though the cookie was genuine). Lax
      // sends cookie on safe-method cross-site nav; CSRF on POST/PUT/DELETE
      // is still blocked because Lax doesn't attach the cookie to cross-site
      // form submissions. Rolling-refresh path must mirror the original
      // login mint or each /api/* call would re-stamp Strict.
      'SameSite=Lax',
      `Max-Age=${LynoxHTTPApi.SESSION_MAX_AGE_S}`,
    ];
    if (isTls) attrs.push('Secure');

    LynoxHTTPApi._appendSetCookie(res, attrs.join('; '));
  }

  // ── Google OAuth state cookie (CSRF guard for /api/google/callback) ───
  //
  // Cookie format: `<state>.<ts>.<hmac>`. State is a UUID (no dots), ts is a
  // unix-second integer, hmac uses HKDF-style key derivation off
  // LYNOX_HTTP_SECRET (purpose "lynox-oauth-state") to keep the OAuth secret
  // separate from the session-cookie secret. 10-minute TTL — long enough for
  // any human OAuth flow, short enough that a stolen cookie expires before
  // it's useful.

  private static readonly OAUTH_STATE_COOKIE = 'lynox_oauth_state';
  private static readonly OAUTH_STATE_TTL_SEC = 10 * 60;

  private _signOAuthStateCookie(state: string, secret: string): string {
    const ts = Math.floor(Date.now() / 1000).toString();
    const payload = `${state}.${ts}`;
    const key = createHmac('sha256', 'lynox-oauth-state').update(secret).digest();
    const sig = createHmac('sha256', key).update(payload).digest('hex');
    return `${payload}.${sig}`;
  }

  private _verifyOAuthStateCookie(req: IncomingMessage, secret: string): string | null {
    const cookieHeader = req.headers['cookie'];
    if (!cookieHeader) return null;
    const matched = cookieHeader.match(new RegExp(`(?:^|;\\s*)${LynoxHTTPApi.OAUTH_STATE_COOKIE}=([^;]+)`));
    if (!matched?.[1]) return null;

    const token = decodeURIComponent(matched[1]);
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [stateRaw, tsStr, sig] = parts;
    if (!stateRaw || !tsStr || !sig) return null;

    const ts = parseInt(tsStr, 10);
    if (Number.isNaN(ts)) return null;
    if (Math.floor(Date.now() / 1000) - ts > LynoxHTTPApi.OAUTH_STATE_TTL_SEC) return null;

    try {
      const key = createHmac('sha256', 'lynox-oauth-state').update(secret).digest();
      const expected = createHmac('sha256', key).update(`${stateRaw}.${tsStr}`).digest('hex');
      const sigBuf = Buffer.from(sig, 'hex');
      const expBuf = Buffer.from(expected, 'hex');
      if (sigBuf.length !== expBuf.length) return null;
      return timingSafeEqual(sigBuf, expBuf) ? stateRaw : null;
    } catch {
      return null;
    }
  }

  private _buildOAuthStateSetCookie(state: string, secret: string): string {
    const value = this._signOAuthStateCookie(state, secret);
    // SameSite=Lax so the cookie survives the Google → callback redirect.
    // Strict would drop it, Lax preserves it for top-level GET (which is
    // exactly the callback redirect's request mode).
    return `${LynoxHTTPApi.OAUTH_STATE_COOKIE}=${encodeURIComponent(value)}; Path=/api/google/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=${LynoxHTTPApi.OAUTH_STATE_TTL_SEC}`;
  }

  private _clearOAuthStateCookie(): string {
    return `${LynoxHTTPApi.OAUTH_STATE_COOKIE}=; Path=/api/google/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
  }

  /**
   * Backs `/api/usage/current` (canonical) and `/api/usage/summary` (alias).
   * Aggregates RunHistory over the requested period and decorates with
   * tier-aware budget, projection (linear extrapolation from the last 7
   * days of `daily` data), and hard_limits (full numeric on self-host/BYOK,
   * opaque on managed).
   */
  private async _serveUsageCurrent(
    req: IncomingMessage,
    res: ServerResponse,
    engine: Engine,
  ): Promise<void> {
    const history = engine.getRunHistory();
    if (!requireService(res, history, 'History')) return;
    const { readUserConfig } = await import('../core/config.js');
    const { getHardLimits } = await import('../core/limits.js');
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const rawPeriod = url.searchParams.get('period') ?? 'current';
    const period = rawPeriod === 'prev' || rawPeriod === '7d' || rawPeriod === '30d' ? rawPeriod : 'current';

    const now = new Date();
    let startIso: string;
    let endIso: string;
    let source: 'calendar-month' | 'rolling' | 'stripe-billing';
    let label: string;
    const monthFmt = (d: Date) => d.toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

    if (period === 'current') {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      startIso = start.toISOString();
      endIso = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
      source = 'calendar-month';
      label = `${monthFmt(start)} – ${monthFmt(now)}`;
    } else if (period === 'prev') {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      startIso = start.toISOString();
      endIso = end.toISOString();
      source = 'calendar-month';
      const lastDay = new Date(end.getTime() - 86_400_000);
      label = `${monthFmt(start)} – ${monthFmt(lastDay)}`;
    } else {
      const days = period === '7d' ? 7 : 30;
      const start = new Date(now.getTime() - days * 86_400_000);
      startIso = start.toISOString();
      endIso = now.toISOString();
      source = 'rolling';
      label = `${monthFmt(start)} – ${monthFmt(now)}`;
    }

    const config = readUserConfig();
    const tier = readEnvAlias('LYNOX_BILLING_TIER') ?? null;
    const isManagedTier = cpSuppliesLLMKey(tier);

    interface CpSummary {
      managed: boolean;
      tier?: string;
      budget_cents?: number;
      topup_cents?: number;
      available_cents?: number;
      used_cents?: number;
      balance_cents?: number;
      period?: { start_iso: string; end_iso: string; source: 'stripe-billing' } | null;
    }
    let cpSummary: CpSummary | null = null;
    if (isManagedTier && period === 'current') {
      const { fetchControlPlaneUsageSummary } = await import('../core/managed-usage-summary.js');
      cpSummary = await fetchControlPlaneUsageSummary();
      if (cpSummary?.managed && cpSummary.period) {
        startIso = cpSummary.period.start_iso;
        endIso = cpSummary.period.end_iso;
        source = 'stripe-billing';
        const periodStart = new Date(startIso);
        const periodEnd = new Date(endIso);
        const lastDay = new Date(periodEnd.getTime() - 86_400_000);
        label = `${monthFmt(periodStart)} – ${monthFmt(lastDay)}`;
      }
    }

    const cacheKey = `${period}:${startIso}`;
    const cached = this._usageSummaryCache.get(cacheKey);
    const nowMs = Date.now();
    let summary;
    if (cached && cached.expiresAt > nowMs) {
      summary = cached.summary;
    } else {
      summary = history.getUsageSummary({ startIso, endIso, source, label });
      this._usageSummaryCache.set(cacheKey, { summary, expiresAt: nowMs + USAGE_SUMMARY_TTL_MS });
    }

    let budgetCents: number;
    if (cpSummary?.managed) {
      // Budget stays CP-driven (Stripe tier amount is the canonical truth);
      // `used_cents` is always recomputed from local `daily` below so it
      // stays consistent with the rest of the response shape (`by_kind`,
      // `daily`, and the StatusBar footer all read the same engine SQLite).
      // The CP-supplied `used_cents` was a separate counter that drifted to
      // 0 on staging — see commit message for the regression details.
      budgetCents = cpSummary.budget_cents ?? 0;
    } else if (isManagedTier) {
      budgetCents = 0;
    } else {
      budgetCents = typeof config.max_monthly_cost_usd === 'number'
        ? Math.round(config.max_monthly_cost_usd * 100)
        : 0;
    }

    // Available = included budget + genuine top-ups (credit packs). The
    // dashboard sizes its progress bar / remaining against this so a purchased
    // pack shows as real headroom instead of being clamped to the included
    // budget. Falls back to `budgetCents` for self-host/BYOK (no CP top-ups)
    // and for an older CP that doesn't yet send `available_cents`.
    const topupCents = cpSummary?.managed ? (cpSummary.topup_cents ?? 0) : 0;
    const availableCents = cpSummary?.managed
      ? (cpSummary.available_cents ?? budgetCents)
      : budgetCents;

    // SSoT: rebuild `used_cents` from `daily` entries (already done in
    // `getUsageSummary`, but the dashboard reads `used_cents` directly so
    // we re-derive here defensively in case a future caller mocks
    // `summary.used_cents` out of sync with `daily`).
    //
    // Managed-tier floor: if the CP supplied its own `used_cents` (Stripe-
    // canonical for the current billing window), take the MAX of local-sum
    // and CP-sum. Prevents under-reporting against Stripe when the engine
    // SQLite is younger than the Stripe billing cycle — post-migration,
    // post-restore, or any tenant whose engine was provisioned mid-cycle.
    // Self-hosted tenants have `cpSummary = null`, so this is a no-op for
    // the OSS path.
    const localUsedCents = summary.daily.reduce((sum, d) => sum + d.cost_cents, 0);
    const usedCents = cpSummary?.managed
      ? Math.max(localUsedCents, cpSummary.used_cents ?? 0)
      : localUsedCents;
    const projection = this._projectExhaust(summary.daily, usedCents, availableCents, endIso);
    const hardLimits = isManagedTier
      ? { tier: 'managed', contact_for_quotas: true }
      : getHardLimits();

    jsonResponse(res, 200, {
      tier,
      ...summary,
      used_cents: usedCents,
      budget_cents: budgetCents,
      topup_cents: topupCents,
      available_cents: availableCents,
      limit_cents: availableCents > 0 ? availableCents : null,
      projection,
      hard_limits: hardLimits,
    });
  }

  /**
   * Linear projection from the last 7 days of `daily` data — when (if ever)
   * the budget gets exhausted at the current pace. Returns null when there
   * is no limit set, no spend yet, or fewer than 2 days of data.
   */
  private _projectExhaust(
    daily: ReadonlyArray<{ date: string; cost_cents: number }>,
    usedCents: number,
    limitCents: number,
    periodEndIso: string,
  ): { exhaust_eta_iso: string | null; projection_basis_days: number } | null {
    if (limitCents <= 0 || usedCents <= 0 || daily.length < 2) return null;
    const window = daily.slice(-7).filter((d) => d.cost_cents > 0);
    if (window.length < 2) return null;
    const totalRecent = window.reduce((sum, d) => sum + d.cost_cents, 0);
    const dailyAvg = totalRecent / window.length;
    if (dailyAvg <= 0) return null;
    const remainingCents = limitCents - usedCents;
    if (remainingCents <= 0) {
      // Already exhausted.
      return { exhaust_eta_iso: new Date().toISOString(), projection_basis_days: window.length };
    }
    const daysRemaining = remainingCents / dailyAvg;
    const etaMs = Date.now() + daysRemaining * 86_400_000;
    const periodEndMs = new Date(periodEndIso).getTime();
    // Only return ETA if it falls before the period ends (otherwise the
    // user is on pace to finish under-budget — no projection needed).
    if (etaMs >= periodEndMs) return null;
    return { exhaust_eta_iso: new Date(etaMs).toISOString(), projection_basis_days: window.length };
  }

  async start(port: number): Promise<void> {
    // Web UI mode binds to 0.0.0.0 — without a secret, the engine API would
    // be reachable unauthenticated from any container network neighbour.
    // The secret is auto-generated (persisted to ~/.lynox/http-secret) inside
    // _tryLoadWebUiHandler() — BEFORE the SvelteKit handler is import()-ed —
    // so the Web UI auth gate and the engine API observe the same secret.
    // API-only mode loads no handler and keeps its localhost bind without a
    // secret as before.
    const secret = process.env['LYNOX_HTTP_SECRET'];

    const trustProxy = process.env['LYNOX_TRUST_PROXY'] === 'true';

    const handler = async (req: IncomingMessage, res: ServerResponse) => {
      const start = Date.now();

      // Security headers safe for all responses (API + Web UI)
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      if (useTls) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

      // Method filtering
      const method = req.method ?? 'GET';
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].includes(method)) {
        errorResponse(res, 405, `Method ${method} not allowed`);
        return;
      }

      // Resolve client IP (proxy-aware: trusts the proxy-appended rightmost
      // X-Forwarded-For hop, never the client-controllable left-most entry —
      // see client-ip.ts). Feeds the IP allowlist + request audit log.
      const clientIp = resolveClientIp(req, trustProxy);

      // IP allowlist check
      if (ALLOWED_IPS.length > 0) {
        if (!ALLOWED_IPS.includes(clientIp)) {
          errorResponse(res, 403, 'IP not allowed');
          return;
        }
      }

      try {
        await this._handleRequest(req, res, secret, clientIp, trustProxy);
      } catch (err: unknown) {
        if (!res.headersSent) {
          errorResponse(res, 500, 'Internal server error');
        }
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`HTTP API error: ${msg}\n`);
      }
      const url = req.url ?? '/';
      const status = res.statusCode;
      const ms = Date.now() - start;
      process.stderr.write(`${method} ${url} ${status} ${ms}ms\n`);
    };

    // TLS support: use HTTPS if cert + key provided
    const useTls = TLS_CERT && TLS_KEY;
    if (useTls) {
      try {
        const cert = readFileSync(TLS_CERT);
        const key = readFileSync(TLS_KEY);
        this.server = createTlsServer({ cert, key }, handler) as unknown as Server;
      } catch (err: unknown) {
        process.stderr.write(`TLS setup failed: ${err instanceof Error ? err.message : String(err)}\n`);
        process.stderr.write(`Falling back to plain HTTP.\n`);
        this.server = createServer(handler);
      }
    } else {
      this.server = createServer(handler);
    }

    // When Web UI is embedded, always bind to 0.0.0.0 (Web UI has session-cookie auth).
    // API-only mode: bind to 0.0.0.0 only with auth, else localhost only.
    const host = this.webUiHandler ? '0.0.0.0' : (secret ? '0.0.0.0' : '127.0.0.1');
    const protocol = useTls ? 'https' : 'http';

    // Refuse to expose Bearer tokens in plaintext (API-only mode without TLS).
    // When Web UI is embedded, auth uses session cookies — allow plain HTTP behind reverse proxy.
    if (secret && !useTls && !this.webUiHandler && process.env['LYNOX_ALLOW_PLAIN_HTTP'] !== 'true') {
      throw new Error(
        'Refusing to bind HTTP API on 0.0.0.0 without TLS — Bearer tokens would be sent in plaintext.\n'
        + 'Fix: set LYNOX_TLS_CERT + LYNOX_TLS_KEY, use a TLS reverse proxy, '
        + 'or set LYNOX_ALLOW_PLAIN_HTTP=true to override.',
      );
    }

    this.server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        process.stderr.write(`✗ Port ${port} is already in use.\n`);
        process.stderr.write(`  Try: LYNOX_HTTP_PORT=${port + 1} lynox\n`);
        process.exit(1);
      }
      throw err;
    });

    this.server.listen(port, host, () => {
      const authStatus = secret ? '(auth enabled)' : '(localhost only)';
      process.stderr.write(`lynox HTTP API listening on ${protocol}://${host}:${port} ${authStatus}\n`);
      if (ALLOWED_IPS.length > 0) {
        process.stderr.write(`  IP allowlist: ${ALLOWED_IPS.join(', ')}\n`);
      }
      if (secret && !useTls) {
        process.stderr.write(`⚠ Warning: HTTP API exposed without TLS (LYNOX_ALLOW_PLAIN_HTTP=true). Use a reverse proxy.\n`);
      }
      // Fire-and-forget Mistral account health check. Surfaces 401 (key
      // invalid), 402 (no credits), 429 (rate-limited) into stderr +
      // Bugsink so operators see the problem in the logs instead of
      // first hearing about it via a "Vorlesen fehlgeschlagen" report.
      void import('../core/mistral-health-check.js').then(({ reportMistralAccountHealth }) => reportMistralAccountHealth());
    });

    // Rate limit GC
    this.rateGcTimer = setInterval(() => {
      const now = Date.now();
      for (const [ip, entry] of this.rateCounts) {
        if (entry.resetAt < now) this.rateCounts.delete(ip);
      }
    }, 5 * 60_000);

    // Session idle eviction — prevents unbounded memory growth
    this.sessionStore.setRunningCheck((id) => this.runningSessions.has(id));
    this.sessionStore.startEviction();
  }

  async shutdown(): Promise<void> {
    if (this.rateGcTimer) clearInterval(this.rateGcTimer);
    this.sessionStore.stopEviction();
    // Expire all pending prompts in SQLite on shutdown
    this.engine?.getPromptStore()?.expireAll();
    this.server?.close();
    await this.engine?.shutdown();
  }

  // ── Request handling ─────────────────────────────────────────────────────

  private async _handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    secret: string | undefined,
    clientIp: string = 'unknown',
    trustProxy: boolean = false,
  ): Promise<void> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    // Accept both /api/v1/... and /api/... (normalize v1 prefix away for route matching)
    const pathname = url.pathname.startsWith('/api/v1/')
      ? '/api/' + url.pathname.slice('/api/v1/'.length)
      : url.pathname;

    // Health check (unauthenticated — used by container probes, Web UI status bar, and managed hosting monitor).
    // Returns system + process metrics (no user data, no thread content, no secrets — counters only).
    if (method === 'GET' && (pathname === '/health' || pathname === '/api/health')) {
      const health = await this._collectHealthMetrics();
      jsonResponse(res, 200, health);
      return;
    }

    // ── Non-API routes → Web UI handler (if available) ──────────────────
    // SvelteKit handles its own auth (session cookies), body parsing, and CSP.
    if (!pathname.startsWith('/api/') && this.webUiHandler) {
      await this.webUiHandler(req, res);
      return;
    }

    // ── API routes: security headers, auth, rate limiting, dispatch ──────
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'");

    // Provider status — cached Anthropic statuspage check (unauthenticated, public data)
    if (method === 'GET' && (pathname === '/api/provider/status')) {
      const status = await this.getProviderStatus();
      jsonResponse(res, 200, status);
      return;
    }

    // Multi-provider status — returns primary provider + any configured secondary
    // providers (Mistral fallback, TTS, etc.). Public, unauthenticated.
    if (method === 'GET' && (pathname === '/api/providers/status')) {
      const providers = await this.getProvidersStatus();
      jsonResponse(res, 200, { providers });
      return;
    }

    // Google OAuth callback — unauthenticated (browser redirect from Google).
    // CSRF protection is via the `state` parameter (HMAC-bound to a separate
    // SameSite=Lax state cookie scoped to /api/google/callback). The main
    // session cookie is now SameSite=Lax so it WOULD attach on this top-level
    // cross-site GET, but we still route this path as unauthenticated — the
    // OAuth state cookie + state-param verification is the authoritative
    // identity check at this entry point.
    if (method === 'GET' && pathname === '/api/google/callback') {
      const handler = this.staticRoutes.get('GET /api/google/callback');
      if (handler) { await handler(req, res, {}, null); return; }
    }

    // CORS — restrict to allowed origins (or allow all for localhost-only mode)
    const requestOrigin = req.headers['origin'] ?? '';
    // Localhost origins accepted in no-auth mode; with auth require explicit LYNOX_ALLOWED_ORIGINS
    const isLocalhostOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(requestOrigin);
    const corsOrigin = ALLOWED_ORIGINS.length > 0
      ? (ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin : '')
      : (secret ? '' : (isLocalhostOrigin ? requestOrigin : ''));

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }

    if (corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    }

    // Auth — Bearer token, session cookie, or migration token (same-origin Web UI).
    // Two-tier: LYNOX_HTTP_SECRET = user scope, LYNOX_HTTP_ADMIN_SECRET = admin scope.
    // When only LYNOX_HTTP_SECRET is set, it implicitly grants admin (backwards compat).
    // Migration endpoints accept X-Migration-Token as alternative auth (admin scope).
    let authScope: AuthScope = 'admin'; // default for no-secret (localhost) mode
    if (secret) {
      // Migration token auth — grants admin scope for /api/migration/* endpoints only
      const migrationToken = req.headers['x-migration-token'];
      const isMigrationEndpoint = pathname.startsWith('/api/migration/') && pathname !== '/api/migration/preview';
      if (isMigrationEndpoint && typeof migrationToken === 'string' && migrationToken.length === 64) {
        const storedToken = process.env['LYNOX_MIGRATION_TOKEN'];
        if (storedToken) {
          const { verifyMigrationToken } = await import('../core/migration-crypto.js');
          if (verifyMigrationToken(migrationToken, storedToken)) {
            authScope = 'admin';
          } else {
            errorResponse(res, 403, 'Invalid migration token');
            return;
          }
        } else {
          errorResponse(res, 403, 'No migration token configured');
          return;
        }
      } else {

      const auth = req.headers['authorization'] ?? '';
      const bearerToken = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const adminSecret = process.env['LYNOX_HTTP_ADMIN_SECRET'];

      if (bearerToken) {
        // Bearer token auth (external clients, MCP).
        // Avoid `len(a) !== len(b) && timingSafeEqual(a, b)` — the early-return
        // shape leaks server-secret length via response-time. Compare in
        // fixed-width buffers and fold the length-equality check into the
        // final boolean only after timingSafeEqual has run.
        const tokenBuf = Buffer.from(bearerToken);
        const secretBuf = Buffer.from(secret);

        if (adminSecret) {
          const adminBuf = Buffer.from(adminSecret);
          const isAdmin = constantTimeEqual(tokenBuf, adminBuf);
          const isUser = constantTimeEqual(tokenBuf, secretBuf);
          if (isAdmin) {
            authScope = 'admin';
          } else if (isUser) {
            authScope = 'user';
          } else {
            errorResponse(res, 401, 'Unauthorized');
            return;
          }
        } else {
          // Single-token mode — LYNOX_HTTP_SECRET grants admin
          if (!constantTimeEqual(tokenBuf, secretBuf)) {
            errorResponse(res, 401, 'Unauthorized');
            return;
          }
          authScope = 'admin';
        }
      } else {
        const cookieIssuedAt = this._verifySessionCookie(req, secret);
        if (cookieIssuedAt !== null) {
          // Session cookie auth (same-origin Web UI requests)
          authScope = adminSecret ? 'user' : 'admin';
          this._maybeRefreshSessionCookie(req, res, secret, cookieIssuedAt, trustProxy);
        } else {
          errorResponse(res, 401, 'Unauthorized');
          return;
        }
      }
      } // end migration-token else
    }

    // Admin scope check — read scope off the matched route's registration.
    // Falls through (no 403) for unmatched paths so the 404 path stays
    // reachable as a non-leaking response (consistent with the previous
    // behaviour where requiresAdmin returned false for unknown paths).
    {
      const routeScope = this._lookupRouteScope(method, pathname);
      if (routeScope === 'admin' && authScope !== 'admin') {
        errorResponse(res, 403, 'Admin scope required');
        return;
      }
    }

    // Content-Length check (guard against NaN/negative from malformed headers)
    const contentLength = parseInt(req.headers['content-length'] ?? '0', 10);
    if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > MAX_BODY_BYTES) {
      errorResponse(res, 413, 'Request body too large');
      return;
    }

    // Rate limiting (always applied — uses socket IP for loopback detection to prevent spoofing)
    {
      const socketIp = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
      const isLoopback = socketIp === '127.0.0.1' || socketIp === '::1';
      const limit = isLoopback ? RATE_MAX_LOOPBACK : RATE_MAX;
      const ip = clientIp;
      const now = Date.now();
      let rateEntry = this.rateCounts.get(ip);
      if (!rateEntry || rateEntry.resetAt < now) {
        rateEntry = { count: 0, resetAt: now + RATE_WINDOW_MS };
        this.rateCounts.set(ip, rateEntry);
      }
      rateEntry.count++;
      if (rateEntry.count > limit) {
        const retryAfter = Math.ceil((rateEntry.resetAt - now) / 1000);
        res.setHeader('Retry-After', String(retryAfter));
        errorResponse(res, 429, 'Too many requests');
        return;
      }
    }

    // Parse body for POST/PUT/PATCH/DELETE. DELETE carries a JSON body for
    // confirm-guarded destructive routes (e.g. DELETE /api/data's
    // { "confirm": "DELETE_ALL_DATA" } Right-to-Erasure gate) — without parsing
    // it the guard could never be satisfied and the route was unreachable. A
    // body-less DELETE parses to null (no Content-Type ⇒ no 415), so existing
    // DELETE routes are unaffected.
    let body: unknown = null;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const ct = (req.headers['content-type'] ?? '').split(';')[0]!.trim();
      if (ct && ct !== 'application/json') {
        errorResponse(res, 415, 'Content-Type must be application/json');
        return;
      }
      try {
        // Webhook routes need raw bytes for provider HMAC verification.
        // Attach rawBody to req so the route handler can read it back.
        if (pathname.startsWith('/api/webhooks/')) {
          const { raw, parsed } = await parseBodyWithRaw(req, MAX_BODY_BYTES);
          body = parsed;
          (req as IncomingMessage & { rawBody?: string }).rawBody = raw;
        } else {
          body = await parseBody(req, MAX_BODY_BYTES);
        }
      } catch {
        errorResponse(res, 400, 'Invalid request body');
        return;
      }
    }

    // Route dispatch — also try GET handler for HEAD requests (RFC 9110 §9.3.2)
    const routeKey = `${method} ${pathname}`;
    const staticHandler = this.staticRoutes.get(routeKey)
      ?? (method === 'HEAD' ? this.staticRoutes.get(`GET ${pathname}`) : undefined);
    if (staticHandler) {
      await staticHandler(req, res, {}, body);
      return;
    }

    const dispatchMethod = method === 'HEAD' ? ['HEAD', 'GET'] : [method];
    for (const route of this.dynamicRoutes) {
      if (!dispatchMethod.includes(route.method)) continue;
      const match = route.pattern.exec(pathname);
      if (match) {
        const params: Record<string, string> = {};
        for (let i = 0; i < route.paramNames.length; i++) {
          const name = route.paramNames[i];
          const value = match[i + 1];
          if (name !== undefined && value !== undefined) {
            params[name] = value;
          }
        }
        await route.handler(req, res, params, body);
        return;
      }
    }

    errorResponse(res, 404, 'Not found');
  }

  // ── Provider status (cached) ──────────────────────────────────────────────

  private async getProviderStatus(): Promise<ProviderStatus> {
    const now = Date.now();
    if (this.providerStatusCache && now < this.providerStatusCache.expiresAt) {
      return this.providerStatusCache.data;
    }

    const provider = getActiveProvider();

    // Pre-flight: is a key actually configured for the active provider? Pre-fix
    // the status bar showed "Anthropic · API OK" on every fresh self-host
    // install because this method only ever hit status.anthropic.com — that's
    // about Anthropic's endpoint health, not about whether the user has wired
    // their key. HN-launch user would see green, ignore the red SetupBanner
    // dot, then be confused why nothing works. `not-configured` is a distinct
    // indicator the StatusBar renders as amber "Setup needed".
    const store = this.engine?.getSecretStore();
    const userConfig = this.engine?.getUserConfig() ?? {};
    const managedMode = readEnvAlias('LYNOX_BILLING_TIER');
    // Only bypass the not-configured check for tiers where the CP supplies
    // the LLM key (managed / managed_pro / eu-sovereign). The Hosted-BYOK
    // starter tier requires the CUSTOMER to bring their own key, so the
    // not-configured signal MUST still surface — pre-fix the status bar
    // showed "API OK" on managed-BYOK with empty vault while SetupBanner
    // was simultaneously demanding the key, lying green on the indicator.
    const cpSuppliesKey = cpSuppliesLLMKey(managedMode);
    if (!cpSuppliesKey && store) {
      let configured = false;
      try {
        if (provider === 'vertex') {
          configured = !!(userConfig.gcp_project_id ?? process.env['GCP_PROJECT_ID'] ?? process.env['ANTHROPIC_VERTEX_PROJECT_ID']);
        } else if (provider === 'custom') {
          const customBase = userConfig.api_base_url ?? readEnvAlias('LYNOX_API_BASE_URL');
          const customKey = resolveProviderApiKey({ provider, apiBaseURL: userConfig.api_base_url, secretStore: store, userConfig });
          configured = !!customBase && !!customKey;
        } else if (provider === 'openai') {
          // Parity with GET /api/secrets/status (line ~2496): an OpenAI-compat
          // install needs base URL + key + model id. Missing any of the three
          // = unusable, so the status bar must reflect that. Without the
          // model-id check the two truth sources would disagree (SetupBanner
          // still demands setup while StatusBar already shows green).
          const openaiKey = resolveProviderApiKey({ provider, apiBaseURL: userConfig.api_base_url, secretStore: store, userConfig });
          // A loopback runtime (Ollama et al.) serves unauthenticated on the
          // user's own box. Demanding a key there would leave a perfectly
          // working local install stuck behind a banner it cannot satisfy.
          const openaiNeedsKey = endpointNeedsCredential(provider, userConfig.api_base_url);
          configured = !!userConfig.api_base_url && (!openaiNeedsKey || !!openaiKey) && !!userConfig.openai_model_id;
        } else {
          const anthropicKey = resolveProviderApiKey({ provider, apiBaseURL: userConfig.api_base_url, secretStore: store, userConfig });
          configured = !!anthropicKey;
        }
      } catch {
        // If the resolver throws (vault sealed, etc.) treat as not-configured —
        // honest signal for the user, never opaque "API OK".
        configured = false;
      }
      if (!configured) {
        const providerLabel = provider === 'anthropic' ? 'Anthropic'
          : provider === 'vertex' ? 'Google Vertex AI'
          : provider === 'openai' ? 'OpenAI-compatible'
          : 'Custom';
        const data: ProviderStatus = { indicator: 'not-configured', description: 'API key not configured', provider: providerLabel };
        this.providerStatusCache = { data, expiresAt: now + 30_000 };
        return data;
      }
    }

    // Custom + OpenAI providers have no public status page — rely solely on run history
    if (provider === 'custom' || provider === 'openai') {
      // Hostname-aware label: detect the well-known managed-EU preset (Mistral)
      // so the status bar reads 'Mistral' instead of the wire-format-internal
      // 'OpenAI-compatible'. Other openai-compat endpoints (Ollama, LiteLLM,
      // etc.) keep the generic label.
      const apiBaseURL = this.engine?.getUserConfig().api_base_url;
      let label = provider === 'openai' ? 'OpenAI-compatible' : 'Custom';
      if (provider === 'openai' && apiBaseURL) {
        try {
          const hostname = new URL(apiBaseURL).hostname.toLowerCase();
          if (hostname === 'api.mistral.ai') label = 'Mistral';
        } catch { /* malformed baseURL — fall through to generic label */ }
      }
      const data = this.getRunBasedStatus(now, label);
      this.providerStatusCache = { data, expiresAt: now + 60_000 };
      return data;
    }

    // Vertex AI uses Google Cloud status; Anthropic has native status page
    const statusUrl = provider === 'vertex'
      ? 'https://status.cloud.google.com/incidents.json'
      : 'https://status.anthropic.com/api/v2/status.json';
    const providerLabel = provider === 'vertex' ? 'Google Vertex AI' : 'Anthropic';

    // GCP incidents API has different format — fall back to run-history-based status
    if (provider === 'vertex') {
      const data = this.getRunBasedStatus(now, providerLabel);
      this.providerStatusCache = { data, expiresAt: now + 60_000 };
      return data;
    }

    const fallback: ProviderStatus = { indicator: 'unknown', description: 'Status unavailable', provider: providerLabel };
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(statusUrl, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        this.providerStatusCache = { data: fallback, expiresAt: now + 30_000 };
        return fallback;
      }

      const body = (await res.json()) as { status?: { indicator?: string; description?: string } };
      const indicator = body.status?.indicator;
      let resolvedIndicator: 'none' | 'minor' | 'major' | 'critical' | 'unknown' =
        indicator === 'none' || indicator === 'minor' || indicator === 'major' || indicator === 'critical'
          ? indicator : 'unknown';
      let description = body.status?.description ?? 'Unknown';

      // If the status page reports major/critical but our own recent runs succeeded,
      // downgrade to minor — the API is reachable from this engine despite the outage.
      if (resolvedIndicator === 'major' || resolvedIndicator === 'critical') {
        const history = this.engine?.getRunHistory();
        if (history) {
          const recent = history.getRecentRuns(1);
          const lastRun = recent[0];
          if (lastRun) {
            const lastRunTime = new Date(lastRun.created_at).getTime();
            const fiveMinAgo = now - 5 * 60_000;
            if (lastRunTime > fiveMinAgo && lastRun.status === 'completed') {
              resolvedIndicator = 'minor';
              description = `${description} (API responding locally)`;
            }
          }
        }
      }

      const data: ProviderStatus = { indicator: resolvedIndicator, description, provider: providerLabel };
      this.providerStatusCache = { data, expiresAt: now + 60_000 };
      return data;
    } catch {
      this.providerStatusCache = { data: fallback, expiresAt: now + 30_000 };
      return fallback;
    }
  }

  /** Derive provider status from recent run history (for providers without a public status page). */
  private getRunBasedStatus(now: number, providerLabel: string): ProviderStatus {
    const history = this.engine?.getRunHistory();
    if (!history) return { indicator: 'unknown', description: 'No run history', provider: providerLabel };

    const recent = history.getRecentRuns(1);
    const lastRun = recent[0];
    if (!lastRun) {
      // No runs yet — if the engine has an API key, assume operational (fresh instance)
      // Use dynamic check — import at module level would cause circular dependency
      const hasKey = !!(process.env['ANTHROPIC_API_KEY'] ?? process.env['AWS_ACCESS_KEY_ID'] ?? readEnvAlias('LYNOX_BILLING_TIER'));
      return hasKey
        ? { indicator: 'none', description: 'Ready', provider: providerLabel }
        : { indicator: 'unknown', description: 'No API key configured', provider: providerLabel };
    }

    const lastRunTime = new Date(lastRun.created_at).getTime();
    const fiveMinAgo = now - 5 * 60_000;

    if (lastRun.status === 'completed') {
      // Recent success = green, older success = neutral "OK" (not unknown)
      return lastRunTime > fiveMinAgo
        ? { indicator: 'none', description: 'All Systems Operational', provider: providerLabel }
        : { indicator: 'none', description: 'API OK', provider: providerLabel };
    }
    if (lastRun.status === 'failed') {
      return lastRunTime > fiveMinAgo
        ? { indicator: 'major', description: 'Last run failed', provider: providerLabel }
        : { indicator: 'minor', description: 'Last run failed (not recent)', provider: providerLabel };
    }
    return { indicator: 'none', description: 'Ready', provider: providerLabel };
  }

  // ── Multi-provider status ────────────────────────────────────────────────

  /**
   * Return status for every LLM provider currently configured on this instance.
   * The primary provider is the first entry; Mistral follows if MISTRAL_API_KEY
   * is set (used as fallback/worker in standard mode or primary in eu-sovereign).
   * Voxtral voice provider shares the Mistral key — if the key is present it is
   * already covered by the Mistral entry.
   */
  private async getProvidersStatus(): Promise<ProviderStatus[]> {
    const primary = await this.getProviderStatus();
    const list: ProviderStatus[] = [primary];

    // Mistral is present when MISTRAL_API_KEY is configured AND we are not
    // already reporting Mistral as the primary (eu-sovereign mode).
    const hasMistralKey = !!(process.env['MISTRAL_API_KEY']?.length);
    const primaryIsMistral = primary.provider?.toLowerCase().includes('mistral') ?? false;
    if (hasMistralKey && !primaryIsMistral) {
      list.push(this.getMistralStatus());
    }

    return list;
  }

  /**
   * Derive Mistral status from run history. Mistral does not publish a
   * Statuspage-compatible JSON endpoint, so we infer health from recent runs
   * whose model_id starts with "mistral".
   *
   * Healthy-config rule: when MISTRAL_API_KEY is configured but no Mistral
   * run has been recorded yet, return `none` ("Ready") — mirroring the
   * primary's `getRunBasedStatus` semantics for the same state. This is the
   * normal day-1 state for every prod tenant that has the EU-residency
   * fallback key set engine-side but hasn't toggled into Mistral yet.
   *
   * Pre-fix this returned `unknown` here, which the StatusBar aggregator
   * (severity-ranked unknown > none) then bubbled up over a fully healthy
   * Anthropic primary — surfacing in the UI as "Anthropic · API ?" despite
   * the API being fine. Caller (`getProvidersStatus`) only invokes this
   * function when the key IS present, so the key-existence precondition is
   * implicit.
   */
  private getMistralStatus(): ProviderStatus {
    const label = 'Mistral AI';
    const history = this.engine?.getRunHistory();
    if (!history) return { indicator: 'none', description: 'Ready', provider: label };

    const recent = history.getRecentRuns(50);
    const mistralRun = recent.find(r => r.model_id?.toLowerCase().startsWith('mistral'));

    if (!mistralRun) {
      return { indicator: 'none', description: 'Ready', provider: label };
    }

    const lastRunTime = new Date(mistralRun.created_at).getTime();
    const fiveMinAgo = Date.now() - 5 * 60_000;

    if (mistralRun.status === 'completed') {
      return lastRunTime > fiveMinAgo
        ? { indicator: 'none', description: 'All Systems Operational', provider: label }
        : { indicator: 'none', description: 'API OK (last success older than 5min)', provider: label };
    }
    if (mistralRun.status === 'failed') {
      return lastRunTime > fiveMinAgo
        ? { indicator: 'major', description: 'Last run failed', provider: label }
        : { indicator: 'minor', description: 'Last run failed (not recent)', provider: label };
    }
    return { indicator: 'none', description: 'Ready', provider: label };
  }

  // ── Route registration ───────────────────────────────────────────────────

  private _registerRoutes(): void {
    const engine = this.engine!;

    // ── Sessions ──
    this.addStatic('user', 'POST /api/sessions', async (_req, res, _params, body) => {
      const opts = body && typeof body === 'object' ? body as Record<string, unknown> : {};
      const rawThreadId = typeof opts['threadId'] === 'string' ? opts['threadId'] : undefined;
      // Resolve the resume id, accepting two shapes:
      //  • a UUID — lowercase-normalised BEFORE the check. SQLite TEXT PRIMARY KEY
      //    is case-sensitive (BINARY collation), so an uppercased UUID resend would
      //    mint a NEW sessionStore entry + a NEW thread row, silently forking
      //    history. `randomUUID()` always emits lowercase; normalising makes resume
      //    case-tolerant.
      //  • an `escalation-<key>` id — an agent-opened, RESUMABLE chat thread whose id
      //    is NOT a UUID. Used VERBATIM (never lowercased) so it matches the stored
      //    thread PK exactly. Rejecting these was the "conversation could not be
      //    opened" bug on agent-escalation threads.
      let threadId: string | undefined;
      if (rawThreadId !== undefined) {
        const lower = rawThreadId.toLowerCase();
        if (UUID_REGEX.test(lower)) {
          threadId = lower;
        } else if (ESCALATION_ID_REGEX.test(rawThreadId)) {
          threadId = rawThreadId;
        } else {
          errorResponse(res, 400, 'Invalid threadId — expected a UUID or escalation id');
          return;
        }
      }
      const sessionId = threadId ?? randomUUID();
      const session = this.sessionStore.getOrCreate(sessionId, engine, {
        model: typeof opts['model'] === 'string' ? normalizeTier(opts['model']) : undefined,
        // Provenance (P1, DEF-0095): the picker declares 'user' vs 'default'.
        // Only stamped for a genuinely NEW thread (createThread is OR IGNORE on
        // resume). Absent/invalid → 'unknown' at the ctor.
        source: normalizeThreadModelSource(opts['source']),
        effort: typeof opts['effort'] === 'string' ? opts['effort'] as 'low' | 'medium' | 'high' : undefined,
        systemPromptSuffix: WEB_UI_SYSTEM_PROMPT_SUFFIX,
      });
      const tier = session.getModelTier();
      const threadStore = engine.getThreadStore();
      const thread = threadStore?.getThread(sessionId);
      // Use the SAME effective window the agent itself uses (min of model
      // native and user's max_context_window_tokens cap). Pre-fix this
      // returned native only, so a session whose effective window was
      // smaller (or larger via 1M-beta) showed nonsense percentages in
      // the UI — staging 2026-05-18 saw "Kontext: 423%" because the UI
      // divided real tokensIn by a stale 200k while the engine had
      // applied a different cap. Single source of truth via models.ts.
      const sessionUserConfig = engine.getUserConfig();
      const userCap = sessionUserConfig.max_context_window_tokens;
      // Resolve the id under the ACTIVE provider, not the Anthropic MODEL_MAP —
      // otherwise a managed-Mistral / self-host session reported the Claude
      // window (200k) instead of its real one. The `?? MODEL_MAP[...]` fallback
      // still guards against a tier that slipped past normalization (e.g. a
      // legacy `model_tier` restored from a pre-rename thread) resolving to
      // undefined and crashing effectiveContextWindow.
      const sessionProvider = getActiveProvider();
      const modelId = getModelId(tier, sessionProvider) ?? MODEL_MAP[tier] ?? MODEL_MAP['balanced'];
      jsonResponse(res, 201, {
        sessionId,
        model: tier,
        // Provider + declared window so custom/BYOK/self-host (and managed
        // Mistral) report their real native window via the resolver SSOT.
        contextWindow: effectiveContextWindow(modelId, userCap, {
          provider: sessionProvider,
          declaredWindow: sessionUserConfig.openai_context_window,
        }),
        threadId: sessionId,
        resumed: !!threadId && !!thread,
      });
    });

    this.dynamicRoutes.push(parseDynamicRoute('user', 'DELETE', '/api/sessions/:id', async (_req, res, params) => {
      const session = this.sessionStore.get(params['id']!);
      if (!session) { errorResponse(res, 404, 'Session not found'); return; }
      session.abort();
      this.sessionStore.reset(params['id']!);
      jsonResponse(res, 200, { ok: true });
    }));

    // ── Runs (SSE) ──
    this.dynamicRoutes.push(parseDynamicRoute('user', 'POST', '/api/sessions/:id/run', async (req, res, params, body) => {
      const sessionId = params['id']!;
      const session = this.sessionStore.get(sessionId);
      if (!session) { errorResponse(res, 404, 'Session not found'); return; }

      // Stale-run takeover. A previous /run whose SSE stream has closed +
      // one of these holds → hand control to the new request:
      //   (a) parked on a pending prompt (Bug 3 — original case)
      //   (b) silent for >STALE_RUN_SILENCE_MS (cat 2026-05-19 — run stuck on
      //       a hanging http_request, no SSE activity, no pending prompt,
      //       session locked for 30 min until the engine's hard run cap).
      // Without (b), a hung tool call locks the session forever from the
      // client's perspective — every /run retry gets 409 until the 30-min
      // streamTimeout fires server-side.
      const STALE_RUN_SILENCE_MS = 60_000;
      const promptStoreEarly = this.engine?.getPromptStore();
      const existingSlot = this.runningSessions.get(sessionId);
      if (existingSlot && !existingSlot.streamAlive) {
        const hasPrompt = !!promptStoreEarly?.getPending(sessionId);
        const stale = Date.now() - existingSlot.lastEventAt > STALE_RUN_SILENCE_MS;
        if (hasPrompt || stale) {
          existingSlot.takeover();
          // Wait for the previous handler's `finally` to clear the slot.
          // Realistic drain after takeover() is sub-100 ms (one tick to
          // resolve waitForSettled, then session.run unwinds); the 1 s cap
          // bounds worker-tying if the previous handler is unexpectedly slow
          // to unwind. Falls through to a 409 if the slot still hasn't drained.
          const drainStart = Date.now();
          while (this.runningSessions.has(sessionId) && Date.now() - drainStart < 1000) {
            await new Promise<void>((r) => setTimeout(r, 25));
          }
        }
      }

      // Guard: reject concurrent runs on the same session
      if (this.runningSessions.has(sessionId)) {
        errorResponse(res, 409, 'A run is already in progress for this session');
        return;
      }

      // Global concurrency cap (Tier 2, AC6). Bound how many chat runs execute
      // at once across all threads — many parallel headless runs would otherwise
      // blow LLM cost + run-buffer memory (R3). Fail fast here (before the LLM
      // preflight + SSE headers) with a typed 429 the client surfaces as "too
      // many runs". The real reservation is executor.acquire() once the runId
      // exists; this early check is a fail-fast (a benign TOCTOU under the cap
      // is harmless on a single-tenant engine). A run already on THIS session is
      // a 409 above, so this only trips on a 6th *distinct* thread's run.
      const runExecutor = this.engine?.getRunExecutor();
      if (runExecutor?.atCapacity()) {
        jsonResponse(res, 429, { error: 'run_queue_full', capacity: runExecutor.capacity });
        return;
      }

      const b = body as Record<string, unknown> | null;
      const taskText = b && typeof b['task'] === 'string' ? b['task'] : '';
      if (!taskText) { errorResponse(res, 400, 'Missing task'); return; }

      // Chat-with-context entry (Slice C, §4.6 context-seam): a "💬 Bearbeiten"
      // (kind 'workflow') / "💬 Fixen" (kind 'run') button opens this run with a
      // typed `{kind,id}` reference to the object being worked on. The server
      // resolves it to a context preamble it prepends to the user's first
      // message — the reusable injection point, so any future "discuss this X"
      // entry passes the same shape and the server owns how each kind renders.
      // Best-effort: an unknown/foreign id yields no preamble and the chat still
      // runs. Single-tenant container ⇒ the id is always the tenant's own.
      let contextPreamble = '';
      const rawCtx = b?.['context'];
      if (rawCtx && typeof rawCtx === 'object' && !Array.isArray(rawCtx)) {
        const c = rawCtx as Record<string, unknown>;
        const ctxKind = c['kind'];
        let ref: ChatContextRef | null = null;
        if (
          (ctxKind === 'workflow' || ctxKind === 'run' || ctxKind === 'mail') &&
          typeof c['id'] === 'string' &&
          c['id'].length > 0
        ) {
          ref = { kind: ctxKind, id: c['id'] };
        } else if (ctxKind === 'mail-batch' && Array.isArray(c['ids'])) {
          // The "💬 N im Chat" bulk affordance — carries the selected item ids.
          const ids = c['ids'].filter((x): x is string => typeof x === 'string' && x.length > 0);
          if (ids.length > 0) ref = { kind: 'mail-batch', ids };
        }
        if (ref) {
          const preamble = resolveChatContext(
            engine.getRunHistory(),
            ref,
            engine.getInboxRuntime()?.state ?? null,
          );
          // Close the loaded-context block with an explicit boundary sentinel
          // before the user's own text. Two jobs: (1) it gives the model a clear
          // end-of-loaded-context marker (the block already OPENS with a
          // `[Loaded …]` line from resolveChatContext); (2) it lets the chat UI
          // strip the whole preamble on replay — the preamble is engine framing,
          // not the user's words, and without a boundary it leaks into the user
          // bubble on resume (the [Now:] marker has the same store-as-sent /
          // strip-at-render contract). The sentinel is UNFORGEABLE by field
          // content: every interpolated field passes chat-context.oneLine(),
          // which collapses newlines, so nothing but this template line can put
          // `[/loaded-context]` on its own line. MUST stay in sync with the
          // web-ui stripLoadedContext() matcher (packages/web-ui now-marker.ts).
          if (preamble) contextPreamble = `${preamble}\n${LOADED_CONTEXT_END}\n\n`;
        }
      }
      // Defense-in-depth: the client sanitises chat-over-bespoke framings, but
      // re-strip the EXOTIC line-separators server-side from any task text —
      // U+2028/U+2029/NEL/C1 + C0-controls are never legitimately typed, so
      // collapsing them to a space neutralises a pseudo-directive-on-its-own-line
      // injection that bypasses the client gate, WITHOUT touching legitimate
      // \n/\t/\r in a normal multi-line message.
      const safeTaskText = stripUntrustedSeparators(taskText);
      const composedTask = `${contextPreamble}${safeTaskText}`;

      // Pre-flight: provider key must be configured before we hand off to the
      // LLM SDK. Without this the Anthropic SDK throws deep inside
      // validateHeaders() ("Could not resolve authentication method ..."),
      // which surfaces in the UI as a stacktrace and lands in Bugsink as a
      // noisy "handled" error every time someone opens a BYOK demo tenant
      // without supplying a key. Symmetric with the `configured.api_key`
      // check in GET /api/secrets/status.
      const preflightStore = engine.getSecretStore();
      const preflightCfg = engine.getUserConfig();
      const preflightProvider = preflightCfg.provider ?? 'anthropic';
      let preflightKeyOk: boolean;
      if (preflightProvider === 'vertex') {
        preflightKeyOk = !!(preflightCfg.gcp_project_id ?? process.env['GCP_PROJECT_ID'] ?? process.env['ANTHROPIC_VERTEX_PROJECT_ID']);
      } else if (preflightProvider === 'custom') {
        const base = preflightCfg.api_base_url ?? readEnvAlias('LYNOX_API_BASE_URL');
        const key = preflightStore ? resolveProviderApiKey({ provider: preflightProvider, apiBaseURL: preflightCfg.api_base_url, secretStore: preflightStore, userConfig: preflightCfg }) : undefined;
        preflightKeyOk = !!base && !!key;
      } else if (preflightProvider === 'openai') {
        const key = preflightStore ? resolveProviderApiKey({ provider: preflightProvider, apiBaseURL: preflightCfg.api_base_url, secretStore: preflightStore, userConfig: preflightCfg }) : undefined;
        preflightKeyOk = !!preflightCfg.api_base_url
          && (!endpointNeedsCredential(preflightProvider, preflightCfg.api_base_url) || !!key)
          && !!preflightCfg.openai_model_id;
      } else {
        const key = preflightStore ? resolveProviderApiKey({ provider: preflightProvider, apiBaseURL: preflightCfg.api_base_url, secretStore: preflightStore, userConfig: preflightCfg }) : undefined;
        preflightKeyOk = !!key;
      }
      if (!preflightKeyOk) {
        errorResponse(res, 400, `No ${preflightProvider} API key configured. Open Settings → Providers and add one.`);
        return;
      }

      // Client-capability negotiation. protocol=2 enables one-shot multi-question
      // ask_user via `prompt_tabs` SSE event + /reply-tabs endpoint. Older or
      // legacy clients omit it and fall back to sequential per-question prompts.
      const clientProtocol = typeof b?.['protocol'] === 'number' ? b['protocol'] : 1;
      const tabsCapable = clientProtocol >= 2;

      // Optional per-run overrides (e.g. onboarding uses low effort)
      const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
      const runEffort = typeof b?.['effort'] === 'string' && VALID_EFFORTS.has(b['effort'])
        ? b['effort'] as import('../types/index.js').EffortLevel
        : undefined;
      const runThinking = b?.['thinking'] === 'disabled'
        ? { type: 'disabled' as const }
        : undefined;
      // Always an object so the Tier-2 eager-persist checkpoint hook can be
      // attached below (once runId + buffer exist). effort/thinking stay optional.
      const runOptions: import('../core/session.js').RunOptions = {
        ...(runEffort ? { effort: runEffort } : {}),
        ...(runThinking ? { thinking: runThinking } : {}),
      };

      // User's IANA timezone for the per-turn `[Now: …]` marker. The client
      // sends `Intl.DateTimeFormat().resolvedOptions().timeZone` per /run.
      // Allowlist is strict so the value can't break out of the marker.
      const rawTz = typeof b?.['tz'] === 'string' ? b['tz'] : '';
      const sanitisedTz = rawTz.length > 0 && rawTz.length <= TZ_MAX_LENGTH && TZ_PATTERN.test(rawTz)
        ? rawTz
        : '';
      if (sanitisedTz) session.userTimezone = sanitisedTz;

      // Build multimodal content if files are attached
      const files = Array.isArray(b?.['files']) ? b['files'] as { name: string; type: string; data: string }[] : [];
      let task: string | unknown[];
      if (files.length > 0) {
        const content: unknown[] = [];
        // 5 MB base64-payload cap (not decoded bytes), applied to every provider
        // as a conservative floor derived from Anthropic's vision limit. Reject
        // earlier with a typed error so the user sees a friendly message instead
        // of a raw provider 400. The frontend downscales to 1568px first, so a
        // real photo/screenshot lands far under this on any provider.
        const MAX_IMAGE_B64_BYTES = 5 * 1024 * 1024;
        const MAX_FILE_B64_BYTES = 10 * 1024 * 1024;
        const MAX_TEXT_FILE_DECODED_CHARS = 200_000;
        // Allowlist matches what Anthropic vision accepts AND what the frontend
        // resize path produces. Anything else here is either client tampering
        // or an unsupported format that we should reject before forwarding.
        const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
        for (const file of files) {
          if (typeof file.data !== 'string') {
            errorResponse(res, 400, `Invalid file: ${typeof file.name === 'string' ? file.name : 'unknown'}`); return;
          }
          // Sanitize file.name before any interpolation: it's user-controlled
          // (POST body), and naive interpolation into the LLM prompt as
          // `[File: ${name}]\n${text}` lets a crafted name break out of the
          // header line via an embedded line break and inject pseudo-system
          // text. sanitizeUploadFilename collapses C0 AND the exotic separators
          // (NEL/U+2028/U+2029/C1) a bare `[\r\n\x00-\x1f]` strip would miss,
          // and the same safeName flows into the knowledge-layer ingestion below.
          const safeName = sanitizeUploadFilename(typeof file.name === 'string' ? file.name : 'unknown');
          const rawType = typeof file.type === 'string' ? file.type : '';
          const isImage = rawType.startsWith('image/');
          if (isImage && !ALLOWED_IMAGE_TYPES.has(rawType)) {
            errorResponse(res, 415, `Unsupported image type: ${rawType}. Use JPEG, PNG, GIF, or WebP.`);
            return;
          }
          const limit = isImage ? MAX_IMAGE_B64_BYTES : MAX_FILE_B64_BYTES;
          if (file.data.length > limit) {
            const sizeMb = (file.data.length / (1024 * 1024)).toFixed(1);
            const limitMb = (limit / (1024 * 1024)).toFixed(0);
            const reason = isImage
              ? `Image too large: ${sizeMb} MB exceeds the ${limitMb} MB image limit. Resize or compress before uploading.`
              : `File too large: ${sizeMb} MB exceeds ${limitMb} MB limit.`;
            errorResponse(res, 413, reason);
            return;
          }
          if (isImage) {
            content.push({ type: 'image', source: { type: 'base64', media_type: rawType, data: file.data } });
          } else {
            // Non-image files: decode and include as text. Cap the decoded
            // size so a 10 MB base64 can't push ~7.5 MB of arbitrary text
            // straight into the model context.
            const buf = Buffer.from(file.data, 'base64');
            // U1: PDF / Word documents are extracted server-side instead of
            // being rejected. Unsupported binary formats (xlsx/pptx/legacy doc)
            // return null here and fall through to the 415 below.
            try {
              const extracted = await extractDocumentText(buf, safeName);
              if (extracted) {
                // The extracted body is untrusted third-party content (the doc
                // may have been authored by someone other than the uploader).
                // Strip the exotic separators (NEL/U+2028/U+2029/C1) that would
                // otherwise put a pseudo-directive on its own line — the same
                // hygiene the user's own message text and the watch page-text
                // get — before it is framed to the model AND persisted+recalled.
                const safeBody = stripUntrustedSeparators(extracted.text);
                content.push({ type: 'text', text: `[File: ${safeName}]\n${safeBody}` });
                // U1 persist+recall: store the document into the knowledge layer
                // (best-effort, OFF the request path) so it survives the turn and
                // is auto-recalled on later turns. Never awaited — embedding /
                // entity-extraction must not delay the chat turn; a failure just
                // means the document isn't recalled (its text was already inlined).
                const kl = this.engine?.getKnowledgeLayer();
                const docScope = pickDocumentScope(this.engine?.getActiveScopes() ?? []);
                if (kl && docScope) {
                  void ingestDocumentText(kl, {
                    text: safeBody,
                    fileName: safeName,
                    scope: docScope,
                    threadId: session.sessionId,
                  }).catch(() => { /* best-effort */ });
                }
                continue;
              }
            } catch (err) {
              if (err instanceof DocumentExtractError) {
                errorResponse(res, 422, `Couldn't read "${safeName}": ${err.message}. Export it to text and re-upload.`);
                return;
              }
              // Unexpected extraction failure: fall through to the binary/415
              // handling below rather than risk hanging the request.
            }
            if (looksBinaryUpload(buf)) {
              errorResponse(res, 415, `"${safeName}" looks like a binary document (Excel/PowerPoint/…). Inline text extraction for this format isn't supported yet — paste the text, or upload a PDF, Word (.docx), or .txt/.md/.csv.`);
              return;
            }
            const decoded = buf.toString('utf-8');
            const text = decoded.length > MAX_TEXT_FILE_DECODED_CHARS
              ? `${decoded.slice(0, MAX_TEXT_FILE_DECODED_CHARS)}\n[…truncated, ${String(decoded.length - MAX_TEXT_FILE_DECODED_CHARS)} chars omitted]`
              : decoded;
            content.push({ type: 'text', text: `[File: ${safeName}]\n${text}` });
          }
        }
        content.push({ type: 'text', text: composedTask });
        task = content;
      } else {
        task = composedTask;
      }

      // SSE headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'X-lynox-AI-Generated': 'true',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      let aborted = false;

      // ── Pausable run wall-clock (compute-only 30-min budget) ──
      // The wall-clock is a single timer, but a run PARKED on a pending prompt
      // (ask_user / tabs / ask_secret / connect_mail) is waiting on a HUMAN,
      // not computing. Human think-time must NOT consume the budget —
      // otherwise someone who answers after the budget elapsed lands on an
      // already-aborted run (their reply is captured but nobody awaits it; the
      // #77 prod bug). We PAUSE the timer on every prompt-start and re-arm it
      // with the REMAINING budget on prompt-settle. The budget arithmetic lives
      // in WallClockBudget (unit-tested); this handler owns the actual timer.
      const wallClockBudget = new WallClockBudget(resolveRunWallClockMs());
      // `undefined` = no live timer (paused, fired, or not yet armed). Kept in
      // sync with wallClockBudget.paused; the guards below never touch a stale id.
      let streamTimeout: ReturnType<typeof setTimeout> | undefined;

      // ── Per-run identity + resumable event buffer ──
      // `runId` identifies this run to the client-queryable registry
      // (GET /api/runs/active) and the resumable stream endpoint
      // (GET /api/runs/:runId/stream). The buffer is engine-owned (outlives
      // this request), so a headless run keeps filling it after the SSE closes
      // and a reconnecting client can replay-then-tail (Tier 2).
      const runId = randomUUID();
      const runBuffer = this.engine?.getRunBufferManager()?.create(runId) ?? null;

      // Wire streaming. Every rendered event is appended to the buffer (which
      // assigns a monotonic seq) and emitted with an `id:` line so a client can
      // resume from `?since=<lastSeq>`. The buffer append happens even while
      // `aborted` (the SSE is dead but the headless run keeps producing events
      // for a reconnecting subscriber).
      session.onStream = async (event: StreamEvent) => {
        const seq = runBuffer?.append(event);
        if (aborted) return;
        const data = JSON.stringify(event);
        const idLine = seq !== undefined ? `id: ${seq}\n` : '';
        res.write(`${idLine}event: ${event.type}\ndata: ${data}\n\n`);
      };

      // Sync streamHandler to toolContext so workflow progress events reach the SSE stream
      const agent = session.getAgent();
      if (agent?.toolContext) {
        agent.toolContext.streamHandler = session.onStream;
      }

      // Surface any init-time agent warnings as SSE events for the web-UI to
      // render as toasts. Currently only emits for the thinking-flag-guard
      // when a user opts thinking on a non-reasoning Mistral model.
      // Explicit projection (not JSON.stringify of the whole object) so a
      // future AgentWarning field additions can't silently leak to the
      // browser without an SSE-shape review.
      if (agent) {
        for (const w of agent.getWarnings()) {
          const payload = { code: w.code, modelId: w.modelId, hint: w.hint };
          res.write(`event: warning\ndata: ${JSON.stringify(payload)}\n\n`);
        }
      }

      // ── Run registry wiring (SQLite-backed, survives SSE disconnects) ──
      // The registry is an additive status mirror alongside runningSessions;
      // execution still lives in this handler (Tier 1) while the buffer above
      // enables resumable re-attach (Tier 2). `runId` is created above.
      const runRegistry = this.engine?.getRunRegistry();

      // Tier-2 resumable re-attach: at each eager-persist checkpoint, stamp the
      // run buffer's current high-water seq as `last_persisted_seq`. A
      // reconnecting client reads it (atomically with the transcript via
      // GET /threads/:id/messages) and replays `GET /runs/:runId/stream?since=`
      // from exactly the durable boundary — the in-flight (not-yet-persisted)
      // turn lives in the buffer above that seq, the persisted turns below it,
      // so the replay never double-renders what the transcript already showed.
      runOptions.onPersistCheckpoint = () => {
        if (runBuffer) runRegistry?.touch(runId, { lastPersistedSeq: runBuffer.currentSeq() });
      };

      // ── Prompt wiring (SQLite-backed, survives SSE disconnects) ──
      const promptStore = this.engine?.getPromptStore();
      // AbortController for the session — used to cancel prompt polling on disconnect
      const sessionAbortController = new AbortController();
      let hasActivePendingPrompt = false;

      // Wire promptUser — writes prompt to SQLite, event-driven wait.
      session.promptUser = async (question: string, options?: string[], meta?: PromptMeta): Promise<string> => {
        if (!promptStore) return 'n'; // fallback if store unavailable
        const promptId = promptStore.insertAskUser(sessionId, question, options, meta?.multiSelect === true);
        hasActivePendingPrompt = true;
        pauseWallClock(); // parked on a human — don't spend the compute budget
        // Best-effort SSE notification (client may not be connected).
        if (!aborted && !res.writableEnded) {
          const data = JSON.stringify({
            promptId, question, options, timeoutMs: PROMPT_TIMEOUT_MS,
            step_id: meta?.stepId, step_task: meta?.stepTask,
            // Multi-select pills (toggle several + Send). The client posts the
            // chosen labels back as a JSON array string via the normal /reply;
            // the ask_user tool parses it. A reconnect mid-prompt (which loads
            // /pending-prompt without this flag) degrades to single-select.
            multi_select: meta?.multiSelect === true ? true : undefined,
          });
          res.write(`event: prompt\ndata: ${data}\n\n`);
        }
        const outcome = await promptStore.waitForSettled(promptId, sessionAbortController.signal);
        hasActivePendingPrompt = false;
        resumeWallClock(); // human answered/dismissed — resume the compute budget
        if (outcome.status === 'answered') return outcome.row.answer ?? '__dismissed__';
        // Surface an explicit reason to the client — no silent 'n' default.
        if (!aborted && !res.writableEnded) {
          const data = JSON.stringify({ promptId, reason: outcome.status });
          res.write(`event: prompt_error\ndata: ${data}\n\n`);
        }
        return '__dismissed__';
      };

      // Wire promptTabs — one-shot multi-question path (v2 clients only).
      // Legacy clients fall back to the sequential agent-handler loop that
      // still uses session.promptUser per question.
      if (tabsCapable) {
        session.promptTabs = async (questions, meta?: PromptMeta): Promise<string[]> => {
          if (!promptStore) return [];
          const promptId = promptStore.insertAskUserTabs(sessionId, questions);
          hasActivePendingPrompt = true;
          pauseWallClock(); // parked on a human — don't spend the compute budget
          if (!aborted && !res.writableEnded) {
            const data = JSON.stringify({
              promptId, questions, timeoutMs: PROMPT_TIMEOUT_MS,
              step_id: meta?.stepId, step_task: meta?.stepTask,
            });
            res.write(`event: prompt_tabs\ndata: ${data}\n\n`);
          }
          const outcome = await promptStore.waitForSettled(promptId, sessionAbortController.signal);
          hasActivePendingPrompt = false;
          resumeWallClock(); // human answered/dismissed — resume the compute budget
          if (outcome.status === 'answered' && outcome.row.answer) {
            try {
              const parsed = JSON.parse(outcome.row.answer) as unknown;
              if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
                return parsed as string[];
              }
            } catch { /* malformed — treat as cancel */ }
          }
          if (!aborted && !res.writableEnded) {
            const data = JSON.stringify({ promptId, reason: outcome.status });
            res.write(`event: prompt_error\ndata: ${data}\n\n`);
          }
          return []; // empty array = "user canceled" per ask-user.ts contract
        };
      }

      // Wire promptSecret — secret value never enters SSE, only the prompt metadata
      session.promptSecret = async (name: string, prompt: string, keyType?: string, meta?: PromptMeta): Promise<SecretOutcome> => {
        if (!promptStore) return 'vault_error';

        // Predict managed-tier rejection BEFORE opening the UI prompt.
        // On managed mode, names matching INFRA_ADMIN_ONLY_PATTERNS will be
        // 403'd by the vault PUT (engine-internal + channel-managed creds
        // stay admin-only by design). For those names — opening the prompt
        // leads to a guaranteed 403 round-trip plus a confused user
        // who typed a secret that wasn't writable, then a wasted agent
        // turn to interpret the failure. Predict + short-circuit so the
        // tool result is `managed_blocked` on the first call, never a
        // false-start cancel. Staging incident 2026-05-18.
        if (predictManagedBlocked(name)) {
          // Audit-trail parity with the PUT /api/secrets/:name path at
          // L~2364 — that path emits a `secret_update` row on accept.
          // Pre-predict-block, every blocked attempt left a pending_prompts
          // row with answer_error='managed_blocked' that incident-replay
          // could read; the short-circuit removed that trail. Record a
          // names-only `secret_blocked` event so the agent's attempt
          // to write a non-allowlisted slot is still discoverable.
          try {
            const audit = engine.getSecurityAudit();
            audit?.record({
              event_type: 'secret_blocked',
              decision: 'blocked',
              source: 'managed_predict',
              detail: JSON.stringify({
                slot: name,
                tool: 'ask_secret',
                tier: readEnvAlias('LYNOX_BILLING_TIER') ?? 'self-host',
              }),
            });
          } catch {
            // Audit failure must not block the agent's tool result.
          }
          return 'managed_blocked';
        }

        const promptId = promptStore.insertAskSecret(sessionId, name, prompt, keyType);
        hasActivePendingPrompt = true;
        pauseWallClock(); // parked on a human — don't spend the compute budget
        if (!aborted && !res.writableEnded) {
          const data = JSON.stringify({
            promptId, name, prompt, key_type: keyType,
            step_id: meta?.stepId, step_task: meta?.stepTask,
          });
          res.write(`event: secret_prompt\ndata: ${data}\n\n`);
        }
        const row = await promptStore.waitForAnswer(promptId, sessionAbortController.signal);
        hasActivePendingPrompt = false;
        resumeWallClock(); // human answered/dismissed — resume the compute budget
        // answer_error wins over answer_saved when set — see SecretOutcome contract
        // (server-side rejection must not be mistranslated as a user cancel).
        if (row?.answer_error === 'managed_blocked') return 'managed_blocked';
        if (row?.answer_error === 'vault_error') return 'vault_error';
        if (row?.answer_saved === 1) return 'saved';
        // No row means the prompt expired or the session aborted before the
        // user could answer — NOT a user cancel. Returning 'canceled' here
        // would trigger the agent's hard "DO NOT retry, DO NOT plaintext"
        // guards inappropriately. 'vault_error' keeps the door open for a
        // retry once the connection / session is healthy again.
        if (!row) return 'vault_error';
        return 'canceled';
      };

      // Wire promptMailConnect — the staged account metadata rides the SSE
      // event; the app-password is entered in the in-chat consent step and
      // goes client→POST /api/mail/accounts→vault, NEVER through this callback
      // or the agent/model context. The route is NOT walled by the infra-
      // secret deny-list (mail accounts have their own path), so there is no
      // managed-block path here — unlike ask_secret for MAIL_ACCOUNT_* names.
      session.promptMailConnect = async (data: MailConnectPromptData, meta?: PromptMeta): Promise<MailConnectOutcome> => {
        if (!promptStore) return 'canceled';
        const promptId = promptStore.insertConnectMail(
          sessionId,
          `Connect mailbox ${data.address}`,
          JSON.stringify(data),
        );
        hasActivePendingPrompt = true;
        pauseWallClock(); // parked on a human — don't spend the compute budget
        if (!aborted && !res.writableEnded) {
          const payload = JSON.stringify({
            promptId, ...data,
            step_id: meta?.stepId, step_task: meta?.stepTask,
          });
          res.write(`event: mail_connect_prompt\ndata: ${payload}\n\n`);
        }
        const row = await promptStore.waitForAnswer(promptId, sessionAbortController.signal);
        hasActivePendingPrompt = false;
        resumeWallClock(); // human answered/dismissed — resume the compute budget
        // answer_saved === 1 means the consent step POSTed the account and the
        // route accepted it. No row (expired / session aborted) or a 0 flag is
        // a dismissal — the agent must NOT fall back to asking for the password
        // in chat (the tool result spells that out).
        return row?.answer_saved === 1 ? 'connected' : 'canceled';
      };

      // Heartbeat — every 10s emit a real SSE event (not a comment line) so
      // the client can update its "last alive" timestamp and surface a soft
      // "Verbindung scheint langsam" hint when the gap grows. 10s sits well
      // under the typical 30s proxy idle timeout and gives iPad Safari
      // background-throttling headroom before the proxy closes us. Payload
      // is just sentAt — clients only need a wall-clock bump.
      const keepaliveTimer = setInterval(() => {
        if (!aborted && !res.writableEnded) {
          res.write(`event: heartbeat\ndata: ${JSON.stringify({ sentAt: Date.now() })}\n\n`);
          // Bump lastEventAt so the stale-run-takeover at /run entry can
          // distinguish "actively streaming" from "silent for >60s, probably
          // stuck on a hung tool". Stops updating as soon as the SSE write
          // gate (aborted/writableEnded) closes — which is exactly when we
          // want the stale clock to start counting.
          const slot = this.runningSessions.get(sessionId);
          if (slot) slot.lastEventAt = Date.now();
          // Mirror liveness into the registry so /api/runs/active + stale-run
          // detection see a fresh heartbeat for this run.
          runRegistry?.touch(runId);
        }
      }, 10_000);

      // Wall-clock backstop (compute-only budget, 30 min default). Fires for a
      // still-streaming run AND for a headless run whose client already
      // disconnected (disconnect≠abort leaves this armed). `res.destroyed`
      // guards the post-disconnect case so we never call res.end() on a
      // torn-down socket.
      //
      // The abort action is factored out so the INITIAL arm and every
      // pause/resume re-arm reuse the EXACT same teardown — no drift.
      const fireWallClockAbort = (): void => {
        aborted = true;
        clearInterval(keepaliveTimer);
        sessionAbortController.abort();
        session.abort();
        if (!res.writableEnded && !res.destroyed) res.end();
        streamTimeout = undefined; // timer consumed — keep the paused/armed invariant honest
      };
      // Arm (or re-arm) the wall-clock with whatever compute budget remains.
      const armWallClock = (): void => {
        streamTimeout = setTimeout(fireWallClockAbort, wallClockBudget.arm(Date.now()));
      };
      // PAUSE at prompt-start: stop the timer and bank the compute-time spent so
      // far. Idempotent — with no live timer it is a no-op, so a defensive
      // double-pause can never double-subtract the budget.
      const pauseWallClock = (): void => {
        if (streamTimeout === undefined) return;
        clearTimeout(streamTimeout);
        streamTimeout = undefined;
        wallClockBudget.pause(Date.now());
      };
      // RESUME at prompt-settle: re-arm with the remaining (compute-only)
      // budget. Skips re-arming if the run was already aborted (a disconnect set
      // `aborted` while parked → the run either finishes headless with no
      // wall-clock, matching the prior disconnect-drops-the-timer behavior, or a
      // takeover is about to throw RunAbortedError). Skips if a timer is somehow
      // already live so it never stacks two timers.
      const resumeWallClock = (): void => {
        if (aborted || streamTimeout !== undefined) return;
        armWallClock();
      };
      armWallClock();

      req.on('close', () => {
        clearInterval(keepaliveTimer);
        // Stop writing to the dead socket — `onStream` no-ops while `aborted`
        // (L1875), so the run can keep computing without write-after-close. We
        // do NOT clear `streamTimeout` here: it stays armed as the headless
        // wall-clock backstop below (the prompt branch drops it explicitly).
        aborted = true;
        // Mark this run's stream as dead so a fresh /run on the same session
        // can take it over if the agent is parked on a pending prompt.
        const slot = this.runningSessions.get(sessionId);
        if (slot) slot.streamAlive = false;
        // Orphan watchdog (armed in BOTH branches). 10 min after the stream
        // dies, if the run is parked on a still-pending prompt that nobody
        // reconnected to answer, free the slot. Pre-1.5.0 such a slot could sit
        // `streamAlive=false` up to PROMPT_TTL (24h), pinning a runningSessions
        // entry + open SQLite handles until the prompt expired.
        //
        // The `getPending` guard is what makes this safe to arm unconditionally:
        // it fires takeover ONLY for a genuinely stuck, dead-stream prompt —
        // never against a headless run that is productively computing (no
        // pending prompt) or whose prompt was already answered via reconnect
        // (getPending now empty). This also bounds the prompt-fires-AFTER-a
        // -headless-disconnect case at 10 min; the close-time
        // `hasActivePendingPrompt` snapshot alone would leave it to the 30-min
        // streamTimeout.
        setTimeout(() => {
          const liveSlot = this.runningSessions.get(sessionId);
          if (liveSlot && !liveSlot.streamAlive && promptStore?.getPending(sessionId)) {
            liveSlot.takeover();
          }
        }, ORPHAN_PROMPT_WATCHDOG_MS);
        if (hasActivePendingPrompt) {
          // Already parked on a prompt at close → the wall-clock is already
          // PAUSED (pauseWallClock cleared it at prompt-start), so there is
          // normally no live timer here. The guarded clearTimeout is defense in
          // depth against any race where it was re-armed; the orphan watchdog
          // above bounds the wait. The user can reconnect and answer (the loop
          // keeps polling SQLite) — resumeWallClock then no-ops because `aborted`
          // is now set, matching the prior disconnect-drops-the-timer behavior.
          if (streamTimeout !== undefined) clearTimeout(streamTimeout);
        }
        // else: RUNNING with no prompt → Tier-1 disconnect≠abort. Do NOT abort
        // the session; let it finish headless. Eager-persist keeps the
        // transcript durable and the run registry keeps reporting it via
        // GET /api/runs/active, so a reload re-attaches (re-reads
        // /threads/:id/messages + sees the live run) instead of going blind —
        // this is the v1.9.0 reload-blind fix. The 30-min streamTimeout stays
        // armed as the wall-clock backstop (it aborts the session + ends res),
        // so a hung headless run can't leak; the finally clears it on natural
        // completion. PRD-RUN-RESILIENCE D2.
      });

      // Run
      // Takeover hook: a future /run for this session can call this to free
      // the slot when our SSE stream is dead and we're stuck on a prompt.
      const takeover = (): void => {
        const pending = promptStore?.getPending(sessionId);
        if (pending) promptStore?.expirePrompt(pending.id);
        sessionAbortController.abort();
        session.abort();
      };
      this.runningSessions.set(sessionId, { streamAlive: true, takeover, lastEventAt: Date.now() });
      try {
        // Reserve a concurrency slot + register the abort handle so the run can
        // be aborted by id from any connection (DELETE /api/runs/:runId) —
        // including a headless run whose original SSE is already gone. `takeover`
        // is the same expire-prompt + abort path the stale-run reclaim uses (for
        // a headless run `aborted` is already true, so no terminal is owed).
        // INSIDE the try so a throw from runRegistry.start (SQLite busy/disk-full)
        // still hits the finally's release() — otherwise the slot would leak and
        // after `maxConcurrent` such failures every /run would 429 forever.
        runExecutor?.acquire(runId, sessionId, takeover);
        // Register the run as live (replaces any prior/interrupted row for this
        // thread). A crash before the finally leaves this row 'running' → the
        // boot-sweep marks it 'interrupted' so the client shows a banner + Retry.
        runRegistry?.start(sessionId, runId);
        const result = await session.run(task, runOptions);
        if (!aborted) {
          // Notify client if changeset has pending file changes for review
          const csm = session.getChangesetManager();
          if (csm?.hasChanges()) {
            res.write(`event: changeset_ready\ndata: ${JSON.stringify({ fileCount: csm.size })}\n\n`);
          }
          res.write(`event: done\ndata: ${JSON.stringify({ result, usage: session.getLastRunUsage() ?? undefined })}\n\n`);
          res.end();
        }
      } catch (err: unknown) {
        // A run aborted via takeover (stop button / stale-run reclaim) does NOT
        // set the local `aborted` flag, yet session.run() now THROWS
        // RunAbortedError (previously it swallowed the abort and returned ''). It
        // was an intentional interruption, not a failure — end the stream cleanly
        // WITHOUT a scary `error` event, matching the prior no-error behavior.
        // (The backstop/disconnect paths already set `aborted` and tore down res.)
        if (err instanceof RunAbortedError) {
          if (!res.writableEnded && !res.destroyed) res.end();
        } else if (!aborted) {
          const msg = err instanceof Error ? err.message : String(err);
          res.write(`event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`);
          res.end();
        }
      } finally {
        // May be undefined if the run ended while paused on a prompt (or the
        // timer already fired) — guard the clear so we never touch a stale id.
        if (streamTimeout !== undefined) clearTimeout(streamTimeout);
        clearInterval(keepaliveTimer);
        this.runningSessions.delete(sessionId);
        // Free the concurrency slot + abort handle (idempotent). The next queued
        // /run can now reserve a slot.
        runExecutor?.release(runId);
        // Run reached a terminal state (done/error/abort-completion) — drop it
        // from the registry. The transcript persists in thread_messages. A
        // process crash never reaches here, leaving the row for the boot-sweep.
        runRegistry?.remove(runId);
        // End + drop the resumable buffer: notifies any live `/stream`
        // subscribers to close, then frees the ring (the durable transcript
        // persists regardless).
        this.engine?.getRunBufferManager()?.remove(runId);
      }
    }));

    // GET /runs/active — client-queryable live-run state for the nav indicator.
    // Returns every registry row (running + interrupted; done/error are already
    // removed), so a reloaded client can re-attach a "still working" indicator
    // and surface interrupted runs (banner + Retry). `awaiting_input` is derived
    // from a pending prompt rather than tracked as a separate write, keeping the
    // registry a simple liveness mirror with a single source of truth for
    // "blocked on the user". Whole-tenant (single-tenant engine, no per-user
    // scoping — see PRD-RUN-RESILIENCE N5).
    this.dynamicRoutes.push(parseDynamicRoute('user', 'GET', '/api/runs/active', async (_req, res) => {
      const registry = this.engine?.getRunRegistry();
      if (!registry) { jsonResponse(res, 200, { runs: [] }); return; }
      const promptStoreForRuns = this.engine?.getPromptStore();
      const runs = registry.getActive().map((r) => {
        const awaiting = r.status === 'running' && !!promptStoreForRuns?.getPending(r.thread_id);
        return {
          runId: r.run_id,
          threadId: r.thread_id,
          status: awaiting ? 'awaiting_input' : r.status,
          startedAt: r.started_at,
          lastActivity: r.last_activity,
          // Durable replay boundary — the client re-attaches with `?since=` this
          // to GET /runs/:runId/stream after a reload (Tier 2).
          lastPersistedSeq: r.last_persisted_seq,
        };
      });
      jsonResponse(res, 200, { runs });
    }));

    // DELETE /runs/:runId — abort a live run by id (AC10). Works from any
    // connection, including for a headless run whose original SSE is gone (the
    // executor holds the abort handle independent of the request). 404 if no
    // such run is live — the executor's active set is the liveness oracle, same
    // as the buffer for /stream (no existence leak). The run's own finally then
    // tears down registry + buffer as the session unwinds.
    this.dynamicRoutes.push(parseDynamicRoute('user', 'DELETE', '/api/runs/:runId', async (_req, res, params) => {
      const runId = params['runId'] ?? '';
      const executor = this.engine?.getRunExecutor();
      const registry = this.engine?.getRunRegistry();
      // Live run → abort it (the run's own finally then clears registry + buffer
      // as the session unwinds). Not live but present in the registry → it's an
      // interrupted row the client is acking; remove it so the nav dot + banner
      // clear. Neither → 404 (no existence oracle).
      const wasLive = executor?.abort(runId) ?? false;
      if (wasLive) { jsonResponse(res, 200, { aborted: true, runId }); return; }
      // Not live → only an INTERRUPTED row may be acked/removed. A 'running' row
      // that isn't in the executor's live set is an inconsistency we must NOT
      // silently clear (it could still be live on a path that bypassed acquire);
      // leave it for the boot-sweep / its own finally and report not-found.
      const row = registry?.getByRunId(runId);
      if (row?.status === 'interrupted') {
        registry?.remove(runId);
        jsonResponse(res, 200, { aborted: false, dismissed: true, runId });
        return;
      }
      jsonResponse(res, 404, { error: 'run not found' });
    }));

    // GET /runs/:runId/stream?since=<seq> — resumable SSE re-attach (Tier 2).
    // Replays buffered events newer than `since`, then live-tails new appends,
    // emitting `id:` lines so the client can resume again from the last seq.
    // Ownership (S3, D-S3): an unknown / not-live runId returns 404 — never 403
    // (no existence oracle). The buffer is the liveness source of truth: it
    // exists only while the run is live, so a completed/never-existed run 404s.
    this.dynamicRoutes.push(parseDynamicRoute('user', 'GET', '/api/runs/:runId/stream', async (req, res, params) => {
      const runId = params['runId'] ?? '';
      const buffer = this.engine?.getRunBufferManager()?.get(runId);
      if (!buffer) { jsonResponse(res, 404, { error: 'run not found' }); return; }

      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const sinceRaw = parseInt(url.searchParams.get('since') ?? '0', 10);
      const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : 0;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'X-lynox-AI-Generated': 'true',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const write = (seq: number, event: StreamEvent): void => {
        if (res.writableEnded) return;
        res.write(`id: ${seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      };

      // Heartbeat keeps proxies from idling the connection closed (mirrors /run).
      const keepalive = setInterval(() => {
        if (!res.writableEnded) res.write(`event: heartbeat\ndata: ${JSON.stringify({ sentAt: Date.now() })}\n\n`);
      }, 10_000);

      // 1) Replay everything newer than `since` (catch up to the live tail).
      //    No `await` between replay and subscribe → atomic w.r.t. the event
      //    loop, so no appended event can slip through the gap.
      for (const e of buffer.replaySince(since)) write(e.seq, e.event);

      // 2) Subscribe for the live tail. onEnd fires when the run completes →
      //    emit a terminal `done` (the full result lives in the persisted
      //    transcript; the re-subscribed client only needs the completion
      //    signal) and close.
      let ended = false;
      const finish = (): void => {
        if (ended) return;
        ended = true;
        clearInterval(keepalive);
        if (!res.writableEnded) {
          res.write(`event: done\ndata: ${JSON.stringify({ resumed: true })}\n\n`);
          res.end();
        }
      };
      const unsub = buffer.subscribe((e) => write(e.seq, e.event), finish);

      req.on('close', () => {
        clearInterval(keepalive);
        unsub();
      });
    }));

    // GET /sessions/:id/pending-prompt — client checks for resumable prompts on reconnect
    this.dynamicRoutes.push(parseDynamicRoute('user', 'GET', '/api/sessions/:id/pending-prompt', async (_req, res, params) => {
      const ps = this.engine?.getPromptStore();
      if (!ps) { jsonResponse(res, 200, { pending: false }); return; }
      const row = ps.getPending(params['id']!);
      if (!row) { jsonResponse(res, 200, { pending: false }); return; }
      // Never leak secret answers back to client
      const isTabs = row.prompt_type === 'ask_user' && !!row.questions_json;
      const kind = isTabs
        ? 'tabs'
        : row.prompt_type === 'ask_secret'
          ? 'secret'
          : row.prompt_type === 'connect_mail'
            ? 'mail'
            : 'single';
      jsonResponse(res, 200, {
        pending: true,
        promptId: row.id,
        promptType: row.prompt_type,
        kind,
        question: row.question,
        options: row.options_json ? JSON.parse(row.options_json) as string[] : undefined,
        // Restore the multi-select-pills opt-in (v33) so a reconnect mid-prompt
        // re-renders multi-select instead of degrading to single-select.
        multiSelect: row.multi_select === 1,
        questions: row.questions_json ? JSON.parse(row.questions_json) as unknown[] : undefined,
        partialAnswers: row.partial_answers_json ? JSON.parse(row.partial_answers_json) as unknown[] : undefined,
        secretName: row.secret_name,
        secretKeyType: row.secret_key_type,
        // The staged mail-account fields for a connect_mail prompt (no password).
        mailConnect: row.payload_json ? JSON.parse(row.payload_json) as unknown : undefined,
        timeoutMs: PROMPT_TIMEOUT_MS,
        createdAt: row.created_at,
      });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('user', 'POST', '/api/sessions/:id/reply', async (_req, res, params, body) => {
      const ps = this.engine?.getPromptStore();
      if (!ps) { errorResponse(res, 404, 'No pending prompt'); return; }

      const b = body as Record<string, unknown> | null;
      const promptId = b && typeof b['promptId'] === 'string' ? b['promptId'] : undefined;
      const answer = b && typeof b['answer'] === 'string' ? b['answer'] : '';
      if (!answer && !promptId) { errorResponse(res, 400, 'Missing answer'); return; }

      // Idempotency: if the client retries with the same promptId after a
      // successful answer (network blip), return 200 so the client can move
      // on instead of seeing 404 and wedging. Stale/unknown promptId → 404;
      // expired → 410. Cross-session IDs → 409.
      if (promptId) {
        const existing = ps.getById(promptId);
        if (existing) {
          if (existing.session_id !== params['id']) { errorResponse(res, 409, 'Prompt belongs to a different session'); return; }
          if (existing.status === 'expired') { errorResponse(res, 410, 'Prompt expired'); return; }
          if (existing.status === 'answered') { jsonResponse(res, 200, { ok: true, idempotent: true }); return; }
        }
        if (ps.answerUser(promptId, answer)) { jsonResponse(res, 200, { ok: true }); return; }
      }

      // Fallback for clients that didn't echo the promptId (legacy path).
      const pending = ps.getPending(params['id']!);
      if (pending && pending.prompt_type === 'ask_user' && !pending.questions_json) {
        if (ps.answerUser(pending.id, answer)) { jsonResponse(res, 200, { ok: true }); return; }
      }

      errorResponse(res, 404, 'No pending prompt');
    }));

    // POST /sessions/:id/reply-tabs — one-shot reply for multi-question tabs prompts.
    // Body: { promptId: string, answers: string[] }. Each answer corresponds
    // to a question in order; '__dismissed__' is the canonical skip marker.
    this.dynamicRoutes.push(parseDynamicRoute('user', 'POST', '/api/sessions/:id/reply-tabs', async (_req, res, params, body) => {
      const ps = this.engine?.getPromptStore();
      if (!ps) { errorResponse(res, 404, 'No pending prompt'); return; }

      const b = body as Record<string, unknown> | null;
      const promptId = b && typeof b['promptId'] === 'string' ? b['promptId'] : '';
      const answers = b && Array.isArray(b['answers']) ? b['answers'] : undefined;
      if (!promptId) { errorResponse(res, 400, 'Missing promptId'); return; }
      if (!answers || !answers.every((a): a is string => typeof a === 'string')) {
        errorResponse(res, 400, 'Missing or invalid answers array'); return;
      }

      const existing = ps.getById(promptId);
      if (!existing) { errorResponse(res, 404, 'No pending prompt'); return; }
      if (existing.session_id !== params['id']) { errorResponse(res, 409, 'Prompt belongs to a different session'); return; }
      if (existing.status === 'expired') { errorResponse(res, 410, 'Prompt expired'); return; }
      if (existing.status === 'answered') { jsonResponse(res, 200, { ok: true, idempotent: true }); return; }
      if (!existing.questions_json) { errorResponse(res, 400, 'Prompt is not a tabs prompt — use /reply'); return; }

      // Length sanity: answers must match question count.
      try {
        const questions = JSON.parse(existing.questions_json) as unknown[];
        if (!Array.isArray(questions) || answers.length !== questions.length) {
          errorResponse(res, 400, `answers length ${answers.length} does not match questions length ${Array.isArray(questions) ? questions.length : '?'}`); return;
        }
      } catch {
        errorResponse(res, 500, 'Stored questions malformed'); return;
      }

      if (ps.answerUserTabs(promptId, answers)) { jsonResponse(res, 200, { ok: true }); return; }
      errorResponse(res, 404, 'No pending prompt');
    }));

    // POST /sessions/:id/tab-progress — persist partial answers (optional).
    // Called by the client as the user answers individual tabs so a mid-batch
    // reconnect restores progress. Does NOT settle the prompt.
    this.dynamicRoutes.push(parseDynamicRoute('user', 'POST', '/api/sessions/:id/tab-progress', async (_req, res, params, body) => {
      const ps = this.engine?.getPromptStore();
      if (!ps) { errorResponse(res, 404, 'No pending prompt'); return; }

      const b = body as Record<string, unknown> | null;
      const promptId = b && typeof b['promptId'] === 'string' ? b['promptId'] : '';
      const partial = b && Array.isArray(b['partial']) ? b['partial'] : undefined;
      if (!promptId || !partial) { errorResponse(res, 400, 'Missing promptId or partial'); return; }
      if (!partial.every((a) => typeof a === 'string' || a === null)) {
        errorResponse(res, 400, 'partial must be array of string|null'); return;
      }

      const existing = ps.getById(promptId);
      if (!existing) { errorResponse(res, 404, 'No pending prompt'); return; }
      if (existing.session_id !== params['id']) { errorResponse(res, 409, 'Prompt belongs to a different session'); return; }
      if (existing.status !== 'pending') { jsonResponse(res, 200, { ok: true, idempotent: true }); return; }

      ps.setPartialAnswers(promptId, partial as (string | null)[]);
      jsonResponse(res, 200, { ok: true });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('user', 'POST', '/api/sessions/:id/secret-saved', async (_req, res, params, body) => {
      const ps = this.engine?.getPromptStore();
      if (!ps) { errorResponse(res, 404, 'No pending secret prompt'); return; }

      const b = body as Record<string, unknown> | null;
      const promptId = b && typeof b['promptId'] === 'string' ? b['promptId'] : undefined;

      // Prefer the v29 `status` field — it distinguishes managed_blocked /
      // vault_error from a real user cancel. Fall back to legacy `saved`
      // boolean so older UI bundles still close out cleanly. When neither
      // is parseable, default to 'vault_error' — NOT 'canceled' — because a
      // missing field is "we don't know what happened" not "user said no",
      // and the ask_secret tool result treats 'canceled' as a hard guard
      // that blocks retry + plaintext fallback (the exact spiral this PR
      // exists to fix).
      const rawStatus = b && typeof b['status'] === 'string' ? b['status'] : undefined;
      const legacySaved = b && typeof b['saved'] === 'boolean' ? b['saved'] : undefined;
      let outcome: SecretOutcome;
      if (rawStatus === 'saved' || rawStatus === 'canceled' || rawStatus === 'managed_blocked' || rawStatus === 'vault_error') {
        outcome = rawStatus;
      } else if (legacySaved === true) {
        outcome = 'saved';
      } else if (legacySaved === false) {
        // Old UI bundles only sent `saved:false` on real user-cancel; vault
        // failures from those bundles are indistinguishable here, accept
        // the cancel reading rather than escalating, since the user-cancel
        // case dominates by frequency.
        outcome = 'canceled';
      } else {
        outcome = 'vault_error';
      }

      // Bind the supplied promptId to the URL session to prevent an
      // authenticated client from settling a different session's prompt.
      // Mirrors the partial-answers route at L1965. Fails closed: an
      // unbindable promptId falls through to the per-session lookup.
      let answered = false;
      if (promptId) {
        const existing = ps.getById(promptId);
        if (existing && existing.session_id === params['id'] && existing.prompt_type === 'ask_secret') {
          answered = ps.answerSecret(promptId, outcome);
        }
      }
      if (!answered) {
        const pending = ps.getPending(params['id']!);
        if (pending && pending.prompt_type === 'ask_secret') {
          answered = ps.answerSecret(pending.id, outcome);
        }
      }
      if (!answered) { errorResponse(res, 404, 'No pending secret prompt'); return; }
      jsonResponse(res, 200, { ok: true });
    }));

    // POST /sessions/:id/mail-connected — settle a connect_mail prompt after the
    // in-chat consent step has POSTed the account to /api/mail/accounts. Body:
    // { promptId: string, status: 'connected' | 'canceled' }. The password is
    // never part of this call — it went straight to the mail-account route.
    this.dynamicRoutes.push(parseDynamicRoute('user', 'POST', '/api/sessions/:id/mail-connected', async (_req, res, params, body) => {
      const ps = this.engine?.getPromptStore();
      if (!ps) { errorResponse(res, 404, 'No pending mail prompt'); return; }

      const b = body as Record<string, unknown> | null;
      const promptId = b && typeof b['promptId'] === 'string' ? b['promptId'] : undefined;
      const rawStatus = b && typeof b['status'] === 'string' ? b['status'] : undefined;
      // Default to 'canceled' when the status is missing/unknown: a connect_mail
      // dismissal is benign (the agent just acknowledges), unlike ask_secret
      // where an unknown outcome must not be read as a hard user-cancel.
      const connected = rawStatus === 'connected';

      // Bind the promptId to the URL session so an authenticated client can't
      // settle another session's prompt (mirrors /secret-saved). Fails closed
      // to the per-session lookup.
      let answered = false;
      if (promptId) {
        const existing = ps.getById(promptId);
        if (existing) {
          if (existing.session_id !== params['id']) { errorResponse(res, 409, 'Prompt belongs to a different session'); return; }
          if (existing.status === 'expired') { errorResponse(res, 410, 'Prompt expired'); return; }
          if (existing.status === 'answered') { jsonResponse(res, 200, { ok: true, idempotent: true }); return; }
          if (existing.prompt_type === 'connect_mail') {
            answered = ps.answerMailConnect(promptId, connected);
          }
        }
      }
      if (!answered) {
        const pending = ps.getPending(params['id']!);
        if (pending && pending.prompt_type === 'connect_mail') {
          answered = ps.answerMailConnect(pending.id, connected);
        }
      }
      if (!answered) { errorResponse(res, 404, 'No pending mail prompt'); return; }
      jsonResponse(res, 200, { ok: true });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('user', 'POST', '/api/sessions/:id/abort', async (_req, res, params) => {
      const session = this.sessionStore.get(params['id']!);
      if (!session) { errorResponse(res, 404, 'Session not found'); return; }
      session.abort();
      jsonResponse(res, 200, { ok: true });
    }));

    // ── Changeset review ──
    this.dynamicRoutes.push(parseDynamicRoute('user', 'GET', '/api/sessions/:id/changeset', async (_req, res, params) => {
      const session = this.sessionStore.get(params['id']!);
      if (!session) { errorResponse(res, 404, 'Session not found'); return; }
      const csm = session.getChangesetManager();
      if (!csm || !csm.hasChanges()) {
        jsonResponse(res, 200, { hasChanges: false, files: [] });
        return;
      }
      const changes = csm.getChanges();
      const files = changes.map(c => {
        const lines = c.diff.split('\n');
        let added = 0;
        let removed = 0;
        for (const line of lines) {
          if (line.startsWith('+') && !line.startsWith('+++')) added++;
          else if (line.startsWith('-') && !line.startsWith('---')) removed++;
        }
        return { file: c.file, status: c.status, diff: c.diff, added, removed };
      });
      jsonResponse(res, 200, { hasChanges: true, files });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('user', 'POST', '/api/sessions/:id/changeset/review', async (_req, res, params, body) => {
      const session = this.sessionStore.get(params['id']!);
      if (!session) { errorResponse(res, 404, 'Session not found'); return; }
      const csm = session.getChangesetManager();
      if (!csm || !csm.hasChanges()) {
        errorResponse(res, 400, 'No changeset to review');
        return;
      }

      const b = body as Record<string, unknown> | null;
      const action = typeof b?.['action'] === 'string' ? b['action'] : '';
      if (!['accept', 'rollback', 'partial'].includes(action)) {
        errorResponse(res, 400, 'Invalid action — must be accept, rollback, or partial');
        return;
      }

      const changes = csm.getChanges();
      let accepted = 0;
      let rolledBack = 0;

      if (action === 'accept') {
        accepted = changes.length;
        csm.acceptAll();
      } else if (action === 'rollback') {
        rolledBack = changes.length;
        csm.rollbackAll();
      } else {
        // Partial: validate rolledBackFiles against changeset entries
        const clientFiles = Array.isArray(b?.['rolledBackFiles']) ? b['rolledBackFiles'] as string[] : [];
        const validRelPaths = new Set(changes.map(c => c.file));
        const toRollback: string[] = [];

        for (const f of clientFiles) {
          if (typeof f !== 'string' || !validRelPaths.has(f)) continue;
          // Resolve relative path back to absolute via cwd
          const abs = resolve(process.cwd(), f);
          toRollback.push(abs);
        }

        if (toRollback.length > 0) {
          csm.rollbackFiles(toRollback);
        }
        rolledBack = toRollback.length;
        accepted = changes.length - rolledBack;
      }

      csm.cleanup();
      jsonResponse(res, 200, { ok: true, accepted, rolledBack });
    }));

    // ── Compact (context management) ──
    this.dynamicRoutes.push(parseDynamicRoute('user', 'POST', '/api/sessions/:id/compact', async (_req, res, params, body) => {
      const sessionId = params['id']!;
      const session = this.sessionStore.get(sessionId);
      if (!session) { errorResponse(res, 404, 'Session not found'); return; }
      if (this.runningSessions.has(sessionId)) {
        errorResponse(res, 409, 'Cannot compact while a run is in progress');
        return;
      }
      const b = body as Record<string, unknown> | null;
      const focus = typeof b?.['focus'] === 'string' ? b['focus'] : undefined;
      const result = await session.compact(focus);
      jsonResponse(res, 200, { ok: result.success, summary: result.summary });
    }));

    // Mid-thread model re-pick (arc:model-selector P1, §5.1b) — the "continue a
    // historical chat on another model" half of the ask. Resolves an EXISTING
    // live session (never mints — `get`, not `getOrCreate`, so an unknown id is a
    // 404 not a new thread; S2). Refuses 409 while a run is in flight (swapping
    // the agent mid-turn would orphan the in-flight output — the same hazard
    // /compact guards). The Session method clamps (S1) + pre-checks downgrade
    // overflow (D20/F9) + persists the requested pick; a downgrade that wouldn't
    // fit the smaller window is refused BEFORE any write with a 422 the client
    // renders as actionable copy (U1).
    this.dynamicRoutes.push(parseDynamicRoute('user', 'PATCH', '/api/sessions/:id/model', async (_req, res, params, body) => {
      const sessionId = params['id']!;
      const session = this.sessionStore.get(sessionId);
      if (!session) { errorResponse(res, 404, 'Session not found'); return; }
      if (this.runningSessions.has(sessionId)) {
        errorResponse(res, 409, 'Cannot change the model while a run is in progress');
        return;
      }
      const b = body as Record<string, unknown> | null;
      const requestedTier = typeof b?.['tier'] === 'string' ? normalizeTier(b['tier']) : undefined;
      if (!requestedTier) {
        errorResponse(res, 400, 'Invalid or missing tier — expected fast, balanced, or deep');
        return;
      }
      const result = session.repickModel(requestedTier);
      if (!result.ok) {
        // Downgrade overflow (D20/F9): the occupied context does not fit the
        // target window. 422 (distinct from the 409 busy case) + machine-readable
        // fields; the client localizes the "chat too long for {tier}" copy.
        jsonResponse(res, 422, {
          error: 'context_overflow',
          targetTier: result.targetTier,
          occupancy: result.occupancy,
          window: result.window,
        });
        return;
      }
      jsonResponse(res, 200, { ok: true, model: result.tier, modelId: result.modelId });
    }));

    // ── Threads ──
    this.addStatic('user', 'GET /api/threads', async (req, res) => {
      const threadStore = engine.getThreadStore();
      if (!requireService(res, threadStore, 'Thread store')) return;
      const url = new URL(req.url ?? '', 'http://localhost');
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), 500);
      const includeArchived = url.searchParams.get('includeArchived') === 'true';
      const threads = threadStore.listThreads({ limit, includeArchived });
      jsonResponse(res, 200, { threads });
    });

    this.dynamicRoutes.push(parseDynamicRoute('user', 'GET', '/api/threads/:id', async (_req, res, params) => {
      const threadStore = engine.getThreadStore();
      if (!requireService(res, threadStore, 'Thread store')) return;
      const thread = threadStore.getThread(params['id']!);
      // An old/deleted thread (or a transient tenant-scope race / mid-deploy
      // window before routes register) is a benign GET, not a client error: a
      // 404 lands as browser console noise on every thread-resume. Return 200
      // with a null thread + threadMissing flag so the client can distinguish
      // "gone" from "exists" without the noise. PATCH/DELETE below keep their
      // 404 — mutating a nonexistent thread IS an error.
      if (!thread) { jsonResponse(res, 200, { thread: null, threadMissing: true }); return; }
      jsonResponse(res, 200, { thread });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('user', 'PATCH', '/api/threads/:id', async (_req, res, params, body) => {
      const threadStore = engine.getThreadStore();
      if (!requireService(res, threadStore, 'Thread store')) return;
      const thread = threadStore.getThread(params['id']!);
      if (!thread) { errorResponse(res, 404, 'Thread not found'); return; }
      const b = body as Record<string, unknown> | null;
      const skipExtraction = typeof b?.['skip_extraction'] === 'boolean' ? b['skip_extraction'] : undefined;
      threadStore.updateThread(params['id']!, {
        title: typeof b?.['title'] === 'string' ? b['title'] : undefined,
        is_archived: typeof b?.['is_archived'] === 'boolean' ? b['is_archived'] : undefined,
        is_favorite: typeof b?.['is_favorite'] === 'boolean' ? b['is_favorite'] : undefined,
        skip_extraction: skipExtraction,
      });
      // Slice B3: the web UI sends `{ is_unread: false }` when the user opens an
      // escalated thread. Clear it via markThreadRead (which deliberately does
      // NOT bump updated_at — reading shouldn't re-sort the list).
      if (typeof b?.['is_unread'] === 'boolean') {
        if (b['is_unread']) threadStore.updateThread(params['id']!, { is_unread: true });
        else threadStore.markThreadRead(params['id']!);
      }
      // Propagate extraction toggle to in-memory session (if active)
      if (skipExtraction !== undefined) {
        const session = this.sessionStore.get(params['id']!);
        if (session) {
          session.setSkipMemoryExtraction(skipExtraction);
        }
        // Private mode: purge extracted knowledge from this thread
        if (skipExtraction) {
          const knowledgeLayer = engine.getKnowledgeLayer();
          if (knowledgeLayer) {
            try {
              const purged = knowledgeLayer.purgeThread(params['id']!);
              if (purged > 0) {
                process.stderr.write(`[lynox:private] Purged ${purged} memories from thread ${params['id']!.slice(0, 8)}\n`);
              }
            } catch (err: unknown) {
              process.stderr.write(`[lynox:private] Purge failed for thread ${params['id']!.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}\n`);
            }
          }
        }
      }
      jsonResponse(res, 200, { ok: true });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('user', 'DELETE', '/api/threads/:id', async (_req, res, params) => {
      const threadStore = engine.getThreadStore();
      if (!requireService(res, threadStore, 'Thread store')) return;
      const thread = threadStore.getThread(params['id']!);
      if (!thread) { errorResponse(res, 404, 'Thread not found'); return; }
      // Also clean up in-memory session
      this.sessionStore.reset(params['id']!);
      threadStore.deleteThread(params['id']!);
      jsonResponse(res, 200, { ok: true });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('user', 'GET', '/api/threads/:id/messages', async (req, res, params) => {
      const threadStore = engine.getThreadStore();
      if (!requireService(res, threadStore, 'Thread store')) return;
      const thread = threadStore.getThread(params['id']!);
      // Mirror GET /threads/:id: a missing/old thread returns 200 with an empty
      // transcript + threadMissing flag, not a 404. The client keeps its local
      // snapshot (a stale copy is recoverable, a wipe is not) and renders an
      // empty state instead of a misleading connection error — and the browser
      // logs no failed-resource console noise.
      if (!thread) { jsonResponse(res, 200, { messages: [], activeRun: null, threadMissing: true }); return; }
      const url = new URL(req.url ?? '', 'http://localhost');
      const fromSeq = Math.max(parseInt(url.searchParams.get('fromSeq') ?? '0', 10) || 0, 0);
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '10000', 10) || 10000, 1), 50000);
      const records = threadStore.getMessages(params['id']!, { fromSeq, limit });
      // Apply render projection: merge tool-result carriers into preceding
      // tool-use blocks, strip safety wrappers for display, flatten into the
      // UI-ready shape that mirrors the client's ChatMessage.
      const messages = projectMessages(records);
      // Resumable re-attach (Tier 2, AC2/AC3): read this thread's live run
      // SYNCHRONOUSLY in the same tick as the transcript above. Two synchronous
      // reads can't be interleaved by an eager-persist checkpoint (which runs on
      // the same event loop), so the returned `lastPersistedSeq` is exactly the
      // durable boundary of THIS transcript — the client replays the buffer from
      // there with no gap and no double-render. `interrupted` tells the client to
      // show a Retry banner instead of re-attaching a dead run.
      const registry = this.engine?.getRunRegistry();
      let activeRun: { runId: string; status: string; lastPersistedSeq: number } | null = null;
      if (registry) {
        const row = registry.getActive().find((r) => r.thread_id === params['id']);
        if (row) {
          const awaiting = row.status === 'running' && !!this.engine?.getPromptStore()?.getPending(row.thread_id);
          activeRun = {
            runId: row.run_id,
            status: awaiting ? 'awaiting_input' : row.status,
            lastPersistedSeq: row.last_persisted_seq,
          };
        }
      }
      jsonResponse(res, 200, { messages, activeRun });
    }));

    // Comprehensive thread DEBUG-EXPORT. The thin client export (AppShell
    // exportThreadJson) carries only the thread record + rendered messages;
    // this adds the per-run telemetry that IS persisted but was never exported
    // — provider, per-run tokens/cost/cache, status/stop_reason/durations, the
    // RAW tool I/O, and the system-prompt snapshot at run time. Secret-scrubbed:
    // raw tool I/O + prompt snapshots can carry credentials that the display
    // projection masks but the raw store retained. User-scoped (the caller's own
    // thread). prd/engine-context-cost debug-export. Tier 1 = read-only bundle;
    // Tier 2 adds persisted cost data (per-run composition + cache-hit, raw
    // error detail, compaction events, thread cost rollup) captured by migrations
    // v36–v38 — they ride the bundle here via the run/compaction read paths.
    this.dynamicRoutes.push(parseDynamicRoute('user', 'GET', '/api/threads/:id/debug-export', async (_req, res, params) => {
      const threadStore = engine.getThreadStore();
      if (!requireService(res, threadStore, 'Thread store')) return;
      const id = params['id']!;
      const thread = threadStore.getThread(id);
      if (!thread) { errorResponse(res, 404, 'Thread not found'); return; }

      const messages = projectMessages(threadStore.getMessages(id, { fromSeq: 0, limit: 50000 }));

      const history = engine.getRunHistory();
      const runs = history
        ? history.getRunsBySession(id).map((run) => {
            // Tier 2: parse the per-run composition (stored as a JSON string) into
            // an object for readability, and drop the raw string to avoid a
            // double-escaped duplicate in the bundle.
            const { composition_json, ...rest } = run;
            let composition: unknown = null;
            if (composition_json) {
              try { composition = JSON.parse(composition_json); } catch { composition = null; }
            }
            // Tier 2: per-run cache-hit rate over the full prompt input (base +
            // cache_read + cache_write). null when the run billed no input.
            const promptInput = rest.tokens_in + rest.tokens_cache_read + rest.tokens_cache_write;
            const cache_hit_rate = promptInput > 0
              ? Math.round((rest.tokens_cache_read / promptInput) * 1000) / 1000
              : null;
            return {
              ...rest,
              composition,
              cache_hit_rate,
              tool_calls: history.getRunToolCalls(run.id).map((tc) => ({
                tool_name: tc.tool_name,
                input: tc.input_json,
                output: tc.output_json,
                duration_ms: tc.duration_ms,
                sequence_order: tc.sequence_order,
              })),
              prompt_snapshot: run.prompt_hash ? (history.getPromptSnapshot(run.prompt_hash)?.prompt_text ?? null) : null,
            };
          })
        : [];

      // Tier 2: persisted compaction events (when/why the carried context was
      // reset, and how much it dropped) — the cache-read floor's hidden mover.
      const compactionEvents = history ? history.getCompactionEventsBySession(id) : [];

      // Tier 2: thread-level cost rollup so a debugger sees "where the money went"
      // at a glance without re-summing the runs. Computed export-side from the
      // persisted rows — no schema change.
      const debugSummary = (() => {
        if (runs.length === 0) return null;
        let totalIn = 0, totalOut = 0, totalCacheRead = 0, totalCacheWrite = 0, totalCost = 0;
        let peak: { run_id: string; total_bytes: number; message_count: number } | null = null;
        for (const r of runs) {
          totalIn += r.tokens_in; totalOut += r.tokens_out;
          totalCacheRead += r.tokens_cache_read; totalCacheWrite += r.tokens_cache_write;
          totalCost += r.cost_usd;
          const comp = r.composition as { totalBytes?: number; messageCount?: number } | null;
          if (comp && typeof comp.totalBytes === 'number' && (!peak || comp.totalBytes > peak.total_bytes)) {
            peak = { run_id: r.id, total_bytes: comp.totalBytes, message_count: comp.messageCount ?? 0 };
          }
        }
        const promptInput = totalIn + totalCacheRead + totalCacheWrite;
        return {
          run_count: runs.length,
          total_cost_usd: totalCost,
          total_tokens_in: totalIn,
          total_tokens_out: totalOut,
          total_cache_read: totalCacheRead,
          total_cache_write: totalCacheWrite,
          overall_cache_hit_rate: promptInput > 0 ? Math.round((totalCacheRead / promptInput) * 1000) / 1000 : null,
          compaction_count: compactionEvents.length,
          peak_composition: peak,
        };
      })();

      // Memory snapshot (retention-safe): the tenant's OWN stored facts + KG stats, so a
      // debugger can see cross-subject bleed / poisoning directly — the runtime <fact>
      // injection the agent reacts to is derived from exactly this. Reads ALREADY-persisted
      // memory (the legacy write-authoritative store, complete regardless of the read-cutover
      // flag) — NO new always-on retention. Capped, and secret-scrubbed with the rest of the
      // bundle below; PII is kept (the user's own data, exported by their own action — see
      // sharing_notice). Best-effort: a KG hiccup must not fail the whole export.
      const MEMORY_SNAPSHOT_CAP = 200;
      const knowledgeLayer = engine.getKnowledgeLayer();
      let memory: unknown = null;
      if (knowledgeLayer) {
        try {
          memory = {
            kg_stats: await knowledgeLayer.stats(),
            active_memories_shown: 0,
            active_memories: knowledgeLayer.getDb().listAllActiveMemories(MEMORY_SNAPSHOT_CAP).map((m) => ({
              text: m.text,
              namespace: m.namespace,
              scope: `${m.scope_type}:${m.scope_id}`,
              source_type: m.source_type,
              source_tool_name: m.source_tool_name,
              confidence: m.confidence,
              confirmation_count: m.confirmation_count,
              created_at: m.created_at,
            })),
          };
          (memory as { active_memories_shown: number; active_memories: unknown[] }).active_memories_shown =
            (memory as { active_memories: unknown[] }).active_memories.length;
        } catch { memory = { error: 'memory snapshot unavailable' }; }
      }

      const buildSha = (process.env['BUILD_SHA'] ?? '').trim();
      const bundle = {
        exported_at: new Date().toISOString(),
        exported_by: 'lynox debug-export',
        schema: 'thread-debug-export/v2',
        engine: { version: PKG_VERSION, build_sha: buildSha.length > 0 ? buildSha : null },
        // The export is the user's own data, exported by their own action; it contains PII
        // (kept — scrubbing it would destroy the diagnostic value) with SECRETS masked below.
        sharing_notice: 'This export contains your own conversation data — including personal information and stored memories — with secrets masked. Share it only with recipients you trust.',
        thread,
        debug_summary: debugSummary,
        messages,
        runs,
        compaction_events: compactionEvents,
        memory,
      };
      // Secret-scrub the WHOLE bundle in one pass — messages AND runs AND tool
      // I/O AND prompt snapshots — so a credential pasted in chat or passed as a
      // tool argument can't surface unmasked. (Per-field masking of only `runs`
      // left the `messages` array — the largest free-text surface — exposed.)
      // NOTE: maskSecretPatterns matches KNOWN key shapes (sk-…, AKIA…, xox…);
      // prefix-less opaque tokens are NOT masked (the generic high-entropy
      // pattern is skipped to avoid over-masking legit debug data). This is
      // user-scoped own-thread data; the scrub is defense-in-depth for sharing.
      // A stricter export-only scrub (masking prefix-less opaque tokens) remains
      // a follow-up hardening — not in this Tier-2 scope.
      const scrubbed: unknown = JSON.parse(maskSecretPatterns(JSON.stringify(bundle)));
      jsonResponse(res, 200, scrubbed);
    }));

    // ── Memory ──
    const VALID_MEMORY_NS = new Set(['knowledge', 'methods', 'status', 'learnings']);
    type MemoryNs = 'knowledge' | 'methods' | 'status' | 'learnings';

    this.dynamicRoutes.push(parseDynamicRoute('user', 'GET', '/api/memory/:ns', async (_req, res, params) => {
      const memory = engine.getMemory();
      if (!requireService(res, memory, 'Memory')) return;
      if (!VALID_MEMORY_NS.has(params['ns']!)) { errorResponse(res, 400, 'Invalid memory namespace'); return; }
      const ns = params['ns'] as MemoryNs;
      const content = await memory.load(ns);
      jsonResponse(res, 200, { content });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('user', 'PUT', '/api/memory/:ns', async (_req, res, params, body) => {
      const memory = engine.getMemory();
      if (!requireService(res, memory, 'Memory')) return;
      if (!VALID_MEMORY_NS.has(params['ns']!)) { errorResponse(res, 400, 'Invalid memory namespace'); return; }
      const ns = params['ns'] as MemoryNs;
      const content = body && typeof body === 'object' && 'content' in body ? String((body as Record<string, unknown>)['content']) : '';
      if (engine.getSecretStore()?.containsSecret(content)) { errorResponse(res, 400, 'Cannot store content containing secret values in memory. Remove secrets and try again.'); return; }
      await new MemoryFacade(memory, engine.getKnowledgeLayer()).replaceDocument(ns, content);
      jsonResponse(res, 200, { ok: true });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('user', 'POST', '/api/memory/:ns/append', async (_req, res, params, body) => {
      const memory = engine.getMemory();
      if (!requireService(res, memory, 'Memory')) return;
      if (!VALID_MEMORY_NS.has(params['ns']!)) { errorResponse(res, 400, 'Invalid memory namespace'); return; }
      const ns = params['ns'] as MemoryNs;
      const text = body && typeof body === 'object' && 'text' in body ? String((body as Record<string, unknown>)['text']) : '';
      if (!text) { errorResponse(res, 400, 'Missing text'); return; }
      if (engine.getSecretStore()?.containsSecret(text)) { errorResponse(res, 400, 'Cannot store content containing secret values in memory. Remove secrets and try again.'); return; }
      await new MemoryFacade(memory, engine.getKnowledgeLayer()).append(ns, text);
      jsonResponse(res, 200, { ok: true });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('user', 'DELETE', '/api/memory/:ns', async (req, res, params) => {
      const memory = engine.getMemory();
      if (!requireService(res, memory, 'Memory')) return;
      if (!VALID_MEMORY_NS.has(params['ns']!)) { errorResponse(res, 400, 'Invalid memory namespace'); return; }
      const ns = params['ns'] as MemoryNs;
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const pattern = url.searchParams.get('pattern') ?? '';
      const deleted = await new MemoryFacade(memory, engine.getKnowledgeLayer()).delete(ns, pattern);
      jsonResponse(res, 200, { deleted });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('user', 'PATCH', '/api/memory/:ns', async (_req, res, params, body) => {
      const memory = engine.getMemory();
      if (!requireService(res, memory, 'Memory')) return;
      if (!VALID_MEMORY_NS.has(params['ns']!)) { errorResponse(res, 400, 'Invalid memory namespace'); return; }
      const ns = params['ns'] as MemoryNs;
      // Accept BOTH body contracts: the UI sends {old_content,new_content}; older/tool
      // callers send {old,new}. Reading only {old,new} made every UI inline edit a
      // silent no-op (empty strings → identity replace, reported as success).
      const b = body as Record<string, unknown> | null;
      const pick = (primary: string, fallback: string): string => {
        const v = b?.[primary] ?? b?.[fallback];
        return typeof v === 'string' ? v : '';
      };
      const oldText = pick('old', 'old_content');
      const newText = pick('new', 'new_content');
      if (engine.getSecretStore()?.containsSecret(newText)) { errorResponse(res, 400, 'Cannot store content containing secret values in memory. Remove secrets and try again.'); return; }
      const updated = await new MemoryFacade(memory, engine.getKnowledgeLayer()).update(ns, oldText, newText);
      jsonResponse(res, 200, { updated });
    }));

    // ── Knowledge review queue (DK.2) — the pending_review surface ──
    // Present ONLY when `durable_memory_enabled` (getKnowledgeStore() returns null
    // otherwise → requireService 503). Single-tenant, user scope: the queue is the
    // tenant's OWN untrusted-turn captures awaiting the human trust event. The
    // reviewer sees the RAW text deliberately (a human must judge injected content
    // on its actual wording — masking here would hide exactly what needs judging).
    this.addStatic('user', 'GET /api/knowledge/queue', async (req, res) => {
      const store = engine.getKnowledgeStore();
      if (!requireService(res, store, 'Durable memory')) return;
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 100, 500));
      jsonResponse(res, 200, { entries: store.listPending(limit), pendingCount: store.pendingCount() });
    });

    // Cheap badge poll (the Intelligence-Hub tab pill).
    this.addStatic('user', 'GET /api/knowledge/queue/count', async (_req, res) => {
      const store = engine.getKnowledgeStore();
      if (!requireService(res, store, 'Durable memory')) return;
      jsonResponse(res, 200, { pendingCount: store.pendingCount() });
    });

    this.dynamicRoutes.push(parseDynamicRoute('user', 'POST', '/api/knowledge/queue/:id/review', async (_req, res, params, body) => {
      const store = engine.getKnowledgeStore();
      if (!requireService(res, store, 'Durable memory')) return;
      const b = body as Record<string, unknown> | null;
      const action = typeof b?.['action'] === 'string' ? b['action'] : '';
      if (action !== 'approve' && action !== 'edit_approve' && action !== 'reject') {
        errorResponse(res, 400, "action must be 'approve', 'edit_approve' or 'reject'"); return;
      }
      const editedText = typeof b?.['text'] === 'string' ? b['text'] : undefined;
      if (action === 'edit_approve' && !editedText?.trim()) { errorResponse(res, 400, 'edit_approve needs text'); return; }
      // Approval promotes to the agent-readable active set — the same secret guard
      // as every other durable write surface (mirror of the memory PUT above).
      if (editedText && engine.getSecretStore()?.containsSecret(editedText)) {
        errorResponse(res, 400, 'Cannot store content containing secret values. Remove secrets and try again.'); return;
      }
      try {
        const entry = store.reviewEntry(params['id']!, action, editedText);
        if (!entry) { errorResponse(res, 404, 'No queued entry with this id'); return; }
        jsonResponse(res, 200, { entry });
      } catch (err) {
        errorResponse(res, 400, err instanceof Error ? err.message : 'Review failed');
      }
    }));

    // ── Knowledge read-surface (DK-UX) — the "Wissen" browse tab ──
    // Present ONLY when `durable_memory_enabled` (getKnowledgeStore() null otherwise
    // → requireService 503). Single-tenant, user scope: the tenant's OWN active memory.
    // Unlike the review queue these reads are MASKED (a browse/display surface — the
    // store applies the same two-layer H7 masking as the always-loaded block render).
    this.addStatic('user', 'GET /api/knowledge/entries', async (req, res) => {
      const store = engine.getKnowledgeStore();
      if (!requireService(res, store, 'Durable memory')) return;
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 200, 500));
      jsonResponse(res, 200, { entries: store.listActive(limit) });
    });

    this.addStatic('user', 'GET /api/knowledge/blocks', async (_req, res) => {
      const store = engine.getKnowledgeStore();
      if (!requireService(res, store, 'Durable memory')) return;
      jsonResponse(res, 200, store.readSurfaceBlocks());
    });

    // Undo of a just-made trusted write (the inline "rückgängig" chip, DK-UX). A USER act
    // via the UI (user_asserted tier) — NOT an agent tool, so it is not agent-self-approvable.
    // retireEntry refuses when the entry is not active (already retired) or outranks the user
    // channel; 404 for gone, 400 for a refusal.
    this.dynamicRoutes.push(parseDynamicRoute('user', 'POST', '/api/knowledge/entries/:id/retire', async (_req, res, params) => {
      const store = engine.getKnowledgeStore();
      if (!requireService(res, store, 'Durable memory')) return;
      try {
        const entry = store.retireEntry(params['id']!, 'user_asserted');
        jsonResponse(res, 200, { entry });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Retire failed';
        errorResponse(res, /no active entry/i.test(msg) ? 404 : 400, msg);
      }
    }));

    // ── Subjects (Record-on-spine R2b) — read-only subject-graph surface ──
    // Present ONLY when `subject_graph_enabled` (getSubjectStore/getSubjectFootprint
    // return null otherwise → requireService 503). Single-tenant, user scope; every
    // read is the tenant's OWN graph. No mutation route here — the surface is read +
    // one chat handoff; edits route through the agent (`set_thread_context`).
    this.addStatic('user', 'GET /api/subjects', async (req, res) => {
      const subjectStore = engine.getSubjectStore();
      if (!requireService(res, subjectStore, 'Subject graph')) return;
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
      const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 50, 200));
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      const all = subjectStore.listSubjects();
      const filtered = q ? all.filter(s => s.name.toLowerCase().includes(q)) : all;
      const page = filtered.slice(offset, offset + limit);
      // Project to id/kind/name only — the picker never needs aliases/embedding/detail.
      jsonResponse(res, 200, {
        subjects: page.map(s => ({ id: s.id, kind: s.kind, name: s.name })),
        total: filtered.length,
      });
    });

    this.dynamicRoutes.push(parseDynamicRoute('user', 'GET', '/api/subjects/:id/footprint', async (req, res, params) => {
      if (!requireService(res, engine.getSubjectStore(), 'Subject graph')) return;
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 50, 200));
      const footprint = engine.getSubjectFootprint(params['id']!, { limit });
      // null = stale/purged/unknown id (or flag off, already 503'd above) → 404.
      if (!footprint) { errorResponse(res, 404, 'Subject not found'); return; }
      jsonResponse(res, 200, footprint);
    }));

    // ── Secrets ──
    // user scope: the name list for the Settings UI — `listNames()` returns key
    // NAMES only, never values. The list is unfiltered (it includes infra/channel
    // key names too, not just the customer's own); that's names-only and exposes
    // no secret material, and PUT/DELETE still gate infra/channel secrets via
    // isAdminOnlySecret. (A managed-customer-visible filter is a possible
    // follow-up; not needed for the scope fix.)
    this.addStatic('user', 'GET /api/secrets', async (_req, res) => {
      const store = engine.getSecretStore();
      if (!requireService(res, store, 'Secret store')) return;
      const names = store.listNames();
      jsonResponse(res, 200, { names });
    });

    // Category-level booleans — available to all authenticated users
    this.addStatic('user', 'GET /api/secrets/status', async (_req, res) => {
      const store = engine.getSecretStore();
      if (!requireService(res, store, 'Secret store')) return;
      const names = new Set(store.listNames());
      const userConfig = engine.getUserConfig();
      const provider = userConfig.provider ?? 'anthropic';
      // Provider-aware LLM configured check (BYOK). Delegate the api-key check
      // to resolveProviderApiKey() so the env > vault > legacy-config fallback
      // ladder lives in one place (provider-keys.ts) — pre-fix this handler
      // open-coded the Anthropic branch and read `userConfig.api_key` for
      // openai/custom, which always returned `false` because config.ts only
      // populates `api_key` from ANTHROPIC_API_KEY. Net effect: Mistral /
      // OpenAI-compat installs landed in the SetupBanner wizard on first
      // login even with MISTRAL_API_KEY / OPENAI_API_KEY set (HN-launch
      // installer regression caught 2026-05-23).
      let llmConfigured: boolean;
      if (provider === 'vertex') {
        // Vertex needs GCP project + service account creds
        llmConfigured = !!(userConfig.gcp_project_id ?? process.env['GCP_PROJECT_ID'] ?? process.env['ANTHROPIC_VERTEX_PROJECT_ID']);
      } else if (provider === 'custom') {
        // Custom needs api_base_url configured + a key in the CUSTOM_API_KEY slot
        const customBase = userConfig.api_base_url ?? readEnvAlias('LYNOX_API_BASE_URL');
        const customKey = resolveProviderApiKey({ provider, apiBaseURL: userConfig.api_base_url, secretStore: store, userConfig });
        llmConfigured = !!customBase && !!customKey;
      } else if (provider === 'openai') {
        // OpenAI-compatible needs api_base_url + a key (env MISTRAL_API_KEY /
        // OPENAI_API_KEY or vault) + model id
        const openaiKey = resolveProviderApiKey({ provider, apiBaseURL: userConfig.api_base_url, secretStore: store, userConfig });
        llmConfigured = !!userConfig.api_base_url
          && (!endpointNeedsCredential(provider, userConfig.api_base_url) || !!openaiKey)
          && !!userConfig.openai_model_id;
      } else {
        // Anthropic direct — needs API key (env, vault, or legacy config.api_key)
        const anthropicKey = resolveProviderApiKey({ provider, apiBaseURL: userConfig.api_base_url, secretStore: store, userConfig });
        llmConfigured = !!anthropicKey;
      }
      const searxngUrl = userConfig.searxng_url ?? process.env['SEARXNG_URL'];
      jsonResponse(res, 200, {
        provider,
        // Emit the CANONICAL billing tier (hosted/managed/managed_pro). Legacy
        // values — `starter` (→hosted) or `eu` (→managed) — still live in the
        // LYNOX_MANAGED_MODE env on pre-rename tenants that haven't been
        // re-synced; normalizing here means every Web UI consumer sees the
        // canonical id regardless of provisioning vintage. null on self-host.
        managed: normalizeBillingTier(readEnvAlias('LYNOX_BILLING_TIER')) ?? null,
        // PRD-HN-LAUNCH-HARDENING tier-1 item 5: surface a public-demo flag so
        // the Web UI can render a "shared instance, no real data" banner on
        // engine.lynox.cloud for HackerNews launch week. Off by default — only  public-repo-guard:allow public demo host
        // the lynox-operated demo engine sets this env. Customer
        // self-host stays clean.
        public_demo: process.env['LYNOX_PUBLIC_DEMO'] === 'true',
        // Provider hints for SetupBanner restore (added 2026-05-27 to fix G5
        // SetupBanner-Ollama-defaults regression). Without these, when the
        // vault becomes empty (or the user re-opens SetupBanner after a
        // provider switch), the banner can't distinguish "Mistral preset"
        // from "generic OpenAI-compat" and falls back to Ollama defaults
        // (URL=localhost:11434, model=llama3.2). These two fields are non-
        // secret — base URLs are public + model ids are public — so safe to
        // expose alongside provider.
        api_base_url: userConfig.api_base_url ?? null,
        openai_model_id: userConfig.openai_model_id ?? null,
        configured: {
          api_key: llmConfigured,
          // Tavily backend retired 2026-05-24 — search is "configured" only
          // when SearXNG is wired (full quality). The DDG HTML-scrape
          // fallback always provides a `web_research` tool but counts as
          // best-effort, not configured.
          search: !!searxngUrl,
          searxng: !!searxngUrl,
          google: names.has('GOOGLE_CLIENT_ID') || names.has('GOOGLE_CLIENT_SECRET'),
          bugsink: names.has('LYNOX_BUGSINK_DSN'),
        },
        count: names.size,
        searxng_url: searxngUrl ?? null,
      });
    });

    this.dynamicRoutes.push(parseDynamicRoute('user', 'PUT', '/api/secrets/:name', async (_req, res, params, body) => {
      const name = params['name']!;
      // Managed-tier user (cookie auth → user scope per L~1049): user-writable
      // for any name EXCEPT infrastructure / channel-managed patterns (see
      // INFRA_ADMIN_ONLY_PATTERNS doc). Self-host has no admin secret, so
      // cookie users are already promoted to admin and this gate never applies.
      if (requiresAdminSplitGate(readEnvAlias('LYNOX_BILLING_TIER')) && isAdminOnlySecret(name)) {
        errorResponse(res, 403, `Managed mode: secret "${name}" is admin-managed (infrastructure or channel-managed). Set this via the relevant integration UI or contact support@lynox.ai.`);
        return;
      }
      const store = engine.getSecretStore();
      if (!requireService(res, store, 'Secret store')) return;
      const b = body as Record<string, unknown> | null;
      const value = b && typeof b['value'] === 'string' ? b['value'] : '';
      if (!value) { errorResponse(res, 400, 'Missing value'); return; }
      try {
        store.set(name, value);
        store.recordConsent(name);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to store secret';
        errorResponse(res, 503, msg);
        return;
      }
      // PRD-IA-V2 P3-PR-B (Security S4) parity: emit a names-only audit row
      // for every BYOK secret write. /api/config audits at L~2510; secrets
      // need the same trail for compliance + incident-replay.
      try {
        const audit = engine.getSecurityAudit();
        audit?.record({
          event_type: 'secret_update',
          decision: 'applied',
          source: 'http_api',
          detail: JSON.stringify({
            slot: name,
            tier: readEnvAlias('LYNOX_BILLING_TIER') ?? 'self-host',
          }),
        });
      } catch {
        // Audit failure must not mask the user-visible write success.
      }
      // Hot-reload the LLM client so subsequent sessions pick up the new key
      // without a process restart. Uses reloadCredentials (not reloadUserConfig)
      // because the gate in reloadUserConfig only re-creates `engine.client`
      // when a config.json field changes — vault-only writes wouldn't fire it
      // and `engine.client` (KG init + batch) would keep a stale key.
      let hotReload = true;
      if (PROVIDER_KEY_SLOTS.has(name)) {
        try {
          await engine.reloadCredentials();
        } catch {
          hotReload = false;
        }
      }
      jsonResponse(res, 200, { ok: true, hot_reload: hotReload });
    }));

    // user scope (matches PUT): the instance owner manages their own integration
    // keys. The real protection is the tier-keyed gate below, not the route scope.
    this.dynamicRoutes.push(parseDynamicRoute('user', 'DELETE', '/api/secrets/:name', async (_req, res, params) => {
      const name = params['name']!;
      // Defense-in-depth, independent of route scope: on a managed instance an
      // infra / channel-managed secret (LYNOX_VAULT_KEY, MANAGED_*, MAIL_ACCOUNT_*,
      // GOOGLE_*, …) must never be deletable — only the customer's own tool
      // credentials (SHOPIFY_*, …) delete freely. Mirrors the PUT gate.
      if (requiresAdminSplitGate(readEnvAlias('LYNOX_BILLING_TIER')) && isAdminOnlySecret(name)) {
        errorResponse(res, 403, `Managed mode: secret "${name}" is admin-managed (infrastructure or channel-managed). Manage this via the relevant integration UI or contact support@lynox.ai.`);
        return;
      }
      const store = engine.getSecretStore();
      if (!requireService(res, store, 'Secret store')) return;
      const deleted = store.deleteSecret(name);
      jsonResponse(res, 200, { deleted });
    }));

    // BYOK validation probe — used by the Web UI SetupBanner BEFORE
    // PUT /api/secrets/:name so a typo'd key never silently lands in the
    // vault + walks the user through 5 minutes of onboarding before
    // dead-ending at a 401. Mirrors the CLI installer's pre-save
    // validation (validateAnthropicKey / validateOpenAICompatKey in
    // src/cli/docker-installer.ts) so both surfaces enforce the same
    // contract: anthropic hits POST /v1/messages with max_tokens=1,
    // openai-compat hits GET <base>/models. 3-state contract: `valid`
    // blocks save on UI side iff false; `invalid` shows the engine
    // reason (Invalid API key / Rate limited / etc.); `network-error`
    // is non-blocking so a flaky Anthropic outage doesn't trap the
    // user mid-setup.
    this.addStatic('user', 'POST /api/secrets/validate-key', async (_req, res, _params, body) => {
      const b = body as Record<string, unknown> | null;
      const provider = b && typeof b['provider'] === 'string' ? b['provider'] : '';
      const key = b && typeof b['key'] === 'string' ? b['key'] : '';
      const apiBaseUrl = b && typeof b['api_base_url'] === 'string' ? b['api_base_url'] : '';
      if (!provider || !key) { errorResponse(res, 400, 'Missing provider or key'); return; }
      const { validateAnthropicKey, validateMistralKey, validateOpenAICompatKey } = await import('../cli/docker-installer.js');
      try {
        if (provider === 'anthropic') {
          const result = await validateAnthropicKey(key);
          jsonResponse(res, 200, result);
        } else if (provider === 'mistral') {
          const result = await validateMistralKey(key);
          jsonResponse(res, 200, result);
        } else if (provider === 'openai' || provider === 'custom') {
          if (!apiBaseUrl) { errorResponse(res, 400, 'Missing api_base_url for openai/custom provider'); return; }
          // The base URL is user-supplied. Validate it resolves to a public host
          // before we fetch it server-side, so this key-validation probe can't be
          // turned into an SSRF against the engine's internal network / cloud
          // metadata. (The /api/llm/test probe does the same via the guard.)
          const { assertPublicUrl, fetchWithPublicRedirects } = await import('../core/network-guard.js');
          try {
            await assertPublicUrl(apiBaseUrl);
          } catch {
            jsonResponse(res, 200, { state: 'invalid', error: 'Endpoint URL must be a public address' });
            return;
          }
          // Pin the probe fetch too: assertPublicUrl only checks the initial host,
          // so the actual request must go through the guarded transport that
          // re-validates each redirect hop + pins the resolved IP (no 302→private,
          // no DNS-rebind between the check and the socket).
          const result = await validateOpenAICompatKey(key, apiBaseUrl, undefined, fetchWithPublicRedirects);
          jsonResponse(res, 200, result);
        } else {
          errorResponse(res, 400, `Unsupported provider: ${provider}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Validation failed';
        jsonResponse(res, 200, { state: 'network-error', error: msg });
      }
    });

    // SearXNG health check — validates a SearXNG URL is reachable
    this.addStatic('user', 'POST /api/searxng/check', async (_req, res, _params, body) => {
      const b = body as Record<string, unknown> | null;
      const url = b && typeof b['url'] === 'string' ? b['url'].replace(/\/+$/, '') : '';
      if (!url) { errorResponse(res, 400, 'Missing url'); return; }
      // Validate scheme (http/https only) and block cloud metadata endpoints
      let parsed: URL;
      try { parsed = new URL(url); } catch { errorResponse(res, 400, 'Invalid URL'); return; }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        errorResponse(res, 400, 'URL must use http:// or https://');
        return;
      }
      const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
      // Block cloud metadata endpoints (AWS/GCP/Azure all use 169.254.169.254)
      // Private IPs intentionally allowed — SearXNG typically runs on Docker network or LAN
      if (hostname === '169.254.169.254' || hostname.startsWith('169.254.')
          || hostname === 'metadata.google.internal'
          || hostname === 'metadata.internal') {
        errorResponse(res, 400, 'Blocked: cloud metadata endpoint');
        return;
      }
      try {
        const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(5000) });
        jsonResponse(res, 200, { healthy: response.ok });
      } catch {
        jsonResponse(res, 200, { healthy: false });
      }
    });

    // Search reranker capability probe — read-time provider snapshot so the
    // Settings → Search page can surface "Reranker is Anthropic-only" instead
    // of letting users toggle LYNOX_SEARCH_RERANK=true on Mistral and get a
    // silent no-op. The runtime guard in search-reranker.ts is unchanged;
    // this just mirrors it for the UI. No DB row, no settings flag.
    this.addStatic('user', 'GET /api/search/reranker/capability', async (_req, res) => {
      jsonResponse(res, 200, getRerankerCapability());
    });

    // ── Config ──
    this.addStatic('user', 'GET /api/config', async (_req, res) => {
      const { readUserConfig, applyManagedTierSetConstraints } = await import('../core/config.js');
      const config = readUserConfig();
      // Canonical redaction: strips top-level secrets (with `${key}_configured`
      // markers for the UI) AND nested tier_set/model_profiles api_keys.
      const redacted = redactConfigForResponse(config);
      // Expose managed tier so the Web UI can adapt its settings UI ('hosted' = BYOK, managed/managed_pro = CP-supplied LLM)
      const tier = readEnvAlias('LYNOX_BILLING_TIER') ?? null;
      const isManagedTier = cpSuppliesLLMKey(tier);
      if (tier) {
        // Emit the CANONICAL tier (starter→hosted, eu→managed) so every Web UI
        // consumer sees canonical ids regardless of provisioning vintage — a
        // pre-rename tenant still carries LYNOX_MANAGED_MODE=starter until it's
        // re-synced. cpSuppliesLLMKey above already normalizes internally.
        redacted['managed'] = normalizeBillingTier(tier) ?? tier;
      }
      // Capability probe: what this instance *can* do, independent of tier.
      // Drives capability-based gating in the Web UI so working features stop
      // being hidden by tier checks (see PRD-SETTINGS-REFACTOR Principle 6).
      const secretStore = engine.getSecretStore();
      const secretNames = secretStore ? new Set(secretStore.listNames()) : new Set<string>();
      const mistralAvailable = secretNames.has('MISTRAL_API_KEY') || !!process.env['MISTRAL_API_KEY'];
      const [transcribeMod, speakMod, limitsMod] = await Promise.all([
        import('../core/transcribe.js'),
        import('../core/speak.js'),
        import('../core/limits.js'),
      ]);
      redacted['capabilities'] = {
        mistral_available: mistralAvailable,
        voice_stt_available: transcribeMod.hasTranscribeProvider(),
        voice_tts_available: speakMod.hasSpeakProvider(),
        whisper_local_available: transcribeMod.whisperCppProvider.isAvailable,
        // Capability gates — drive UI visibility instead of tier checks
        // P3-FOLLOWUP-HOTFIX: provider switching is now allowed on Managed
        // between the curated allowlist (anthropic + mistral preset), so
        // `can_set_provider` is true everywhere. The narrower lock lives in
        // `can_set_custom_provider_endpoints` for free-text base_url tiles.
        can_set_provider: true,
        can_set_custom_provider_endpoints: !isManagedTier,
        can_set_limits: !isManagedTier,
        can_set_context_window: true,
        can_set_thinking_effort: true,
        can_set_custom_endpoints: !isManagedTier,
        can_export_data: true,
        can_delete_account: true,
        // Dark gates — flip to true when PRD-MCP / PRD-CAL backends land
        has_mcp_support: false,
        has_calendar: false,
        // R2b subject-graph surface: true iff subject_graph_enabled wired the store
        // (fleet OFF today) → the Web UI shows/hides the Subjects tab on this probe.
        has_subject_graph: engine.getSubjectStore() !== null,
        // DK.2 durable-memory surface: true iff durable_memory_enabled wired the
        // KnowledgeStore → the Web UI shows/hides the review-queue tab on this probe.
        has_durable_memory: engine.getKnowledgeStore() !== null,
        // Hard-limits exposure: full numbers for self-host/BYOK,
        // opaque tier-tag for managed (prevents DoS-knob disclosure).
        hard_limits: isManagedTier
          ? { tier: 'managed', contact_for_quotas: true }
          : limitsMod.getHardLimits(),
      };
      // Lock metadata for every `can_set_X = false` decision. UI renders a
      // human-readable reason instead of an unexplained disabled input.
      const locks: CapabilityLocks = {};
      if (isManagedTier) {
        // P3-FOLLOWUP-HOTFIX: provider was previously fully locked on Managed;
        // we now allow switching between curated providers (Anthropic + Mistral)
        // and only lock the free-text custom-endpoint tiles. UI consumes the
        // `custom_provider_endpoints` flag to disable `requires_base_url` tiles
        // while keeping the curated tiles clickable. Backend enforces the same
        // rule via `enforceManagedProviderConstraints()` on PUT.
        locks.custom_provider_endpoints = { reason: 'managed-tier' };
        locks.limits = {
          reason: 'managed-tier',
          contact_cta: { href: 'mailto:support@lynox.ai?subject=Quota%20adjustment', label: 'Contact support' },
        };
        locks.custom_endpoints = { reason: 'managed-tier' };
      }
      redacted['locks'] = locks;
      // Settings v3 Item 6 (model-aware context-window radios): resolve the
      // currently active model from tier + provider and surface its native
      // capability data so the UI doesn't have to bundle the registry or
      // guess from a tier alias. UI filters context-window radio options to
      // values ≤ contextWindow; show-all-grayed (Item 8) reads `features` to
      // disable settings that don't apply to the active model.
      const activeProvider = getActiveProvider();
      const activeTier = config.default_tier ?? 'balanced';
      const activeModelId = getModelId(activeTier, activeProvider);
      const activeCap = modelCapability(activeModelId);
      // SSOT window resolution: a declared `openai_context_window` (self-host)
      // wins; else the registry; else an honest default — and crucially NOT a
      // Claude window when an openai/custom tier resolver fell back to an
      // Anthropic id. Same helper the agent + /api/sessions use, so the radio
      // filter can't drift from what the engine actually trims against.
      const activeNativeWindow = resolveNativeContextWindow(activeModelId, activeProvider, config.openai_context_window);
      if (activeCap) {
        redacted['active_model'] = {
          id: activeCap.id,
          tier: activeTier,
          // Use the runtime-active provider, not `activeCap.provider`, so an
          // openai-compat instance whose tier resolver fell back to an
          // Anthropic id (no MISTRAL_MODEL_MAP bootstrap) still reports
          // `'openai'` to the UI for tier-awareness gating.
          provider: activeProvider,
          // Resolver, not `activeCap.contextWindow`: honours a declared
          // self-host window and dodges the Anthropic-fallback Claude window.
          contextWindow: activeNativeWindow,
          defaultMaxOutput: activeCap.defaultMaxOutput,
          maxContinuations: activeCap.maxContinuations,
          features: activeCap.features,
          uiLabel: activeCap.uiLabel,
        };
      } else if (config.openai_context_window !== undefined && config.openai_context_window > 0) {
        // Unknown id BUT the operator declared a native window (self-host
        // openai-compat). Surface a minimal active_model so the UI filters its
        // context-window radios against the REAL window instead of the legacy
        // static list. Features unknown → all-false (assert no capability we
        // can't verify; UI reads them defensively via optional-chaining).
        redacted['active_model'] = {
          id: activeModelId,
          tier: activeTier,
          provider: activeProvider,
          contextWindow: activeNativeWindow,
          defaultMaxOutput: FALLBACK_CAPABILITY.defaultMaxOutput,
          maxContinuations: FALLBACK_CAPABILITY.maxContinuations,
          features: { vision: false, extendedThinking: false, toolUse: false, promptCaching: false, pdfInput: false },
          uiLabel: activeModelId,
        };
      } else {
        // Unknown id, no declared window (legacy custom-endpoint model or
        // registry gap). UI falls back to the legacy static radio list.
        // Surface for support tracing.
        console.warn(`[http-api] /config: no MODEL_CAPABILITIES entry for ${activeModelId} (tier=${activeTier}, provider=${activeProvider})`);
      }
      // Sonnet-variant selection (Sonnet 5 opt-in): surface the RESOLVED
      // `balanced_model` so the LLM-Advanced variant picker always has a
      // concrete served-Sonnet value to bind to — present even when the field
      // is unset (defaults to Sonnet 4.6) or holds a stale/invalid value
      // (resolveBalancedModel falls it back to the default). The redaction
      // spread already carries the raw stored value; overriding it with the
      // resolver guarantees the UI never sees `undefined` or a non-served id.
      redacted['balanced_model'] = resolveBalancedModel(config);

      // main_chat_tiers (DEF-0082): the active provider's per-tier model LABEL,
      // for the composer picker's two follow-ups —
      //   (a) name-enrichment: render "Tief (Opus 4.6)" instead of a bare tier;
      //   (b) hide the picker on a single-model provider (a custom / OpenAI-compat
      //       proxy whose three tiers all resolve to the same one model).
      // Absent when the active provider exposes fewer than two DISTINCT tier
      // models; that absence is the signal the composer reads to hide itself.
      // Derived by `mainChatTierLabels` from the catalog's `main_chat_models` —
      // where the tier→model maps live — so labels can't drift from what routes.
      // In HYBRID routing each tier may run a different provider+model (tier_set),
      // so the labels must be resolved through the tier_set — otherwise the picker
      // shows the active provider's default map (e.g. "Ausgewogen (Sonnet 5)")
      // while the tier actually routes to the slot's model (e.g. Mistral Large).
      // Standard routing keeps the single-provider derivation.
      if (config.routing_mode === 'hybrid' && config.tier_set) {
        // On a managed tenant the runtime drops any tier_set slot the CP can't back (no key for
        // that provider), so the picker must label the CONSTRAINED set — otherwise it shows a
        // model that never routes (e.g. "Ausgewogen (Mistral Large)" while it routes Sonnet).
        const effectiveTierSet = isManagedTier ? applyManagedTierSetConstraints(config.tier_set) : config.tier_set;
        const tierLabels = mainChatTierLabelsFromTierSet(effectiveTierSet, activeProvider);
        if (tierLabels) redacted['main_chat_tiers'] = tierLabels;
      } else {
        const mainChatEntry = getCatalogEntryByKey(resolveCatalogKey(activeProvider, config.api_base_url));
        if (mainChatEntry) {
          const tierLabels = mainChatTierLabels(mainChatEntry, resolveBalancedModel(config));
          if (tierLabels) redacted['main_chat_tiers'] = tierLabels;
        }
      }
      // Bugsink-toggle UX requires the page to know whether a DSN is
      // configured (env or vault) without leaking the DSN itself.
      redacted['bugsink_dsn_configured'] = !!(process.env['LYNOX_BUGSINK_DSN'] || secretNames.has('LYNOX_BUGSINK_DSN') || config.bugsink_dsn);

      // ENV override surface — self-host docs recommend LYNOX_LLM_PROVIDER, but
      // when set it overrides config.json on every reload, so the Settings →
      // LLM provider-switch UI silently fails (user clicks Mistral, saves,
      // refreshes — still on Anthropic because env trumps disk). Tell the UI
      // so it can render a banner instead of accepting the click in silence.
      // Symmetric for any future env override we add to the same screen.
      redacted['env_overrides'] = {
        provider: !!process.env['LYNOX_LLM_PROVIDER'],
      };

      // F1b: when the provider is env-pinned it never lands in config.json, so
      // `provider`/`api_base_url` are absent from the spread above and the
      // Settings UI can't tell which tile is active (it falls back to
      // 'anthropic' and shows the wrong provider selected — engine runs e.g.
      // Mistral). Surface the EFFECTIVE active provider + its (non-secret) base
      // URL so the UI can highlight the right tile. Gated on the env-pin so the
      // on-disk `provider`/empty-state/`providerExplicit` logic is untouched
      // when the provider comes from config.json normally.
      if (process.env['LYNOX_LLM_PROVIDER']) {
        redacted['active_provider'] = {
          provider: getActiveProvider(),
          api_base_url: engine.getUserConfig().api_base_url ?? '',
        };
      }

      // Stripe Customer Portal hosted-login URL (v1.6.0 stopgap for PR 3).
      // When set, the engine surfaces it as `stripe_portal_login_url` so the
      // Account/Billing page can render a working CTA that drops the customer
      // into Stripe's email-OTP login (Stripe handles auth + portal — no
      // cross-domain cookie tanz). Set per-instance via `sync-env` admin API
      // until the PR 3 sprint moves it into the CP config-generator pipeline.
      // See [[project_pr3_stripe_portal_sso_deferred]] for the full SSO plan.
      const stripePortalUrl = process.env['LYNOX_STRIPE_PORTAL_LOGIN_URL'];
      if (stripePortalUrl && /^https:\/\/billing\.stripe\.com\//.test(stripePortalUrl)) {
        redacted['stripe_portal_login_url'] = stripePortalUrl;
      }

      jsonResponse(res, 200, redacted);
    });

    // Scope = 'user' so managed-mode cookie users (always user-scope per the
    // `adminSecret ? 'user' : 'admin'` logic) can reach the allowlist below.
    // Self-host: no admin secret → cookie users auto-promoted to admin scope
    // at the auth layer, so the allowlist branch is a no-op for them.
    this.addStatic('user', 'PUT /api/config', async (_req, res, _params, body) => {
      const { readUserConfig, saveUserConfig, reloadConfig, loadConfig } = await import('../core/config.js');
      if (!body || typeof body !== 'object') { errorResponse(res, 400, 'Invalid config'); return; }
      // Wave 5d BYOK liability gate (server-side): `confirm_custom_endpoint` is
      // a control-plane signal, not a config field — it acts as a per-call
      // equivalent of the `LYNOX_CUSTOM_ENDPOINT_ACCEPTED=true` env-flag and
      // shifts controller-responsibility for the third-party endpoint to the
      // customer. Strip it BEFORE schema-parse because `LynoxUserConfigSchema`
      // is `.strict()` and would otherwise 400 on the unknown key. We hold
      // the boolean and feed it to `evaluateEndpointBootGate` below.
      const bodyObj = body as Record<string, unknown>;
      const confirmCustomEndpoint = bodyObj['confirm_custom_endpoint'] === true;
      if ('confirm_custom_endpoint' in bodyObj) {
        delete bodyObj['confirm_custom_endpoint'];
      }
      const parsed = LynoxUserConfigSchema.safeParse(body);
      if (!parsed.success) {
        errorResponse(res, 400, `Invalid config: ${parsed.error.issues.map(i => i.message).join(', ')}`);
        return;
      }
      // Sonnet-variant selection: the schema admits any 1–64-char string
      // (`balanced_model` is intentionally NOT a z.enum — an unrecognised value
      // must degrade at the resolver, not null the whole `.strict()` config).
      // Enforce the served-Sonnet allowlist HERE, before any persistence, so an
      // invalid or non-Sonnet id (e.g. an Opus id, or a typo) is rejected with a
      // clear 400 and can never route the `balanced` tier off-Sonnet. Runs for
      // EVERY tier (self-host + managed) and before the managed lock-gate, so a
      // bad value is a 400 (invalid), not a 403 (the field itself IS writable).
      const incomingBalancedModel = (parsed.data as Record<string, unknown>)['balanced_model'];
      if (incomingBalancedModel !== undefined) {
        if (typeof incomingBalancedModel !== 'string' || !SERVED_BALANCED_SONNET_IDS.has(incomingBalancedModel)) {
          errorResponse(res, 400, `Invalid balanced_model: must be one of ${[...SERVED_BALANCED_SONNET_IDS].join(', ')}`);
          return;
        }
      }
      // Managed-pool tiers (managed / managed_pro / eu): CP locks provider +
      // cost-caps + integrations. Starter BYOK is NOT gated here — customer
      // owns their LLM, owns their config. The Web UI re-sends every field on
      // every save (PRD-SETTINGS-REFACTOR Principle 6), so we can't reject
      // non-allowlist fields outright — compare each against the *effective*
      // value (config file + managed defaults) and only block real changes.
      // Schema is `.strict()` (PRD-IA-V2 P1-PR-A2) — unknown fields already
      // 400 before we get here, so this loop only sees real schema fields.
      if (requiresConfigLockGate(readEnvAlias('LYNOX_BILLING_TIER'))) {
        const fileConfig = loadConfig() as Record<string, unknown>;
        const update = parsed.data as Record<string, unknown>;
        // P3-FOLLOWUP-HOTFIX: value-range validation for the curated provider
        // allowlist. `provider` is in MANAGED_USER_WRITABLE_CONFIG (so the
        // strict-diff below lets it pass) — this is the additional guard that
        // caps the allowed set to Anthropic + Mistral. Reject FIRST so a
        // malformed save can't pollute downstream config-merge state.
        const providerReason = enforceManagedProviderConstraints(update);
        if (providerReason) {
          errorResponse(res, 403, providerReason);
          return;
        }
        const attempted: string[] = [];
        for (const [field, value] of Object.entries(update)) {
          if (MANAGED_USER_WRITABLE_CONFIG.has(field)) continue;
          // Managed pool: provider is forced to 'anthropic' (CP key); the UI
          // resends it on every save (read from /api/secrets/status, which
          // defaults the field). A strict diff against loadConfig() would
          // 403 because the field isn't physically in the config file —
          // overlay the managed default before comparing so the no-op
          // resend passes.
          const effective = fileConfig[field] ?? MANAGED_EFFECTIVE_DEFAULTS[field];
          if (JSON.stringify(value) !== JSON.stringify(effective)) {
            attempted.push(field);
          }
        }
        if (attempted.length > 0) {
          errorResponse(res, 403, `Managed instance: cannot change ${attempted.join(', ')}`);
          return;
        }
      }
      // T2-P3: cross-field validation for `provider: 'openai'`. The OpenAI-
      // compatible adapter has no usable default for `api_base_url` or
      // `openai_model_id`; saving `provider: 'openai'` alone leaves the
      // engine in a half-configured state that crashes on first inference.
      // Reject the save with a 400 that names the missing field so the
      // SetupBanner can surface "API base URL required" instead of a generic
      // "Save failed" toast. Only applies when `provider` is explicitly
      // present in the PUT body — partial updates of other fields on an
      // already-configured `provider: 'openai'` instance must still work.
      // Runs AFTER the managed lock-gate so a managed-mode `provider:'openai'`
      // attempt 403s on the security gate rather than 400ing on the cross-
      // field check (preserves the "managed reject names the field" contract).
      const incoming = parsed.data as Record<string, unknown>;
      // Env-pinned provider (LYNOX_LLM_PROVIDER set): the provider + its endpoint
      // fields are controlled by the env, never config.json, and the runtime masks
      // any user value. The Web UI re-sends every field on every save, so a naive
      // 403 would break legitimate no-op saves of OTHER fields — instead STRIP the
      // env-controlled fields from the persisted update. Without this, a user PUT
      // (or curl) persists e.g. provider:'anthropic' into config.json where it's
      // masked at runtime but surfaces in the LLM-settings UI + /api/export as the
      // (wrong) configured provider/residency — the H-001 corruption. Silent strip,
      // not reject: these fields have no effect under an env-pin anyway.
      if (process.env['LYNOX_LLM_PROVIDER']) {
        delete incoming['provider'];
        delete incoming['api_base_url'];
        delete incoming['openai_model_id'];
      }
      if (incoming['provider'] === 'openai') {
        const apiBaseUrl = incoming['api_base_url'];
        if (typeof apiBaseUrl !== 'string' || apiBaseUrl.trim() === '') {
          errorResponse(res, 400, "provider:'openai' requires api_base_url");
          return;
        }
        const openaiModelId = incoming['openai_model_id'];
        if (typeof openaiModelId !== 'string' || openaiModelId.trim() === '') {
          errorResponse(res, 400, "provider:'openai' requires openai_model_id");
          return;
        }
      }
      // Wave 5d BYOK liability gate (HTTP surface). Closes the UI-only carveout
      // — a direct `curl PUT /api/config` previously bypassed the LLMSettings
      // modal entirely. When the incoming body proposes a non-allowlisted
      // `api_base_url`, require either:
      //   - `confirm_custom_endpoint: true` in the body (per-call acceptance,
      //     equivalent to the env-flag for this single write), OR
      //   - `LYNOX_CUSTOM_ENDPOINT_ACCEPTED=true` on the engine process
      //     (operator-side acceptance, persists across writes)
      // Decision logic is the SAME `evaluateEndpointBootGate` used at engine
      // boot + by `_enforceEndpointAllowlist`, so the contract is one
      // source-of-truth. Disclosure text comes from `describeDisclosure(url)`
      // — single wording across Settings UI, api_setup tool, engine boot,
      // and this HTTP gate.
      //
      // Only fires when `api_base_url` is present in the incoming body — a
      // PUT that touches unrelated fields leaves the existing `api_base_url`
      // alone and doesn't re-trigger the disclosure (the engine-boot gate
      // already captured acceptance when the URL was first installed).
      // Defense-in-depth: `reloadUserConfig` re-checks the gate post-save so
      // any non-HTTP write-path (config.json edit, vault rotation) is still
      // gated before the LLM client is rebuilt.
      const incomingBaseUrl = incoming['api_base_url'];
      let acceptedHostToRecord: string | null = null;
      if (typeof incomingBaseUrl === 'string' && incomingBaseUrl.trim().length > 0) {
        const acceptedFlag = confirmCustomEndpoint
          ? 'true'
          : process.env['LYNOX_CUSTOM_ENDPOINT_ACCEPTED'];
        const decision = evaluateEndpointBootGate(incomingBaseUrl, acceptedFlag);
        if (decision === 'refuse') {
          jsonResponse(res, 400, {
            error: 'REQUIRES_USER_CONFIRMATION',
            disclosure: describeDisclosure(incomingBaseUrl),
            hint: 'Re-submit with `confirm_custom_endpoint: true` in the body to record acceptance.',
          });
          return;
        }
        // A non-allowlisted endpoint that passed the gate = an explicit
        // disclosure acceptance. Persist {host, accepted_at} server-side
        // (below, into the merged config) so it survives reload / new device
        // and is auditable — replacing the old sessionStorage-only flag.
        if (decision === 'accepted') {
          try { acceptedHostToRecord = new URL(incomingBaseUrl).hostname; } catch { /* malformed — skip */ }
        }
      }
      // Merge with existing config so partial updates don't lose other fields
      const existing = readUserConfig() as Record<string, unknown>;
      const update = parsed.data as Record<string, unknown>;
      const merged = { ...existing };
      for (const [key, value] of Object.entries(update)) {
        if (value === null) {
          delete merged[key]; // explicit null = delete field
        } else {
          merged[key] = value;
        }
      }
      // Record the disclosure acceptance (dedup by host) into the durable config.
      if (acceptedHostToRecord) {
        const prior = Array.isArray(merged['accepted_custom_endpoints'])
          ? (merged['accepted_custom_endpoints'] as Array<{ host: string; accepted_at: string }>)
          : [];
        if (!prior.some((e) => e.host === acceptedHostToRecord)) {
          merged['accepted_custom_endpoints'] = [...prior, { host: acceptedHostToRecord, accepted_at: new Date().toISOString() }];
        }
      }
      saveUserConfig(merged);
      reloadConfig();
      await engine.reloadUserConfig();

      // PRD-IA-V2 P3-PR-B (Security S4) — structured audit-log per
      // saveUserConfig write. Keys-only (no values) → safe for self-host
      // history.db + managed CP without leaking secrets/limit-values into
      // the audit trail. SecurityAudit auto-masks any accidental secret
      // strings via maskSecrets(), but we only emit field-names here.
      try {
        const audit = engine.getSecurityAudit();
        if (audit) {
          const fields = Object.keys(parsed.data);
          audit.record({
            event_type: 'config_update',
            decision: 'applied',
            source: 'http_api',
            detail: JSON.stringify({
              tier: readEnvAlias('LYNOX_BILLING_TIER') ?? 'self-host',
              fields_changed: fields,
            }),
          });
        }
      } catch {
        // Never let audit-emit failures break the config write.
      }

      jsonResponse(res, 200, { ok: true });
    });

    // ── History ──
    this.addStatic('user', 'GET /api/history/runs', async (req, res) => {
      const history = engine.getRunHistory();
      if (!requireService(res, history, 'History')) return;
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const q = url.searchParams.get('q');
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '20', 10) || 20, 1), 500);
      const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0);
      if (q) {
        const runs = history.searchRuns(q, limit, offset);
        jsonResponse(res, 200, { runs });
      } else {
        const filters: { status?: string; model?: string; dateFrom?: string; dateTo?: string; sessionId?: string } = {};
        const status = url.searchParams.get('status');
        const model = url.searchParams.get('model');
        const dateFrom = url.searchParams.get('dateFrom');
        const dateTo = url.searchParams.get('dateTo');
        const sessionId = url.searchParams.get('sessionId') ?? url.searchParams.get('thread_id');
        if (status) filters.status = status;
        if (model) filters.model = model;
        if (dateFrom) filters.dateFrom = dateFrom;
        if (dateTo) filters.dateTo = dateTo;
        if (sessionId) filters.sessionId = sessionId;
        const runs = history.getRecentRuns(limit, offset, Object.keys(filters).length > 0 ? filters : undefined);
        jsonResponse(res, 200, { runs });
      }
    });

    this.dynamicRoutes.push(parseDynamicRoute('user', 'GET', '/api/history/runs/:id', async (_req, res, params) => {
      const history = engine.getRunHistory();
      if (!requireService(res, history, 'History')) return;
      const run = history.getRun(params['id']!);
      if (!run) { errorResponse(res, 404, 'Run not found'); return; }
      jsonResponse(res, 200, run);
    }));

    this.dynamicRoutes.push(parseDynamicRoute('user', 'GET', '/api/history/runs/:id/tool-calls', async (_req, res, params) => {
      const history = engine.getRunHistory();
      if (!requireService(res, history, 'History')) return;
      const toolCalls = history.getRunToolCalls(params['id']!);
      jsonResponse(res, 200, { toolCalls });
    }));

    this.addStatic('user', 'GET /api/history/stats', async (_req, res) => {
      const history = engine.getRunHistory();
      if (!requireService(res, history, 'History')) return;
      const stats = history.getStats();
      jsonResponse(res, 200, stats);
    });

    this.addStatic('user', 'GET /api/history/cost/daily', async (req, res) => {
      const history = engine.getRunHistory();
      if (!requireService(res, history, 'History')) return;
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const days = Math.min(Math.max(parseInt(url.searchParams.get('days') ?? '30', 10) || 30, 1), 365);
      // Optional client timezone offset (JS Date.getTimezoneOffset() convention,
      // UTC+2 → -120) so day buckets group by the user's LOCAL calendar day —
      // the footer + dashboard then agree on "today" instead of UTC-bucketing
      // (rafael 2026-06-04: footer $3.15 vs dashboard $1.83). Clamped to ±14h.
      const rawTz = parseInt(url.searchParams.get('tzOffsetMin') ?? '0', 10) || 0;
      const tzOffsetMin = Math.min(Math.max(rawTz, -14 * 60), 14 * 60);
      const data = history.getCostByDay(days, { tzOffsetMin });
      jsonResponse(res, 200, data);
    });

    // ── Usage SSoT ──
    // PRD-SETTINGS-REFACTOR Phase 0e: `/api/usage/current` is the canonical
    // cost + usage SSoT. `/api/usage/summary` stays as an alias for older
    // consumers (Web UI Usage Dashboard) — both endpoints serve the same
    // payload built by `_buildUsageCurrent`. 30s in-memory TTL cache keyed
    // by (period, startIso) so repeated tab opens don't re-hammer SQLite.
    this.addStatic('user', 'GET /api/usage/current', async (req, res) => {
      await this._serveUsageCurrent(req, res, engine);
    });
    this.addStatic('user', 'GET /api/usage/summary', async (req, res) => {
      await this._serveUsageCurrent(req, res, engine);
    });

    // ── Workflows ──
    this.addStatic('user', 'GET /api/workflows', async (req, res) => {
      const history = engine.getRunHistory();
      if (!requireService(res, history, 'History')) return;
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '20', 10) || 20, 1), 500);
      const runs = history.getRecentPipelineRuns(limit);
      jsonResponse(res, 200, { runs });
    });

    this.addStatic('user', 'GET /api/workflows/stats/steps', async (req, res) => {
      const history = engine.getRunHistory();
      if (!requireService(res, history, 'History')) return;
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const days = Math.min(Math.max(parseInt(url.searchParams.get('days') ?? '30', 10) || 30, 1), 365);
      const stats = history.getPipelineStepStats(days);
      jsonResponse(res, 200, { stats });
    });

    this.addStatic('user', 'GET /api/workflows/stats/cost', async (req, res) => {
      const history = engine.getRunHistory();
      if (!requireService(res, history, 'History')) return;
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const days = Math.min(Math.max(parseInt(url.searchParams.get('days') ?? '30', 10) || 30, 1), 365);
      const stats = history.getPipelineCostStats(days);
      jsonResponse(res, 200, { stats });
    });

    this.dynamicRoutes.push(parseDynamicRoute('user', 'GET', '/api/workflows/:id', async (_req, res, params) => {
      const history = engine.getRunHistory();
      if (!requireService(res, history, 'History')) return;
      const run = history.getPipelineRun(params['id']!);
      if (!run) { errorResponse(res, 404, 'Pipeline run not found'); return; }
      jsonResponse(res, 200, run);
    }));

    this.dynamicRoutes.push(parseDynamicRoute('user', 'GET', '/api/workflows/:id/steps', async (_req, res, params) => {
      const history = engine.getRunHistory();
      if (!requireService(res, history, 'History')) return;
      const steps = history.getPipelineStepResults(params['id']!);
      jsonResponse(res, 200, { steps });
    }));

    // ── Saved Workflows library (PRD §6.8 / D13) ──
    // A "saved workflow" = an engine.db workflow definition whose deserialized
    // manifest_json.template === true. The library filter is app-layer (on the
    // deserialized blob), no migration.
    this.addStatic('user', 'GET /api/workflows/library', async (req, res) => {
      const history = engine.getRunHistory();
      if (!requireService(res, history, 'History')) return;
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 1), 500);
      // Over-fetch: the `template` filter runs app-layer below, so a plain
      // LIMIT would let non-template planned rows (un-run plans) starve the
      // result. Scan a generous fixed window, then slice to `limit`.
      const rows = history.getPlannedPipelines(500);
      // Backfill `mode` for legacy rows the same way getPipeline does, so the
      // library agrees with the schedule handler on cron-eligibility (otherwise a
      // legacy autonomous workflow with no stored mode hides its Schedule button).
      const { inferPipelineMode } = await import('../orchestrator/human-in-the-loop.js');
      const workflows: Array<{ id: string; name: string; description: string; step_count: number; steps: Array<{ id: string; task: string }>; parameters: Array<{ name: string; description: string; type: string }>; created_at: string; mode?: string; confirmedAt?: string; capabilityContract?: unknown }> = [];
      for (const row of rows) {
        let parsed: { template?: unknown; name?: unknown; goal?: unknown; steps?: unknown; parameters?: unknown; mode?: unknown; confirmedAt?: unknown; capabilityContract?: unknown };
        try {
          parsed = JSON.parse(row.manifest_json) as typeof parsed;
        } catch { continue; } // skip corrupt rows
        if (parsed.template !== true) continue; // app-layer template filter
        // Narrow `parsed.steps` (typed `unknown`) to the InlinePipelineStep
        // subset the card needs (id + task). Drop malformed entries.
        const steps = Array.isArray(parsed.steps)
          ? parsed.steps.flatMap((s) =>
              s && typeof s === 'object'
                && typeof (s as { id?: unknown }).id === 'string'
                && typeof (s as { task?: unknown }).task === 'string'
                ? [{ id: (s as { id: string }).id, task: (s as { task: string }).task }]
                : [])
          : [];
        // Surface the re-target schema (name + type + description) so the run
        // UI can collect values before invoking POST /run with `{ params }`.
        const parameters = Array.isArray(parsed.parameters)
          ? parsed.parameters.flatMap((p) =>
              p && typeof p === 'object'
                && typeof (p as { name?: unknown }).name === 'string'
                ? [{
                    name: (p as { name: string }).name,
                    description: typeof (p as { description?: unknown }).description === 'string'
                      ? (p as { description: string }).description : '',
                    type: typeof (p as { type?: unknown }).type === 'string'
                      ? (p as { type: string }).type : 'string',
                  }]
                : [])
          : [];
        workflows.push({
          id: row.id,
          name: typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : row.manifest_name,
          description: typeof parsed.goal === 'string' ? parsed.goal : '',
          step_count: Array.isArray(parsed.steps) ? parsed.steps.length : row.step_count,
          steps,
          parameters,
          created_at: row.started_at,
          // Slice B2: the consent surface needs these to decide cron-eligibility
          // (autonomous + confirmed) and to render the resolved capability-contract.
          mode: typeof parsed.mode === 'string'
            ? parsed.mode
            : (Array.isArray(parsed.steps) ? inferPipelineMode(parsed.steps as import('../types/index.js').InlinePipelineStep[]) : 'autonomous'),
          ...(typeof parsed.confirmedAt === 'string' ? { confirmedAt: parsed.confirmedAt } : {}),
          ...(parsed.capabilityContract !== undefined ? { capabilityContract: parsed.capabilityContract } : {}),
        });
      }
      jsonResponse(res, 200, { workflows: workflows.slice(0, limit) });
    });

    this.dynamicRoutes.push(parseDynamicRoute('user', 'POST', '/api/workflows/:id/run', async (_req, res, params, body) => {
      const history = engine.getRunHistory();
      if (!requireService(res, history, 'History')) return;
      // Optional re-target values: { "params": { "<name>": <value>, ... } }.
      // Validated + coerced against the workflow's parameter schema inside
      // runSavedWorkflow (a missing required param → 400 from there). An absent
      // body keeps the legacy no-arg behaviour (all params bind to defaults).
      let runParams: Record<string, unknown> | undefined;
      if (body !== undefined && body !== null) {
        if (typeof body !== 'object' || Array.isArray(body)) {
          errorResponse(res, 400, 'Invalid request body — expected an object.');
          return;
        }
        const rawParams = (body as Record<string, unknown>)['params'];
        if (rawParams !== undefined) {
          if (typeof rawParams !== 'object' || rawParams === null || Array.isArray(rawParams)) {
            errorResponse(res, 400, 'Invalid "params" — expected an object of name to value.');
            return;
          }
          runParams = rawParams as Record<string, unknown>;
        }
      }
      // Consent gate — mirror the worker-loop cron gate (worker-loop.ts:574).
      // This Run path executes the workflow headless with autonomy:'autonomous'
      // (no per-action approval prompt), so it must not run a workflow whose steps
      // the user has never seen. A self-built workflow is first-run-confirmed at
      // save (process.ts); an IMPORTED workflow lands unconfirmed on purpose, its
      // steps being attacker-authorable. Refuse an unconfirmed workflow here
      // rather than headless-running arbitrary imported bash. (Resolve via
      // getPipeline so a prefix id + the post-confirm cache eviction are handled;
      // a not-found id falls through to runGuardedSavedWorkflow's 404.)
      const { getPipeline } = await import('../tools/builtin/pipeline.js');
      const plannedForRun = getPipeline(params['id']!, history);
      if (plannedForRun && !plannedForRun.confirmedAt) {
        errorResponse(
          res,
          403,
          'This workflow needs first-run confirmation before it can run unattended. Review its steps and schedule it (the consent step confirms it), or run it from a chat where each action asks for your approval.',
        );
        return;
      }
      // Route through the budget + managed-credit lifecycle (cap, credit gate,
      // cost report) — runSavedWorkflow alone bypasses all three.
      const { runGuardedSavedWorkflow } = await import('../core/saved-workflow-runner.js');
      const result = await runGuardedSavedWorkflow(engine, params['id']!, runParams);
      if (!result.ok) {
        const code = result.error?.includes('not found') ? 404 : 400;
        errorResponse(res, code, result.error ?? 'Workflow run failed');
        return;
      }
      // A2: surface the run's cost + per-step failures (not just status), so the
      // library UI can show WHICH step failed and the spend where the run was
      // triggered. costUsd/stepErrors default safely for legacy callers.
      jsonResponse(res, 200, {
        ran: true,
        runId: result.runId,
        status: result.status,
        error: result.error,
        costUsd: result.costUsd ?? 0,
        stepErrors: result.stepErrors ?? [],
      });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('user', 'PATCH', '/api/workflows/:id', async (_req, res, params, body) => {
      const history = engine.getRunHistory();
      if (!requireService(res, history, 'History')) return;
      if (!body || typeof body !== 'object') { errorResponse(res, 400, 'Invalid update'); return; }
      const name = (body as Record<string, unknown>)['name'];
      if (typeof name !== 'string' || name.trim().length === 0) {
        errorResponse(res, 400, 'name is required'); return;
      }
      if (name.trim().length > 200) {
        errorResponse(res, 400, 'name too long (max 200 characters)'); return;
      }
      const renamed = history.renamePlannedPipeline(params['id']!, name.trim());
      if (!renamed) { errorResponse(res, 404, 'Workflow not found'); return; }
      // Evict the in-memory cache so a later run reflects the new name.
      const { forgetPipeline } = await import('../tools/builtin/pipeline.js');
      forgetPipeline(params['id']!);
      jsonResponse(res, 200, { renamed: true });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('user', 'DELETE', '/api/workflows/:id', async (_req, res, params) => {
      const history = engine.getRunHistory();
      if (!requireService(res, history, 'History')) return;
      const deleted = history.deletePlannedPipeline(params['id']!);
      if (!deleted) { errorResponse(res, 404, 'Workflow not found'); return; }
      // Evict the in-memory cache so the deleted workflow can't be resurrected.
      const { forgetPipeline } = await import('../tools/builtin/pipeline.js');
      forgetPipeline(params['id']!);
      jsonResponse(res, 200, { deleted: true });
    }));

    // ── Tasks ──
    this.addStatic('user', 'GET /api/tasks', async (req, res) => {
      const taskManager = engine.getTaskManager();
      if (!requireService(res, taskManager, 'Task manager')) return;
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const status = url.searchParams.get('status') as 'open' | 'in_progress' | 'completed' | undefined;
      const tasks = taskManager.list(status ? { status } : undefined);
      jsonResponse(res, 200, { tasks });
    });

    // Agent-triggers (cron/watch/pipeline/reminder/backup) — split out of the
    // `tasks` table in v42. The UI fetches both and renders them together; the
    // create/patch/delete routes below resolve a row's kind by its id.
    this.addStatic('user', 'GET /api/triggers', async (req, res) => {
      const taskManager = engine.getTaskManager();
      if (!requireService(res, taskManager, 'Task manager')) return;
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const status = url.searchParams.get('status') as 'open' | 'in_progress' | 'completed' | undefined;
      const triggers = taskManager.listTriggers(status ? { status } : undefined);
      jsonResponse(res, 200, { triggers });
    });

    this.addStatic('user', 'POST /api/tasks', async (_req, res, _params, body) => {
      const taskManager = engine.getTaskManager();
      if (!requireService(res, taskManager, 'Task manager')) return;
      if (!body || typeof body !== 'object') { errorResponse(res, 400, 'Invalid task'); return; }
      const b = body as Record<string, unknown>;
      const title = typeof b['title'] === 'string' ? b['title'] : undefined;
      const description = typeof b['description'] === 'string' ? b['description'] : undefined;
      const assignee = typeof b['assignee'] === 'string' ? b['assignee'] : undefined;
      const scheduleCron = typeof b['scheduleCron'] === 'string' && b['scheduleCron'].length > 0 ? b['scheduleCron'] : undefined;
      const runAt = typeof b['runAt'] === 'string' && b['runAt'].length > 0 ? b['runAt'] : undefined;
      const dueDate = typeof b['dueDate'] === 'string' && b['dueDate'].length > 0 ? b['dueDate'] : undefined;
      const pipelineId = typeof b['pipelineId'] === 'string' && b['pipelineId'].length > 0 ? b['pipelineId'] : undefined;

      // Slice B2: schedule a saved workflow on cron — the promote-to-cron consent
      // action. Validates the workflow is autonomous, binds + constrains the
      // stored param values NOW (the cron run can't prompt, so a contract-
      // violating re-target is rejected at schedule time, not at fire), stamps
      // the human's first-run-confirm, then creates the cron task with the bound
      // params. This is the only product path that writes a confirmed schedule.
      if (pipelineId) {
        const history = engine.getRunHistory();
        if (!requireService(res, history, 'History')) return;
        if (!scheduleCron) { errorResponse(res, 400, 'A scheduled workflow needs a scheduleCron expression.'); return; }
        // Validate the cron BEFORE any mutation so a typo can't spuriously stamp
        // the (security-gate) confirmedAt on the workflow.
        const { isValidCron } = await import('../core/cron-parser.js');
        if (!isValidCron(scheduleCron)) { errorResponse(res, 400, `Invalid cron expression: ${scheduleCron}`); return; }
        const rawParams = b['params'];
        if (rawParams !== undefined && (typeof rawParams !== 'object' || rawParams === null || Array.isArray(rawParams))) {
          errorResponse(res, 400, 'Invalid "params" — expected an object of name to value.'); return;
        }
        const { getPipeline, forgetPipeline } = await import('../tools/builtin/pipeline.js');
        const planned = getPipeline(pipelineId, history);
        if (!planned || planned.template !== true) { errorResponse(res, 404, `Workflow "${pipelineId}" not found.`); return; }
        if (planned.mode !== 'autonomous') {
          errorResponse(res, 400, `Workflow "${planned.id}" is interactive and cannot be scheduled — convert it to autonomous first.`); return;
        }
        const { bindWorkflowParameters } = await import('../orchestrator/workflow-params.js');
        const bound = bindWorkflowParameters(planned.parameters ?? [], rawParams as Record<string, unknown> | undefined, {
          requireAll: true,
          constraints: planned.capabilityContract?.paramConstraints,
        });
        if (!bound.ok) { errorResponse(res, 400, bound.error); return; }
        try {
          // Use the RESOLVED id (`planned.id`), never the caller's (possibly
          // prefix) `pipelineId`, so the confirm-stamp + the cron task target
          // exactly this workflow. Stamp the first-run-confirm, then evict the
          // in-memory pipeline cache (mirrors the rename/delete routes) so the
          // WorkerLoop re-reads the now-confirmed blob at fire time instead of a
          // stale pre-confirm copy — otherwise the confirmedAt gate would refuse
          // to run the workflow this slice just scheduled.
          history.setWorkflowConfirmedAt(planned.id, new Date().toISOString());
          forgetPipeline(planned.id);
          const task = taskManager.createPipelineTask({
            title: title ?? `Scheduled: ${planned.name}`,
            pipelineId: planned.id,
            scheduleCron,
            pipelineParams: JSON.stringify(bound.params),
          });
          jsonResponse(res, 201, task);
        } catch (e) {
          errorResponse(res, 400, e instanceof Error ? e.message : 'Failed to schedule workflow');
        }
        return;
      }

      if (!title) { errorResponse(res, 400, 'Missing required field: title'); return; }
      if (runAt && Number.isNaN(Date.parse(runAt))) {
        errorResponse(res, 400, 'Invalid runAt: must be ISO 8601 datetime'); return;
      }
      try {
        // A human creating a schedule via this authenticated route IS the consent
        // action for a `run_agent` trigger (mirrors the pipelineId branch above,
        // which stamps the workflow's confirmedAt). Stamp `confirmedAt` so a
        // human-created autonomous trigger is due + dispatches immediately; the agent
        // `task_create` tool never passes it, so ITS run_agent triggers land
        // unconfirmed and wait for an explicit confirm. Ignored for TODOs /
        // non-run_agent effects.
        const baseParams = { title, description, assignee, dueDate, confirmedAt: new Date().toISOString() };
        const task = scheduleCron
          ? taskManager.createScheduled({ ...baseParams, scheduleCron })
          : taskManager.create({ ...baseParams, ...(runAt ? { nextRunAt: runAt } : {}) });
        jsonResponse(res, 201, task);
      } catch (e) {
        errorResponse(res, 400, e instanceof Error ? e.message : 'Failed to create task');
      }
    });

    this.dynamicRoutes.push(parseDynamicRoute('user', 'PATCH', '/api/tasks/:id', async (_req, res, params, body) => {
      const taskManager = engine.getTaskManager();
      if (!requireService(res, taskManager, 'Task manager')) return;
      if (!body || typeof body !== 'object') { errorResponse(res, 400, 'Invalid update'); return; }
      const b = body as Record<string, unknown>;
      // Slice B2: cron kill-switch toggle — `{ "enabled": true|false }`.
      if (typeof b['enabled'] === 'boolean') {
        if (!taskManager.setEnabled(params['id']!, b['enabled'])) { errorResponse(res, 404, 'Task not found'); return; }
        // setEnabled toggles a TRIGGER (the `triggers` table), so read the
        // updated row back from there — getTask reads the `tasks` table and
        // would always miss, dropping the response to the {id, enabled} stub.
        const updated = engine.getRunHistory()?.getTrigger(params['id']!);
        jsonResponse(res, 200, updated ?? { id: params['id'], enabled: b['enabled'] ? 1 : 0 });
        return;
      }
      const task = taskManager.update(params['id']!, body as Parameters<typeof taskManager.update>[1]);
      if (!task) { errorResponse(res, 404, 'Task not found'); return; }
      jsonResponse(res, 200, task);
    }));

    this.dynamicRoutes.push(parseDynamicRoute('user', 'DELETE', '/api/tasks/:id', async (_req, res, params) => {
      const runHistory = engine.getRunHistory();
      if (!requireService(res, runHistory, 'History')) return;
      // A row id lives in exactly one table after the v42 split — try the TODO
      // table first, then triggers, so deleting a scheduled trigger still works.
      const deleted = runHistory.deleteTask(params['id']!) || runHistory.deleteTrigger(params['id']!);
      if (!deleted) { errorResponse(res, 404, 'Task not found'); return; }
      jsonResponse(res, 200, { deleted: true });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('user', 'POST', '/api/tasks/:id/complete', async (_req, res, params) => {
      const taskManager = engine.getTaskManager();
      if (!requireService(res, taskManager, 'Task manager')) return;
      const task = taskManager.complete(params['id']!);
      if (!task) { errorResponse(res, 404, 'Task not found'); return; }
      jsonResponse(res, 200, task);
    }));

    // Triggers-consent: a human confirms an agent-scheduled `run_agent` trigger for
    // unattended execution — stamps `confirmed_at` so it becomes due + dispatches
    // (an unconfirmed run_agent trigger is neither, closing the injection-
    // amplification hole). This user-scope HTTP action is the ONLY consent surface;
    // the agent `task_create` tool cannot reach it, so confirmation is always an
    // explicit human step. Idempotent (re-confirming just re-stamps).
    this.dynamicRoutes.push(parseDynamicRoute('user', 'POST', '/api/tasks/:id/confirm', async (_req, res, params) => {
      const taskManager = engine.getTaskManager();
      if (!requireService(res, taskManager, 'Task manager')) return;
      const trigger = taskManager.confirmTrigger(params['id']!);
      if (!trigger) { errorResponse(res, 404, 'Trigger not found'); return; }
      jsonResponse(res, 200, trigger);
    }));

    // Run a trigger immediately, off-schedule (the Triggers-home "Run now"
    // control). Delegates to the WorkerLoop so the manual run goes through the
    // same execute path — and the same consent/autonomous gate — as a scheduled
    // fire. 202 = accepted + dispatched (the run continues async; its result
    // lands in the run history), 409 = already running, 404 = no such trigger.
    this.dynamicRoutes.push(parseDynamicRoute('user', 'POST', '/api/triggers/:id/run', async (_req, res, params) => {
      const workerLoop = engine.getWorkerLoop();
      if (!requireService(res, workerLoop, 'Worker loop')) return;
      const outcome = await workerLoop.runTriggerNow(params['id']!);
      if (!outcome.ok) {
        if (outcome.reason === 'already_running') { errorResponse(res, 409, 'Trigger is already running'); return; }
        errorResponse(res, 404, 'Trigger not found'); return;
      }
      jsonResponse(res, 202, { started: true });
    }));

    // ── Artifacts ──
    this.addStatic('user', 'GET /api/artifacts', async (_req, res) => {
      const store = engine.getArtifactStore();
      if (!requireService(res, store, 'Artifact store')) return;
      jsonResponse(res, 200, { artifacts: store.list() });
    });

    this.addStatic('user', 'POST /api/artifacts', async (_req, res, _params, body) => {
      const store = engine.getArtifactStore();
      if (!requireService(res, store, 'Artifact store')) return;
      if (!body || typeof body !== 'object') { errorResponse(res, 400, 'Invalid artifact'); return; }
      const b = body as Record<string, unknown>;
      if (typeof b['title'] !== 'string' || typeof b['content'] !== 'string') {
        errorResponse(res, 400, 'title and content are required'); return;
      }
      const VALID_TYPES = ['html', 'mermaid', 'svg', 'markdown', 'csv', 'tsv', 'json', 'text'] as const;
      const rawType = typeof b['type'] === 'string' ? b['type'] : undefined;
      if (rawType && !VALID_TYPES.includes(rawType as typeof VALID_TYPES[number])) {
        errorResponse(res, 400, `Invalid type. Must be one of: ${VALID_TYPES.join(', ')}`); return;
      }
      const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024; // 5 MB
      if (b['content'].length > MAX_ARTIFACT_BYTES) {
        errorResponse(res, 413, 'Artifact content too large (max 5 MB)'); return;
      }
      const artifact = store.save({
        title: b['title'],
        content: b['content'],
        ...(rawType ? { type: rawType as typeof VALID_TYPES[number] } : {}),
        ...(typeof b['description'] === 'string' ? { description: b['description'] } : {}),
        ...(typeof b['id'] === 'string' ? { id: b['id'] } : {}),
      });
      jsonResponse(res, 201, artifact);
    });

    this.dynamicRoutes.push(parseDynamicRoute('user', 'GET', '/api/artifacts/:id', async (_req, res, params) => {
      const store = engine.getArtifactStore();
      if (!requireService(res, store, 'Artifact store')) return;
      const artifact = store.get(params['id']!);
      if (!artifact) { errorResponse(res, 404, 'Artifact not found'); return; }
      jsonResponse(res, 200, artifact);
    }));

    this.dynamicRoutes.push(parseDynamicRoute('user', 'DELETE', '/api/artifacts/:id', async (_req, res, params) => {
      const store = engine.getArtifactStore();
      if (!requireService(res, store, 'Artifact store')) return;
      const deleted = store.delete(params['id']!);
      if (!deleted) { errorResponse(res, 404, 'Artifact not found'); return; }
      jsonResponse(res, 200, { deleted: true });
    }));

    // ── Transcription (provider info for UI hint) ──
    this.addStatic('user', 'GET /api/transcribe/info', async (_req, res) => {
      const { getActiveTranscribeProvider, hasTranscribeProvider } = await import('../core/transcribe.js');
      const provider = getActiveTranscribeProvider();
      jsonResponse(res, 200, {
        available: hasTranscribeProvider(),
        provider: provider?.name ?? null,
      });
    });

    // ── Privacy & Data — stop-gap delete-request ──
    // PRD-SETTINGS-REFACTOR Phase 3 mailto stop-gap. Phase 6 replaces with
    // synchronous DELETE /api/privacy/account. For now we acknowledge — the
    // Web UI opens a mailto to privacy@lynox.ai and a human handles within
    // GDPR Art. 17's 30-day window.
    this.addStatic('user', 'POST /api/privacy/delete-request', async (_req, res) => {
      process.stderr.write('[privacy] account deletion requested via UI stop-gap mailto\n');
      jsonResponse(res, 200, { ok: true, channel: 'mailto', recipient: 'privacy@lynox.ai' });
    });

    // ── Available tools (T5 — Tool Toggles UI) ──
    // Drives the categorised Tool Toggles surface (P3-FOLLOWUP-HOTFIX).
    // Returns name + description for every tool registered at startup.
    // Disabled tools are merged into `excludeTools` in session.ts so the
    // agent never sees them (server-side enforcement, not UI-only hide).
    //
    // Description size: 500 chars max (was 200 — F3 from 2026-05-17 staging
    // QA: the old 200-char cap chopped mid-sentence in the categorised view
    // because most tool descriptions are 250-400 chars). Whole description
    // (incl. newlines folded to spaces) instead of first-line-only —
    // multi-paragraph descriptions kept their useful "do not use when…"
    // caveats below the summary, and the UI now has room to render them.
    // Truncated descriptions get a trailing "…" so users see the clip.
    this.addStatic('user', 'GET /api/tools/available', async (_req, res) => {
      const entries = engine.registry.getEntries();
      const tools = entries.map((e) => {
        const raw = typeof e.definition.description === 'string' ? e.definition.description : '';
        const flattened = raw.replace(/\s+/g, ' ').trim();
        const description = flattened.length > 500
          ? flattened.slice(0, 499) + '…'
          : flattened;
        return { name: e.definition.name, description };
      });
      jsonResponse(res, 200, { tools });
    });

    // ── LLM model catalog ──
    // Static + version-pinned — safe to cache aggressively on the client.
    this.addStatic('user', 'GET /api/llm/catalog', async (_req, res) => {
      const { LLM_CATALOG } = await import('../core/llm/catalog.js');
      res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
      jsonResponse(res, 200, { providers: LLM_CATALOG });
    });

    // ── LLM connection probe (PRD-SETTINGS-REFACTOR Phase 2) ──
    // 1-token health probe so the Settings → LLM page can show green/red BEFORE
    // the user submits a real query. Custom/OpenAI-compatible endpoints route
    // through `fetchWithPublicRedirects` to block SSRF + cloud-metadata
    // exfiltration of the API key (PRD Security Model).
    //
    // Rate-limited: closes the credential-probe oracle (attacker can't brute
    // -force stolen keys here) AND the cost-amplification vector (each probe
    // costs ~$0.0001 on Anthropic). 6 probes per 60s rolling window per IP
    // — matches PRD spec.
    // Periodic sweep of empty rate-limit buckets — without it the Map grows
    // unbounded over the engine's lifetime (one entry per IP that ever hit
    // /api/llm/test, never reclaimed once their `recent` array emptied).
    const llmTestRateLimit = new Map<string, number[]>();
    const LLM_TEST_WINDOW_MS = 60_000;
    const LLM_TEST_MAX_PROBES = 6;
    setInterval(() => {
      const nowTs = Date.now();
      for (const [key, recent] of llmTestRateLimit) {
        const fresh = recent.filter((t) => nowTs - t < LLM_TEST_WINDOW_MS);
        if (fresh.length === 0) llmTestRateLimit.delete(key);
        else if (fresh.length !== recent.length) llmTestRateLimit.set(key, fresh);
      }
    }, LLM_TEST_WINDOW_MS).unref();
    this.addStatic('user', 'POST /api/llm/test', async (req, res, _params, body) => {
      // Key on the proxy-aware client IP (resolveClientIp trusts the
      // proxy-appended rightmost XFF hop, matching the request entry point),
      // not the raw socket — behind Traefik / a managed CP every user shares
      // one socket-IP and one user would starve the 6/min window for all peers.
      // Using the rightmost hop (not the left-most) is also what stops an
      // attacker from minting fresh buckets via forged X-Forwarded-For entries.
      // Re-derive locally instead of plumbing clientIp through addStatic.
      const ip = resolveClientIp(req, process.env['LYNOX_TRUST_PROXY'] === 'true');
      const nowTs = Date.now();
      const history = llmTestRateLimit.get(ip) ?? [];
      const recent = history.filter((t) => nowTs - t < LLM_TEST_WINDOW_MS);
      if (recent.length >= LLM_TEST_MAX_PROBES) {
        errorResponse(res, 429, `Rate limit exceeded: max ${String(LLM_TEST_MAX_PROBES)} probes per minute`);
        return;
      }
      recent.push(nowTs);
      llmTestRateLimit.set(ip, recent);
      const b = body as { provider?: string; api_key?: string; base_url?: string; model?: string } | null;
      if (!b || typeof b['provider'] !== 'string') {
        errorResponse(res, 400, 'Missing provider');
        return;
      }
      const provider = b['provider'];
      // Validate against the LLMProvider union before the cast — keeps
      // attacker-chosen slot names out of SECONDARY_SLOTS expansion paths.
      const ALLOWED_PROVIDERS: ReadonlySet<string> = new Set(['anthropic', 'openai', 'custom', 'vertex']);
      if (!ALLOWED_PROVIDERS.has(provider)) {
        errorResponse(res, 400, `Unknown provider "${provider}"`);
        return;
      }
      const bodyKey = typeof b['api_key'] === 'string' ? b['api_key'] : '';
      const baseUrl = typeof b['base_url'] === 'string' ? b['base_url'] : '';
      // Vault fallback: when the user already saved the key earlier and now
      // hits "test connection" without re-typing, the form posts an empty body
      // key. Pre-1.5.2 the endpoint 400'd "API key required" even though the
      // vault had the value.
      //
      // Resolve against the endpoint being TESTED, not just the provider. This is
      // the leak in its purest form otherwise: a user with a Mistral key saved,
      // testing a Groq endpoint without re-typing a key, would have that Mistral
      // key bearer-tokened straight to Groq by the fallback.
      //
      // SECURITY — `base_url` here is untrusted request input, unlike every other
      // resolveProviderApiKey() caller (which passes the STORED userConfig.api_base_url).
      // resolveProviderApiKey falls through to the generic tile's SHARED slot (the
      // managed pool key) for any host it doesn't recognise, so a request with an
      // arbitrary base_url and no typed key would bearer-token the pool key straight
      // to that host. Gate the vault fallback to an endpoint the stored key actually
      // belongs to: the provider default (no base_url → Anthropic/Vertex tile), a host
      // that matches a preset (pinned slot, not a generic fall-through), or a vetted
      // LLM host. A free-text/unknown base_url with no typed key gets the pre-1.5.2
      // "API key required" — the user must supply it, never the shared pool key. A
      // body-supplied key is the caller's own credential and always passes through.
      const apiKey = bodyKey || (mayFallBackToStoredKey(provider as LLMProvider, baseUrl)
        ? (resolveProviderApiKey({
            provider: provider as LLMProvider,
            apiBaseURL: baseUrl || undefined,
            secretStore: engine.getSecretStore(),
            userConfig: engine.getUserConfig(),
          }) ?? '')
        : '');
      const model = typeof b['model'] === 'string' ? b['model'] : '';
      const started = Date.now();
      try {
        if (provider === 'anthropic') {
          if (!apiKey) { errorResponse(res, 400, 'API key required'); return; }
          const probeRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: model || 'claude-haiku-4-5-20251001',
              max_tokens: 1,
              messages: [{ role: 'user', content: 'hi' }],
            }),
            signal: AbortSignal.timeout(10_000),
          });
          if (!probeRes.ok) {
            const status = probeRes.status;
            errorResponse(res, 200, status === 401 || status === 403 ? 'Authentication failed' : `Provider returned ${status}`);
            return;
          }
          jsonResponse(res, 200, { ok: true, latency_ms: Date.now() - started, provider_model: model || 'claude-haiku-4-5-20251001' });
          return;
        }
        if (provider === 'openai' || provider === 'custom') {
          if (!baseUrl) { errorResponse(res, 400, 'Base URL required'); return; }
          if (!apiKey) { errorResponse(res, 400, 'API key required'); return; }
          const { fetchWithPublicRedirects } = await import('../core/network-guard.js');
          // OpenAI-compatible /v1/models is the canonical health endpoint.
          // Custom (Anthropic-compatible) proxies don't have a stable health
          // path, so we use /v1/messages too — both shape variants are accepted.
          const probeUrl = provider === 'openai'
            ? `${baseUrl.replace(/\/+$/, '')}/models`
            : `${baseUrl.replace(/\/+$/, '')}/messages`;
          const probeRes = await fetchWithPublicRedirects(probeUrl, {
            method: provider === 'openai' ? 'GET' : 'POST',
            headers: provider === 'openai'
              ? { 'Authorization': `Bearer ${apiKey}` }
              : { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
            ...(provider === 'custom' && {
              body: JSON.stringify({ model: model || 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
            }),
            signal: AbortSignal.timeout(10_000),
          });
          if (!probeRes.ok) {
            const status = probeRes.status;
            errorResponse(res, 200, status === 401 || status === 403 ? 'Authentication failed' : `Provider returned ${status}`);
            return;
          }
          jsonResponse(res, 200, { ok: true, latency_ms: Date.now() - started, provider_model: model || null });
          return;
        }
        if (provider === 'vertex') {
          // Vertex AI requires OAuth-token generation from a service-account key —
          // too heavy for a synchronous probe endpoint. We accept the config and
          // surface failures at first real inference instead.
          jsonResponse(res, 200, { ok: true, latency_ms: 0, skipped: true, reason: 'Vertex test deferred to first inference' });
          return;
        }
        errorResponse(res, 400, `Unknown provider "${provider}"`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Probe failed';
        // Surface SSRF-guard blocks and timeouts cleanly without leaking
        // server-side context.
        errorResponse(res, 200, msg.startsWith('Blocked:') ? msg : 'Probe failed: timeout or network error');
      }
    });

    // ── Voice info (combined STT + TTS capabilities for the Web UI) ──
    // Drives the privacy hint + auto-speak toggle visibility + the
    // Settings → Voice provider pickers. Prefer this over the legacy
    // /api/transcribe/info for new callers — the old path stays for
    // back-compat with existing clients.
    this.addStatic('user', 'GET /api/voice/info', async (_req, res) => {
      const [transcribeMod, speakMod] = await Promise.all([
        import('../core/transcribe.js'),
        import('../core/speak.js'),
      ]);
      const { readUserConfig } = await import('../core/config.js');
      const sttProvider = transcribeMod.getActiveTranscribeProvider();
      const ttsProvider = speakMod.getActiveSpeakProvider();
      const userConfig = readUserConfig();

      // Provider lists for the Settings picker. `available` reflects whether
      // the prerequisite (API key / local binary) is present; disabled options
      // still appear so users see which choices exist on upgrade.
      const sttProviders = [
        { id: 'auto',    name: 'Auto',                            available: true },
        { id: 'mistral', name: 'Mistral Voxtral (Paris, EU)',     available: transcribeMod.mistralVoxtralProvider.isAvailable },
        { id: 'whisper', name: 'whisper.cpp (local)',             available: transcribeMod.whisperCppProvider.isAvailable },
      ];
      const ttsProviders = [
        { id: 'auto',    name: 'Auto',                            available: true },
        { id: 'mistral', name: 'Mistral Voxtral (Paris, EU)',     available: speakMod.mistralVoxtralTtsProvider.isAvailable },
      ];

      // Env-var overrides — when set, the Settings selector should display
      // disabled with "controlled by env" hint so the user isn't confused
      // why their picker choice doesn't stick after restart.
      const sttEnvOverride = process.env['LYNOX_TRANSCRIBE_PROVIDER'] ? 'LYNOX_TRANSCRIBE_PROVIDER' : null;
      const ttsEnvOverride = process.env['LYNOX_TTS_PROVIDER'] ? 'LYNOX_TTS_PROVIDER' : null;

      // Voice catalog is async — fetch Mistral live (1h cache) or fall back.
      // Wrapped in try/catch as a belt + suspenders; listMistralVoices itself
      // already handles its own errors but we never want /voice/info to 5xx.
      let voices: Awaited<ReturnType<typeof speakMod.listMistralVoices>> = [];
      try { voices = await speakMod.listMistralVoices(); } catch { /* keep empty */ }

      jsonResponse(res, 200, {
        stt: {
          available: transcribeMod.hasTranscribeProvider(),
          provider: sttProvider?.name ?? null,
          providers: sttProviders,
          config_value: userConfig.transcription_provider ?? null,
          env_override: sttEnvOverride,
        },
        tts: {
          available: speakMod.hasSpeakProvider(),
          provider: ttsProvider?.name ?? null,
          providers: ttsProviders,
          voices,
          config_value: userConfig.tts_provider ?? null,
          config_voice: userConfig.tts_voice ?? null,
          env_override: ttsEnvOverride,
        },
      });
    });

    // ── TTS (streaming via SSE) ──
    // Body: { text: string, voice?: string, model?: string }
    // Response: text/event-stream
    //   data: {"status":"synthesizing", characters, model, voice}
    //   data: {"chunk":"<base64 MP3 chunk>"}   ← repeated
    //   data: {"done":true, latencyMs, ttfbMs}
    //   data: {"error":"..."}
    // Client concatenates chunk payloads (base64-decoded) into one MP3 blob
    // and plays via <audio>. See pro/docs/internal/prd/voice-tts.md for the
    // rationale (stream mode is mandatory to hit the 1.5 s TTFA target on
    // replies > ~200 chars).
    this.addStatic('user', 'POST /api/speak', async (_req, res, _params, body) => {
      const { hasSpeakProvider, speakStream } = await import('../core/speak.js');
      if (!hasSpeakProvider()) {
        errorResponse(res, 503, 'TTS not available (set MISTRAL_API_KEY)');
        return;
      }
      const b = body as Record<string, unknown> | null;
      const text = b && typeof b['text'] === 'string' ? b['text'] : '';
      // Voice resolution: request body → user config `tts_voice` → provider default.
      // The picker in Settings → Compliance writes config; ad-hoc callers can still
      // override per-request by passing `voice` in the body.
      const { readUserConfig } = await import('../core/config.js');
      const voiceFromRequest = b && typeof b['voice'] === 'string' ? b['voice'] : undefined;
      const voiceFromConfig = readUserConfig().tts_voice;
      const voice = voiceFromRequest ?? (typeof voiceFromConfig === 'string' && voiceFromConfig.length > 0 ? voiceFromConfig : undefined);
      const model = b && typeof b['model'] === 'string' ? b['model'] : undefined;
      // Caller-provided source language for text-prep (Web UI passes user's
      // UI locale). Falls back to 'auto' — leaf runs a stopword vote.
      const langRaw = b && typeof b['lang'] === 'string' ? b['lang'] : undefined;
      const lang: Lang | 'auto' | undefined =
        langRaw === 'de' || langRaw === 'en' || langRaw === 'auto' ? langRaw : undefined;
      if (!text.trim()) { errorResponse(res, 400, 'Missing text'); return; }
      // Hard ceiling on one request to bound Mistral cost + latency. Phase 0
      // tested up to 2 687 chars; 10 k gives headroom for long replies without
      // a single call burning through a tenant's budget.
      if (text.length > SPEAK_MAX_TEXT_CHARS) {
        errorResponse(res, 413, `Text too long — max ${String(SPEAK_MAX_TEXT_CHARS)} characters (got ${String(text.length)})`);
        return;
      }

      // Managed credit gate — TTS hits the lynox-supplied pool key on managed
      // instances, so it must clear the same onBeforeRun gate as a chat run:
      // a credit-exhausted tenant (or one whose control plane is stale →
      // fail-closed) is blocked here BEFORE any provider spend, and before the
      // 200 SSE head is written so the client gets a clean error status. No-op
      // on self-host (no hooks registered). The matching debit fires after
      // synthesis below, keyed on this run id.
      const gate = await fireBeforeRunGate(engine, 'fast');
      if (gate.blockedReason) {
        errorResponse(res, 402, gate.blockedReason);
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'X-lynox-AI-Generated': 'true',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      let firstByteSent = false;
      const meta = await speakStream(text, (chunk) => {
        if (!firstByteSent) {
          // TTFB signal — fire once before the first chunk so the client can
          // render a "synthesizing" state without waiting for full audio.
          res.write(`data: ${JSON.stringify({ status: 'synthesizing' })}\n\n`);
          firstByteSent = true;
        }
        const b64 = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('base64');
        res.write(`data: ${JSON.stringify({ chunk: b64 })}\n\n`);
      }, {
        ...(voice ? { voice } : {}),
        ...(model ? { model } : {}),
        ...(lang ? { lang } : {}),
      });

      if (meta) {
        // Bill the post-prep character count to RunHistory so the Usage
        // Dashboard line-items voice TTS separately from chat runs. Mistral
        // doesn't surface usage headers — $0.016/1 000 chars is the
        // documented rate, applied after text-prep has stripped Markdown
        // noise. (TTS no longer increments the in-memory session-cost
        // counter — it isn't tied to a chat Session, and the dashboard's
        // daily/monthly caps still pick the cost up via RunHistory.)
        const costUsd = meta.characters * SPEAK_USD_PER_CHAR;
        // Debit the spend to the control-plane balance on managed instances
        // (no-op on self-host). Keyed on the gate's run id so the CP dedups the
        // debit. Mirrors Session.run's onAfterRun — non-fatal, never breaks the
        // audio response. Without this the pool-key TTS cost was written to the
        // local dashboard but never deducted from the customer's balance.
        reportMeteredCost(engine, gate.runId, costUsd, 'fast');
        // Persist as a RunRecord so the Usage Dashboard can show voice TTS
        // cost as its own line item. See prd/usage-dashboard.md. Best-effort:
        // history failure must not break audio streaming to the client.
        try {
          const history = engine.getRunHistory();
          if (history) {
            const runId = history.insertRun({
              taskText: text,
              modelTier: 'voice',
              modelId: meta.model,
              kind: 'voice_tts',
              units: meta.characters,
            });
            history.updateRun(runId, {
              costUsd,
              durationMs: meta.latencyMs,
              status: 'completed',
            });
          }
        } catch { /* history is best-effort, don't fail the request */ }
        res.write(`data: ${JSON.stringify({
          done: true,
          characters: meta.characters,
          model: meta.model,
          voice: meta.voice,
          latencyMs: meta.latencyMs,
          ttfbMs: meta.ttfbMs,
        })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ error: 'TTS synthesis failed' })}\n\n`);
      }
      res.end();
    });

    // ── Transcription (streaming via SSE) ──
    this.addStatic('user', 'POST /api/transcribe', async (_req, res, _params, body) => {
      const {
        HAS_WHISPER,
        transcribeWithStream,
        extractSessionContext,
        getActiveTranscribeProvider,
        VOXTRAL_USD_PER_MIN,
      } = await import('../core/transcribe.js');
      if (!HAS_WHISPER) {
        errorResponse(res, 503, 'Transcription not available (set MISTRAL_API_KEY or install whisper.cpp + ffmpeg)');
        return;
      }
      const b = body as Record<string, unknown> | null;
      const audioData = b && typeof b['audio'] === 'string' ? b['audio'] : '';
      const filename = b && typeof b['filename'] === 'string' ? b['filename'] : 'audio.webm';
      const language = b && typeof b['language'] === 'string' ? b['language'] : undefined;
      const sessionId = b && typeof b['sessionId'] === 'string' ? b['sessionId']
        : b && typeof b['thread_id'] === 'string' ? b['thread_id']
        : null;
      if (!audioData) { errorResponse(res, 400, 'Missing audio (base64)'); return; }
      const buffer = Buffer.from(audioData, 'base64');

      // Managed credit gate — STT shares the lynox-supplied pool key, so a
      // credit-exhausted / fail-closed tenant is blocked here before any
      // provider spend (same onBeforeRun gate as TTS + chat runs). No-op on
      // self-host. The matching onAfterRun debit fires after transcription
      // below, keyed on this run id, when Voxtral (pool key) was the backend.
      const sttGate = await fireBeforeRunGate(engine, 'fast');
      if (sttGate.blockedReason) {
        errorResponse(res, 402, sttGate.blockedReason);
        return;
      }

      // Session context pulls CRM contacts, API profile names, thread titles
      // and KG entity labels so the session glossary can correct proper-noun
      // mishearings. Sessionless calls still get the static core glossary.
      const sessionContext = extractSessionContext(engine, sessionId);

      // SSE streaming — forward provider segments (whisper) or a single final
      // segment (Voxtral, no native streaming).
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'X-lynox-AI-Generated': 'true',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const sttStartMs = Date.now();
      // Run ffprobe in parallel with the transcription request — the Usage
      // Dashboard wants seconds-of-audio as the `units` value, but we don't
      // want to block the user's transcription waiting for a ~20 ms probe.
      // Provider-agnostic: one path for whisper + Mistral + future providers.
      const durationPromise = (async () => {
        const { getAudioDurationSec } = await import('../core/audio-duration.js');
        return getAudioDurationSec(buffer, filename);
      })();

      const text = await transcribeWithStream(buffer, filename, (segment) => {
        if (!segment) {
          res.write(`data: ${JSON.stringify({ status: 'transcribing' })}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify({ segment })}\n\n`);
        }
      }, {
        ...(language ? { language } : {}),
        session: sessionContext,
      });

      if (text) {
        // Persist as a RunRecord so the Usage Dashboard can show voice STT
        // as its own line item. See prd/usage-dashboard.md.
        // ffprobe gives seconds of audio for cost attribution; null on
        // failure → `units: 0` (same as pre-0.5 behavior; dashboard shows
        // run count but no duration).
        const durationSec = await durationPromise;
        // Debit managed pool-key STT to the tenant balance, keyed on the gate's
        // run id (the CP dedups on it) — the STT twin of TTS's reportMeteredCost.
        // Only when Voxtral is the active backend (local whisper.cpp is free → no
        // pool-key spend) and the duration probe succeeded. $0.003/min × minutes.
        // No-op on self-host. Non-fatal — never breaks the transcription response.
        const sttProvider = getActiveTranscribeProvider();
        if (sttProvider?.name === 'mistral-voxtral') {
          // Voxtral spent the managed pool key above, so the debit MUST fire for
          // every real transcription. `durationSec` is a best-effort ffprobe
          // probe that returns null for the browser's chunked WebM/Opus
          // (`recorder.start(1000)` → `duration=N/A` in the container header),
          // i.e. essentially every real client recording — so DECOUPLE the debit
          // from the probe and fall back to a byte-length estimate, which can
          // never price a non-empty recording at $0. Local whisper.cpp is free,
          // so this branch is skipped for it. Non-fatal: reportMeteredCost
          // swallows hook errors, so billing never breaks the response.
          const { estimateAudioSecondsFromBytes } = await import('../core/audio-duration.js');
          // `durationSec` (ffprobe) is the accurate basis and is never clamped.
          // The byte estimate assumes the browser's ~48 kbps Opus; a much denser
          // upload (e.g. WAV/PCM) whose ffprobe ALSO fails would over-estimate
          // duration several-fold. Cap the FALLBACK to a sane ceiling so it can
          // never over-bill by orders of magnitude — it still never prices a
          // non-empty recording at $0. A genuinely long recording measured by
          // ffprobe is unaffected; only the unmeasurable fallback is bounded.
          const MAX_STT_FALLBACK_SEC = 600;
          const billedSec = durationSec !== null && durationSec > 0
            ? durationSec
            : Math.min(estimateAudioSecondsFromBytes(buffer.length), MAX_STT_FALLBACK_SEC);
          reportMeteredCost(engine, sttGate.runId, (billedSec / 60) * VOXTRAL_USD_PER_MIN, 'fast');
        }
        try {
          const history = engine.getRunHistory();
          if (history) {
            const runId = history.insertRun({
              sessionId: sessionId ?? '',
              taskText: text,
              modelTier: 'voice',
              modelId: 'voxtral-mini-transcribe',
              kind: 'voice_stt',
              units: durationSec !== null ? Math.round(durationSec) : 0,
            });
            history.updateRun(runId, {
              durationMs: Date.now() - sttStartMs,
              status: 'completed',
            });
          }
        } catch { /* history is best-effort, don't fail the request */ }
        res.write(`data: ${JSON.stringify({ done: true, text })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ error: 'Transcription failed' })}\n\n`);
      }
      res.end();
    });

    // ── Push Notifications ──

    this.addStatic('user', 'GET /api/push/vapid-key', async (_req, res) => {
      if (!this.pushChannel) {
        errorResponse(res, 503, 'Push notifications not available');
        return;
      }
      jsonResponse(res, 200, { publicKey: this.pushChannel.getPublicKey() });
    });

    this.addStatic('user', 'POST /api/push/subscribe', async (_req, res, _params, body) => {
      if (!this.pushChannel) {
        errorResponse(res, 503, 'Push notifications not available');
        return;
      }
      const b = body as Record<string, unknown> | null;
      const sub = b?.['subscription'] as Record<string, unknown> | undefined;
      const endpoint = typeof sub?.['endpoint'] === 'string' ? sub['endpoint'] : '';
      const keys = sub?.['keys'] as Record<string, unknown> | undefined;
      const p256dh = typeof keys?.['p256dh'] === 'string' ? keys['p256dh'] : '';
      const auth = typeof keys?.['auth'] === 'string' ? keys['auth'] : '';

      if (!endpoint || !p256dh || !auth) {
        errorResponse(res, 400, 'Missing subscription fields: endpoint, keys.p256dh, keys.auth');
        return;
      }

      // Endpoint validation — must be HTTPS, must be a known push service
      try {
        const url = new URL(endpoint);
        if (url.protocol !== 'https:') {
          errorResponse(res, 400, 'Subscription endpoint must use HTTPS');
          return;
        }
        // Allow only known Web Push service domains (Google FCM, Mozilla, Apple, Microsoft)
        const host = url.hostname;
        const allowedPushDomains = [
          'fcm.googleapis.com',
          'updates.push.services.mozilla.com',
          'push.services.mozilla.com',
          'web.push.apple.com',
          'wns2-par02p.notify.windows.com',
          'wns.windows.com',
        ];
        const isAllowed = allowedPushDomains.some((d) => host === d || host.endsWith(`.${d}`));
        if (!isAllowed) {
          errorResponse(res, 400, 'Subscription endpoint must be a valid push service');
          return;
        }
      } catch {
        errorResponse(res, 400, 'Invalid subscription endpoint URL');
        return;
      }

      this.pushChannel.subscribe(endpoint, p256dh, auth);
      jsonResponse(res, 201, { ok: true });
    });

    this.addStatic('user', 'POST /api/push/unsubscribe', async (_req, res, _params, body) => {
      if (!this.pushChannel) {
        errorResponse(res, 503, 'Push notifications not available');
        return;
      }
      const b = body as Record<string, unknown> | null;
      const endpoint = typeof b?.['endpoint'] === 'string' ? b['endpoint'] : '';
      if (!endpoint) {
        errorResponse(res, 400, 'Missing endpoint');
        return;
      }
      this.pushChannel.unsubscribe(endpoint);
      jsonResponse(res, 200, { ok: true });
    });

    this.addStatic('user', 'POST /api/push/test', async (_req, res) => {
      if (!this.pushChannel) {
        errorResponse(res, 503, 'Push notifications not available');
        return;
      }
      const count = this.pushChannel.subscriptionCount();
      if (count === 0) {
        errorResponse(res, 404, 'No push subscriptions registered');
        return;
      }
      const result = await this.pushChannel.sendDetailed({
        title: 'lynox',
        body: 'Push notifications are working.',
        priority: 'normal',
      });
      if (result.sent === 0) {
        errorResponse(res, 502, `Delivery failed — ${result.cleaned} subscription(s) expired, ${result.failed} failed`);
        return;
      }
      jsonResponse(res, 200, { ok: true, sent: result.sent, failed: result.failed, cleaned: result.cleaned });
    });

    // ── Google Auth ──
    this.addStatic('user', 'GET /api/google/status', async (_req, res) => {
      const google = engine.getGoogleAuth();
      if (!google) { jsonResponse(res, 200, { available: false }); return; }
      jsonResponse(res, 200, {
        available: true,
        authenticated: google.isAuthenticated(),
        ...google.getAccountInfo(),
      });
    });

    this.addStatic('user', 'POST /api/google/auth', async (_req, res, _params, body) => {
      const google = engine.getGoogleAuth();
      if (!requireService(res, google, 'Google auth')) return;

      // Scope mode: "full" includes write scopes, default is read-only
      const b = body as Record<string, unknown> | null;
      const { READ_ONLY_SCOPES, WRITE_SCOPES } = await import('../integrations/google/google-auth.js');
      const scopes = b?.['scopeMode'] === 'full'
        ? [...READ_ONLY_SCOPES, ...WRITE_SCOPES]
        : [...READ_ONLY_SCOPES];

      // Web-hosted instances: use redirect flow (ORIGIN env is set on managed instances)
      const origin = process.env['ORIGIN'];
      const preferRedirect = b?.['mode'] === 'redirect' || !!origin;

      if (preferRedirect && origin) {
        try {
          const redirectUri = `${origin}/api/google/callback`;
          const { authUrl, state } = google.startRedirectAuth(redirectUri, scopes);
          // Sign the state into a short-TTL cookie so the callback can
          // verify it came from this user-agent. Replaces the previous
          // instance-level _googleOAuthState slot which raced when two
          // OAuth attempts started in parallel.
          const httpSecret = process.env['LYNOX_HTTP_SECRET'];
          if (!httpSecret) {
            errorResponse(res, 500, 'LYNOX_HTTP_SECRET must be set for redirect-mode OAuth');
            return;
          }
          LynoxHTTPApi._appendSetCookie(res, this._buildOAuthStateSetCookie(state, httpSecret));
          jsonResponse(res, 200, { authUrl });
          return;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          errorResponse(res, 500, msg);
          return;
        }
      }

      // Fallback: device flow (self-hosted / headless)
      try {
        const flow = await google.startDeviceFlow(scopes);
        jsonResponse(res, 200, {
          verificationUrl: flow.verificationUrl,
          userCode: flow.userCode,
        });
        // Wait for auth in background — user opens URL and enters code
        flow.waitForAuth().catch(() => {});
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errorResponse(res, 500, msg);
      }
    });

    // Google OAuth callback — handles redirect from Google after user consent
    this.addStatic('user', 'GET /api/google/callback', async (req, res) => {
      const google = engine.getGoogleAuth();
      if (!google) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Error</h1><p>Google auth not configured.</p></body></html>');
        return;
      }

      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        const safe = error.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h1>Error</h1><p>${safe}</p><p>You can close this tab.</p></body></html>`);
        return;
      }

      // Render the post-callback redirect page. Uses meta-refresh (not inline JS,
      // which the engine API CSP `default-src 'none'` blocks; not a 302 directly
      // out of the callback handler because we want a same-origin navigation
      // hop for predictable cookie + history behaviour). Under SameSite=Lax
      // the session cookie WOULD survive a direct 302 cross-site continuation
      // too, but the meta-refresh keeps the cleaner same-origin pattern.
      const sendSuccessRedirect = (): void => {
        const target = `${process.env['ORIGIN'] ?? ''}/app/settings/channels/google`;
        const escaped = target.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${escaped}"><title>Connected</title></head><body><p>Google connected. Returning to settings…</p><p><a href="${escaped}">Click here if not redirected.</a></p></body></html>`);
      };

      const httpSecret = process.env['LYNOX_HTTP_SECRET'] ?? '';
      const cookieState = httpSecret ? this._verifyOAuthStateCookie(req, httpSecret) : null;

      if (!code || !state || state !== cookieState) {
        // Idempotency: if the user reloads the callback URL after a successful
        // exchange, the cookie is already cleared but the engine is already
        // authenticated. Render the same success page instead of a confusing error.
        if (code && state && google.isAuthenticated()) {
          sendSuccessRedirect();
          return;
        }
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Error</h1><p>Invalid callback — missing code or state mismatch.</p></body></html>');
        return;
      }

      try {
        // Rebuild redirectUri from ORIGIN — same construction site as the
        // /api/google/auth handler, so the values always match.
        const origin = process.env['ORIGIN'] ?? '';
        const redirectUri = `${origin}/api/google/callback`;
        await google.exchangeRedirectCode(code, redirectUri);
        LynoxHTTPApi._appendSetCookie(res, this._clearOAuthStateCookie());
        sendSuccessRedirect();
      } catch (err: unknown) {
        const msg = (err instanceof Error ? err.message : String(err))
          .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h1>Error</h1><p>${msg}</p></body></html>`);
      }
    });

    this.addStatic('user', 'POST /api/google/revoke', async (_req, res) => {
      const google = engine.getGoogleAuth();
      if (!requireService(res, google, 'Google auth')) return;
      await google.revoke();
      jsonResponse(res, 200, { ok: true });
    });

    // Reload Google integration after credentials change
    this.addStatic('user', 'POST /api/google/reload', async (_req, res) => {
      const ok = await engine.reloadGoogle();
      jsonResponse(res, 200, { ok });
    });

    // Get Google OAuth start URL (managed instances — redirects via control plane)
    this.addStatic('user', 'GET /api/google/oauth-url', async (_req, res) => {
      const controlPlaneUrl = process.env['LYNOX_MANAGED_CONTROL_PLANE_URL'];
      const instanceId = process.env['LYNOX_MANAGED_INSTANCE_ID'];

      if (!controlPlaneUrl || !instanceId) {
        errorResponse(res, 400, 'Not a managed instance');
        return;
      }

      const url = `${controlPlaneUrl}/oauth/google/start?instance_id=${encodeURIComponent(instanceId)}`;
      jsonResponse(res, 200, { url });
    });

    // Claim Google tokens from managed control plane OAuth broker
    this.addStatic('user', 'POST /api/google/claim-managed', async (_req, res, _params, body) => {
      const google = engine.getGoogleAuth();
      if (!requireService(res, google, 'Google auth')) return;

      const controlPlaneUrl = process.env['LYNOX_MANAGED_CONTROL_PLANE_URL'];
      const instanceId = process.env['LYNOX_MANAGED_INSTANCE_ID'];
      const httpSecret = process.env['LYNOX_HTTP_SECRET'];

      if (!controlPlaneUrl || !instanceId || !httpSecret) {
        errorResponse(res, 400, 'Not a managed instance or missing control plane config');
        return;
      }

      const parsed = body as Record<string, unknown> | undefined;
      const claimNonce = typeof parsed?.['claim_nonce'] === 'string' ? parsed['claim_nonce'] : '';
      if (!claimNonce) {
        errorResponse(res, 400, 'Missing claim_nonce');
        return;
      }

      try {
        const claimRes = await fetch(`${controlPlaneUrl}/internal/oauth/google/claim`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-instance-secret': httpSecret,
          },
          body: JSON.stringify({ instance_id: instanceId, claim_nonce: claimNonce }),
        });

        if (!claimRes.ok) {
          const data = (await claimRes.json().catch(() => ({}))) as Record<string, unknown>;
          errorResponse(res, claimRes.status, (data['error'] as string) ?? 'Failed to claim tokens');
          return;
        }

        const tokens = (await claimRes.json()) as {
          access_token: string;
          refresh_token: string;
          expires_at: number;
          scopes: string[];
        };

        await google.setTokens(tokens);
        jsonResponse(res, 200, { ok: true, scopes: tokens.scopes });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errorResponse(res, 500, msg);
      }
    });

    // ── Knowledge Graph ──────────────────────────────────────────

    this.addStatic('user', 'GET /api/kg/stats', async (_req, res) => {
      const kg = engine.getKnowledgeLayer();
      if (!kg) { jsonResponse(res, 200, { entityCount: 0, relationCount: 0, memoryCount: 0, communityCount: 0 }); return; }
      const stats = await kg.stats();
      jsonResponse(res, 200, stats);
    });

    // Admin: purge legacy mis-extracted entities (stopwords + pricing fragments).
    // Pre-v2 extractor wrote rows like "in" (person), "tools" (location),
    // "39/mo" (project). v2 prevents new ones; this endpoint cleans the past.
    // ?dryRun=true previews without deleting.
    this.addStatic('admin', 'POST /api/kg/cleanup', async (req, res) => {
      const kg = engine.getKnowledgeLayer();
      if (!requireService(res, kg, 'Knowledge graph')) return;
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const dryRun = url.searchParams.get('dryRun') === 'true';
      const { cleanupBadEntities } = await import('../core/kg-cleanup.js');
      const result = cleanupBadEntities(kg.getDb(), { dryRun });
      jsonResponse(res, 200, { dryRun, ...result });
    });

    // ── Mail (provider-agnostic IMAP/SMTP + app-password) ──

    this.addStatic('user', 'GET /api/mail/presets', async (_req, res) => {
      const { listPresets } = await import('../integrations/mail/providers/presets.js');
      const { ALL_ACCOUNT_TYPES, defaultPersonaFor, isReceiveOnlyType } = await import('../integrations/mail/provider.js');
      const accountTypes = ALL_ACCOUNT_TYPES.map(type => ({
        type,
        receiveOnly: isReceiveOnlyType(type),
        defaultPersona: defaultPersonaFor(type),
      }));
      jsonResponse(res, 200, { presets: listPresets(), accountTypes });
    });

    // Autodiscover for custom preset: given an email address, try to find
    // IMAP/SMTP servers via autoconfig.thunderbird.net. Returns a draft config.
    this.addStatic('user', 'POST /api/mail/autodiscover', async (_req, res, _params, body) => {
      const b = body as Record<string, unknown> | null;
      const address = typeof b?.['address'] === 'string' ? b['address'] : '';
      if (!address) { errorResponse(res, 400, 'address is required'); return; }
      try {
        const { autodiscover } = await import('../integrations/mail/providers/presets.js');
        const result = await autodiscover(address);
        jsonResponse(res, 200, result);
      } catch (err: unknown) {
        const { MailError } = await import('../integrations/mail/provider.js');
        if (err instanceof MailError) {
          errorResponse(res, err.code === 'not_found' ? 404 : 502, err.message);
        } else {
          errorResponse(res, 500, err instanceof Error ? err.message : String(err));
        }
      }
    });

    this.addStatic('user', 'GET /api/mail/accounts', async (_req, res) => {
      const ctx = engine.getMailContext();
      if (!ctx) { jsonResponse(res, 200, { accounts: [] }); return; }
      jsonResponse(res, 200, { accounts: ctx.listAccounts() });
    });

    // user scope: connecting/managing a mailbox is an instance-owner action. The
    // managed mail-connect flow drives this route through the customer's session
    // cookie after the in-chat consent step, so it must be reachable at user scope.
    // (Mailbox credentials are the owner's own; nothing here is off-box.)
    this.addStatic('user', 'POST /api/mail/accounts', async (_req, res, _params, body) => {
      const ctx = engine.getMailContext();
      if (!requireService(res, ctx, 'Mail integration')) return;

      const b = body as Record<string, unknown> | null;
      if (!b) { errorResponse(res, 400, 'Missing request body'); return; }

      try {
        const { buildPresetAccount, buildCustomAccount } = await import('../integrations/mail/providers/presets.js');
        const { isValidAccountType } = await import('../integrations/mail/provider.js');
        const id = typeof b['id'] === 'string' ? b['id'] : '';
        const displayName = typeof b['displayName'] === 'string' ? b['displayName'] : '';
        const address = typeof b['address'] === 'string' ? b['address'] : '';
        const preset = typeof b['preset'] === 'string' ? b['preset'] : '';
        const rawType = b['type'];
        const type = isValidAccountType(rawType) ? rawType : 'personal';
        const personaPrompt = typeof b['personaPrompt'] === 'string' && b['personaPrompt'].trim() ? b['personaPrompt'].trim() : undefined;
        const creds = b['credentials'] as { user?: unknown; pass?: unknown } | undefined;
        const user = typeof creds?.user === 'string' ? creds.user : '';
        const pass = typeof creds?.pass === 'string' ? creds.pass : '';

        if (!id || !displayName || !address || !preset) {
          errorResponse(res, 400, 'id, displayName, address, preset are required'); return;
        }
        if (!user || !pass) {
          errorResponse(res, 400, 'credentials.user and credentials.pass are required'); return;
        }

        let account;
        if (preset === 'custom') {
          const custom = b['custom'] as { imap?: { host?: unknown; port?: unknown; secure?: unknown }; smtp?: { host?: unknown; port?: unknown; secure?: unknown } } | undefined;
          const imapHost = typeof custom?.imap?.host === 'string' ? custom.imap.host : '';
          const imapPort = typeof custom?.imap?.port === 'number' ? custom.imap.port : 993;
          const imapSecure = custom?.imap?.secure !== false;
          const smtpHost = typeof custom?.smtp?.host === 'string' ? custom.smtp.host : '';
          const smtpPort = typeof custom?.smtp?.port === 'number' ? custom.smtp.port : 465;
          const smtpSecure = custom?.smtp?.secure !== false;
          if (!imapHost || !smtpHost) {
            errorResponse(res, 400, 'custom preset requires non-empty imap.host and smtp.host'); return;
          }
          if (!isValidMailPort(imapPort) || !isValidMailPort(smtpPort)) {
            errorResponse(res, 400, 'imap.port and smtp.port must be 1..65535'); return;
          }
          try {
            const { assertPublicHost } = await import('../core/network-guard.js');
            await assertPublicHost(imapHost);
            await assertPublicHost(smtpHost);
          } catch (err: unknown) {
            errorResponse(res, 400, err instanceof Error ? err.message : 'host validation failed'); return;
          }
          account = buildCustomAccount({
            id, displayName, address, type, personaPrompt,
            imap: { host: imapHost, port: imapPort, secure: imapSecure },
            smtp: { host: smtpHost, port: smtpPort, secure: smtpSecure },
          });
        } else if (preset === 'gmail' || preset === 'icloud' || preset === 'fastmail' || preset === 'yahoo' || preset === 'outlook') {
          account = buildPresetAccount(preset, { id, displayName, address, type, personaPrompt });
        } else {
          errorResponse(res, 400, `Unknown preset "${preset}"`); return;
        }

        // Optional pre-save connection test — on by default
        const skipTest = b['skipTest'] === true;
        if (!skipTest) {
          const probe = await ctx!.testAccount({ config: account, credentials: { user, pass } });
          if (!probe.ok) {
            errorResponse(res, 400, `Connection test failed: ${probe.error ?? 'unknown error'} (${probe.code ?? 'unknown'})`);
            return;
          }
        }

        await ctx!.addAccount({ config: account, credentials: { user, pass } });
        jsonResponse(res, 200, { ok: true, account: ctx!.listAccounts().find(a => a.id === id) });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errorResponse(res, 500, msg);
      }
    });

    // In-memory rate limiter for /api/mail/accounts/test. Closes the
    // credential-probe oracle: an attacker cannot brute-force test many
    // stolen credentials against the endpoint. 10 probes per 60s rolling
    // window per remote address. Reset on the client side via time.
    const mailTestRateLimit = new Map<string, number[]>();
    const MAIL_TEST_WINDOW_MS = 60_000;
    const MAIL_TEST_MAX_PROBES = 10;
    const mailTestRateCheck = (req: IncomingMessage): string | null => {
      const ip = req.socket.remoteAddress ?? 'unknown';
      const now = Date.now();
      const history = mailTestRateLimit.get(ip) ?? [];
      const recent = history.filter(t => now - t < MAIL_TEST_WINDOW_MS);
      if (recent.length >= MAIL_TEST_MAX_PROBES) {
        return `Rate limit exceeded: max ${String(MAIL_TEST_MAX_PROBES)} test probes per minute`;
      }
      recent.push(now);
      mailTestRateLimit.set(ip, recent);
      // Opportunistic cleanup: every ~100 hits, prune expired entries
      if (recent.length === 1 && mailTestRateLimit.size > 100) {
        for (const [k, v] of mailTestRateLimit.entries()) {
          const stillRecent = v.filter(t => now - t < MAIL_TEST_WINDOW_MS);
          if (stillRecent.length === 0) mailTestRateLimit.delete(k);
          else mailTestRateLimit.set(k, stillRecent);
        }
      }
      return null;
    };

    // user scope: same mailbox-management surface as POST /api/mail/accounts.
    this.addStatic('user', 'POST /api/mail/accounts/test', async (req, res, _params, body) => {
      const rateErr = mailTestRateCheck(req);
      if (rateErr) { errorResponse(res, 429, rateErr); return; }

      const ctx = engine.getMailContext();
      if (!requireService(res, ctx, 'Mail integration')) return;
      const b = body as Record<string, unknown> | null;
      if (!b) { errorResponse(res, 400, 'Missing request body'); return; }

      try {
        const { buildPresetAccount, buildCustomAccount } = await import('../integrations/mail/providers/presets.js');
        const { isValidAccountType } = await import('../integrations/mail/provider.js');
        const id = typeof b['id'] === 'string' ? b['id'] : 'draft';
        const displayName = typeof b['displayName'] === 'string' ? b['displayName'] : 'Draft';
        const address = typeof b['address'] === 'string' ? b['address'] : '';
        const preset = typeof b['preset'] === 'string' ? b['preset'] : '';
        const rawType = b['type'];
        const type = isValidAccountType(rawType) ? rawType : 'personal';
        const creds = b['credentials'] as { user?: unknown; pass?: unknown } | undefined;
        const user = typeof creds?.user === 'string' ? creds.user : '';
        const pass = typeof creds?.pass === 'string' ? creds.pass : '';

        if (!address || !preset || !user || !pass) {
          errorResponse(res, 400, 'address, preset, credentials.user, credentials.pass are required'); return;
        }

        let account;
        if (preset === 'custom') {
          const custom = b['custom'] as { imap?: { host?: unknown; port?: unknown; secure?: unknown }; smtp?: { host?: unknown; port?: unknown; secure?: unknown } } | undefined;
          const imapHost = typeof custom?.imap?.host === 'string' ? custom.imap.host : '';
          const imapPort = typeof custom?.imap?.port === 'number' ? custom.imap.port : 993;
          const imapSecure = custom?.imap?.secure !== false;
          const smtpHost = typeof custom?.smtp?.host === 'string' ? custom.smtp.host : '';
          const smtpPort = typeof custom?.smtp?.port === 'number' ? custom.smtp.port : 465;
          const smtpSecure = custom?.smtp?.secure !== false;
          if (!imapHost || !smtpHost) { errorResponse(res, 400, 'custom preset requires imap.host + smtp.host'); return; }
          if (!isValidMailPort(imapPort) || !isValidMailPort(smtpPort)) {
            errorResponse(res, 400, 'imap.port and smtp.port must be 1..65535'); return;
          }
          try {
            const { assertPublicHost } = await import('../core/network-guard.js');
            await assertPublicHost(imapHost);
            await assertPublicHost(smtpHost);
          } catch (err: unknown) {
            errorResponse(res, 400, err instanceof Error ? err.message : 'host validation failed'); return;
          }
          account = buildCustomAccount({
            id, displayName, address, type,
            imap: { host: imapHost, port: imapPort, secure: imapSecure },
            smtp: { host: smtpHost, port: smtpPort, secure: smtpSecure },
          });
        } else if (preset === 'gmail' || preset === 'icloud' || preset === 'fastmail' || preset === 'yahoo' || preset === 'outlook') {
          account = buildPresetAccount(preset, { id, displayName, address, type });
        } else {
          errorResponse(res, 400, `Unknown preset "${preset}"`); return;
        }

        const result = await ctx!.testAccount({ config: account, credentials: { user, pass } });
        jsonResponse(res, 200, result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errorResponse(res, 500, msg);
      }
    });

    // user scope: same mailbox-management surface as POST /api/mail/accounts.
    this.dynamicRoutes.push(parseDynamicRoute('user', 'DELETE', '/api/mail/accounts/:id', async (_req, res, params) => {
      const ctx = engine.getMailContext();
      if (!requireService(res, ctx, 'Mail integration')) return;
      const removed = await ctx!.removeAccount(params['id']!);
      if (!removed) { errorResponse(res, 404, `Account "${params['id']}" not found`); return; }
      jsonResponse(res, 200, { ok: true });
    }));

    // Set the default mailbox. Persists `is_default=1` on the target row and
    // updates the in-memory registry so subsequent tool calls fall back to
    // this account when none is explicitly named.
    // user scope: same mailbox-management surface as POST /api/mail/accounts.
    this.dynamicRoutes.push(parseDynamicRoute('user', 'POST', '/api/mail/accounts/:id/default', async (_req, res, params) => {
      const ctx = engine.getMailContext();
      if (!requireService(res, ctx, 'Mail integration')) return;
      try {
        ctx!.setDefault(params['id']!);
        jsonResponse(res, 200, { ok: true, accounts: ctx!.listAccounts() });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const status = msg.includes('not registered') ? 404 : 400;
        errorResponse(res, status, msg);
      }
    }));

    // ── /api/inbox/* (PRD-UNIFIED-INBOX Phase 1a) ───────────────────────────
    //
    // Pure handlers live in `integrations/inbox/api.ts`; these routes are
    // thin: extract query/body, hand to the handler, write the envelope.
    // Every route gates on `engine.getInboxRuntime()` being non-null —
    // returns 503 when the `unified-inbox` feature flag is off.
    const inboxDeps = (): null | import('../integrations/inbox/api.js').InboxApiDeps => {
      const rt = engine.getInboxRuntime();
      if (!rt) return null;
      const deps: import('../integrations/inbox/api.js').InboxApiDeps = {
        state: rt.state,
        rules: rt.rules,
        coldStartTracker: rt.coldStartTracker,
        sensitiveMode: rt.sensitiveMode,
      };
      if (rt.contactResolver !== null) deps.contactResolver = rt.contactResolver;
      // Mail provider lookup for the body-refresh handler. The mail
      // context exposes the registry; when absent (pre-vault startup),
      // refresh returns 503 for email items.
      const mailCtx = engine.getMailContext();
      if (mailCtx !== null) {
        deps.providerResolver = (accountId: string) => mailCtx.registry.get(accountId);
      }
      // MailContext for the reading-pane context handlers — exposes the
      // followup + outbound-history state DB they read from.
      if (mailCtx !== null) {
        deps.mailContext = mailCtx;
        // Operator cold-start re-run: needs both a registered MailProvider
        // and the runtime's bound runner (hook + tracker + state). Wired
        // here so the handler stays free of registry plumbing.
        deps.coldStartRunner = async (accountId, runOpts) => {
          const provider = mailCtx.registry.get(accountId);
          if (!provider) throw new Error(`account "${accountId}" not registered`);
          await rt.runColdStart(provider, runOpts ?? {});
        };
        // v11 envelope-metadata backfill — same provider/state plumbing.
        deps.backfillMetadataRunner = async (accountId) => {
          const provider = mailCtx.registry.get(accountId);
          if (!provider) throw new Error(`account "${accountId}" not registered`);
          return inboxBackfillMetadata({ provider, state: rt.state });
        };
      }
      return deps;
    };
    const sendInbox = (
      res: ServerResponse,
      response: { status: number; body: unknown },
    ): void => {
      if (response.body === null) {
        res.statusCode = response.status;
        res.end();
      } else {
        jsonResponse(res, response.status, response.body);
      }
    };

    this.addStatic('user', 'GET /api/inbox/items', async (req, res) => {
      const deps = inboxDeps();
      if (!requireService(res, deps, 'Inbox')) return;
      const { handleListItems } = await import('../integrations/inbox/api.js');
      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
      const query: import('../integrations/inbox/api.js').ListItemsQuery = {};
      const bucket = url.searchParams.get('bucket');
      if (bucket !== null) query.bucket = bucket;
      const limit = url.searchParams.get('limit');
      if (limit !== null) query.limit = limit;
      const offset = url.searchParams.get('offset');
      if (offset !== null) query.offset = offset;
      const tenantId = url.searchParams.get('tenantId');
      if (tenantId !== null) query.tenantId = tenantId;
      const q = url.searchParams.get('q');
      if (q !== null) query.q = q;
      const snoozedOnly = url.searchParams.get('snoozedOnly');
      if (snoozedOnly !== null) query.snoozedOnly = snoozedOnly;
      sendInbox(res, handleListItems(deps!, query));
    });

    this.addStatic('user', 'GET /api/inbox/counts', async (req, res) => {
      const deps = inboxDeps();
      if (!requireService(res, deps, 'Inbox')) return;
      const { handleGetCounts } = await import('../integrations/inbox/api.js');
      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
      const tenantId = url.searchParams.get('tenantId');
      sendInbox(res, handleGetCounts(deps!, tenantId !== null ? { tenantId } : {}));
    });

    this.addStatic('user', 'GET /api/inbox/notification-prefs', async (_req, res) => {
      const deps = inboxDeps();
      if (!requireService(res, deps, 'Inbox')) return;
      const { handleGetNotificationPrefs } = await import('../integrations/inbox/api.js');
      sendInbox(res, handleGetNotificationPrefs(deps!));
    });

    this.addStatic('user', 'PATCH /api/inbox/notification-prefs', async (_req, res, _params, body) => {
      const deps = inboxDeps();
      if (!requireService(res, deps, 'Inbox')) return;
      const { handleUpdateNotificationPrefs } = await import('../integrations/inbox/api.js');
      // Reject non-object payloads (arrays, primitives, null) before they
      // reach the handler — `Object.entries(['a'])` would otherwise
      // happily iterate array indices and write garbage settings.
      const safeBody = body !== null && typeof body === 'object' && !Array.isArray(body)
        ? (body as import('../integrations/inbox/api.js').NotificationPrefsBody)
        : {};
      sendInbox(res, handleUpdateNotificationPrefs(deps!, safeBody));
    });

    this.addStatic('user', 'GET /api/inbox/cold-start', async (_req, res) => {
      const deps = inboxDeps();
      if (!requireService(res, deps, 'Inbox')) return;
      const { handleGetColdStart } = await import('../integrations/inbox/api.js');
      sendInbox(res, handleGetColdStart(deps!));
    });

    this.addStatic('user', 'POST /api/inbox/cold-start/run', async (_req, res, _params, body) => {
      const deps = inboxDeps();
      if (!requireService(res, deps, 'Inbox')) return;
      const { handleRunColdStart } = await import('../integrations/inbox/api.js');
      const b = (body ?? {}) as Record<string, unknown>;
      const runBody: import('../integrations/inbox/api.js').RunColdStartBody = {
        accountId: typeof b['accountId'] === 'string' ? b['accountId'] : '',
      };
      if (typeof b['force'] === 'boolean') runBody.force = b['force'];
      sendInbox(res, await handleRunColdStart(deps!, runBody));
    });

    this.addStatic('user', 'POST /api/inbox/items/bulk-action', async (_req, res, _params, body) => {
      const deps = inboxDeps();
      if (!requireService(res, deps, 'Inbox')) return;
      const { handleBulkAction } = await import('../integrations/inbox/api.js');
      const b = (body ?? {}) as Record<string, unknown>;
      const bulkBody: import('../integrations/inbox/api.js').BulkActionBody = {
        ids: Array.isArray(b['ids']) ? (b['ids'] as ReadonlyArray<string>).filter((s) => typeof s === 'string') : [],
        action: b['action'] as import('../integrations/inbox/api.js').BulkAction,
      };
      sendInbox(res, handleBulkAction(deps!, bulkBody));
    });

    this.dynamicRoutes.push(parseDynamicRoute('user', 'POST', '/api/inbox/undo/:bulkId', async (_req, res, params) => {
      const deps = inboxDeps();
      if (!requireService(res, deps, 'Inbox')) return;
      const { handleUndoBulk } = await import('../integrations/inbox/api.js');
      sendInbox(res, handleUndoBulk(deps!, params['bulkId']!));
    }));

    this.addStatic('user', 'GET /api/inbox/undo/recent', async (_req, res) => {
      const deps = inboxDeps();
      if (!requireService(res, deps, 'Inbox')) return;
      const { handleListRecentBulks } = await import('../integrations/inbox/api.js');
      sendInbox(res, handleListRecentBulks(deps!));
    });

    this.addStatic('user', 'POST /api/inbox/backfill-metadata', async (_req, res, _params, body) => {
      const deps = inboxDeps();
      if (!requireService(res, deps, 'Inbox')) return;
      const { handleRunBackfillMetadata } = await import('../integrations/inbox/api.js');
      const b = (body ?? {}) as Record<string, unknown>;
      const runBody: import('../integrations/inbox/api.js').RunBackfillMetadataBody = {
        accountId: typeof b['accountId'] === 'string' ? b['accountId'] : '',
      };
      sendInbox(res, await handleRunBackfillMetadata(deps!, runBody));
    });

    this.dynamicRoutes.push(parseDynamicRoute('user', 'GET', '/api/inbox/items/:id', async (_req, res, params) => {
      const deps = inboxDeps();
      if (!requireService(res, deps, 'Inbox')) return;
      const { handleGetItem } = await import('../integrations/inbox/api.js');
      sendInbox(res, handleGetItem(deps!, params['id']!));
    }));

    this.dynamicRoutes.push(parseDynamicRoute('user', 'GET', '/api/inbox/items/:id/full', async (_req, res, params) => {
      const deps = inboxDeps();
      if (!requireService(res, deps, 'Inbox')) return;
      const { handleGetItemFull } = await import('../integrations/inbox/api.js');
      sendInbox(res, handleGetItemFull(deps!, params['id']!));
    }));

    this.dynamicRoutes.push(parseDynamicRoute('user', 'GET', '/api/inbox/items/:id/thread', async (req, res, params) => {
      const deps = inboxDeps();
      if (!requireService(res, deps, 'Inbox')) return;
      const { handleGetItemThread } = await import('../integrations/inbox/api.js');
      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
      const limitRaw = url.searchParams.get('limit');
      const parsedLimit = limitRaw !== null ? Number.parseInt(limitRaw, 10) : NaN;
      const opts = Number.isFinite(parsedLimit) && parsedLimit > 0 ? { limit: parsedLimit } : {};
      sendInbox(res, handleGetItemThread(deps!, params['id']!, opts));
    }));

    this.dynamicRoutes.push(parseDynamicRoute('user', 'GET', '/api/inbox/items/:id/audit', async (_req, res, params) => {
      const deps = inboxDeps();
      if (!requireService(res, deps, 'Inbox')) return;
      const { handleListItemAudit } = await import('../integrations/inbox/api.js');
      sendInbox(res, handleListItemAudit(deps!, params['id']!));
    }));

    this.dynamicRoutes.push(parseDynamicRoute('user', 'GET', '/api/inbox/items/:id/context', async (_req, res, params) => {
      const deps = inboxDeps();
      if (!requireService(res, deps, 'Inbox')) return;
      const { handleGetItemContext } = await import('../integrations/inbox/api.js');
      sendInbox(res, handleGetItemContext(deps!, params['id']!));
    }));

    this.dynamicRoutes.push(parseDynamicRoute('user', 'PATCH', '/api/inbox/items/:id/action', async (_req, res, params, body) => {
      const deps = inboxDeps();
      if (!requireService(res, deps, 'Inbox')) return;
      const b = (body ?? {}) as Record<string, unknown>;
      const { handleSetAction } = await import('../integrations/inbox/api.js');
      const action = b['action'];
      const at = typeof b['at'] === 'string' ? (b['at'] as string) : undefined;
      const setActionBody: import('../integrations/inbox/api.js').SetActionBody = {
        action: action as import('../integrations/inbox/api.js').SetActionBody['action'],
      };
      if (at !== undefined) setActionBody.at = at;
      sendInbox(res, handleSetAction(deps!, params['id']!, setActionBody));
    }));

    this.dynamicRoutes.push(parseDynamicRoute('user', 'PATCH', '/api/inbox/items/:id/snooze', async (_req, res, params, body) => {
      const deps = inboxDeps();
      if (!requireService(res, deps, 'Inbox')) return;
      const b = (body ?? {}) as Record<string, unknown>;
      const { handleSetSnooze } = await import('../integrations/inbox/api.js');
      const snoozeBody: import('../integrations/inbox/api.js').SetSnoozeBody = {
        until: (b['until'] ?? null) as string | null,
      };
      if (typeof b['condition'] === 'string' || b['condition'] === null) {
        snoozeBody.condition = b['condition'] as string | null;
      }
      if (typeof b['unsnoozeOnReply'] === 'boolean') {
        snoozeBody.unsnoozeOnReply = b['unsnoozeOnReply'];
      }
      if (typeof b['preset'] === 'string' || b['preset'] === null) {
        snoozeBody.preset = b['preset'] as import('../integrations/inbox/api.js').SnoozePreset | null;
      }
      if (typeof b['timezone'] === 'string') {
        snoozeBody.timezone = b['timezone'];
      }
      sendInbox(res, handleSetSnooze(deps!, params['id']!, snoozeBody));
    }));

    this.dynamicRoutes.push(parseDynamicRoute('user', 'GET', '/api/inbox/contacts/:email', async (_req, res, params) => {
      const deps = inboxDeps();
      if (!requireService(res, deps, 'Inbox')) return;
      const { handleResolveContact } = await import('../integrations/inbox/api.js');
      // parseDynamicRoute does NOT decode URL params (verified vs.
      // /api/crm/contacts/:name which also calls decodeURIComponent).
      // Without this step every real address would arrive as `name%40host`
      // and the contact lookup would always miss.
      let email: string;
      try {
        email = decodeURIComponent(params['email']!);
      } catch {
        errorResponse(res, 400, 'invalid url-encoded email');
        return;
      }
      sendInbox(res, handleResolveContact(deps!, email));
    }));

    this.dynamicRoutes.push(parseDynamicRoute('user', 'POST', '/api/inbox/items/:id/body/refresh', async (_req, res, params) => {
      const deps = inboxDeps();
      if (!requireService(res, deps, 'Inbox')) return;
      const { handleRefreshItemBody } = await import('../integrations/inbox/api.js');
      sendInbox(res, await handleRefreshItemBody(deps!, params['id']!));
    }));

    this.addStatic('user', 'GET /api/inbox/rules', async (req, res) => {
      const deps = inboxDeps();
      if (!requireService(res, deps, 'Inbox')) return;
      const { handleListRules } = await import('../integrations/inbox/api.js');
      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
      const accountId = url.searchParams.get('accountId') ?? '';
      const query: import('../integrations/inbox/api.js').ListRulesQuery = { accountId };
      const tenantId = url.searchParams.get('tenantId');
      if (tenantId !== null) query.tenantId = tenantId;
      sendInbox(res, handleListRules(deps!, query));
    });

    this.addStatic('user', 'POST /api/inbox/rules', async (_req, res, _params, body) => {
      const deps = inboxDeps();
      if (!requireService(res, deps, 'Inbox')) return;
      const { handleCreateRule } = await import('../integrations/inbox/api.js');
      const b = (body ?? {}) as Record<string, unknown>;
      const ruleBody = {
        accountId: typeof b['accountId'] === 'string' ? b['accountId'] : '',
        matcherKind: b['matcherKind'] as import('../integrations/inbox/api.js').CreateRuleBody['matcherKind'],
        matcherValue: typeof b['matcherValue'] === 'string' ? b['matcherValue'] : '',
        bucket: b['bucket'] as import('../integrations/inbox/api.js').CreateRuleBody['bucket'],
        action: b['action'] as import('../integrations/inbox/api.js').CreateRuleBody['action'],
        source: b['source'] as import('../integrations/inbox/api.js').CreateRuleBody['source'],
      };
      const finalRuleBody: import('../integrations/inbox/api.js').CreateRuleBody =
        typeof b['tenantId'] === 'string'
          ? { ...ruleBody, tenantId: b['tenantId'] }
          : ruleBody;
      sendInbox(res, handleCreateRule(deps!, finalRuleBody));
    });

    this.dynamicRoutes.push(parseDynamicRoute('user', 'DELETE', '/api/inbox/rules/:id', async (_req, res, params) => {
      const deps = inboxDeps();
      if (!requireService(res, deps, 'Inbox')) return;
      const { handleDeleteRule } = await import('../integrations/inbox/api.js');
      sendInbox(res, handleDeleteRule(deps!, params['id']!));
    }));

    this.dynamicRoutes.push(parseDynamicRoute('user', 'GET', '/api/kg/entities', async (req, res) => {
      const kg = engine.getKnowledgeLayer();
      if (!kg) { jsonResponse(res, 200, { entities: [] }); return; }
      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
      const typeFilter = url.searchParams.get('type') ?? '';
      const query = url.searchParams.get('q') ?? '';
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), 500);
      const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0);
      try {
        if (query) {
          const entities = await kg.searchEntities(query, limit);
          jsonResponse(res, 200, { entities });
        } else {
          const listOpts: { type?: string; limit?: number; offset?: number } = { limit, offset };
          if (typeFilter) listOpts.type = typeFilter;
          const result = await kg.listEntities(listOpts);
          jsonResponse(res, 200, { entities: result });
        }
      } catch {
        jsonResponse(res, 200, { entities: [] });
      }
    }));

    this.dynamicRoutes.push(parseDynamicRoute('user', 'GET', '/api/kg/entities/:id', async (_req, res, params) => {
      const kg = engine.getKnowledgeLayer();
      if (!requireService(res, kg, 'Knowledge graph')) return;
      try {
        const entity = await kg.getEntity(params['id']!);
        if (!entity) { errorResponse(res, 404, 'Entity not found'); return; }
        const relations = await kg.getEntityRelations(entity.id);
        jsonResponse(res, 200, { entity, relations });
      } catch {
        errorResponse(res, 404, 'Entity not found');
      }
    }));

    this.dynamicRoutes.push(parseDynamicRoute('user', 'GET', '/api/kg/graph', async (req, res) => {
      const kg = engine.getKnowledgeLayer();
      if (!kg) { jsonResponse(res, 200, { nodes: [], edges: [] }); return; }
      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '80', 10) || 80, 1), 300);
      try {
        const graph = await kg.getGraph(limit);
        jsonResponse(res, 200, graph);
      } catch {
        jsonResponse(res, 200, { nodes: [], edges: [] });
      }
    }));

    // ── Thread Insights + Metrics ──────────────────────────────────

    this.addStatic('user', 'GET /api/thread-insights', async (req, res) => {
      const rh = engine.getRunHistory();
      if (!rh) { jsonResponse(res, 200, { threadInsights: [] }); return; }
      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '20', 10) || 20, 1), 500);
      const threadInsights = rh.getThreadAggregates(limit);
      jsonResponse(res, 200, { threadInsights });
    });

    this.addStatic('user', 'GET /api/metrics', async (req, res) => {
      const kg = engine.getKnowledgeLayer();
      if (!kg) { jsonResponse(res, 200, { metrics: [] }); return; }
      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
      const metricName = url.searchParams.get('name') ?? undefined;
      const window = url.searchParams.get('window') ?? undefined;
      const metrics = kg.getMetrics(
        metricName,
        window as import('../types/index.js').MetricWindow | undefined,
      );
      jsonResponse(res, 200, { metrics });
    });

    // ── CRM ──────────────────────────────────────────────────────

    this.addStatic('user', 'GET /api/crm/contacts', async (req, res) => {
      const crm = engine.getCRM();
      if (!crm) { jsonResponse(res, 200, { contacts: [] }); return; }
      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), 500);
      const typeFilter = url.searchParams.get('type') ?? '';
      const filter: Record<string, unknown> = {};
      if (typeFilter) filter['type'] = { $eq: typeFilter };
      const contacts = crm.listContacts(Object.keys(filter).length > 0 ? filter : undefined, limit);
      jsonResponse(res, 200, { contacts });
    });

    this.addStatic('user', 'GET /api/crm/deals', async (req, res) => {
      const crm = engine.getCRM();
      if (!crm) { jsonResponse(res, 200, { deals: [] }); return; }
      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), 500);
      const stageFilter = url.searchParams.get('stage') ?? '';
      // Show all deals by default (not just open ones)
      const filter: Record<string, unknown> = {};
      if (stageFilter) filter['stage'] = { $eq: stageFilter };
      const result = crm.getAllDeals(filter, limit);
      jsonResponse(res, 200, { deals: result });
    });

    this.addStatic('user', 'GET /api/crm/stats', async (_req, res) => {
      const crm = engine.getCRM();
      if (!crm) { jsonResponse(res, 200, { contacts: 0, pipeline: [] }); return; }
      const stats = crm.getContactStats();
      const pipeline = crm.getPipelineSummary();
      jsonResponse(res, 200, { contacts: stats, pipeline });
    });

    this.dynamicRoutes.push(parseDynamicRoute('user', 'GET', '/api/crm/contacts/:name/interactions', async (_req, res, params) => {
      const crm = engine.getCRM();
      if (!crm) { jsonResponse(res, 200, { interactions: [] }); return; }
      const interactions = crm.getInteractions(decodeURIComponent(params['name']!), 50);
      jsonResponse(res, 200, { interactions });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('user', 'GET', '/api/crm/contacts/:name/deals', async (_req, res, params) => {
      const crm = engine.getCRM();
      if (!crm) { jsonResponse(res, 200, { deals: [] }); return; }
      const deals = crm.getDealsForContact(decodeURIComponent(params['name']!), 50);
      jsonResponse(res, 200, { deals });
    }));

    // ── Backups ──────────────────────────────────────────────────

    this.addStatic('user', 'GET /api/backups', async (_req, res) => {
      const bm = engine.getBackupManager();
      if (!bm) { jsonResponse(res, 200, { backups: [] }); return; }
      const backups = bm.listBackups();
      jsonResponse(res, 200, { backups });
    });

    this.addStatic('user', 'POST /api/backups', async (_req, res) => {
      const bm = engine.getBackupManager();
      if (!requireService(res, bm, 'Backup manager')) return;
      try {
        const result = await bm.createBackup();
        jsonResponse(res, 200, result);
      } catch (err: unknown) {
        errorResponse(res, 500, err instanceof Error ? err.message : 'Backup failed');
      }
    });

    this.dynamicRoutes.push(parseDynamicRoute('admin', 'POST', '/api/backups/:id/restore', async (_req, res, params) => {
      if (denyOnManagedInstance(res, 'backup restore')) return;
      const bm = engine.getBackupManager();
      if (!requireService(res, bm, 'Backup manager')) return;
      const backupPath = bm.getBackupPath(params['id']!);
      if (!backupPath) { errorResponse(res, 404, 'Backup not found'); return; }
      try {
        const result = await bm.restoreBackup(backupPath);
        jsonResponse(res, result.success ? 200 : 500, result);
        // Auto-restart after successful restore so restored data takes effect
        if (result.success) {
          setTimeout(() => { process.exit(0); }, 500);
        }
      } catch (err: unknown) {
        errorResponse(res, 500, err instanceof Error ? err.message : 'Restore failed');
      }
    }));

    // ── API Store ────────────────────────────────────────────────

    this.addStatic('user', 'GET /api/api-profiles', async (_req, res) => {
      const store = engine.getApiStore();
      if (!store) { jsonResponse(res, 200, { profiles: [] }); return; }
      const profiles = store.getAll();
      jsonResponse(res, 200, { profiles });
    });

    this.dynamicRoutes.push(parseDynamicRoute('user', 'GET', '/api/api-profiles/:id', async (_req, res, params) => {
      const store = engine.getApiStore();
      if (!requireService(res, store, 'API store')) return;
      const profile = store.get(params['id']!);
      if (!profile) { errorResponse(res, 404, 'Profile not found'); return; }
      jsonResponse(res, 200, { profile });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('user', 'DELETE', '/api/api-profiles/:id', async (_req, res, params) => {
      const store = engine.getApiStore();
      if (!requireService(res, store, 'API store')) return;
      const { getLynoxDir } = await import('../core/config.js');
      const { ApiProfileUnlinkError } = await import('../core/api-store.js');
      const apisDir = join(getLynoxDir(), 'apis');
      try {
        const removed = store.remove(params['id']!, apisDir);
        if (!removed) { errorResponse(res, 404, 'Profile not found'); return; }
      } catch (err) {
        if (err instanceof ApiProfileUnlinkError) {
          // The in-memory side already happened; report the partial state
          // so the operator sees a 500 instead of a misleading 404 + a
          // silent file that would resurrect on next restart.
          errorResponse(res, 500, 'Profile removed from memory but on-disk delete failed; restart will resurrect it');
          return;
        }
        throw err;
      }
      jsonResponse(res, 200, { ok: true });
    }));

    // ── DataStore ────────────────────────────────────────────────

    this.addStatic('user', 'GET /api/datastore/collections', async (_req, res) => {
      const ds = engine.getDataStore();
      if (!ds) { jsonResponse(res, 200, { collections: [] }); return; }
      const { CRM_OVERLAP_NAMES } = await import('../core/data-store.js');
      // Belt-and-suspenders: the engine drops empty CRM-overlap collections
      // at startup, but if the agent re-creates one mid-session it must not
      // resurface in the UI alongside the dedicated Contacts tab. Hide only
      // when empty — a non-empty user-owned table is legitimate.
      const collections = ds.listCollections().filter(c => !(CRM_OVERLAP_NAMES.has(c.name) && c.recordCount === 0));
      jsonResponse(res, 200, { collections });
    });

    this.dynamicRoutes.push(parseDynamicRoute('user', 'GET', '/api/datastore/:collection', async (req, res, params) => {
      const ds = engine.getDataStore();
      if (!requireService(res, ds, 'DataStore')) return;
      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '20', 10) || 20, 1), 500);
      const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0);
      try {
        const result = ds.queryRecords({ collection: params['collection']!, limit, offset });
        jsonResponse(res, 200, result);
      } catch (err: unknown) {
        errorResponse(res, 400, err instanceof Error ? err.message : 'Query failed');
      }
    }));

    // ── Security-event aggregates (abuse detection, content-free) ──────
    //
    // GET /api/security/events/aggregate?hours=24
    //
    // Admin-scoped. Returns ONLY non-content dimensions + counts of fired
    // security guards (event_type, tool_name, decision, autonomy_level,
    // count, last_seen). It deliberately never exposes `input_preview` or
    // `detail` — the underlying `getContentFreeAggregates` uses an explicit
    // column projection, so customer content cannot leak through this route.
    //
    // The managed control plane polls this with the instance's admin bearer
    // token (single-token mode: LYNOX_HTTP_SECRET grants admin) to detect a
    // tenant whose guards are firing abnormally often, WITHOUT reading any
    // conversation/tool content. See pro admin-visibility-policy.md.
    this.addStatic('admin', 'GET /api/security/events/aggregate', async (req, res) => {
      const audit = typeof engine.getSecurityAudit === 'function' ? engine.getSecurityAudit() : null;
      if (!audit) {
        jsonResponse(res, 200, { window_hours: 0, generated_at: new Date().toISOString(), aggregates: [] });
        return;
      }
      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
      const rawHours = Number.parseInt(url.searchParams.get('hours') ?? '24', 10);
      // Clamp to [1, 168] (1 hour … 7 days); fall back to 24 on garbage input.
      const windowHours = Number.isFinite(rawHours) ? Math.min(168, Math.max(1, rawHours)) : 24;
      const aggregates = audit.getContentFreeAggregates(windowHours);
      jsonResponse(res, 200, {
        window_hours: windowHours,
        generated_at: new Date().toISOString(),
        aggregates,
      });
    });

    // ── GDPR Data Export & Erasure ─────────────────────────────────

    // GET /api/export — GDPR Art. 15 (Right of Access) + Art. 20 (Data Portability)
    this.addStatic('admin', 'GET /api/export', async (_req, res) => {
      const exportData: Record<string, unknown> = {
        exported_at: new Date().toISOString(),
        version: PKG_VERSION,
      };

      // Threads + messages
      const threadStore = engine.getThreadStore();
      if (threadStore) {
        const threads = threadStore.listThreads({ limit: 200, includeArchived: true });
        const threadsWithMessages = threads.map(t => ({
          ...t,
          messages: threadStore.getMessages(t.id, { limit: 50000 }).map(m => ({
            seq: m.seq,
            role: m.role,
            content: JSON.parse(m.content_json) as unknown,
            // Include the B-full display-only flag in the GDPR data dump so a
            // re-import preserves which rows are failed-turn notes (display-only)
            // vs real API messages. (The encrypted DB-chunk migration keeps the
            // column natively; this is the portable JSON export path.)
            display_only: m.display_only,
            created_at: m.created_at,
          })),
        }));
        exportData['threads'] = threadsWithMessages;
      } else {
        exportData['threads'] = [];
      }

      // Flat-file memory (all namespaces)
      const memory = engine.getMemory();
      if (memory) {
        const memoryData: Record<string, string | null> = {};
        for (const ns of ['knowledge', 'methods', 'status', 'learnings'] as const) {
          memoryData[ns] = await memory.load(ns);
        }
        exportData['memory'] = memoryData;
      } else {
        exportData['memory'] = {};
      }

      // Knowledge graph (entities + relations)
      const kg = engine.getKnowledgeLayer();
      if (kg) {
        try {
          // Page through ALL entities. A single { limit: 200 } call silently
          // dropped every entity past the first 200 from a user's GDPR export
          // (an Art. 15/20 completeness gap, on the legacy KG today and the
          // subject-graph once the flag flips). The page cap bounds a runaway
          // loop. (The per-entity relation cap below stays at 200 newest — a
          // documented bounded loss; the global relation scan is S2-main.)
          const PAGE = 200;
          const MAX_PAGES = 1000;
          const entities: EntityRecord[] = [];
          let truncated = true;
          for (let page = 0; page < MAX_PAGES; page++) {
            const batch = await kg.listEntities({ limit: PAGE, offset: page * PAGE });
            entities.push(...batch);
            if (batch.length < PAGE) { truncated = false; break; }
          }
          if (truncated) {
            // Surfaced, not silent: hitting the cap means the export may be
            // incomplete (an Art.15/20 gap) — log so it's observable, never drop quietly.
            process.stderr.write(`⚠ /api/export: entity export hit the ${MAX_PAGES * PAGE}-row cap — dump may be incomplete\n`);
          }
          const stats = await kg.stats();
          // Collect all relations by iterating entity relations
          const relationSet = new Map<string, unknown>();
          for (const entity of entities) {
            const relations = await kg.getEntityRelations(entity.id);
            for (const rel of relations) {
              const key = `${rel.fromEntityId}:${rel.toEntityId}:${rel.relationType}`;
              if (!relationSet.has(key)) {
                relationSet.set(key, rel);
              }
            }
          }
          exportData['knowledge_graph'] = {
            entities,
            relationships: [...relationSet.values()],
            stats,
          };
        } catch {
          exportData['knowledge_graph'] = { entities: [], relationships: [] };
        }
      } else {
        exportData['knowledge_graph'] = { entities: [], relationships: [] };
      }

      // CRM contacts + deals
      const crm = engine.getCRM();
      if (crm) {
        exportData['contacts'] = crm.listContacts(undefined, 500);
        exportData['deals'] = crm.getAllDeals(undefined, 500);
      } else {
        exportData['contacts'] = [];
        exportData['deals'] = [];
      }

      // DataStore collections + records
      const ds = engine.getDataStore();
      if (ds) {
        const collections = ds.listCollections();
        const datastoreExport: Record<string, unknown[]> = {};
        for (const col of collections) {
          try {
            const result = ds.queryRecords({ collection: col.name, limit: 500 });
            datastoreExport[col.name] = result.rows;
          } catch {
            datastoreExport[col.name] = [];
          }
        }
        exportData['datastore'] = datastoreExport;
      } else {
        exportData['datastore'] = {};
      }

      // Secret names (never values — GDPR export must not leak secrets)
      const secretStore = engine.getSecretStore();
      if (secretStore) {
        exportData['secrets'] = secretStore.listNames();
      } else {
        exportData['secrets'] = [];
      }

      // Config (redacted)
      try {
        const { readUserConfig } = await import('../core/config.js');
        const config = readUserConfig();
        exportData['config'] = redactConfigForResponse(config);
      } catch {
        exportData['config'] = {};
      }

      jsonResponse(res, 200, exportData);
    });

    // DELETE /api/data — GDPR Art. 17 (Right to Erasure)
    this.addStatic('admin', 'DELETE /api/data', async (_req, res, _params, body) => {
      if (denyOnManagedInstance(res, 'bulk data deletion')) return;
      const b = body as Record<string, unknown> | null;
      const confirm = b && typeof b['confirm'] === 'string' ? b['confirm'] : '';
      if (confirm !== 'DELETE_ALL_DATA') {
        errorResponse(res, 400, 'Confirmation required: send { "confirm": "DELETE_ALL_DATA" }');
        return;
      }

      // Delete all threads + messages
      const threadStore = engine.getThreadStore();
      if (threadStore) {
        const threads = threadStore.listThreads({ limit: 200, includeArchived: true });
        for (const t of threads) {
          threadStore.deleteThread(t.id);
        }
      }

      // Delete all flat-file memory
      const memory = engine.getMemory();
      if (memory) {
        for (const ns of ['knowledge', 'methods', 'status', 'learnings'] as const) {
          await memory.save(ns, '');
        }
      }

      // Delete all knowledge graph entities (cascades to relations, mentions, cooccurrences)
      const kg = engine.getKnowledgeLayer();
      if (kg) {
        try {
          const db = kg.getDb();
          let entities = db.listEntities({ limit: 200 });
          while (entities.length > 0) {
            for (const entity of entities) {
              db.deleteEntity(entity.id);
            }
            entities = db.listEntities({ limit: 200 });
          }
          // Also deactivate all memories
          db.deactivateAllMemories();
        } catch { /* best effort */ }
      }

      // Delete all subject-graph data (engine.db) — Foundation Rework v2 tables.
      // The legacy KG wipe above clears agent-memory.db; this clears the engine.db
      // mirror (people.email/phone, memories.text, subjects.name, organizations,
      // artifacts, …) so a Right-to-Erasure request leaves no PII once the S1b/c
      // mirror writes are enabled. Mirror writes are flag-gated, so this lands with
      // the same release that turns them on — the engine.db is empty until then.
      const engineDb = engine.getEngineDb();
      if (engineDb) {
        try {
          engineDb.deleteAllData();
        } catch (err) {
          // The wipe is one atomic transaction: a failure leaves ALL engine.db
          // PII intact while the route still 200s. Surface it (an Art.17 erasure
          // must not silently fail) rather than swallowing best-effort.
          process.stderr.write(`⚠ /api/data: engine.db wipe failed: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }

      // Clear the DORMANT legacy verb-def rows the B1 self-heal keeps alive (the
      // non-destructive v44 no longer drops the legacy `triggers` + workflow-def
      // `pipeline_runs`). Without this an Art.17 erasure would leave trigger/workflow
      // PII on disk, and an engine.db recreate would re-backfill it into live reads.
      const runHistoryForWipe = engine.getRunHistory();
      if (runHistoryForWipe) {
        try {
          runHistoryForWipe.clearLegacyVerbDefs();
        } catch (err) {
          process.stderr.write(`⚠ /api/data: legacy verb-def wipe failed: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }

      // Delete all DataStore collections (includes CRM tables)
      const ds = engine.getDataStore();
      if (ds) {
        const collections = ds.listCollections();
        for (const col of collections) {
          ds.dropCollection(col.name);
        }
      }

      // Delete all secrets from vault
      const secretStore = engine.getSecretStore();
      if (secretStore) {
        const names = secretStore.listNames();
        for (const name of names) {
          secretStore.deleteSecret(name);
        }
      }

      // Reset config to defaults
      try {
        const { saveUserConfig } = await import('../core/config.js');
        saveUserConfig({});
        await engine.reloadUserConfig();
      } catch { /* best effort */ }

      jsonResponse(res, 200, { deleted: true, message: 'All user data has been permanently deleted' });
    });

    // ── Vault ─────────────────────────────────────────────────────

    // user scope: a managed customer's settings page reads configured-status.
    // reveal=true (the actual key) stays 403 on managed via the inline guard below,
    // so user scope never exposes the secret.
    this.addStatic('user', 'GET /api/vault/key', async (req, res) => {
      const key = process.env['LYNOX_VAULT_KEY'];
      if (!key) {
        jsonResponse(res, 200, { configured: false });
        return;
      }
      // Only return the actual key when explicitly requested (settings page reveal)
      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
      if (url.searchParams.get('reveal') === 'true') {
        // Managed mode: never expose vault key to users
        if (readEnvAlias('LYNOX_BILLING_TIER')) {
          errorResponse(res, 403, 'Managed instance: vault key is system-controlled');
          return;
        }
        jsonResponse(res, 200, { configured: true, key });
      } else {
        jsonResponse(res, 200, { configured: true });
      }
    });

    this.addStatic('admin', 'POST /api/vault/rotate', async (_req, res, _params, body) => {
      if (readEnvAlias('LYNOX_BILLING_TIER')) {
        errorResponse(res, 403, 'Managed instance: vault rotation is system-controlled');
        return;
      }
      const b = body as Record<string, unknown> | null;
      const newKey = typeof b?.['newKey'] === 'string' ? b['newKey'] : '';
      if (!newKey || newKey.length < 16) {
        errorResponse(res, 400, 'newKey must be at least 16 characters');
        return;
      }
      const currentKey = process.env['LYNOX_VAULT_KEY'];
      if (!currentKey) {
        errorResponse(res, 400, 'LYNOX_VAULT_KEY not set — cannot rotate');
        return;
      }
      try {
        const { resolve } = await import('node:path');
        const { homedir } = await import('node:os');
        const { SecretVault } = await import('../core/secret-vault.js');
        const vaultPath = resolve(homedir(), '.lynox', 'vault.db');
        const count = SecretVault.rotateVault(vaultPath, currentKey, newKey);
        jsonResponse(res, 200, { rotated: count, message: 'Update LYNOX_VAULT_KEY and restart' });
      } catch (err: unknown) {
        errorResponse(res, 500, err instanceof Error ? err.message : 'Rotation failed');
      }
    });

    // ── Access token (read-only, for Settings UI) ────────────────

    // user scope: status read for the Settings UI. reveal=true (the actual token)
    // stays 403 on managed via the inline guard below, so user scope is safe.
    this.addStatic('user', 'GET /api/auth/token', async (req, res) => {
      const secret = process.env['LYNOX_HTTP_SECRET'];
      if (!secret) {
        jsonResponse(res, 200, { configured: false });
        return;
      }
      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
      if (url.searchParams.get('reveal') === 'true') {
        if (readEnvAlias('LYNOX_BILLING_TIER')) {
          errorResponse(res, 403, 'Managed instance: access token is system-controlled');
          return;
        }
        jsonResponse(res, 200, { configured: true, token: secret });
      } else {
        jsonResponse(res, 200, { configured: true });
      }
    });

    // ── Files (workspace) ────────────────────────────────────────

    const HIDDEN_PATTERNS = new Set(['.git', '.env', '.DS_Store', 'node_modules', '.cache', '__pycache__', 'thumbs.db']);

    // user scope: the workspace file browser operates on the instance owner's own
    // files. Path-traversal/symlink-escape is rejected in resolveWorkspacePath and
    // HIDDEN_PATTERNS hides .env/.git, so user scope adds no exposure beyond the
    // owner's own workspace (it's not off-box — see denyOnManagedInstance routes).
    this.addStatic('user', 'GET /api/files', async (req, res) => {
      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
      const dirPath = url.searchParams.get('path') ?? '.';
      const showHidden = url.searchParams.get('hidden') === '1';
      try {
        const { readdir, stat, access } = (await import('node:fs/promises'));
        const { join } = await import('node:path');
        const { getWorkspaceDir } = await import('../core/workspace.js');
        const { getLynoxDir } = await import('../core/config.js');
        const { ensureDirSync: ensureDir } = await import('../core/atomic-write.js');

        const base = getWorkspaceDir() ?? join(getLynoxDir(), 'workspace');
        try { await access(base); } catch { ensureDir(base); }
        // Resolve + reject traversal AND symlink-escape (realpath) — the same
        // confinement /read, /download and DELETE apply via resolveWorkspacePath.
        // Without the realpath check a symlink inside the workspace pointing out
        // would let readdir enumerate the target directory's entries.
        const target = await resolveWorkspacePath(dirPath);
        if (target === null) { errorResponse(res, 403, 'Outside workspace'); return; }
        const dirEntries = await readdir(target, { withFileTypes: true });
        const filtered = dirEntries.filter(e => showHidden || (!e.name.startsWith('.') && !HIDDEN_PATTERNS.has(e.name)));
        const entries = await Promise.all(filtered.map(async e => ({
          name: e.name,
          isDirectory: e.isDirectory(),
          size: e.isFile() ? (await stat(join(target, e.name))).size : 0,
        })));
        jsonResponse(res, 200, { path: dirPath, entries });
      } catch {
        jsonResponse(res, 200, { path: dirPath, entries: [] });
      }
    });

    /** Resolve a workspace-relative path, rejecting traversal and symlink escape.
     *  Delegates to the single shared file-area resolver in workspace.ts so this
     *  endpoint and the media_process tool confine paths identically. */
    async function resolveWorkspacePath(filePath: string): Promise<string | null> {
      const { resolveFileAreaPath } = await import('../core/workspace.js');
      return resolveFileAreaPath(filePath);
    }

    this.addStatic('user', 'GET /api/files/download', async (req, res) => {
      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
      const filePath = url.searchParams.get('path');
      if (!filePath) { errorResponse(res, 400, 'Missing path parameter'); return; }
      try {
        const { createReadStream } = await import('node:fs');
        const { stat } = await import('node:fs/promises');
        const { basename } = await import('node:path');
        const resolved = await resolveWorkspacePath(filePath);
        if (!resolved) { errorResponse(res, 403, 'Outside workspace'); return; }
        const st = await stat(resolved);
        if (!st.isFile()) { errorResponse(res, 400, 'Not a file'); return; }
        if (st.size > 100 * 1024 * 1024) { errorResponse(res, 413, 'File too large'); return; }
        const name = basename(resolved);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${sanitizeAttachmentFilename(name)}"`,
          'Content-Length': st.size,
        });
        createReadStream(resolved).pipe(res);
      } catch {
        errorResponse(res, 404, 'File not found');
      }
    });

    this.addStatic('user', 'GET /api/files/read', async (req, res) => {
      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
      const filePath = url.searchParams.get('path');
      if (!filePath) { errorResponse(res, 400, 'Missing path parameter'); return; }
      try {
        const { readFile, stat } = await import('node:fs/promises');
        const resolved = await resolveWorkspacePath(filePath);
        if (!resolved) { errorResponse(res, 403, 'Outside workspace'); return; }
        const st = await stat(resolved);
        if (!st.isFile()) { errorResponse(res, 400, 'Not a file'); return; }
        if (st.size > 1024 * 1024) { errorResponse(res, 413, 'File too large for preview (max 1 MB)'); return; }
        const content = await readFile(resolved, 'utf-8');
        jsonResponse(res, 200, { content });
      } catch {
        errorResponse(res, 404, 'File not found');
      }
    });

    this.addStatic('user', 'DELETE /api/files', async (req, res) => {
      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
      const filePath = url.searchParams.get('path');
      if (!filePath) { errorResponse(res, 400, 'Missing path parameter'); return; }
      try {
        const { unlink, stat } = await import('node:fs/promises');
        const resolved = await resolveWorkspacePath(filePath);
        if (!resolved) { errorResponse(res, 403, 'Outside workspace'); return; }
        const st = await stat(resolved);
        if (!st.isFile()) { errorResponse(res, 400, 'Not a file'); return; }
        await unlink(resolved);
        jsonResponse(res, 200, { ok: true });
      } catch {
        errorResponse(res, 404, 'File not found');
      }
    });

    // ── Migration (zero-knowledge self-hosted → managed) ─────────────

    this.addStatic('user', 'GET /api/migration/preview', async (_req, res) => {
      try {
        const { MigrationExporter } = await import('../core/migration-export.js');
        const exporter = new MigrationExporter();
        const preview = exporter.preview();
        jsonResponse(res, 200, preview);
      } catch (err: unknown) {
        errorResponse(res, 500, err instanceof Error ? err.message : 'Preview failed');
      }
    });

    this.addStatic('admin', 'POST /api/migration/export', async (req, res, _params, body) => {
      // Orchestrated migration: engine handles ECDH + export + transfer to target.
      // Browser is just the orchestrator — progress reported via SSE.
      // The exporter ships sensitive instance data (secrets + databases) to a
      // caller-chosen target. On a managed box that off-box transfer is one the
      // control plane must own — managed data portability is CP-mediated.
      if (denyOnManagedInstance(res, 'migration export')) return;
      const b = body as Record<string, unknown> | null;
      const targetUrl = typeof b?.['targetUrl'] === 'string' ? b['targetUrl'] : '';
      const migrationToken = typeof b?.['migrationToken'] === 'string' ? b['migrationToken'] : '';

      if (!targetUrl || !migrationToken) {
        errorResponse(res, 400, 'Missing targetUrl or migrationToken');
        return;
      }

      // Validate targetUrl is a public HTTPS endpoint before opening the stream.
      // The transfer fetches below additionally go through fetchPinned, which
      // re-resolves + pins to that public IP — closing the DNS-rebind window and
      // blocking SSRF to internal/private targets (incl. cloud metadata).
      const { fetchPinned, assertPublicUrl } = await import('../core/network-guard.js');
      try {
        if (new URL(targetUrl).protocol !== 'https:') {
          errorResponse(res, 400, 'targetUrl must use HTTPS');
          return;
        }
      } catch {
        errorResponse(res, 400, 'Invalid targetUrl');
        return;
      }
      try {
        await assertPublicUrl(targetUrl);
      } catch {
        errorResponse(res, 400, 'targetUrl must resolve to a public host');
        return;
      }

      // SSE response for progress
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'X-lynox-AI-Generated': 'true',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const sendEvent = (event: string, data: unknown) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      try {
        const crypto = await import('../core/migration-crypto.js');
        const { MigrationExporter } = await import('../core/migration-export.js');

        // 1. Preview
        sendEvent('progress', { phase: 'preview', message: 'Collecting data inventory...' });
        const exporter = new MigrationExporter();
        const preview = exporter.preview();
        sendEvent('preview', preview);

        // 2. ECDH Handshake with target
        sendEvent('progress', { phase: 'handshake', message: 'Establishing secure connection...' });

        const hsRes = await fetchPinned(`${targetUrl}/api/migration/handshake`, {
          headers: { 'X-Migration-Token': migrationToken, 'Accept': 'application/json' },
        });
        if (!hsRes.ok) {
          const errText = await hsRes.text();
          throw new Error(`Handshake failed: ${errText}`);
        }
        const handshake = await hsRes.json() as { serverPubKey: string; signature: string; challengeNonce: string };

        // Verify the server's signature over its public key — without this, a MITM
        // can substitute the responder's keypair and decrypt the entire transfer.
        // try/finally so the derived key is zeroed even if verifyHandshake throws
        // on malformed input rather than returning false.
        const signingKey = crypto.deriveSigningKey(migrationToken);
        let handshakeValid = false;
        try {
          handshakeValid = crypto.verifyHandshake(handshake.serverPubKey, handshake.signature, signingKey);
        } finally {
          crypto.zeroize(signingKey);
        }
        if (!handshakeValid) {
          throw new Error('Handshake signature invalid — refusing to derive transfer key');
        }

        // Client key agreement
        const clientKp = crypto.generateEphemeralKeypair();
        const serverPub = crypto.deserializePublicKey(handshake.serverPubKey);
        const nonce = Buffer.from(handshake.challengeNonce, 'hex');
        const transferKey = crypto.deriveTransferKey(clientKp.privateKey, serverPub, nonce);

        const migrationHeaders = {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-Migration-Token': migrationToken,
        };

        const completeRes = await fetchPinned(`${targetUrl}/api/migration/handshake`, {
          method: 'POST',
          headers: migrationHeaders,
          body: JSON.stringify({ clientPubKey: crypto.serializePublicKey(clientKp.publicKey) }),
        });
        if (!completeRes.ok) throw new Error('Handshake completion failed');

        sendEvent('progress', { phase: 'handshake_done', message: 'Secure connection established' });

        // 3. Export + Encrypt
        sendEvent('progress', { phase: 'exporting', message: 'Exporting and encrypting data...' });
        const { manifest, chunks } = exporter.export(transferKey, (p) => {
          sendEvent('progress', { phase: p.phase, message: p.currentName, current: p.currentChunk, total: p.totalChunks });
        });

        // Zeroize transfer key — no longer needed after encryption
        crypto.zeroize(transferKey);

        // 4. Send manifest
        sendEvent('progress', { phase: 'transferring', message: 'Sending manifest...' });
        const mRes = await fetchPinned(`${targetUrl}/api/migration/manifest`, {
          method: 'POST',
          headers: migrationHeaders,
          body: JSON.stringify(manifest),
        });
        if (!mRes.ok) throw new Error(`Manifest rejected: ${await mRes.text()}`);

        // 5. Send chunks
        for (let i = 0; i < chunks.length; i++) {
          sendEvent('progress', {
            phase: 'transferring',
            message: `Sending chunk ${String(i + 1)}/${String(chunks.length)}...`,
            current: i + 1,
            total: chunks.length,
          });

          const cRes = await fetchPinned(`${targetUrl}/api/migration/chunk`, {
            method: 'POST',
            headers: migrationHeaders,
            body: JSON.stringify(chunks[i]),
          });
          if (!cRes.ok) throw new Error(`Chunk ${String(i)} rejected: ${await cRes.text()}`);
        }

        // 6. Restore
        sendEvent('progress', { phase: 'restoring', message: 'Restoring data on target...' });
        const rRes = await fetchPinned(`${targetUrl}/api/migration/restore`, {
          method: 'POST',
          headers: migrationHeaders,
        });
        if (!rRes.ok) throw new Error(`Restore failed: ${await rRes.text()}`);

        const result = await rRes.json() as { success: boolean; verification: unknown };
        sendEvent('done', { success: true, verification: result.verification });
      } catch (err: unknown) {
        sendEvent('error', { message: err instanceof Error ? err.message : 'Migration failed' });
      } finally {
        res.end();
      }
    });

    this.addStatic('admin', 'GET /api/migration/handshake', async (req, res) => {
      // Only available on managed instances receiving a migration
      if (!readEnvAlias('LYNOX_BILLING_TIER')) {
        errorResponse(res, 404, 'Migration import only available on managed instances');
        return;
      }

      const token = req.headers['x-migration-token'];
      if (!token || typeof token !== 'string') {
        errorResponse(res, 401, 'Missing X-Migration-Token header');
        return;
      }

      try {
        const importer = await this._getOrCreateMigrationImporter();
        if (!importer) {
          errorResponse(res, 503, 'Migration not available — missing vault key');
          return;
        }

        // Validate migration token
        const storedToken = process.env['LYNOX_MIGRATION_TOKEN'];
        if (!storedToken) {
          errorResponse(res, 403, 'No migration token configured for this instance');
          return;
        }

        const { verifyMigrationToken } = await import('../core/migration-crypto.js');
        if (!verifyMigrationToken(token, storedToken)) {
          errorResponse(res, 403, 'Invalid migration token');
          return;
        }

        // Belt-and-braces: verifyMigrationToken already enforces the 64-hex-char
        // shape (it parses both sides as hex Buffers and length-checks them), but
        // re-assert here so a future change that loosens that check can't slip a
        // low-entropy stored token straight into deriveSigningKey.
        if (!/^[0-9a-f]{64}$/i.test(storedToken)) {
          errorResponse(res, 500, 'Migration token has invalid format');
          return;
        }

        const payload = importer.startHandshake(storedToken);
        jsonResponse(res, 200, payload);
      } catch (err: unknown) {
        errorResponse(res, 400, err instanceof Error ? err.message : 'Handshake failed');
      }
    });

    this.addStatic('admin', 'POST /api/migration/handshake', async (_req, res, _params, body) => {
      if (!readEnvAlias('LYNOX_BILLING_TIER')) {
        errorResponse(res, 404, 'Migration import only available on managed instances');
        return;
      }

      const b = body as Record<string, unknown> | null;
      const clientPubKey = typeof b?.['clientPubKey'] === 'string' ? b['clientPubKey'] : '';
      if (!clientPubKey) {
        errorResponse(res, 400, 'Missing clientPubKey');
        return;
      }

      try {
        const importer = this._getMigrationImporter();
        if (!importer) {
          errorResponse(res, 400, 'No active migration session — start handshake first');
          return;
        }

        importer.completeHandshake(clientPubKey);
        jsonResponse(res, 200, { ready: true });
      } catch (err: unknown) {
        errorResponse(res, 400, err instanceof Error ? err.message : 'Handshake completion failed');
      }
    });

    this.addStatic('admin', 'POST /api/migration/manifest', async (_req, res, _params, body) => {
      if (!readEnvAlias('LYNOX_BILLING_TIER')) {
        errorResponse(res, 404, 'Migration import only available on managed instances');
        return;
      }

      try {
        const importer = this._getMigrationImporter();
        if (!importer) {
          errorResponse(res, 400, 'No active migration session');
          return;
        }

        const manifest = body as import('../core/migration-crypto.js').MigrationManifest;
        importer.setManifest(manifest);
        jsonResponse(res, 200, { accepted: true, totalChunks: manifest.totalChunks });
      } catch (err: unknown) {
        errorResponse(res, 400, err instanceof Error ? err.message : 'Manifest rejected');
      }
    });

    this.addStatic('admin', 'POST /api/migration/chunk', async (_req, res, _params, body) => {
      if (!readEnvAlias('LYNOX_BILLING_TIER')) {
        errorResponse(res, 404, 'Migration import only available on managed instances');
        return;
      }

      try {
        const importer = this._getMigrationImporter();
        if (!importer) {
          errorResponse(res, 400, 'No active migration session');
          return;
        }

        const chunk = body as import('../core/migration-crypto.js').EncryptedChunk;
        const result = importer.receiveChunk(chunk);
        const complete = importer.isComplete();

        jsonResponse(res, 200, { ...result, complete });
      } catch (err: unknown) {
        // On any chunk error, cleanup the session to prevent partial state
        this._migrationImporter?.cleanup();
        this._migrationImporter = null;
        errorResponse(res, 400, err instanceof Error ? err.message : 'Chunk rejected');
      }
    });

    this.addStatic('admin', 'POST /api/migration/restore', async (_req, res) => {
      if (!readEnvAlias('LYNOX_BILLING_TIER')) {
        errorResponse(res, 404, 'Migration import only available on managed instances');
        return;
      }

      try {
        const importer = this._getMigrationImporter();
        if (!importer) {
          errorResponse(res, 400, 'No active migration session');
          return;
        }

        const verification = importer.restore();

        // Cleanup crypto material
        importer.cleanup();
        this._migrationImporter = null;

        // Invalidate the migration token (one-time use)
        delete process.env['LYNOX_MIGRATION_TOKEN'];

        jsonResponse(res, 200, { success: true, verification });

        // Auto-restart so engine loads the imported data
        setTimeout(() => { process.exit(0); }, 1000);
      } catch (err: unknown) {
        this._migrationImporter?.cleanup();
        this._migrationImporter = null;
        errorResponse(res, 500, err instanceof Error ? err.message : 'Restore failed');
      }
    });

    this.addStatic('admin', 'DELETE /api/migration', async (_req, res) => {
      // Cancel an in-progress migration (cleanup keys + memory)
      if (this._migrationImporter) {
        this._migrationImporter.cleanup();
        this._migrationImporter = null;
      }
      jsonResponse(res, 200, { cancelled: true });
    });
  }

  // ── Migration helpers ──────────────────────────────────────────────────────

  private _migrationImporter: import('../core/migration-import.js').MigrationImporter | null = null;

  private async _getOrCreateMigrationImporter(): Promise<import('../core/migration-import.js').MigrationImporter | null> {
    if (this._migrationImporter?.isActive) return this._migrationImporter;

    const vaultKey = process.env['LYNOX_VAULT_KEY'];
    if (!vaultKey) return null;

    const { MigrationImporter } = await import('../core/migration-import.js');
    this._migrationImporter = new MigrationImporter({ vaultKey });
    return this._migrationImporter;
  }

  private _getMigrationImporter(): import('../core/migration-import.js').MigrationImporter | null {
    if (!this._migrationImporter?.isActive) return null;
    return this._migrationImporter;
  }
}
