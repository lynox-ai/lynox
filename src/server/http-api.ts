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
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { Engine } from '../core/engine.js';
import { loadConfig } from '../core/config.js';
import { getActiveProvider } from '../core/llm-client.js';
import { SessionStore } from '../core/session-store.js';
import { WEB_UI_SYSTEM_PROMPT_SUFFIX } from '../core/prompts.js';
import { projectMessages } from '../core/render-projection.js';
import type { StreamEvent } from '../types/index.js';
import { MODEL_MAP, CONTEXT_WINDOW } from '../types/index.js';
import { LynoxUserConfigSchema } from '../types/schemas.js';

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
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

interface ProviderStatus {
  indicator: 'none' | 'minor' | 'major' | 'critical' | 'unknown';
  description: string;
  provider?: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_BODY_BYTES = 30 * 1024 * 1024; // 30 MB
const PKG_VERSION: string = (() => {
  try {
    const raw = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf-8');
    return (JSON.parse(raw) as { version: string }).version;
  } catch { return 'unknown'; }
})();

// Keys stripped from GET /api/config responses (secrets that must not leak)
const REDACTED_CONFIG_KEYS = new Set([
  'api_key', 'telegram_bot_token',
  'search_api_key', 'google_client_id', 'google_client_secret',
]);

// Two-tier auth: when LYNOX_HTTP_ADMIN_SECRET is set, these routes require admin scope.
// When only LYNOX_HTTP_SECRET is set (single-token mode), it grants admin implicitly.
type AuthScope = 'admin' | 'user';

function requiresAdmin(method: string, pathname: string): boolean {
  if (method === 'PUT' && pathname === '/api/config') return true;
  if (method === 'GET' && pathname === '/api/vault/key') return true;
  if (method === 'POST' && pathname === '/api/vault/rotate') return true;
  // All file operations require admin scope (read, download, delete)
  if (pathname.startsWith('/api/files')) return true;
  if (method === 'GET' && pathname === '/api/secrets') return true;
  if (method === 'PUT' && pathname.startsWith('/api/secrets/')) return true;
  if (method === 'DELETE' && pathname.startsWith('/api/secrets/')) return true;
  if (method === 'GET' && pathname === '/api/auth/token') return true;
  // GDPR endpoints require admin scope
  if (method === 'GET' && pathname === '/api/export') return true;
  if (method === 'DELETE' && pathname === '/api/data') return true;
  // Migration endpoints require admin scope (except preview which is read-only)
  if (pathname.startsWith('/api/migration') && pathname !== '/api/migration/preview') return true;
  // WhatsApp credential mutations are admin-scope; read-only status stays user-scope.
  if ((method === 'POST' || method === 'DELETE') && pathname === '/api/whatsapp/credentials') return true;
  // KG cleanup is destructive (deletes entities + their relations) — admin only.
  if (method === 'POST' && pathname === '/api/kg/cleanup') return true;
  return false;
}
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 120;
const RATE_MAX_LOOPBACK = 600; // Higher limit for Web UI proxy on same host
const PROMPT_TIMEOUT_MS = 24 * 60 * 60_000; // 24 hours — prompts persist in SQLite, survive reconnects
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

/** Type-guard that sends 503 if the service is null/undefined. Caller must `return` after a false result. */
function requireService<T>(res: ServerResponse, service: T | null | undefined, name: string): service is NonNullable<T> {
  if (service === null || service === undefined) errorResponse(res, 503, `${name} not available`);
  return service !== null && service !== undefined;
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

function parseDynamicRoute(method: string, path: string, handler: RouteHandler): DynamicRoute {
  const paramNames: string[] = [];
  const pattern = path.replace(/:([^/]+)/g, (_match, name: string) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  return { method, pattern: new RegExp(`^${pattern}$`), paramNames, handler };
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
  private readonly runningSessions = new Map<string, { streamAlive: boolean; takeover: () => void }>();
  private readonly rateCounts = new Map<string, { count: number; resetAt: number }>();
  private readonly staticRoutes = new Map<string, RouteHandler>();
  private readonly dynamicRoutes: DynamicRoute[] = [];
  private rateGcTimer: ReturnType<typeof setInterval> | null = null;
  private providerStatusCache: { data: ProviderStatus; expiresAt: number } | null = null;
  private healthCache: { data: Record<string, unknown>; expiresAt: number } | null = null;
  // 30 s TTL per (period, windowStart) key. Usage Dashboard typically re-opens
  // the tab with the same window multiple times in quick succession — this
  // keeps repeated SQLite scans off the hot path without stale-data risk, since
  // the period window itself rolls forward and evicts old entries.
  private readonly _usageSummaryCache = new Map<string, { summary: import('../core/run-history.js').UsageSummary; expiresAt: number }>();
  private pushChannel: import('../integrations/push/web-push-channel.js').WebPushNotificationChannel | null = null;
  private _googleOAuthState: string | undefined;
  private _googleRedirectUri: string | undefined;

  /** Whether the Web UI handler is loaded (determines default port and bind behavior). */
  hasWebUi(): boolean { return this.webUiHandler !== null; }

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

    const data: Record<string, unknown> = {
      status: 'ok',
      version: PKG_VERSION,
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
    await this._tryStartTelegram(config);
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

  private _verifySessionCookie(req: IncomingMessage, secret: string): boolean {
    const cookieHeader = req.headers['cookie'];
    if (!cookieHeader) return false;

    const match = /(?:^|;\s*)lynox_session=([^;]+)/.exec(cookieHeader);
    if (!match?.[1]) return false;

    const token = decodeURIComponent(match[1]);
    const parts = token.split('.');
    if (parts.length < 2 || parts.length > 3) return false;

    const sig = parts[parts.length - 1]!;
    const payload = parts.slice(0, -1).join('.');
    // Timestamp: last element before sig (supports old ts.hmac and new nonce.ts.hmac)
    const tsStr = parts.length === 3 ? parts[1]! : parts[0]!;

    const timestamp = parseInt(tsStr, 10);
    if (Number.isNaN(timestamp)) return false;
    if (Math.floor(Date.now() / 1000) - timestamp > 7 * 24 * 60 * 60) return false;

    try {
      const key = createHmac('sha256', 'lynox-session').update(secret).digest();
      const expected = createHmac('sha256', key).update(payload).digest('hex');
      const sigBuf = Buffer.from(sig, 'hex');
      const expBuf = Buffer.from(expected, 'hex');
      if (sigBuf.length !== expBuf.length) return false;
      return timingSafeEqual(sigBuf, expBuf);
    } catch {
      return false;
    }
  }

  private async _tryStartTelegram(config: ReturnType<typeof loadConfig>): Promise<void> {
    const store = this.engine?.getSecretStore();
    const token = store?.resolve('TELEGRAM_BOT_TOKEN')
      ?? process.env['TELEGRAM_BOT_TOKEN']
      ?? config.telegram_bot_token;
    if (!token || !this.engine) return;

    const allowedRaw = store?.resolve('TELEGRAM_ALLOWED_CHAT_IDS')
      ?? process.env['TELEGRAM_ALLOWED_CHAT_IDS']
      ?? '';
    const allowedChatIds = allowedRaw
      ? String(allowedRaw).split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n))
      : config.telegram_allowed_chat_ids;

    try {
      const { startTelegramBot } = await import('../integrations/telegram/telegram-bot.js');
      await startTelegramBot({ token, allowedChatIds, engine: this.engine });
      process.stderr.write(`Telegram bot started (${allowedChatIds?.length ?? 0} allowed chat IDs)\n`);
    } catch (err: unknown) {
      process.stderr.write(`Telegram bot failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  async start(port: number): Promise<void> {
    // Web UI mode binds to 0.0.0.0 — without a secret, the engine API would
    // be reachable unauthenticated from any container network neighbour.
    // Auto-generate one (persisted to ~/.lynox/http-secret) so the bearer
    // path always gates the API. API-only mode falls through to its
    // localhost bind without a secret as before.
    if (this.webUiHandler && !process.env['LYNOX_HTTP_SECRET']) {
      const { ensureHttpSecret } = await import('../core/engine-init.js');
      ensureHttpSecret();
    }
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

      // Resolve client IP (proxy-aware)
      let clientIp = req.socket.remoteAddress ?? 'unknown';
      if (trustProxy) {
        const forwarded = req.headers['x-forwarded-for'];
        if (typeof forwarded === 'string') {
          clientIp = forwarded.split(',')[0]?.trim() ?? clientIp;
        }
      }
      clientIp = clientIp.replace(/^::ffff:/, '');

      // IP allowlist check
      if (ALLOWED_IPS.length > 0) {
        if (!ALLOWED_IPS.includes(clientIp)) {
          errorResponse(res, 403, 'IP not allowed');
          return;
        }
      }

      try {
        await this._handleRequest(req, res, secret, clientIp);
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
      process.stderr.write(`LYNOX HTTP API listening on ${protocol}://${host}:${port} ${authStatus}\n`);
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
    // Session cookie is unavailable here because sameSite:strict blocks cross-site
    // navigations. CSRF protection is via the `state` parameter instead.
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
    //
    // Public routes carry their own auth (HMAC signature for webhooks) or expose
    // no sensitive data (status probes hit before login). Skipping the bearer
    // requirement for them is the only way Meta + the pre-auth UI can reach them.
    const isPublicWhatsAppPath =
      (method === 'GET'  && pathname === '/api/whatsapp/status')   ||
      (method === 'GET'  && pathname === '/api/webhooks/whatsapp') ||
      (method === 'POST' && pathname === '/api/webhooks/whatsapp');
    let authScope: AuthScope = 'admin'; // default for no-secret (localhost) mode
    if (secret && !isPublicWhatsAppPath) {
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
        // Bearer token auth (external clients, MCP, Telegram)
        const tokenBuf = Buffer.from(bearerToken);
        const secretBuf = Buffer.from(secret);

        if (adminSecret) {
          const adminBuf = Buffer.from(adminSecret);
          const isAdmin = adminBuf.length === tokenBuf.length && timingSafeEqual(tokenBuf, adminBuf);
          const isUser = secretBuf.length === tokenBuf.length && timingSafeEqual(tokenBuf, secretBuf);
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
          const secretBufCmp = Buffer.from(secret);
          if (tokenBuf.length !== secretBufCmp.length || !timingSafeEqual(tokenBuf, secretBufCmp)) {
            errorResponse(res, 401, 'Unauthorized');
            return;
          }
          authScope = 'admin';
        }
      } else if (this._verifySessionCookie(req, secret)) {
        // Session cookie auth (same-origin Web UI requests)
        authScope = adminSecret ? 'user' : 'admin';
      } else {
        errorResponse(res, 401, 'Unauthorized');
        return;
      }
      } // end migration-token else
    }

    // Admin scope check for destructive endpoints
    if (requiresAdmin(method, pathname) && authScope !== 'admin') {
      errorResponse(res, 403, 'Admin scope required');
      return;
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

    // Parse body for POST/PUT/PATCH
    let body: unknown = null;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
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

    // Custom + OpenAI providers have no public status page — rely solely on run history
    if (provider === 'custom' || provider === 'openai') {
      const label = provider === 'openai' ? 'OpenAI-compatible' : 'Custom';
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
      const hasKey = !!(process.env['ANTHROPIC_API_KEY'] ?? process.env['AWS_ACCESS_KEY_ID'] ?? process.env['LYNOX_MANAGED_MODE']);
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
   * whose model_id starts with "mistral". If there are no Mistral runs yet, we
   * report "Configured" with an unknown indicator.
   */
  private getMistralStatus(): ProviderStatus {
    const label = 'Mistral AI';
    const history = this.engine?.getRunHistory();
    if (!history) return { indicator: 'unknown', description: 'Configured (no run history)', provider: label };

    const recent = history.getRecentRuns(50);
    const mistralRun = recent.find(r => r.model_id?.toLowerCase().startsWith('mistral'));

    if (!mistralRun) {
      return { indicator: 'unknown', description: 'Configured (no runs yet)', provider: label };
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
    this.staticRoutes.set('POST /api/sessions', async (_req, res, _params, body) => {
      const opts = body && typeof body === 'object' ? body as Record<string, unknown> : {};
      const threadId = typeof opts['threadId'] === 'string' ? opts['threadId'] : undefined;
      const sessionId = threadId ?? randomUUID();
      const session = this.sessionStore.getOrCreate(sessionId, engine, {
        model: typeof opts['model'] === 'string' ? opts['model'] as 'opus' | 'sonnet' | 'haiku' : undefined,
        effort: typeof opts['effort'] === 'string' ? opts['effort'] as 'low' | 'medium' | 'high' : undefined,
        systemPromptSuffix: WEB_UI_SYSTEM_PROMPT_SUFFIX,
      });
      const tier = session.getModelTier();
      const threadStore = engine.getThreadStore();
      const thread = threadStore?.getThread(sessionId);
      jsonResponse(res, 201, {
        sessionId,
        model: tier,
        contextWindow: CONTEXT_WINDOW[MODEL_MAP[tier]] ?? 200_000,
        threadId: sessionId,
        resumed: !!threadId && !!thread,
      });
    });

    this.dynamicRoutes.push(parseDynamicRoute('DELETE', '/api/sessions/:id', async (_req, res, params) => {
      const session = this.sessionStore.get(params['id']!);
      if (!session) { errorResponse(res, 404, 'Session not found'); return; }
      session.abort();
      this.sessionStore.reset(params['id']!);
      jsonResponse(res, 200, { ok: true });
    }));

    // ── Runs (SSE) ──
    this.dynamicRoutes.push(parseDynamicRoute('POST', '/api/sessions/:id/run', async (req, res, params, body) => {
      const sessionId = params['id']!;
      const session = this.sessionStore.get(sessionId);
      if (!session) { errorResponse(res, 404, 'Session not found'); return; }

      // Stale-run takeover: a previous /run whose SSE stream has already
      // closed and which is parked on a pending prompt would otherwise lock
      // this session forever — the client polled /run on reconnect, got 409
      // every time, and the prompt-wait never resolved (Bug 3: "forever
      // thinking" after disconnect + reload + new message). When the slot
      // matches that pattern, hand control to the new request.
      const promptStoreEarly = this.engine?.getPromptStore();
      const existingSlot = this.runningSessions.get(sessionId);
      if (existingSlot && !existingSlot.streamAlive && promptStoreEarly?.getPending(sessionId)) {
        existingSlot.takeover();
        // Wait for the previous handler's `finally` to clear the slot
        // (≤5 s — well under the client's 3 s poll cadence × retry budget).
        const drainStart = Date.now();
        while (this.runningSessions.has(sessionId) && Date.now() - drainStart < 5000) {
          await new Promise<void>((r) => setTimeout(r, 25));
        }
      }

      // Guard: reject concurrent runs on the same session
      if (this.runningSessions.has(sessionId)) {
        errorResponse(res, 409, 'A run is already in progress for this session');
        return;
      }

      const b = body as Record<string, unknown> | null;
      const taskText = b && typeof b['task'] === 'string' ? b['task'] : '';
      if (!taskText) { errorResponse(res, 400, 'Missing task'); return; }

      // Client-capability negotiation. protocol=2 enables one-shot multi-question
      // ask_user via `prompt_tabs` SSE event + /reply-tabs endpoint. Older or
      // legacy clients omit it and fall back to sequential per-question prompts.
      const clientProtocol = typeof b?.['protocol'] === 'number' ? b['protocol'] : 1;
      const tabsCapable = clientProtocol >= 2;

      // Optional per-run overrides (e.g. onboarding uses low effort)
      const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'max']);
      const runEffort = typeof b?.['effort'] === 'string' && VALID_EFFORTS.has(b['effort'])
        ? b['effort'] as import('../types/index.js').EffortLevel
        : undefined;
      const runThinking = b?.['thinking'] === 'disabled'
        ? { type: 'disabled' as const }
        : undefined;
      const runOptions = runEffort || runThinking
        ? { ...(runEffort ? { effort: runEffort } : {}), ...(runThinking ? { thinking: runThinking } : {}) }
        : undefined;

      // Build multimodal content if files are attached
      const files = Array.isArray(b?.['files']) ? b['files'] as { name: string; type: string; data: string }[] : [];
      let task: string | unknown[];
      if (files.length > 0) {
        const content: unknown[] = [];
        const MAX_FILE_B64_LEN = 10 * 1024 * 1024; // ~7.5 MB decoded
        for (const file of files) {
          if (typeof file.data !== 'string' || file.data.length > MAX_FILE_B64_LEN) {
            errorResponse(res, 413, `File too large: ${typeof file.name === 'string' ? file.name : 'unknown'}`); return;
          }
          if (file.type.startsWith('image/')) {
            content.push({ type: 'image', source: { type: 'base64', media_type: file.type, data: file.data } });
          } else {
            // Non-image files: decode and include as text
            const text = Buffer.from(file.data, 'base64').toString('utf-8');
            content.push({ type: 'text', text: `[File: ${file.name}]\n${text}` });
          }
        }
        content.push({ type: 'text', text: taskText });
        task = content;
      } else {
        task = taskText;
      }

      // SSE headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      let aborted = false;

      // Wire streaming
      session.onStream = async (event: StreamEvent) => {
        if (aborted) return;
        const data = JSON.stringify(event);
        res.write(`event: ${event.type}\ndata: ${data}\n\n`);
      };

      // Sync streamHandler to toolContext so plan-tracker events reach the SSE stream
      const agent = session.getAgent();
      if (agent?.toolContext) {
        agent.toolContext.streamHandler = session.onStream;
      }

      // ── Prompt wiring (SQLite-backed, survives SSE disconnects) ──
      const promptStore = this.engine?.getPromptStore();
      // AbortController for the session — used to cancel prompt polling on disconnect
      const sessionAbortController = new AbortController();
      let hasActivePendingPrompt = false;

      // Wire promptUser — writes prompt to SQLite, event-driven wait.
      session.promptUser = async (question: string, options?: string[]): Promise<string> => {
        if (!promptStore) return 'n'; // fallback if store unavailable
        const promptId = promptStore.insertAskUser(sessionId, question, options);
        hasActivePendingPrompt = true;
        // Best-effort SSE notification (client may not be connected)
        if (!aborted && !res.writableEnded) {
          const data = JSON.stringify({ promptId, question, options, timeoutMs: PROMPT_TIMEOUT_MS });
          res.write(`event: prompt\ndata: ${data}\n\n`);
        }
        const outcome = await promptStore.waitForSettled(promptId, sessionAbortController.signal);
        hasActivePendingPrompt = false;
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
        session.promptTabs = async (questions): Promise<string[]> => {
          if (!promptStore) return [];
          const promptId = promptStore.insertAskUserTabs(sessionId, questions);
          hasActivePendingPrompt = true;
          if (!aborted && !res.writableEnded) {
            const data = JSON.stringify({ promptId, questions, timeoutMs: PROMPT_TIMEOUT_MS });
            res.write(`event: prompt_tabs\ndata: ${data}\n\n`);
          }
          const outcome = await promptStore.waitForSettled(promptId, sessionAbortController.signal);
          hasActivePendingPrompt = false;
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
      session.promptSecret = async (name: string, prompt: string, keyType?: string): Promise<boolean> => {
        if (!promptStore) return false;
        const promptId = promptStore.insertAskSecret(sessionId, name, prompt, keyType);
        hasActivePendingPrompt = true;
        if (!aborted && !res.writableEnded) {
          const data = JSON.stringify({ promptId, name, prompt, key_type: keyType });
          res.write(`event: secret_prompt\ndata: ${data}\n\n`);
        }
        const row = await promptStore.waitForAnswer(promptId, sessionAbortController.signal);
        hasActivePendingPrompt = false;
        return row?.answer_saved === 1;
      };

      // SSE keepalive — prevents proxies/browsers from dropping idle connections
      const keepaliveTimer = setInterval(() => {
        if (!aborted && !res.writableEnded) res.write(': keepalive\n\n');
      }, 15_000);

      // Abort on client disconnect or timeout (30 min max)
      const streamTimeout = setTimeout(() => {
        aborted = true;
        clearInterval(keepaliveTimer);
        sessionAbortController.abort();
        session.abort();
        if (!res.writableEnded) res.end();
      }, 30 * 60_000);

      req.on('close', () => {
        clearTimeout(streamTimeout);
        clearInterval(keepaliveTimer);
        aborted = true;
        // Mark this run's stream as dead so a fresh /run on the same session
        // can take it over if the agent is parked on a pending prompt.
        const slot = this.runningSessions.get(sessionId);
        if (slot) slot.streamAlive = false;
        // If a prompt is pending, do NOT abort the session —
        // the agent loop stays alive polling SQLite for an answer.
        // The user can reconnect and answer the prompt.
        if (!hasActivePendingPrompt) {
          sessionAbortController.abort();
          session.abort();
        }
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
      this.runningSessions.set(sessionId, { streamAlive: true, takeover });
      try {
        const result = await session.run(task, runOptions);
        if (!aborted) {
          // Notify client if changeset has pending file changes for review
          const csm = session.getChangesetManager();
          if (csm?.hasChanges()) {
            res.write(`event: changeset_ready\ndata: ${JSON.stringify({ fileCount: csm.size })}\n\n`);
          }
          res.write(`event: done\ndata: ${JSON.stringify({ result })}\n\n`);
          res.end();
        }
      } catch (err: unknown) {
        if (!aborted) {
          const msg = err instanceof Error ? err.message : String(err);
          res.write(`event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`);
          res.end();
        }
      } finally {
        clearInterval(keepaliveTimer);
        this.runningSessions.delete(sessionId);
      }
    }));

    // GET /sessions/:id/pending-prompt — client checks for resumable prompts on reconnect
    this.dynamicRoutes.push(parseDynamicRoute('GET', '/api/sessions/:id/pending-prompt', async (_req, res, params) => {
      const ps = this.engine?.getPromptStore();
      if (!ps) { jsonResponse(res, 200, { pending: false }); return; }
      const row = ps.getPending(params['id']!);
      if (!row) { jsonResponse(res, 200, { pending: false }); return; }
      // Never leak secret answers back to client
      const isTabs = row.prompt_type === 'ask_user' && !!row.questions_json;
      jsonResponse(res, 200, {
        pending: true,
        promptId: row.id,
        promptType: row.prompt_type,
        kind: isTabs ? 'tabs' : row.prompt_type === 'ask_secret' ? 'secret' : 'single',
        question: row.question,
        options: row.options_json ? JSON.parse(row.options_json) as string[] : undefined,
        questions: row.questions_json ? JSON.parse(row.questions_json) as unknown[] : undefined,
        partialAnswers: row.partial_answers_json ? JSON.parse(row.partial_answers_json) as unknown[] : undefined,
        secretName: row.secret_name,
        secretKeyType: row.secret_key_type,
        timeoutMs: PROMPT_TIMEOUT_MS,
        createdAt: row.created_at,
      });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('POST', '/api/sessions/:id/reply', async (_req, res, params, body) => {
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
    this.dynamicRoutes.push(parseDynamicRoute('POST', '/api/sessions/:id/reply-tabs', async (_req, res, params, body) => {
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
    this.dynamicRoutes.push(parseDynamicRoute('POST', '/api/sessions/:id/tab-progress', async (_req, res, params, body) => {
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

    this.dynamicRoutes.push(parseDynamicRoute('POST', '/api/sessions/:id/secret-saved', async (_req, res, params, body) => {
      const ps = this.engine?.getPromptStore();
      if (!ps) { errorResponse(res, 404, 'No pending secret prompt'); return; }

      const b = body as Record<string, unknown> | null;
      const promptId = b && typeof b['promptId'] === 'string' ? b['promptId'] : undefined;
      const saved = b && typeof b['saved'] === 'boolean' ? b['saved'] : false;

      let answered = false;
      if (promptId) {
        answered = ps.answerSecret(promptId, saved);
      }
      if (!answered) {
        const pending = ps.getPending(params['id']!);
        if (pending && pending.prompt_type === 'ask_secret') {
          answered = ps.answerSecret(pending.id, saved);
        }
      }
      if (!answered) { errorResponse(res, 404, 'No pending secret prompt'); return; }
      jsonResponse(res, 200, { ok: true });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('POST', '/api/sessions/:id/abort', async (_req, res, params) => {
      const session = this.sessionStore.get(params['id']!);
      if (!session) { errorResponse(res, 404, 'Session not found'); return; }
      session.abort();
      jsonResponse(res, 200, { ok: true });
    }));

    // ── Changeset review ──
    this.dynamicRoutes.push(parseDynamicRoute('GET', '/api/sessions/:id/changeset', async (_req, res, params) => {
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

    this.dynamicRoutes.push(parseDynamicRoute('POST', '/api/sessions/:id/changeset/review', async (_req, res, params, body) => {
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
    this.dynamicRoutes.push(parseDynamicRoute('POST', '/api/sessions/:id/compact', async (_req, res, params, body) => {
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

    // ── Threads ──
    this.staticRoutes.set('GET /api/threads', async (req, res) => {
      const threadStore = engine.getThreadStore();
      if (!requireService(res, threadStore, 'Thread store')) return;
      const url = new URL(req.url ?? '', 'http://localhost');
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), 500);
      const includeArchived = url.searchParams.get('includeArchived') === 'true';
      const threads = threadStore.listThreads({ limit, includeArchived });
      jsonResponse(res, 200, { threads });
    });

    this.dynamicRoutes.push(parseDynamicRoute('GET', '/api/threads/:id', async (_req, res, params) => {
      const threadStore = engine.getThreadStore();
      if (!requireService(res, threadStore, 'Thread store')) return;
      const thread = threadStore.getThread(params['id']!);
      if (!thread) { errorResponse(res, 404, 'Thread not found'); return; }
      jsonResponse(res, 200, { thread });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('PATCH', '/api/threads/:id', async (_req, res, params, body) => {
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

    this.dynamicRoutes.push(parseDynamicRoute('DELETE', '/api/threads/:id', async (_req, res, params) => {
      const threadStore = engine.getThreadStore();
      if (!requireService(res, threadStore, 'Thread store')) return;
      const thread = threadStore.getThread(params['id']!);
      if (!thread) { errorResponse(res, 404, 'Thread not found'); return; }
      // Also clean up in-memory session
      this.sessionStore.reset(params['id']!);
      threadStore.deleteThread(params['id']!);
      jsonResponse(res, 200, { ok: true });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('GET', '/api/threads/:id/messages', async (req, res, params) => {
      const threadStore = engine.getThreadStore();
      if (!requireService(res, threadStore, 'Thread store')) return;
      const thread = threadStore.getThread(params['id']!);
      if (!thread) { errorResponse(res, 404, 'Thread not found'); return; }
      const url = new URL(req.url ?? '', 'http://localhost');
      const fromSeq = Math.max(parseInt(url.searchParams.get('fromSeq') ?? '0', 10) || 0, 0);
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '10000', 10) || 10000, 1), 50000);
      const records = threadStore.getMessages(params['id']!, { fromSeq, limit });
      // Apply render projection: merge tool-result carriers into preceding
      // tool-use blocks, strip safety wrappers for display, flatten into the
      // UI-ready shape that mirrors the client's ChatMessage.
      const messages = projectMessages(records);
      jsonResponse(res, 200, { messages });
    }));

    // ── Memory ──
    const VALID_MEMORY_NS = new Set(['knowledge', 'methods', 'status', 'learnings']);
    type MemoryNs = 'knowledge' | 'methods' | 'status' | 'learnings';

    this.dynamicRoutes.push(parseDynamicRoute('GET', '/api/memory/:ns', async (_req, res, params) => {
      const memory = engine.getMemory();
      if (!requireService(res, memory, 'Memory')) return;
      if (!VALID_MEMORY_NS.has(params['ns']!)) { errorResponse(res, 400, 'Invalid memory namespace'); return; }
      const ns = params['ns'] as MemoryNs;
      const content = await memory.load(ns);
      jsonResponse(res, 200, { content });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('PUT', '/api/memory/:ns', async (_req, res, params, body) => {
      const memory = engine.getMemory();
      if (!requireService(res, memory, 'Memory')) return;
      if (!VALID_MEMORY_NS.has(params['ns']!)) { errorResponse(res, 400, 'Invalid memory namespace'); return; }
      const ns = params['ns'] as MemoryNs;
      const content = body && typeof body === 'object' && 'content' in body ? String((body as Record<string, unknown>)['content']) : '';
      await memory.save(ns, content);
      jsonResponse(res, 200, { ok: true });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('POST', '/api/memory/:ns/append', async (_req, res, params, body) => {
      const memory = engine.getMemory();
      if (!requireService(res, memory, 'Memory')) return;
      if (!VALID_MEMORY_NS.has(params['ns']!)) { errorResponse(res, 400, 'Invalid memory namespace'); return; }
      const ns = params['ns'] as MemoryNs;
      const text = body && typeof body === 'object' && 'text' in body ? String((body as Record<string, unknown>)['text']) : '';
      if (!text) { errorResponse(res, 400, 'Missing text'); return; }
      await memory.append(ns, text);
      jsonResponse(res, 200, { ok: true });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('DELETE', '/api/memory/:ns', async (req, res, params) => {
      const memory = engine.getMemory();
      if (!requireService(res, memory, 'Memory')) return;
      if (!VALID_MEMORY_NS.has(params['ns']!)) { errorResponse(res, 400, 'Invalid memory namespace'); return; }
      const ns = params['ns'] as MemoryNs;
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const pattern = url.searchParams.get('pattern') ?? '';
      const deleted = await memory.delete(ns, pattern);
      jsonResponse(res, 200, { deleted });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('PATCH', '/api/memory/:ns', async (_req, res, params, body) => {
      const memory = engine.getMemory();
      if (!requireService(res, memory, 'Memory')) return;
      if (!VALID_MEMORY_NS.has(params['ns']!)) { errorResponse(res, 400, 'Invalid memory namespace'); return; }
      const ns = params['ns'] as MemoryNs;
      const b = body as Record<string, unknown> | null;
      const oldText = b && typeof b['old'] === 'string' ? b['old'] : '';
      const newText = b && typeof b['new'] === 'string' ? b['new'] : '';
      const updated = await memory.update(ns, oldText, newText);
      jsonResponse(res, 200, { updated });
    }));

    // ── Secrets ──
    // Full name list — admin-scoped (enforced by requiresAdmin)
    this.staticRoutes.set('GET /api/secrets', async (_req, res) => {
      const store = engine.getSecretStore();
      if (!requireService(res, store, 'Secret store')) return;
      const names = store.listNames();
      jsonResponse(res, 200, { names });
    });

    // Category-level booleans — available to all authenticated users
    this.staticRoutes.set('GET /api/secrets/status', async (_req, res) => {
      const store = engine.getSecretStore();
      if (!requireService(res, store, 'Secret store')) return;
      const names = new Set(store.listNames());
      const userConfig = engine.getUserConfig();
      const provider = userConfig.provider ?? 'anthropic';
      // Provider-aware LLM configured check (BYOK)
      let llmConfigured: boolean;
      if (provider === 'vertex') {
        // Vertex needs GCP project + service account creds
        llmConfigured = !!(userConfig.gcp_project_id ?? process.env['GCP_PROJECT_ID'] ?? process.env['ANTHROPIC_VERTEX_PROJECT_ID']);
      } else if (provider === 'custom') {
        // Custom needs api_base_url configured
        llmConfigured = !!(userConfig.api_base_url ?? process.env['ANTHROPIC_BASE_URL']);
      } else if (provider === 'openai') {
        // OpenAI-compatible needs api_base_url + api_key + model id
        llmConfigured = !!(userConfig.api_base_url && userConfig.api_key && userConfig.openai_model_id);
      } else {
        // Anthropic direct — needs API key
        llmConfigured = names.has('ANTHROPIC_API_KEY')
          || !!process.env['ANTHROPIC_API_KEY']
          || !!(userConfig as Record<string, unknown>)['api_key'];
      }
      const searxngUrl = userConfig.searxng_url ?? process.env['SEARXNG_URL'];
      jsonResponse(res, 200, {
        provider,
        managed: process.env['LYNOX_MANAGED_MODE'] ?? null,
        configured: {
          api_key: llmConfigured,
          telegram: names.has('TELEGRAM_BOT_TOKEN'),
          search: names.has('TAVILY_API_KEY') || names.has('SEARCH_API_KEY') || !!searxngUrl,
          searxng: !!searxngUrl,
          google: names.has('GOOGLE_CLIENT_ID') || names.has('GOOGLE_CLIENT_SECRET'),
          bugsink: names.has('LYNOX_BUGSINK_DSN'),
        },
        count: names.size,
        searxng_url: searxngUrl ?? null,
      });
    });

    this.dynamicRoutes.push(parseDynamicRoute('PUT', '/api/secrets/:name', async (_req, res, params, body) => {
      const store = engine.getSecretStore();
      if (!requireService(res, store, 'Secret store')) return;
      const b = body as Record<string, unknown> | null;
      const value = b && typeof b['value'] === 'string' ? b['value'] : '';
      if (!value) { errorResponse(res, 400, 'Missing value'); return; }
      try {
        store.set(params['name']!, value);
        store.recordConsent(params['name']!);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to store secret';
        errorResponse(res, 503, msg);
        return;
      }
      // Hot-reload API key so new sessions use it immediately
      if (params['name'] === 'ANTHROPIC_API_KEY') {
        engine.setApiKey(value);
      }
      jsonResponse(res, 200, { ok: true });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('DELETE', '/api/secrets/:name', async (_req, res, params) => {
      const store = engine.getSecretStore();
      if (!requireService(res, store, 'Secret store')) return;
      const deleted = store.deleteSecret(params['name']!);
      jsonResponse(res, 200, { deleted });
    }));

    // SearXNG health check — validates a SearXNG URL is reachable
    this.staticRoutes.set('POST /api/searxng/check', async (_req, res, _params, body) => {
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

    // ── Config ──
    this.staticRoutes.set('GET /api/config', async (_req, res) => {
      const { readUserConfig } = await import('../core/config.js');
      const config = readUserConfig();
      const redacted: Record<string, unknown> = { ...config };
      for (const key of REDACTED_CONFIG_KEYS) {
        if (key in redacted && redacted[key]) {
          delete redacted[key];
          redacted[`${key}_configured`] = true;
        }
      }
      // Expose managed tier so the Web UI can adapt its settings UI ('starter' = BYOK, 'eu' = Managed Bedrock)
      if (process.env['LYNOX_MANAGED_MODE']) {
        redacted['managed'] = process.env['LYNOX_MANAGED_MODE'];
      }
      // Capability probe: what this instance *can* do, independent of tier.
      // Drives capability-based gating in the Web UI so working features stop
      // being hidden by tier checks (see prd/settings-compliance-overhaul.md).
      const secretStore = engine.getSecretStore();
      const secretNames = secretStore ? new Set(secretStore.listNames()) : new Set<string>();
      const mistralAvailable = secretNames.has('MISTRAL_API_KEY') || !!process.env['MISTRAL_API_KEY'];
      redacted['capabilities'] = {
        mistral_available: mistralAvailable,
      };
      jsonResponse(res, 200, redacted);
    });

    this.staticRoutes.set('PUT /api/config', async (_req, res, _params, body) => {
      const { readUserConfig, saveUserConfig, reloadConfig, loadConfig } = await import('../core/config.js');
      if (!body || typeof body !== 'object') { errorResponse(res, 400, 'Invalid config'); return; }
      const parsed = LynoxUserConfigSchema.safeParse(body);
      if (!parsed.success) {
        errorResponse(res, 400, `Invalid config: ${parsed.error.issues.map(i => i.message).join(', ')}`);
        return;
      }
      // Managed mode: block provider/credential changes (lynox provides the LLM).
      // Starter (BYOK) mode: provider changes are allowed (customer brings own key).
      // Compare incoming values against the *effective* env-merged config — the
      // Web UI re-sends every field on every save (including locked ones it
      // received from GET), so a no-op write of `provider` or `default_tier`
      // would otherwise look like an attempted change and block unrelated
      // updates (e.g. flipping experience level).
      if (process.env['LYNOX_MANAGED_MODE'] === 'managed' || process.env['LYNOX_MANAGED_MODE'] === 'managed_pro' || process.env['LYNOX_MANAGED_MODE'] === 'eu') {
        const LOCKED_FIELDS = ['provider', 'api_key', 'api_base_url', 'gcp_project_id', 'gcp_region', 'openai_model_id', 'default_tier'];
        const effective = loadConfig() as Record<string, unknown>;
        const update = parsed.data as Record<string, unknown>;
        const attempted = LOCKED_FIELDS.filter((f) => {
          if (!(f in update)) return false;
          // No-op write (same value as effective config) → allow.
          return JSON.stringify(update[f]) !== JSON.stringify(effective[f]);
        });
        if (attempted.length > 0) {
          errorResponse(res, 403, `Managed EU instance: cannot change ${attempted.join(', ')}`);
          return;
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
      saveUserConfig(merged);
      reloadConfig();
      await engine.reloadUserConfig();
      jsonResponse(res, 200, { ok: true });
    });

    // ── History ──
    this.staticRoutes.set('GET /api/history/runs', async (req, res) => {
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

    this.dynamicRoutes.push(parseDynamicRoute('GET', '/api/history/runs/:id', async (_req, res, params) => {
      const history = engine.getRunHistory();
      if (!requireService(res, history, 'History')) return;
      const run = history.getRun(params['id']!);
      if (!run) { errorResponse(res, 404, 'Run not found'); return; }
      jsonResponse(res, 200, run);
    }));

    this.dynamicRoutes.push(parseDynamicRoute('GET', '/api/history/runs/:id/tool-calls', async (_req, res, params) => {
      const history = engine.getRunHistory();
      if (!requireService(res, history, 'History')) return;
      const toolCalls = history.getRunToolCalls(params['id']!);
      jsonResponse(res, 200, { toolCalls });
    }));

    this.staticRoutes.set('GET /api/history/stats', async (_req, res) => {
      const history = engine.getRunHistory();
      if (!requireService(res, history, 'History')) return;
      const stats = history.getStats();
      jsonResponse(res, 200, stats);
    });

    this.staticRoutes.set('GET /api/history/cost/daily', async (req, res) => {
      const history = engine.getRunHistory();
      if (!requireService(res, history, 'History')) return;
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const days = Math.min(Math.max(parseInt(url.searchParams.get('days') ?? '30', 10) || 30, 1), 365);
      const data = history.getCostByDay(days);
      jsonResponse(res, 200, data);
    });

    // ── Usage Summary (Usage Dashboard Phase 1) ──
    // Aggregates the local RunHistory into the shape the Web UI's
    // Usage Dashboard renders. Managed tiers currently get the same
    // local-only view; the control-plane included-credit integration
    // is Phase 3. 30-second instance-scoped TTL cache so repeated tab
    // opens don't re-hammer SQLite for the same window.
    this.staticRoutes.set('GET /api/usage/summary', async (req, res) => {
      const history = engine.getRunHistory();
      if (!requireService(res, history, 'History')) return;
      const { readUserConfig } = await import('../core/config.js');
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const rawPeriod = url.searchParams.get('period') ?? 'current';
      const period = rawPeriod === 'prev' || rawPeriod === '7d' || rawPeriod === '30d' ? rawPeriod : 'current';

      const now = new Date();
      let startIso: string;
      let endIso: string;
      let source: 'calendar-month' | 'rolling';
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

      // Phase 3: for managed tiers, re-fetch the control-plane view FIRST so
      // we can align the local aggregation window to the Stripe billing
      // period (otherwise `used_cents` from the control plane and the sum of
      // `daily` from the local DB report different windows and the numbers
      // don't reconcile in the UI). On non-managed or when the CP is
      // unreachable we fall through with the calendar-month / rolling window
      // computed above.
      const config = readUserConfig();
      const tier = process.env['LYNOX_MANAGED_MODE'] ?? null;
      const isManagedTier = tier === 'managed' || tier === 'managed_pro' || tier === 'eu';

      interface CpSummary {
        managed: boolean;
        tier?: string;
        budget_cents?: number;
        used_cents?: number;
        balance_cents?: number;
        period?: { start_iso: string; end_iso: string; source: 'stripe-billing' } | null;
      }
      let cpSummary: CpSummary | null = null;
      if (isManagedTier && period === 'current') {
        const { fetchControlPlaneUsageSummary } = await import('../core/managed-usage-summary.js');
        cpSummary = await fetchControlPlaneUsageSummary();
        if (cpSummary?.managed && cpSummary.period) {
          // Use the Stripe period for the local aggregation so daily + by_model
          // cover the same window the control plane is reporting against.
          startIso = cpSummary.period.start_iso;
          endIso = cpSummary.period.end_iso;
          source = 'calendar-month'; // 'stripe-billing' isn't a summary.source; we reuse calendar-month semantics
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

      // Tier-appropriate budget + used resolution:
      //   - Managed w/ CP reachable → use CP's budget + used (authoritative)
      //   - Managed w/o CP          → fall through to 0 (UI renders "included
      //                                credit view coming in a later release")
      //   - Self-Host / Hosted      → config.max_monthly_cost_usd
      let budgetCents: number;
      let overriddenUsedCents: number | undefined;
      if (cpSummary?.managed) {
        budgetCents = cpSummary.budget_cents ?? 0;
        overriddenUsedCents = cpSummary.used_cents;
      } else if (isManagedTier) {
        budgetCents = 0;
      } else {
        budgetCents = typeof config.max_monthly_cost_usd === 'number'
          ? Math.round(config.max_monthly_cost_usd * 100)
          : 0;
      }

      jsonResponse(res, 200, {
        tier,
        ...summary,
        used_cents: overriddenUsedCents ?? summary.used_cents,
        budget_cents: budgetCents,
      });
    });

    // ── Pipelines ──
    this.staticRoutes.set('GET /api/pipelines', async (req, res) => {
      const history = engine.getRunHistory();
      if (!requireService(res, history, 'History')) return;
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '20', 10) || 20, 1), 500);
      const runs = history.getRecentPipelineRuns(limit);
      jsonResponse(res, 200, { runs });
    });

    this.staticRoutes.set('GET /api/pipelines/stats/steps', async (req, res) => {
      const history = engine.getRunHistory();
      if (!requireService(res, history, 'History')) return;
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const days = Math.min(Math.max(parseInt(url.searchParams.get('days') ?? '30', 10) || 30, 1), 365);
      const stats = history.getPipelineStepStats(days);
      jsonResponse(res, 200, { stats });
    });

    this.staticRoutes.set('GET /api/pipelines/stats/cost', async (req, res) => {
      const history = engine.getRunHistory();
      if (!requireService(res, history, 'History')) return;
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const days = Math.min(Math.max(parseInt(url.searchParams.get('days') ?? '30', 10) || 30, 1), 365);
      const stats = history.getPipelineCostStats(days);
      jsonResponse(res, 200, { stats });
    });

    this.dynamicRoutes.push(parseDynamicRoute('GET', '/api/pipelines/:id', async (_req, res, params) => {
      const history = engine.getRunHistory();
      if (!requireService(res, history, 'History')) return;
      const run = history.getPipelineRun(params['id']!);
      if (!run) { errorResponse(res, 404, 'Pipeline run not found'); return; }
      jsonResponse(res, 200, run);
    }));

    this.dynamicRoutes.push(parseDynamicRoute('GET', '/api/pipelines/:id/steps', async (_req, res, params) => {
      const history = engine.getRunHistory();
      if (!requireService(res, history, 'History')) return;
      const steps = history.getPipelineStepResults(params['id']!);
      jsonResponse(res, 200, { steps });
    }));

    // ── Tasks ──
    this.staticRoutes.set('GET /api/tasks', async (req, res) => {
      const taskManager = engine.getTaskManager();
      if (!requireService(res, taskManager, 'Task manager')) return;
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const status = url.searchParams.get('status') as 'open' | 'in_progress' | 'completed' | undefined;
      const tasks = taskManager.list(status ? { status } : undefined);
      jsonResponse(res, 200, { tasks });
    });

    this.staticRoutes.set('POST /api/tasks', async (_req, res, _params, body) => {
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
      if (!title) { errorResponse(res, 400, 'Missing required field: title'); return; }
      if (runAt && Number.isNaN(Date.parse(runAt))) {
        errorResponse(res, 400, 'Invalid runAt: must be ISO 8601 datetime'); return;
      }
      try {
        const baseParams = { title, description, assignee, dueDate };
        const task = scheduleCron
          ? taskManager.createScheduled({ ...baseParams, scheduleCron })
          : taskManager.create({ ...baseParams, ...(runAt ? { nextRunAt: runAt } : {}) });
        jsonResponse(res, 201, task);
      } catch (e) {
        errorResponse(res, 400, e instanceof Error ? e.message : 'Failed to create task');
      }
    });

    this.dynamicRoutes.push(parseDynamicRoute('PATCH', '/api/tasks/:id', async (_req, res, params, body) => {
      const taskManager = engine.getTaskManager();
      if (!requireService(res, taskManager, 'Task manager')) return;
      if (!body || typeof body !== 'object') { errorResponse(res, 400, 'Invalid update'); return; }
      const task = taskManager.update(params['id']!, body as Parameters<typeof taskManager.update>[1]);
      if (!task) { errorResponse(res, 404, 'Task not found'); return; }
      jsonResponse(res, 200, task);
    }));

    this.dynamicRoutes.push(parseDynamicRoute('DELETE', '/api/tasks/:id', async (_req, res, params) => {
      const runHistory = engine.getRunHistory();
      if (!requireService(res, runHistory, 'History')) return;
      const deleted = runHistory.deleteTask(params['id']!);
      if (!deleted) { errorResponse(res, 404, 'Task not found'); return; }
      jsonResponse(res, 200, { deleted: true });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('POST', '/api/tasks/:id/complete', async (_req, res, params) => {
      const taskManager = engine.getTaskManager();
      if (!requireService(res, taskManager, 'Task manager')) return;
      const task = taskManager.complete(params['id']!);
      if (!task) { errorResponse(res, 404, 'Task not found'); return; }
      jsonResponse(res, 200, task);
    }));

    // ── Artifacts ──
    this.staticRoutes.set('GET /api/artifacts', async (_req, res) => {
      const store = engine.getArtifactStore();
      if (!requireService(res, store, 'Artifact store')) return;
      jsonResponse(res, 200, { artifacts: store.list() });
    });

    this.staticRoutes.set('POST /api/artifacts', async (_req, res, _params, body) => {
      const store = engine.getArtifactStore();
      if (!requireService(res, store, 'Artifact store')) return;
      if (!body || typeof body !== 'object') { errorResponse(res, 400, 'Invalid artifact'); return; }
      const b = body as Record<string, unknown>;
      if (typeof b['title'] !== 'string' || typeof b['content'] !== 'string') {
        errorResponse(res, 400, 'title and content are required'); return;
      }
      const VALID_TYPES = ['html', 'mermaid', 'svg'] as const;
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
        ...(rawType ? { type: rawType as 'html' | 'mermaid' | 'svg' } : {}),
        ...(typeof b['description'] === 'string' ? { description: b['description'] } : {}),
        ...(typeof b['id'] === 'string' ? { id: b['id'] } : {}),
      });
      jsonResponse(res, 201, artifact);
    });

    this.dynamicRoutes.push(parseDynamicRoute('GET', '/api/artifacts/:id', async (_req, res, params) => {
      const store = engine.getArtifactStore();
      if (!requireService(res, store, 'Artifact store')) return;
      const artifact = store.get(params['id']!);
      if (!artifact) { errorResponse(res, 404, 'Artifact not found'); return; }
      jsonResponse(res, 200, artifact);
    }));

    this.dynamicRoutes.push(parseDynamicRoute('DELETE', '/api/artifacts/:id', async (_req, res, params) => {
      const store = engine.getArtifactStore();
      if (!requireService(res, store, 'Artifact store')) return;
      const deleted = store.delete(params['id']!);
      if (!deleted) { errorResponse(res, 404, 'Artifact not found'); return; }
      jsonResponse(res, 200, { deleted: true });
    }));

    // ── Transcription (provider info for UI hint) ──
    this.staticRoutes.set('GET /api/transcribe/info', async (_req, res) => {
      const { getActiveTranscribeProvider, hasTranscribeProvider } = await import('../core/transcribe.js');
      const provider = getActiveTranscribeProvider();
      jsonResponse(res, 200, {
        available: hasTranscribeProvider(),
        provider: provider?.name ?? null,
      });
    });

    // ── Voice info (combined STT + TTS capabilities for the Web UI) ──
    // Drives the privacy hint + auto-speak toggle visibility + the
    // Settings → Compliance voice pickers. Prefer this over the legacy
    // /api/transcribe/info for new callers — the old path stays for
    // back-compat with existing clients.
    this.staticRoutes.set('GET /api/voice/info', async (_req, res) => {
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
    this.staticRoutes.set('POST /api/speak', async (_req, res, _params, body) => {
      const [{ hasSpeakProvider, speakStream }, { recordSessionCost }] = await Promise.all([
        import('../core/speak.js'),
        import('../core/session-budget.js'),
      ]);
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
      if (!text.trim()) { errorResponse(res, 400, 'Missing text'); return; }
      // Hard ceiling on one request to bound Mistral cost + latency. Phase 0
      // tested up to 2 687 chars; 10 k gives headroom for long replies without
      // a single call burning through a tenant's budget.
      if (text.length > SPEAK_MAX_TEXT_CHARS) {
        errorResponse(res, 413, `Text too long — max ${String(SPEAK_MAX_TEXT_CHARS)} characters (got ${String(text.length)})`);
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
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
      });

      if (meta) {
        // Bill the post-prep character count into the session-budget counter so
        // TTS usage shares a ceiling with LLM runs + spawns. Mistral doesn't
        // surface usage headers — $0.016/1 000 chars is the documented rate,
        // applied after text-prep has stripped Markdown noise.
        const costUsd = meta.characters * SPEAK_USD_PER_CHAR;
        recordSessionCost(costUsd);
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
    this.staticRoutes.set('POST /api/transcribe', async (_req, res, _params, body) => {
      const {
        HAS_WHISPER,
        transcribeWithStream,
        extractSessionContext,
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

      // Session context pulls CRM contacts, API profile names, thread titles
      // and KG entity labels so the session glossary can correct proper-noun
      // mishearings. Sessionless calls still get the static core glossary.
      const sessionContext = extractSessionContext(engine, sessionId);

      // SSE streaming — forward provider segments (whisper) or a single final
      // segment (Voxtral, no native streaming).
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
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

    // ── WhatsApp Business Cloud API (Coexistence Mode, BYOK Phase 0) ──

    // Meta webhook verification GET:
    //   GET /api/webhooks/whatsapp?hub.mode=subscribe&hub.challenge=X&hub.verify_token=Y
    // Respond with hub.challenge as plain text if verify_token matches what the
    // customer configured in their Meta App webhook setup.
    // Returns 404 when the `whatsapp-inbox` feature flag is off (waCtx is null).
    this.staticRoutes.set('GET /api/webhooks/whatsapp', async (req, res) => {
      const waCtx = this.engine?.getWhatsAppContext();
      if (!waCtx) { errorResponse(res, 404, 'Not found'); return; }
      if (!waCtx.isConfigured()) {
        errorResponse(res, 503, 'WhatsApp not configured');
        return;
      }
      const url = new URL(req.url ?? '', 'http://localhost');
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');
      const expected = waCtx.getWebhookVerifyToken();
      if (mode !== 'subscribe' || !token || !challenge || token !== expected) {
        errorResponse(res, 403, 'Verify token mismatch');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(challenge);
    });

    // Meta webhook event POST — HMAC-verified raw body, dispatched to context.
    this.staticRoutes.set('POST /api/webhooks/whatsapp', async (req, res, _params, body) => {
      const waCtx = this.engine?.getWhatsAppContext();
      if (!waCtx) { errorResponse(res, 404, 'Not found'); return; }
      if (!waCtx.isConfigured()) {
        errorResponse(res, 503, 'WhatsApp not configured');
        return;
      }
      const appSecret = waCtx.getAppSecret();
      if (!appSecret) { errorResponse(res, 503, 'WhatsApp app secret missing'); return; }

      const raw = (req as IncomingMessage & { rawBody?: string }).rawBody ?? '';
      const signature = (req.headers['x-hub-signature-256'] as string | undefined) ?? null;
      const { verifySignature } = await import('../integrations/whatsapp/signature.js');
      if (!verifySignature(raw, signature, appSecret)) {
        errorResponse(res, 401, 'Invalid signature');
        return;
      }

      try {
        const { dispatchWebhook } = await import('../integrations/whatsapp/webhook.js');
        const result = dispatchWebhook(waCtx, body);
        jsonResponse(res, 200, { ok: true, ...result });
      } catch (err) {
        // Return 200 anyway — Meta retries on non-2xx and we don't want a
        // poison payload to spam us. Internal error is logged server-side.
        console.error('[whatsapp] webhook dispatch failed:', err);
        jsonResponse(res, 200, { ok: false });
      }
    });

    // Settings API — status snapshot for the UI.
    // `featureEnabled` = the `whatsapp-inbox` feature flag is on in this instance.
    // `available` = the backend context initialized (flag on AND vault present).
    // When featureEnabled is false, the UI hides all WhatsApp surfaces entirely.
    this.staticRoutes.set('GET /api/whatsapp/status', async (_req, res) => {
      const { isFeatureEnabled } = await import('../core/features.js');
      const featureEnabled = isFeatureEnabled('whatsapp-inbox');
      const waCtx = this.engine?.getWhatsAppContext();
      if (!waCtx) { jsonResponse(res, 200, { featureEnabled, available: false, configured: false }); return; }
      jsonResponse(res, 200, {
        featureEnabled,
        available: true,
        configured: waCtx.isConfigured(),
      });
    });

    // Save BYOK credentials (admin-scope in requiresAdmin() — see below).
    this.staticRoutes.set('POST /api/whatsapp/credentials', async (_req, res, _params, body) => {
      const waCtx = this.engine?.getWhatsAppContext();
      if (!waCtx) { errorResponse(res, 404, 'Not found'); return; }
      const b = body as Record<string, unknown> | null;
      if (!b) { errorResponse(res, 400, 'Body required'); return; }
      const accessToken = typeof b['accessToken'] === 'string' ? b['accessToken'].trim() : '';
      const wabaId = typeof b['wabaId'] === 'string' ? b['wabaId'].trim() : '';
      const phoneNumberId = typeof b['phoneNumberId'] === 'string' ? b['phoneNumberId'].trim() : '';
      const appSecret = typeof b['appSecret'] === 'string' ? b['appSecret'].trim() : '';
      const webhookVerifyToken = typeof b['webhookVerifyToken'] === 'string' ? b['webhookVerifyToken'].trim() : '';
      if (!accessToken || !wabaId || !phoneNumberId || !appSecret || !webhookVerifyToken) {
        errorResponse(res, 400, 'All fields required: accessToken, wabaId, phoneNumberId, appSecret, webhookVerifyToken');
        return;
      }
      try {
        waCtx.saveCredentials({ accessToken, wabaId, phoneNumberId, appSecret, webhookVerifyToken });
      } catch (err) {
        errorResponse(res, 500, err instanceof Error ? err.message : 'Failed to save credentials');
        return;
      }
      // Probe Meta for a sanity check (not fatal — network hiccups shouldn't block save).
      const client = waCtx.getClient();
      let verified: { displayPhoneNumber: string; verifiedName: string | null } | null = null;
      let probeError: string | null = null;
      if (client) {
        try {
          verified = await client.verifyCredentials();
        } catch (err) {
          probeError = err instanceof Error ? err.message : String(err);
        }
      }
      jsonResponse(res, 200, { saved: true, verified, probeError });
    });

    this.staticRoutes.set('DELETE /api/whatsapp/credentials', async (_req, res) => {
      const waCtx = this.engine?.getWhatsAppContext();
      if (!waCtx) { errorResponse(res, 404, 'Not found'); return; }
      waCtx.clearCredentials();
      jsonResponse(res, 200, { cleared: true });
    });

    // Inbox API — for the Web UI inbox view.
    this.staticRoutes.set('GET /api/whatsapp/threads', async (req, res) => {
      const waCtx = this.engine?.getWhatsAppContext();
      if (!waCtx) { errorResponse(res, 404, 'Not found'); return; }
      const url = new URL(req.url ?? '', 'http://localhost');
      const limitParam = parseInt(url.searchParams.get('limit') ?? '50', 10);
      const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(limitParam, 200)) : 50;
      const threads = waCtx.getStateDb().listThreadSummaries(limit);
      jsonResponse(res, 200, { threads });
    });

    this.dynamicRoutes.push({
      method: 'GET',
      pattern: /^\/api\/whatsapp\/threads\/([^/]+)$/,
      paramNames: ['threadId'],
      handler: async (_req, res, params) => {
        const waCtx = this.engine?.getWhatsAppContext();
        if (!waCtx) { errorResponse(res, 404, 'Not found'); return; }
        const threadId = params['threadId'] ?? '';
        const messages = waCtx.getStateDb().getMessagesForThread(threadId, 200);
        const phone = threadId.replace(/^whatsapp-/, '');
        const contact = waCtx.getStateDb().getContact(phone);
        jsonResponse(res, 200, { threadId, contact, messages });
      },
    });

    this.dynamicRoutes.push({
      method: 'POST',
      pattern: /^\/api\/whatsapp\/threads\/([^/]+)\/read$/,
      paramNames: ['threadId'],
      handler: async (_req, res, params) => {
        const waCtx = this.engine?.getWhatsAppContext();
        if (!waCtx) { errorResponse(res, 404, 'Not found'); return; }
        if (!waCtx.isConfigured()) { errorResponse(res, 503, 'WhatsApp not configured'); return; }
        const threadId = params['threadId'] ?? '';
        waCtx.getStateDb().markThreadRead(threadId);
        jsonResponse(res, 200, { ok: true });
      },
    });

    // Send a message — UI calls this after user approves a draft. No engine-
    // level approval gate here because the UI IS the approval UI; the engine
    // tool handler enforces it for LLM-initiated sends.
    // Optional `replyTo` carries the wa_id of the message being quoted — Meta
    // renders it as a tappable preview above the reply for the recipient.
    this.staticRoutes.set('POST /api/whatsapp/send', async (_req, res, _params, body) => {
      const waCtx = this.engine?.getWhatsAppContext();
      if (!waCtx) { errorResponse(res, 404, 'Not found'); return; }
      if (!waCtx.isConfigured()) { errorResponse(res, 503, 'WhatsApp not configured'); return; }
      const b = body as Record<string, unknown> | null;
      const to = b && typeof b['to'] === 'string' ? b['to'].replace(/[^0-9]/g, '') : '';
      const bodyText = b && typeof b['body'] === 'string' ? b['body'].trim() : '';
      const replyTo = b && typeof b['replyTo'] === 'string' ? b['replyTo'].trim() : '';
      if (!to || !bodyText) { errorResponse(res, 400, 'Fields "to" and "body" required'); return; }
      const client = waCtx.getClient();
      if (!client) { errorResponse(res, 503, 'WhatsApp client not initialized'); return; }
      try {
        const { threadIdForPhone } = await import('../integrations/whatsapp/webhook-parser.js');
        const result = await client.sendText(to, bodyText, replyTo || undefined);
        waCtx.getStateDb().upsertMessage({
          id: result.messageId,
          threadId: threadIdForPhone(to),
          phoneE164: to,
          direction: 'outbound',
          kind: 'text',
          text: bodyText,
          mediaId: null,
          transcript: null,
          mimeType: null,
          timestamp: Math.floor(Date.now() / 1000),
          isEcho: false,
          rawJson: JSON.stringify({ source: 'lynox-ui', messageId: result.messageId }),
        });
        jsonResponse(res, 200, { messageId: result.messageId });
      } catch (err) {
        errorResponse(res, 502, err instanceof Error ? err.message : 'Send failed');
      }
    });

    // Media passthrough for voice-note playback in the UI.
    // Meta media URLs expire after ~5 min; this endpoint re-resolves the
    // current URL via the access token and streams the audio bytes. Only the
    // message must exist locally AND have a media-id — the message ID is
    // guessed-resistant (Meta's wa_id is a long opaque string).
    this.dynamicRoutes.push({
      method: 'GET',
      pattern: /^\/api\/whatsapp\/media\/([^/]+)$/,
      paramNames: ['messageId'],
      handler: async (_req, res, params) => {
        const waCtx = this.engine?.getWhatsAppContext();
        if (!waCtx) { errorResponse(res, 404, 'Not found'); return; }
        if (!waCtx.isConfigured()) { errorResponse(res, 503, 'WhatsApp not configured'); return; }
        const messageId = params['messageId'] ?? '';
        const msg = waCtx.getStateDb().getMessageById(messageId);
        if (!msg || !msg.mediaId) { errorResponse(res, 404, 'Media not found'); return; }
        const client = waCtx.getClient();
        if (!client) { errorResponse(res, 503, 'WhatsApp client not initialized'); return; }
        try {
          const { buffer, mimeType } = await client.fetchMedia(msg.mediaId);
          res.writeHead(200, {
            'Content-Type': mimeType,
            'Content-Length': buffer.byteLength,
            // Media-id URLs are short-lived; don't cache client-side past the session.
            'Cache-Control': 'private, max-age=300',
          });
          res.end(buffer);
        } catch (err) {
          errorResponse(res, 502, err instanceof Error ? err.message : 'Media fetch failed');
        }
      },
    });

    // ── Telegram Setup (chat ID auto-detection via Telegram Bot API) ──

    // In-memory state for the setup wizard — only one setup at a time
    let tgSetup: {
      token: string;
      botName: string;
      botUsername: string;
      updateOffset: number;
      chatId: number | null;
      firstName: string | null;
      startedAt: number;
    } | null = null;

    const TG_SETUP_TIMEOUT_MS = 120_000; // 2 min

    this.staticRoutes.set('POST /api/telegram/setup', async (_req, res, _params, body) => {
      const b = body as Record<string, unknown> | null;
      const token = b && typeof b['token'] === 'string' ? b['token'].trim() : '';
      if (!token) { errorResponse(res, 400, 'token required'); return; }

      // Validate token via getMe
      let botName = '';
      let botUsername = '';
      try {
        const meRes = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!meRes.ok) throw new Error('Invalid bot token');
        const me = (await meRes.json()) as { ok: boolean; result: { first_name: string; username: string } };
        if (!me.ok) throw new Error('Invalid bot token');
        botName = me.result.first_name;
        botUsername = me.result.username;
      } catch {
        errorResponse(res, 400, 'Invalid bot token');
        return;
      }

      // Flush old updates — get last update_id so we only receive NEW messages
      let updateOffset = 0;
      try {
        const flushRes = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=-1&limit=1`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (flushRes.ok) {
          const flushData = (await flushRes.json()) as { result: Array<{ update_id: number }> };
          if (flushData.result.length > 0) {
            updateOffset = flushData.result[flushData.result.length - 1]!.update_id + 1;
          }
        }
      } catch { /* ignore flush errors */ }

      tgSetup = { token, botName, botUsername, updateOffset, chatId: null, firstName: null, startedAt: Date.now() };
      jsonResponse(res, 200, { botName, botUsername });
    });

    this.staticRoutes.set('GET /api/telegram/setup', async (_req, res) => {
      if (!tgSetup) { jsonResponse(res, 200, { status: 'idle' }); return; }

      // Timeout check
      if (Date.now() - tgSetup.startedAt > TG_SETUP_TIMEOUT_MS) {
        tgSetup = null;
        jsonResponse(res, 200, { status: 'timeout' });
        return;
      }

      // Already detected — return result and clear sensitive token from memory
      if (tgSetup.chatId !== null) {
        const { chatId, firstName } = tgSetup;
        tgSetup = null;
        jsonResponse(res, 200, { status: 'detected', chatId, firstName });
        return;
      }

      // Poll for new messages (short poll, 2s server-side timeout)
      try {
        const url = `https://api.telegram.org/bot${tgSetup.token}/getUpdates`
          + `?offset=${tgSetup.updateOffset}&timeout=2&allowed_updates=${encodeURIComponent('["message"]')}`;
        const pollRes = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        if (!pollRes.ok) throw new Error('poll failed');

        const pollData = (await pollRes.json()) as {
          result: Array<{
            update_id: number;
            message?: { chat: { id: number }; from?: { first_name?: string } };
          }>;
        };

        for (const update of pollData.result) {
          // Advance offset regardless
          tgSetup.updateOffset = update.update_id + 1;

          if (update.message) {
            tgSetup.chatId = update.message.chat.id;
            tgSetup.firstName = update.message.from?.first_name ?? '';

            // Send confirmation to the user in Telegram
            try {
              await fetch(`https://api.telegram.org/bot${tgSetup.token}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  chat_id: tgSetup.chatId,
                  text: '✓ Verbunden! Setup wird im Browser fortgesetzt.',
                }),
                signal: AbortSignal.timeout(5_000),
              });
            } catch { /* best effort */ }

            jsonResponse(res, 200, { status: 'detected', chatId: tgSetup.chatId, firstName: tgSetup.firstName });
            return;
          }
        }
      } catch { /* poll error — return waiting */ }

      jsonResponse(res, 200, { status: 'waiting' });
    });

    this.staticRoutes.set('DELETE /api/telegram/setup', async (_req, res) => {
      tgSetup = null;
      jsonResponse(res, 200, { ok: true });
    });

    // ── Push Notifications ──

    this.staticRoutes.set('GET /api/push/vapid-key', async (_req, res) => {
      if (!this.pushChannel) {
        errorResponse(res, 503, 'Push notifications not available');
        return;
      }
      jsonResponse(res, 200, { publicKey: this.pushChannel.getPublicKey() });
    });

    this.staticRoutes.set('POST /api/push/subscribe', async (_req, res, _params, body) => {
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

    this.staticRoutes.set('POST /api/push/unsubscribe', async (_req, res, _params, body) => {
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

    this.staticRoutes.set('POST /api/push/test', async (_req, res) => {
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
    this.staticRoutes.set('GET /api/google/status', async (_req, res) => {
      const google = engine.getGoogleAuth();
      if (!google) { jsonResponse(res, 200, { available: false }); return; }
      jsonResponse(res, 200, {
        available: true,
        authenticated: google.isAuthenticated(),
        ...google.getAccountInfo(),
      });
    });

    this.staticRoutes.set('POST /api/google/auth', async (_req, res, _params, body) => {
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
          // Store state for CSRF validation
          this._googleOAuthState = state;
          this._googleRedirectUri = redirectUri;
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
    this.staticRoutes.set('GET /api/google/callback', async (req, res) => {
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
      // which the engine API CSP `default-src 'none'` blocks; not a 302, which would
      // continue the cross-site redirect chain Google → callback → settings where
      // SameSite=Strict session cookies wouldn't be sent). Meta-refresh from this
      // same-origin page navigates with cookies intact.
      const sendSuccessRedirect = (): void => {
        const target = `${process.env['ORIGIN'] ?? ''}/app/settings/integrations`;
        const escaped = target.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${escaped}"><title>Connected</title></head><body><p>Google connected. Returning to settings…</p><p><a href="${escaped}">Click here if not redirected.</a></p></body></html>`);
      };

      if (!code || !state || state !== this._googleOAuthState) {
        // Idempotency: if the user reloads the callback URL after a successful
        // exchange, the state slot is already cleared but the engine is already
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
        await google.exchangeRedirectCode(code, this._googleRedirectUri ?? '');
        this._googleOAuthState = undefined;
        this._googleRedirectUri = undefined;
        sendSuccessRedirect();
      } catch (err: unknown) {
        const msg = (err instanceof Error ? err.message : String(err))
          .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h1>Error</h1><p>${msg}</p></body></html>`);
      }
    });

    this.staticRoutes.set('POST /api/google/revoke', async (_req, res) => {
      const google = engine.getGoogleAuth();
      if (!requireService(res, google, 'Google auth')) return;
      await google.revoke();
      jsonResponse(res, 200, { ok: true });
    });

    // Reload Google integration after credentials change
    this.staticRoutes.set('POST /api/google/reload', async (_req, res) => {
      const ok = await engine.reloadGoogle();
      jsonResponse(res, 200, { ok });
    });

    // Get Google OAuth start URL (managed instances — redirects via control plane)
    this.staticRoutes.set('GET /api/google/oauth-url', async (_req, res) => {
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
    this.staticRoutes.set('POST /api/google/claim-managed', async (_req, res, _params, body) => {
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

    this.staticRoutes.set('GET /api/kg/stats', async (_req, res) => {
      const kg = engine.getKnowledgeLayer();
      if (!kg) { jsonResponse(res, 200, { entityCount: 0, relationCount: 0, memoryCount: 0, communityCount: 0 }); return; }
      const stats = await kg.stats();
      jsonResponse(res, 200, stats);
    });

    // Admin: purge legacy mis-extracted entities (stopwords + pricing fragments).
    // Pre-v2 extractor wrote rows like "in" (person), "tools" (location),
    // "39/mo" (project). v2 prevents new ones; this endpoint cleans the past.
    // ?dryRun=true previews without deleting.
    this.staticRoutes.set('POST /api/kg/cleanup', async (req, res) => {
      const kg = engine.getKnowledgeLayer();
      if (!requireService(res, kg, 'Knowledge graph')) return;
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const dryRun = url.searchParams.get('dryRun') === 'true';
      const { cleanupBadEntities } = await import('../core/kg-cleanup.js');
      const result = cleanupBadEntities(kg.getDb(), { dryRun });
      jsonResponse(res, 200, { dryRun, ...result });
    });

    // ── Mail (provider-agnostic IMAP/SMTP + app-password) ──

    this.staticRoutes.set('GET /api/mail/presets', async (_req, res) => {
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
    this.staticRoutes.set('POST /api/mail/autodiscover', async (_req, res, _params, body) => {
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

    this.staticRoutes.set('GET /api/mail/accounts', async (_req, res) => {
      const ctx = engine.getMailContext();
      if (!ctx) { jsonResponse(res, 200, { accounts: [] }); return; }
      jsonResponse(res, 200, { accounts: ctx.listAccounts() });
    });

    this.staticRoutes.set('POST /api/mail/accounts', async (_req, res, _params, body) => {
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

    this.staticRoutes.set('POST /api/mail/accounts/test', async (req, res, _params, body) => {
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

    this.dynamicRoutes.push(parseDynamicRoute('DELETE', '/api/mail/accounts/:id', async (_req, res, params) => {
      const ctx = engine.getMailContext();
      if (!requireService(res, ctx, 'Mail integration')) return;
      const removed = await ctx!.removeAccount(params['id']!);
      if (!removed) { errorResponse(res, 404, `Account "${params['id']}" not found`); return; }
      jsonResponse(res, 200, { ok: true });
    }));

    // Set the default mailbox. Persists `is_default=1` on the target row and
    // updates the in-memory registry so subsequent tool calls fall back to
    // this account when none is explicitly named.
    this.dynamicRoutes.push(parseDynamicRoute('POST', '/api/mail/accounts/:id/default', async (_req, res, params) => {
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

    this.dynamicRoutes.push(parseDynamicRoute('GET', '/api/kg/entities', async (req, res) => {
      const kg = engine.getKnowledgeLayer();
      if (!kg) { jsonResponse(res, 200, { entities: [] }); return; }
      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
      const typeFilter = url.searchParams.get('type') ?? '';
      const query = url.searchParams.get('q') ?? '';
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), 500);
      const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0);
      try {
        if (query) {
          const result = await kg.retrieve(query, [{ type: 'global', id: 'global' }], { topK: limit });
          const entities = result.entities ?? [];
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

    this.dynamicRoutes.push(parseDynamicRoute('GET', '/api/kg/entities/:id', async (_req, res, params) => {
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

    // ── Thread Insights + Metrics ──────────────────────────────────

    this.staticRoutes.set('GET /api/thread-insights', async (req, res) => {
      const rh = engine.getRunHistory();
      if (!rh) { jsonResponse(res, 200, { threadInsights: [] }); return; }
      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '20', 10) || 20, 1), 500);
      const threadInsights = rh.getThreadAggregates(limit);
      jsonResponse(res, 200, { threadInsights });
    });

    this.staticRoutes.set('GET /api/patterns', async (_req, res) => {
      const kg = engine.getKnowledgeLayer();
      if (!kg) { jsonResponse(res, 200, { patterns: [] }); return; }
      const patterns = kg.getPatterns();
      jsonResponse(res, 200, { patterns });
    });

    this.staticRoutes.set('GET /api/metrics', async (req, res) => {
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

    this.staticRoutes.set('GET /api/crm/contacts', async (req, res) => {
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

    this.staticRoutes.set('GET /api/crm/deals', async (req, res) => {
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

    this.staticRoutes.set('GET /api/crm/stats', async (_req, res) => {
      const crm = engine.getCRM();
      if (!crm) { jsonResponse(res, 200, { contacts: 0, pipeline: [] }); return; }
      const stats = crm.getContactStats();
      const pipeline = crm.getPipelineSummary();
      jsonResponse(res, 200, { contacts: stats, pipeline });
    });

    this.dynamicRoutes.push(parseDynamicRoute('GET', '/api/crm/contacts/:name/interactions', async (_req, res, params) => {
      const crm = engine.getCRM();
      if (!crm) { jsonResponse(res, 200, { interactions: [] }); return; }
      const interactions = crm.getInteractions(decodeURIComponent(params['name']!), 50);
      jsonResponse(res, 200, { interactions });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('GET', '/api/crm/contacts/:name/deals', async (_req, res, params) => {
      const crm = engine.getCRM();
      if (!crm) { jsonResponse(res, 200, { deals: [] }); return; }
      const deals = crm.getDealsForContact(decodeURIComponent(params['name']!), 50);
      jsonResponse(res, 200, { deals });
    }));

    // ── Backups ──────────────────────────────────────────────────

    this.staticRoutes.set('GET /api/backups', async (_req, res) => {
      const bm = engine.getBackupManager();
      if (!bm) { jsonResponse(res, 200, { backups: [] }); return; }
      const backups = bm.listBackups();
      jsonResponse(res, 200, { backups });
    });

    this.staticRoutes.set('POST /api/backups', async (_req, res) => {
      const bm = engine.getBackupManager();
      if (!requireService(res, bm, 'Backup manager')) return;
      try {
        const result = await bm.createBackup();
        jsonResponse(res, 200, result);
      } catch (err: unknown) {
        errorResponse(res, 500, err instanceof Error ? err.message : 'Backup failed');
      }
    });

    this.dynamicRoutes.push(parseDynamicRoute('POST', '/api/backups/:id/restore', async (_req, res, params) => {
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

    this.staticRoutes.set('GET /api/api-profiles', async (_req, res) => {
      const store = engine.getApiStore();
      if (!store) { jsonResponse(res, 200, { profiles: [] }); return; }
      const profiles = store.getAll();
      jsonResponse(res, 200, { profiles });
    });

    this.dynamicRoutes.push(parseDynamicRoute('GET', '/api/api-profiles/:id', async (_req, res, params) => {
      const store = engine.getApiStore();
      if (!requireService(res, store, 'API store')) return;
      const profile = store.get(params['id']!);
      if (!profile) { errorResponse(res, 404, 'Profile not found'); return; }
      jsonResponse(res, 200, { profile });
    }));

    // ── DataStore ────────────────────────────────────────────────

    this.staticRoutes.set('GET /api/datastore/collections', async (_req, res) => {
      const ds = engine.getDataStore();
      if (!ds) { jsonResponse(res, 200, { collections: [] }); return; }
      const collections = ds.listCollections();
      jsonResponse(res, 200, { collections });
    });

    this.dynamicRoutes.push(parseDynamicRoute('GET', '/api/datastore/:collection', async (req, res, params) => {
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

    // ── GDPR Data Export & Erasure ─────────────────────────────────

    // GET /api/export — GDPR Art. 15 (Right of Access) + Art. 20 (Data Portability)
    this.staticRoutes.set('GET /api/export', async (_req, res) => {
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
          const entities = await kg.listEntities({ limit: 200 });
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
        const redacted: Record<string, unknown> = { ...config };
        for (const key of REDACTED_CONFIG_KEYS) {
          if (key in redacted && redacted[key]) {
            delete redacted[key];
            redacted[`${key}_configured`] = true;
          }
        }
        exportData['config'] = redacted;
      } catch {
        exportData['config'] = {};
      }

      jsonResponse(res, 200, exportData);
    });

    // DELETE /api/data — GDPR Art. 17 (Right to Erasure)
    this.staticRoutes.set('DELETE /api/data', async (_req, res, _params, body) => {
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
          db.deactivateMemoriesByPattern('%');
        } catch { /* best effort */ }
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

    this.staticRoutes.set('GET /api/vault/key', async (req, res) => {
      const key = process.env['LYNOX_VAULT_KEY'];
      if (!key) {
        jsonResponse(res, 200, { configured: false });
        return;
      }
      // Only return the actual key when explicitly requested (settings page reveal)
      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
      if (url.searchParams.get('reveal') === 'true') {
        // Managed mode: never expose vault key to users
        if (process.env['LYNOX_MANAGED_MODE']) {
          errorResponse(res, 403, 'Managed instance: vault key is system-controlled');
          return;
        }
        jsonResponse(res, 200, { configured: true, key });
      } else {
        jsonResponse(res, 200, { configured: true });
      }
    });

    this.staticRoutes.set('POST /api/vault/rotate', async (_req, res, _params, body) => {
      if (process.env['LYNOX_MANAGED_MODE']) {
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

    this.staticRoutes.set('GET /api/auth/token', async (req, res) => {
      const secret = process.env['LYNOX_HTTP_SECRET'];
      if (!secret) {
        jsonResponse(res, 200, { configured: false });
        return;
      }
      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
      if (url.searchParams.get('reveal') === 'true') {
        if (process.env['LYNOX_MANAGED_MODE']) {
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

    this.staticRoutes.set('GET /api/files', async (req, res) => {
      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
      const dirPath = url.searchParams.get('path') ?? '.';
      const showHidden = url.searchParams.get('hidden') === '1';
      try {
        const { readdir, stat, access } = (await import('node:fs/promises'));
        const { join, resolve } = await import('node:path');
        const { getWorkspaceDir } = await import('../core/workspace.js');
        const { getLynoxDir } = await import('../core/config.js');
        const { ensureDirSync: ensureDir } = await import('../core/atomic-write.js');

        const base = getWorkspaceDir() ?? join(getLynoxDir(), 'workspace');
        try { await access(base); } catch { ensureDir(base); }
        const target = resolve(base, dirPath);
        if (target !== base && !target.startsWith(base + '/')) { errorResponse(res, 403, 'Outside workspace'); return; }
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

    /** Resolve a workspace-relative path, rejecting traversal and symlink escape. */
    async function resolveWorkspacePath(filePath: string): Promise<string | null> {
      const { resolve, join } = await import('node:path');
      const { realpathSync } = await import('node:fs');
      const { getWorkspaceDir } = await import('../core/workspace.js');
      const { getLynoxDir } = await import('../core/config.js');
      const base = getWorkspaceDir() ?? join(getLynoxDir(), 'workspace');
      const resolved = resolve(base, filePath);
      // Logical path must be within workspace
      if (resolved !== base && !resolved.startsWith(base + '/')) return null;
      // Real path (after symlink resolution) must also be within workspace
      try {
        const real = realpathSync(resolved);
        if (real !== base && !real.startsWith(base + '/')) return null;
      } catch {
        // File doesn't exist yet — logical path check above is sufficient
      }
      return resolved;
    }

    this.staticRoutes.set('GET /api/files/download', async (req, res) => {
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
          'Content-Disposition': `attachment; filename="${name.replace(/"/g, '\\"')}"`,
          'Content-Length': st.size,
        });
        createReadStream(resolved).pipe(res);
      } catch {
        errorResponse(res, 404, 'File not found');
      }
    });

    this.staticRoutes.set('GET /api/files/read', async (req, res) => {
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

    this.staticRoutes.set('DELETE /api/files', async (req, res) => {
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

    this.staticRoutes.set('GET /api/migration/preview', async (_req, res) => {
      try {
        const { MigrationExporter } = await import('../core/migration-export.js');
        const exporter = new MigrationExporter();
        const preview = exporter.preview();
        jsonResponse(res, 200, preview);
      } catch (err: unknown) {
        errorResponse(res, 500, err instanceof Error ? err.message : 'Preview failed');
      }
    });

    this.staticRoutes.set('POST /api/migration/export', async (req, res, _params, body) => {
      // Orchestrated migration: engine handles ECDH + export + transfer to target.
      // Browser is just the orchestrator — progress reported via SSE.
      const b = body as Record<string, unknown> | null;
      const targetUrl = typeof b?.['targetUrl'] === 'string' ? b['targetUrl'] : '';
      const migrationToken = typeof b?.['migrationToken'] === 'string' ? b['migrationToken'] : '';

      if (!targetUrl || !migrationToken) {
        errorResponse(res, 400, 'Missing targetUrl or migrationToken');
        return;
      }

      // Validate targetUrl is HTTPS (or localhost for testing)
      try {
        const parsed = new URL(targetUrl);
        const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || /^192\.168\./.test(parsed.hostname);
        if (parsed.protocol !== 'https:' && !isLocal) {
          errorResponse(res, 400, 'targetUrl must use HTTPS');
          return;
        }
      } catch {
        errorResponse(res, 400, 'Invalid targetUrl');
        return;
      }

      // SSE response for progress
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
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

        const hsRes = await fetch(`${targetUrl}/api/migration/handshake`, {
          headers: { 'X-Migration-Token': migrationToken, 'Accept': 'application/json' },
        });
        if (!hsRes.ok) {
          const errText = await hsRes.text();
          throw new Error(`Handshake failed: ${errText}`);
        }
        const handshake = await hsRes.json() as { serverPubKey: string; signature: string; challengeNonce: string };

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

        const completeRes = await fetch(`${targetUrl}/api/migration/handshake`, {
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
        const mRes = await fetch(`${targetUrl}/api/migration/manifest`, {
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

          const cRes = await fetch(`${targetUrl}/api/migration/chunk`, {
            method: 'POST',
            headers: migrationHeaders,
            body: JSON.stringify(chunks[i]),
          });
          if (!cRes.ok) throw new Error(`Chunk ${String(i)} rejected: ${await cRes.text()}`);
        }

        // 6. Restore
        sendEvent('progress', { phase: 'restoring', message: 'Restoring data on target...' });
        const rRes = await fetch(`${targetUrl}/api/migration/restore`, {
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

    this.staticRoutes.set('GET /api/migration/handshake', async (req, res) => {
      // Only available on managed instances receiving a migration
      if (!process.env['LYNOX_MANAGED_MODE']) {
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
          errorResponse(res, 503, 'Migration not available — missing vault key or HTTP secret');
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

        const payload = importer.startHandshake();
        jsonResponse(res, 200, payload);
      } catch (err: unknown) {
        errorResponse(res, 400, err instanceof Error ? err.message : 'Handshake failed');
      }
    });

    this.staticRoutes.set('POST /api/migration/handshake', async (_req, res, _params, body) => {
      if (!process.env['LYNOX_MANAGED_MODE']) {
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

    this.staticRoutes.set('POST /api/migration/manifest', async (_req, res, _params, body) => {
      if (!process.env['LYNOX_MANAGED_MODE']) {
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

    this.staticRoutes.set('POST /api/migration/chunk', async (_req, res, _params, body) => {
      if (!process.env['LYNOX_MANAGED_MODE']) {
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

    this.staticRoutes.set('POST /api/migration/restore', async (_req, res) => {
      if (!process.env['LYNOX_MANAGED_MODE']) {
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

    this.staticRoutes.set('DELETE /api/migration', async (_req, res) => {
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
    const httpSecret = process.env['LYNOX_HTTP_SECRET'];
    if (!vaultKey || !httpSecret) return null;

    const { MigrationImporter } = await import('../core/migration-import.js');
    this._migrationImporter = new MigrationImporter({ vaultKey, httpSecret });
    return this._migrationImporter;
  }

  private _getMigrationImporter(): import('../core/migration-import.js').MigrationImporter | null {
    if (!this._migrationImporter?.isActive) return null;
    return this._migrationImporter;
  }
}
