/**
 * Engine HTTP API Server
 *
 * Exposes the Engine singleton over REST + SSE for the PWA Gateway.
 * Each process serves exactly one user (process-per-user model).
 *
 * @see pro/docs/internal/prd/engine-api-pwa.md
 */

import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { Engine } from '../core/engine.js';
import { loadConfig } from '../core/config.js';
import { SessionStore } from '../core/session-store.js';
import type { StreamEvent } from '../types/index.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface PendingPrompt {
  question: string;
  options: string[] | undefined;
  resolve: (answer: string) => void;
  timeout: ReturnType<typeof setTimeout>;
}

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

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_BODY_BYTES = 30 * 1024 * 1024; // 30 MB
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 120;
const PROMPT_TIMEOUT_MS = 2 * 60_000; // 2 minutes
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
  private readonly sessionStore = new SessionStore();
  private readonly pendingPrompts = new Map<string, PendingPrompt>();
  private readonly runningSessions = new Set<string>();
  private readonly rateCounts = new Map<string, { count: number; resetAt: number }>();
  private readonly staticRoutes = new Map<string, RouteHandler>();
  private readonly dynamicRoutes: DynamicRoute[] = [];
  private rateGcTimer: ReturnType<typeof setInterval> | null = null;

  async init(): Promise<void> {
    const config = loadConfig();
    this.engine = new Engine({ model: config.default_tier });
    await this.engine.init();
    this.engine.startWorkerLoop();
    this._registerRoutes();
    await this._tryStartTelegram(config);
  }

  private async _tryStartTelegram(config: ReturnType<typeof loadConfig>): Promise<void> {
    const store = this.engine?.getSecretStore();
    const token = process.env['TELEGRAM_BOT_TOKEN']
      ?? store?.resolve('TELEGRAM_BOT_TOKEN')
      ?? config.telegram_bot_token;
    if (!token || !this.engine) return;

    const allowedRaw = process.env['TELEGRAM_ALLOWED_CHAT_IDS']
      ?? store?.resolve('TELEGRAM_ALLOWED_CHAT_IDS')
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
    const secret = process.env['LYNOX_HTTP_SECRET'];

    const trustProxy = process.env['LYNOX_TRUST_PROXY'] === 'true';

    const handler = async (req: IncomingMessage, res: ServerResponse) => {
      const start = Date.now();

      // Security headers on ALL responses
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Security-Policy', "default-src 'none'");
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

    const host = secret ? '0.0.0.0' : '127.0.0.1';
    const protocol = useTls ? 'https' : 'http';
    this.server.listen(port, host, () => {
      const authStatus = secret ? '(auth enabled)' : '(localhost only)';
      process.stderr.write(`LYNOX HTTP API listening on ${protocol}://${host}:${port} ${authStatus}\n`);
      if (ALLOWED_IPS.length > 0) {
        process.stderr.write(`  IP allowlist: ${ALLOWED_IPS.join(', ')}\n`);
      }
      if (secret && !useTls) {
        process.stderr.write(`Warning: HTTP API exposed without TLS. Use LYNOX_TLS_CERT + LYNOX_TLS_KEY or a reverse proxy.\n`);
      }
    });

    // Rate limit GC
    this.rateGcTimer = setInterval(() => {
      const now = Date.now();
      for (const [ip, entry] of this.rateCounts) {
        if (entry.resetAt < now) this.rateCounts.delete(ip);
      }
    }, 5 * 60_000);
  }

  async shutdown(): Promise<void> {
    if (this.rateGcTimer) clearInterval(this.rateGcTimer);
    for (const [, prompt] of this.pendingPrompts) {
      clearTimeout(prompt.timeout);
      prompt.resolve('n');
    }
    this.pendingPrompts.clear();
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
    const pathname = url.pathname;

    // Health check (unauthenticated)
    if (method === 'GET' && (pathname === '/health' || pathname === '/api/health')) {
      jsonResponse(res, 200, { status: 'ok' });
      return;
    }

    // CORS — restrict to allowed origins (or allow all for localhost-only mode)
    const requestOrigin = req.headers['origin'] ?? '';
    const corsOrigin = ALLOWED_ORIGINS.length > 0
      ? (ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin : '')
      : (secret ? '' : '*'); // no secret = localhost-only = allow all; with secret = require explicit whitelist

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }

    if (corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    }

    // Auth
    if (secret) {
      const auth = req.headers['authorization'] ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const tokenBuf = Buffer.from(token);
      const secretBuf = Buffer.from(secret);
      if (tokenBuf.length !== secretBuf.length || !timingSafeEqual(tokenBuf, secretBuf)) {
        errorResponse(res, 401, 'Unauthorized');
        return;
      }
    }

    // Content-Length check (guard against NaN/negative from malformed headers)
    const contentLength = parseInt(req.headers['content-length'] ?? '0', 10);
    if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > MAX_BODY_BYTES) {
      errorResponse(res, 413, 'Request body too large');
      return;
    }

    // Rate limiting (uses resolved clientIp, proxy-aware)
    const ip = clientIp;
    const now = Date.now();
    let rateEntry = this.rateCounts.get(ip);
    if (!rateEntry || rateEntry.resetAt < now) {
      rateEntry = { count: 0, resetAt: now + RATE_WINDOW_MS };
      this.rateCounts.set(ip, rateEntry);
    }
    rateEntry.count++;
    if (rateEntry.count > RATE_MAX) {
      const retryAfter = Math.ceil((rateEntry.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      errorResponse(res, 429, 'Too many requests');
      return;
    }

    // Parse body for POST/PUT/PATCH
    let body: unknown = null;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      try {
        body = await parseBody(req, MAX_BODY_BYTES);
      } catch {
        errorResponse(res, 400, 'Invalid request body');
        return;
      }
    }

    // Route dispatch
    const routeKey = `${method} ${pathname}`;
    const staticHandler = this.staticRoutes.get(routeKey);
    if (staticHandler) {
      await staticHandler(req, res, {}, body);
      return;
    }

    for (const route of this.dynamicRoutes) {
      if (route.method !== method) continue;
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
      });
      const tier = session.getModelTier();
      const CONTEXT_SIZES: Record<string, number> = { opus: 1_000_000, sonnet: 200_000, haiku: 200_000 };
      const threadStore = engine.getThreadStore();
      const thread = threadStore?.getThread(sessionId);
      jsonResponse(res, 201, {
        sessionId,
        model: tier,
        contextWindow: CONTEXT_SIZES[tier] ?? 200_000,
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

      // Guard: reject concurrent runs on the same session
      if (this.runningSessions.has(sessionId)) {
        errorResponse(res, 409, 'A run is already in progress for this session');
        return;
      }

      const b = body as Record<string, unknown> | null;
      const taskText = b && typeof b['task'] === 'string' ? b['task'] : '';
      if (!taskText) { errorResponse(res, 400, 'Missing task'); return; }

      // Build multimodal content if files are attached
      const files = Array.isArray(b?.['files']) ? b['files'] as { name: string; type: string; data: string }[] : [];
      let task: string | unknown[];
      if (files.length > 0) {
        const content: unknown[] = [];
        for (const file of files) {
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

      // Wire promptUser
      session.promptUser = (question: string, options?: string[]) => {
        return new Promise<string>((resolve) => {
          const timeout = setTimeout(() => {
            this.pendingPrompts.delete(sessionId);
            resolve('n');
          }, PROMPT_TIMEOUT_MS);

          this.pendingPrompts.set(sessionId, { question, options, resolve, timeout });
          const data = JSON.stringify({ question, options });
          res.write(`event: prompt\ndata: ${data}\n\n`);
        });
      };

      // Abort on client disconnect or timeout (30 min max)
      const streamTimeout = setTimeout(() => {
        aborted = true;
        session.abort();
        if (!res.writableEnded) res.end();
      }, 30 * 60_000);

      req.on('close', () => {
        clearTimeout(streamTimeout);
        aborted = true;
        session.abort();
      });

      // Run
      this.runningSessions.add(sessionId);
      try {
        const result = await session.run(task);
        if (!aborted) {
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
        this.runningSessions.delete(sessionId);
      }
    }));

    this.dynamicRoutes.push(parseDynamicRoute('POST', '/api/sessions/:id/reply', async (_req, res, params, body) => {
      const sessionId = params['id']!;
      const pending = this.pendingPrompts.get(sessionId);
      if (!pending) { errorResponse(res, 404, 'No pending prompt'); return; }

      const answer = body && typeof body === 'object' && 'answer' in body ? String((body as Record<string, unknown>)['answer']) : '';
      clearTimeout(pending.timeout);
      this.pendingPrompts.delete(sessionId);
      pending.resolve(answer);
      jsonResponse(res, 200, { ok: true });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('POST', '/api/sessions/:id/abort', async (_req, res, params) => {
      const session = this.sessionStore.get(params['id']!);
      if (!session) { errorResponse(res, 404, 'Session not found'); return; }
      session.abort();
      jsonResponse(res, 200, { ok: true });
    }));

    // ── Threads ──
    this.staticRoutes.set('GET /api/threads', async (req, res) => {
      const threadStore = engine.getThreadStore();
      if (!threadStore) { errorResponse(res, 503, 'Thread store not initialized'); return; }
      const url = new URL(req.url ?? '', 'http://localhost');
      const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
      const includeArchived = url.searchParams.get('includeArchived') === 'true';
      const threads = threadStore.listThreads({ limit, includeArchived });
      jsonResponse(res, 200, { threads });
    });

    this.dynamicRoutes.push(parseDynamicRoute('GET', '/api/threads/:id', async (_req, res, params) => {
      const threadStore = engine.getThreadStore();
      if (!threadStore) { errorResponse(res, 503, 'Thread store not initialized'); return; }
      const thread = threadStore.getThread(params['id']!);
      if (!thread) { errorResponse(res, 404, 'Thread not found'); return; }
      jsonResponse(res, 200, { thread });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('PATCH', '/api/threads/:id', async (_req, res, params, body) => {
      const threadStore = engine.getThreadStore();
      if (!threadStore) { errorResponse(res, 503, 'Thread store not initialized'); return; }
      const thread = threadStore.getThread(params['id']!);
      if (!thread) { errorResponse(res, 404, 'Thread not found'); return; }
      const b = body as Record<string, unknown> | null;
      threadStore.updateThread(params['id']!, {
        title: typeof b?.['title'] === 'string' ? b['title'] : undefined,
        is_archived: typeof b?.['is_archived'] === 'boolean' ? b['is_archived'] : undefined,
      });
      jsonResponse(res, 200, { ok: true });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('DELETE', '/api/threads/:id', async (_req, res, params) => {
      const threadStore = engine.getThreadStore();
      if (!threadStore) { errorResponse(res, 503, 'Thread store not initialized'); return; }
      const thread = threadStore.getThread(params['id']!);
      if (!thread) { errorResponse(res, 404, 'Thread not found'); return; }
      // Also clean up in-memory session
      this.sessionStore.reset(params['id']!);
      threadStore.deleteThread(params['id']!);
      jsonResponse(res, 200, { ok: true });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('GET', '/api/threads/:id/messages', async (req, res, params) => {
      const threadStore = engine.getThreadStore();
      if (!threadStore) { errorResponse(res, 503, 'Thread store not initialized'); return; }
      const thread = threadStore.getThread(params['id']!);
      if (!thread) { errorResponse(res, 404, 'Thread not found'); return; }
      const url = new URL(req.url ?? '', 'http://localhost');
      const fromSeq = parseInt(url.searchParams.get('fromSeq') ?? '0', 10);
      const limit = parseInt(url.searchParams.get('limit') ?? '10000', 10);
      const records = threadStore.getMessages(params['id']!, { fromSeq, limit });
      const messages = records.map(r => ({
        seq: r.seq,
        role: r.role,
        content: JSON.parse(r.content_json) as unknown,
        created_at: r.created_at,
      }));
      jsonResponse(res, 200, { messages });
    }));

    // ── Memory ──
    this.dynamicRoutes.push(parseDynamicRoute('GET', '/api/memory/:ns', async (_req, res, params) => {
      const memory = engine.getMemory();
      if (!memory) { errorResponse(res, 503, 'Memory not initialized'); return; }
      const ns = params['ns'] as 'knowledge' | 'methods' | 'status' | 'learnings';
      const content = await memory.load(ns);
      jsonResponse(res, 200, { content });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('PUT', '/api/memory/:ns', async (_req, res, params, body) => {
      const memory = engine.getMemory();
      if (!memory) { errorResponse(res, 503, 'Memory not initialized'); return; }
      const ns = params['ns'] as 'knowledge' | 'methods' | 'status' | 'learnings';
      const content = body && typeof body === 'object' && 'content' in body ? String((body as Record<string, unknown>)['content']) : '';
      await memory.save(ns, content);
      jsonResponse(res, 200, { ok: true });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('POST', '/api/memory/:ns/append', async (_req, res, params, body) => {
      const memory = engine.getMemory();
      if (!memory) { errorResponse(res, 503, 'Memory not initialized'); return; }
      const ns = params['ns'] as 'knowledge' | 'methods' | 'status' | 'learnings';
      const text = body && typeof body === 'object' && 'text' in body ? String((body as Record<string, unknown>)['text']) : '';
      await memory.append(ns, text);
      jsonResponse(res, 200, { ok: true });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('DELETE', '/api/memory/:ns', async (req, res, params) => {
      const memory = engine.getMemory();
      if (!memory) { errorResponse(res, 503, 'Memory not initialized'); return; }
      const ns = params['ns'] as 'knowledge' | 'methods' | 'status' | 'learnings';
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const pattern = url.searchParams.get('pattern') ?? '';
      const deleted = await memory.delete(ns, pattern);
      jsonResponse(res, 200, { deleted });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('PATCH', '/api/memory/:ns', async (_req, res, params, body) => {
      const memory = engine.getMemory();
      if (!memory) { errorResponse(res, 503, 'Memory not initialized'); return; }
      const ns = params['ns'] as 'knowledge' | 'methods' | 'status' | 'learnings';
      const b = body as Record<string, unknown> | null;
      const oldText = b && typeof b['old'] === 'string' ? b['old'] : '';
      const newText = b && typeof b['new'] === 'string' ? b['new'] : '';
      const updated = await memory.update(ns, oldText, newText);
      jsonResponse(res, 200, { updated });
    }));

    // ── Secrets ──
    this.staticRoutes.set('GET /api/secrets', async (_req, res) => {
      const store = engine.getSecretStore();
      if (!store) { errorResponse(res, 503, 'Secret store not initialized'); return; }
      const names = store.listNames();
      jsonResponse(res, 200, { names });
    });

    this.dynamicRoutes.push(parseDynamicRoute('PUT', '/api/secrets/:name', async (_req, res, params, body) => {
      const store = engine.getSecretStore();
      if (!store) { errorResponse(res, 503, 'Secret store not initialized'); return; }
      const b = body as Record<string, unknown> | null;
      const value = b && typeof b['value'] === 'string' ? b['value'] : '';
      if (!value) { errorResponse(res, 400, 'Missing value'); return; }
      try {
        store.set(params['name']!, value);
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
      if (!store) { errorResponse(res, 503, 'Secret store not initialized'); return; }
      const deleted = store.deleteSecret(params['name']!);
      jsonResponse(res, 200, { deleted });
    }));

    // ── Config ──
    this.staticRoutes.set('GET /api/config', async (_req, res) => {
      const { readUserConfig } = await import('../core/config.js');
      const config = readUserConfig();
      jsonResponse(res, 200, config);
    });

    this.staticRoutes.set('PUT /api/config', async (_req, res, _params, body) => {
      const { saveUserConfig, reloadConfig } = await import('../core/config.js');
      if (!body || typeof body !== 'object') { errorResponse(res, 400, 'Invalid config'); return; }
      saveUserConfig(body as Record<string, unknown>);
      reloadConfig();
      engine.reloadUserConfig();
      jsonResponse(res, 200, { ok: true });
    });

    // ── History ──
    this.staticRoutes.set('GET /api/history/runs', async (req, res) => {
      const history = engine.getRunHistory();
      if (!history) { errorResponse(res, 503, 'History not initialized'); return; }
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const q = url.searchParams.get('q');
      const limit = parseInt(url.searchParams.get('limit') ?? '20', 10);
      const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
      if (q) {
        const runs = history.searchRuns(q, limit, offset);
        jsonResponse(res, 200, { runs });
      } else {
        const filters: { status?: string; model?: string; dateFrom?: string; dateTo?: string } = {};
        const status = url.searchParams.get('status');
        const model = url.searchParams.get('model');
        const dateFrom = url.searchParams.get('dateFrom');
        const dateTo = url.searchParams.get('dateTo');
        if (status) filters.status = status;
        if (model) filters.model = model;
        if (dateFrom) filters.dateFrom = dateFrom;
        if (dateTo) filters.dateTo = dateTo;
        const runs = history.getRecentRuns(limit, offset, Object.keys(filters).length > 0 ? filters : undefined);
        jsonResponse(res, 200, { runs });
      }
    });

    this.dynamicRoutes.push(parseDynamicRoute('GET', '/api/history/runs/:id', async (_req, res, params) => {
      const history = engine.getRunHistory();
      if (!history) { errorResponse(res, 503, 'History not initialized'); return; }
      const run = history.getRun(params['id']!);
      if (!run) { errorResponse(res, 404, 'Run not found'); return; }
      jsonResponse(res, 200, run);
    }));

    this.dynamicRoutes.push(parseDynamicRoute('GET', '/api/history/runs/:id/tool-calls', async (_req, res, params) => {
      const history = engine.getRunHistory();
      if (!history) { errorResponse(res, 503, 'History not initialized'); return; }
      const toolCalls = history.getRunToolCalls(params['id']!);
      jsonResponse(res, 200, { toolCalls });
    }));

    this.staticRoutes.set('GET /api/history/stats', async (_req, res) => {
      const history = engine.getRunHistory();
      if (!history) { errorResponse(res, 503, 'History not initialized'); return; }
      const stats = history.getStats();
      jsonResponse(res, 200, stats);
    });

    this.staticRoutes.set('GET /api/history/cost/daily', async (req, res) => {
      const history = engine.getRunHistory();
      if (!history) { errorResponse(res, 503, 'History not initialized'); return; }
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const days = parseInt(url.searchParams.get('days') ?? '30', 10);
      const data = history.getCostByDay(days);
      jsonResponse(res, 200, data);
    });

    // ── Tasks ──
    this.staticRoutes.set('GET /api/tasks', async (req, res) => {
      const taskManager = engine.getTaskManager();
      if (!taskManager) { errorResponse(res, 503, 'Task manager not initialized'); return; }
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const status = url.searchParams.get('status') as 'open' | 'in_progress' | 'completed' | undefined;
      const tasks = taskManager.list(status ? { status } : undefined);
      jsonResponse(res, 200, { tasks });
    });

    this.staticRoutes.set('POST /api/tasks', async (_req, res, _params, body) => {
      const taskManager = engine.getTaskManager();
      if (!taskManager) { errorResponse(res, 503, 'Task manager not initialized'); return; }
      if (!body || typeof body !== 'object') { errorResponse(res, 400, 'Invalid task'); return; }
      const task = taskManager.create(body as Parameters<typeof taskManager.create>[0]);
      jsonResponse(res, 201, task);
    });

    this.dynamicRoutes.push(parseDynamicRoute('PATCH', '/api/tasks/:id', async (_req, res, params, body) => {
      const taskManager = engine.getTaskManager();
      if (!taskManager) { errorResponse(res, 503, 'Task manager not initialized'); return; }
      if (!body || typeof body !== 'object') { errorResponse(res, 400, 'Invalid update'); return; }
      const task = taskManager.update(params['id']!, body as Parameters<typeof taskManager.update>[1]);
      if (!task) { errorResponse(res, 404, 'Task not found'); return; }
      jsonResponse(res, 200, task);
    }));

    this.dynamicRoutes.push(parseDynamicRoute('DELETE', '/api/tasks/:id', async (_req, res, params) => {
      const runHistory = engine.getRunHistory();
      if (!runHistory) { errorResponse(res, 503, 'Not initialized'); return; }
      const deleted = runHistory.deleteTask(params['id']!);
      if (!deleted) { errorResponse(res, 404, 'Task not found'); return; }
      jsonResponse(res, 200, { deleted: true });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('POST', '/api/tasks/:id/complete', async (_req, res, params) => {
      const taskManager = engine.getTaskManager();
      if (!taskManager) { errorResponse(res, 503, 'Task manager not initialized'); return; }
      const task = taskManager.complete(params['id']!);
      if (!task) { errorResponse(res, 404, 'Task not found'); return; }
      jsonResponse(res, 200, task);
    }));

    // ── Artifacts ──
    this.staticRoutes.set('GET /api/artifacts', async (_req, res) => {
      const store = engine.getArtifactStore();
      if (!store) { errorResponse(res, 503, 'Artifact store not initialized'); return; }
      jsonResponse(res, 200, { artifacts: store.list() });
    });

    this.staticRoutes.set('POST /api/artifacts', async (_req, res, _params, body) => {
      const store = engine.getArtifactStore();
      if (!store) { errorResponse(res, 503, 'Artifact store not initialized'); return; }
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
      if (!store) { errorResponse(res, 503, 'Artifact store not initialized'); return; }
      const artifact = store.get(params['id']!);
      if (!artifact) { errorResponse(res, 404, 'Artifact not found'); return; }
      jsonResponse(res, 200, artifact);
    }));

    this.dynamicRoutes.push(parseDynamicRoute('DELETE', '/api/artifacts/:id', async (_req, res, params) => {
      const store = engine.getArtifactStore();
      if (!store) { errorResponse(res, 503, 'Artifact store not initialized'); return; }
      const deleted = store.delete(params['id']!);
      if (!deleted) { errorResponse(res, 404, 'Artifact not found'); return; }
      jsonResponse(res, 200, { deleted: true });
    }));

    // ── Transcription ──
    this.staticRoutes.set('POST /api/transcribe', async (_req, res, _params, body) => {
      const { HAS_WHISPER, transcribeAudio } = await import('../core/transcribe.js');
      if (!HAS_WHISPER) {
        errorResponse(res, 503, 'Whisper not available (install whisper.cpp + ffmpeg)');
        return;
      }
      const b = body as Record<string, unknown> | null;
      const audioData = b && typeof b['audio'] === 'string' ? b['audio'] : '';
      const filename = b && typeof b['filename'] === 'string' ? b['filename'] : 'audio.webm';
      if (!audioData) { errorResponse(res, 400, 'Missing audio (base64)'); return; }
      const buffer = Buffer.from(audioData, 'base64');
      const text = await transcribeAudio(buffer, filename);
      if (!text) { errorResponse(res, 422, 'Transcription failed'); return; }
      jsonResponse(res, 200, { text });
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

    this.staticRoutes.set('POST /api/google/auth', async (_req, res) => {
      const google = engine.getGoogleAuth();
      if (!google) { errorResponse(res, 503, 'Google auth not configured'); return; }
      try {
        const flow = await google.startDeviceFlow();
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

    this.staticRoutes.set('POST /api/google/revoke', async (_req, res) => {
      const google = engine.getGoogleAuth();
      if (!google) { errorResponse(res, 503, 'Google auth not configured'); return; }
      await google.revoke();
      jsonResponse(res, 200, { ok: true });
    });

    // Reload Google integration after credentials change
    this.staticRoutes.set('POST /api/google/reload', async (_req, res) => {
      const ok = await engine.reloadGoogle();
      jsonResponse(res, 200, { ok });
    });

    // ── Knowledge Graph ──────────────────────────────────────────

    this.staticRoutes.set('GET /api/kg/stats', async (_req, res) => {
      const kg = engine.getKnowledgeLayer();
      if (!kg) { jsonResponse(res, 200, { entityCount: 0, relationCount: 0, memoryCount: 0, communityCount: 0 }); return; }
      const stats = await kg.stats();
      jsonResponse(res, 200, stats);
    });

    this.dynamicRoutes.push(parseDynamicRoute('GET', '/api/kg/entities', async (req, res) => {
      const kg = engine.getKnowledgeLayer();
      if (!kg) { jsonResponse(res, 200, { entities: [] }); return; }
      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
      const typeFilter = url.searchParams.get('type') ?? '';
      const query = url.searchParams.get('q') ?? '';
      const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
      try {
        if (query) {
          const result = await kg.retrieve(query, [{ type: 'global', id: 'global' }], { topK: limit });
          const entities = result.entities ?? [];
          jsonResponse(res, 200, { entities });
        } else {
          const listOpts: { type?: string; limit?: number } = { limit };
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
      if (!kg) { errorResponse(res, 503, 'Knowledge graph not available'); return; }
      try {
        const entity = await kg.getEntity(params['id']!);
        if (!entity) { errorResponse(res, 404, 'Entity not found'); return; }
        const relations = await kg.getEntityRelations(entity.id);
        jsonResponse(res, 200, { entity, relations });
      } catch {
        errorResponse(res, 404, 'Entity not found');
      }
    }));

    // ── Episodic Memory + Metrics ─────────────────────────────────

    this.staticRoutes.set('GET /api/episodes', async (req, res) => {
      const kg = engine.getKnowledgeLayer();
      if (!kg) { jsonResponse(res, 200, { episodes: [] }); return; }
      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
      const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
      const outcomeSignal = url.searchParams.get('outcome_signal') ?? undefined;
      const episodes = kg.queryEpisodes({
        limit,
        outcomeSignal: outcomeSignal as import('../types/index.js').EpisodeOutcomeSignal | undefined,
      });
      jsonResponse(res, 200, { episodes });
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
      const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
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
      const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
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

    // ── Backups ──────────────────────────────────────────────────

    this.staticRoutes.set('GET /api/backups', async (_req, res) => {
      const bm = engine.getBackupManager();
      if (!bm) { jsonResponse(res, 200, { backups: [] }); return; }
      const backups = bm.listBackups();
      jsonResponse(res, 200, { backups });
    });

    this.staticRoutes.set('POST /api/backups', async (_req, res) => {
      const bm = engine.getBackupManager();
      if (!bm) { errorResponse(res, 503, 'Backup manager not available'); return; }
      try {
        const result = await bm.createBackup();
        jsonResponse(res, 200, result);
      } catch (err: unknown) {
        errorResponse(res, 500, err instanceof Error ? err.message : 'Backup failed');
      }
    });

    // ── API Store ────────────────────────────────────────────────

    this.staticRoutes.set('GET /api/api-profiles', async (_req, res) => {
      const store = engine.getApiStore();
      if (!store) { jsonResponse(res, 200, { profiles: [] }); return; }
      const profiles = store.getAll();
      jsonResponse(res, 200, { profiles });
    });

    this.dynamicRoutes.push(parseDynamicRoute('GET', '/api/api-profiles/:id', async (_req, res, params) => {
      const store = engine.getApiStore();
      if (!store) { errorResponse(res, 503, 'API store not available'); return; }
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
      if (!ds) { errorResponse(res, 503, 'DataStore not available'); return; }
      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
      const limit = parseInt(url.searchParams.get('limit') ?? '20', 10);
      const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
      try {
        const result = ds.queryRecords({ collection: params['collection']!, limit, offset });
        jsonResponse(res, 200, result);
      } catch (err: unknown) {
        errorResponse(res, 400, err instanceof Error ? err.message : 'Query failed');
      }
    }));

    // ── Files (workspace) ────────────────────────────────────────

    const HIDDEN_PATTERNS = new Set(['.git', '.env', '.DS_Store', 'node_modules', '.cache', '__pycache__', 'thumbs.db']);

    this.staticRoutes.set('GET /api/files', async (req, res) => {
      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
      const dirPath = url.searchParams.get('path') ?? '.';
      const showHidden = url.searchParams.get('hidden') === '1';
      try {
        const { readdirSync, statSync, existsSync: fsExists } = await import('node:fs');
        const { join, resolve } = await import('node:path');
        const { getWorkspaceDir } = await import('../core/workspace.js');
        const { getLynoxDir } = await import('../core/config.js');
        const { ensureDirSync: ensureDir } = await import('../core/atomic-write.js');

        // Use explicit workspace dir, or default to ~/.lynox/workspace/
        const base = getWorkspaceDir() ?? join(getLynoxDir(), 'workspace');
        if (!fsExists(base)) { ensureDir(base); }
        const target = resolve(base, dirPath);
        if (!target.startsWith(base)) { errorResponse(res, 403, 'Outside workspace'); return; }
        const entries = readdirSync(target, { withFileTypes: true })
          .filter(e => showHidden || (!e.name.startsWith('.') && !HIDDEN_PATTERNS.has(e.name)))
          .map(e => ({
            name: e.name,
            isDirectory: e.isDirectory(),
            size: e.isFile() ? statSync(join(target, e.name)).size : 0,
          }));
        jsonResponse(res, 200, { path: dirPath, entries });
      } catch {
        jsonResponse(res, 200, { path: dirPath, entries: [] });
      }
    });

    this.staticRoutes.set('GET /api/files/download', async (req, res) => {
      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
      const filePath = url.searchParams.get('path');
      if (!filePath) { errorResponse(res, 400, 'Missing path parameter'); return; }
      try {
        const { statSync, createReadStream } = await import('node:fs');
        const { resolve, basename } = await import('node:path');
        const resolved = resolve(filePath);
        const st = statSync(resolved);
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
  }
}
