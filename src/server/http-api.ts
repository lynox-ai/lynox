/**
 * Engine HTTP API Server
 *
 * Exposes the Engine singleton over REST + SSE for the PWA Gateway.
 * Each process serves exactly one user (process-per-user model).
 *
 * @see pro/docs/internal/prd/engine-api-pwa.md
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
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
  }

  async start(port: number): Promise<void> {
    const secret = process.env['LYNOX_HTTP_SECRET'];

    this.server = createServer(async (req, res) => {
      const start = Date.now();
      try {
        await this._handleRequest(req, res, secret);
      } catch (err: unknown) {
        if (!res.headersSent) {
          errorResponse(res, 500, 'Internal server error');
        }
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`HTTP API error: ${msg}\n`);
      }
      const method = req.method ?? 'GET';
      const url = req.url ?? '/';
      const status = res.statusCode;
      const ms = Date.now() - start;
      process.stderr.write(`${method} ${url} ${status} ${ms}ms\n`);
    });

    const host = secret ? '0.0.0.0' : '127.0.0.1';
    this.server.listen(port, host, () => {
      const authStatus = secret ? '(auth enabled)' : '(localhost only)';
      process.stderr.write(`LYNOX HTTP API listening on http://${host}:${port} ${authStatus}\n`);
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
  ): Promise<void> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    // Health check (unauthenticated)
    if (method === 'GET' && pathname === '/health') {
      jsonResponse(res, 200, { status: 'ok' });
      return;
    }

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }

    // CORS headers for all responses
    res.setHeader('Access-Control-Allow-Origin', '*');

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

    // Content-Length check
    const contentLength = parseInt(req.headers['content-length'] ?? '0', 10);
    if (contentLength > MAX_BODY_BYTES) {
      errorResponse(res, 413, 'Request body too large');
      return;
    }

    // Rate limiting
    const ip = req.socket.remoteAddress ?? 'unknown';
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
      const sessionId = randomUUID();
      this.sessionStore.getOrCreate(sessionId, engine, {
        model: typeof opts['model'] === 'string' ? opts['model'] as 'opus' | 'sonnet' | 'haiku' : undefined,
        effort: typeof opts['effort'] === 'string' ? opts['effort'] as 'low' | 'medium' | 'high' : undefined,
      });
      jsonResponse(res, 201, { sessionId });
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

      const task = body && typeof body === 'object' && 'task' in body ? String((body as Record<string, unknown>)['task']) : '';
      if (!task) { errorResponse(res, 400, 'Missing task'); return; }

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

      // Abort on client disconnect
      req.on('close', () => {
        aborted = true;
        session.abort();
      });

      // Run
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

    // ── Memory ──
    this.dynamicRoutes.push(parseDynamicRoute('GET', '/api/memory/:ns', async (_req, res, params) => {
      const memory = engine.getMemory();
      if (!memory) { errorResponse(res, 503, 'Memory not initialized'); return; }
      const ns = params['ns'] as 'knowledge' | 'methods' | 'project-state' | 'learnings';
      const content = await memory.load(ns);
      jsonResponse(res, 200, { content });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('PUT', '/api/memory/:ns', async (_req, res, params, body) => {
      const memory = engine.getMemory();
      if (!memory) { errorResponse(res, 503, 'Memory not initialized'); return; }
      const ns = params['ns'] as 'knowledge' | 'methods' | 'project-state' | 'learnings';
      const content = body && typeof body === 'object' && 'content' in body ? String((body as Record<string, unknown>)['content']) : '';
      await memory.save(ns, content);
      jsonResponse(res, 200, { ok: true });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('POST', '/api/memory/:ns/append', async (_req, res, params, body) => {
      const memory = engine.getMemory();
      if (!memory) { errorResponse(res, 503, 'Memory not initialized'); return; }
      const ns = params['ns'] as 'knowledge' | 'methods' | 'project-state' | 'learnings';
      const text = body && typeof body === 'object' && 'text' in body ? String((body as Record<string, unknown>)['text']) : '';
      await memory.append(ns, text);
      jsonResponse(res, 200, { ok: true });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('DELETE', '/api/memory/:ns', async (req, res, params) => {
      const memory = engine.getMemory();
      if (!memory) { errorResponse(res, 503, 'Memory not initialized'); return; }
      const ns = params['ns'] as 'knowledge' | 'methods' | 'project-state' | 'learnings';
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const pattern = url.searchParams.get('pattern') ?? '';
      const deleted = await memory.delete(ns, pattern);
      jsonResponse(res, 200, { deleted });
    }));

    this.dynamicRoutes.push(parseDynamicRoute('PATCH', '/api/memory/:ns', async (_req, res, params, body) => {
      const memory = engine.getMemory();
      if (!memory) { errorResponse(res, 503, 'Memory not initialized'); return; }
      const ns = params['ns'] as 'knowledge' | 'methods' | 'project-state' | 'learnings';
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
      store.set(params['name']!, value);
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
      jsonResponse(res, 200, { ok: true });
    });

    // ── History ──
    this.staticRoutes.set('GET /api/history/runs', async (req, res) => {
      const history = engine.getRunHistory();
      if (!history) { errorResponse(res, 503, 'History not initialized'); return; }
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const q = url.searchParams.get('q');
      const limit = parseInt(url.searchParams.get('limit') ?? '20', 10);
      const runs = q ? history.searchRuns(q, limit) : history.getRecentRuns(limit);
      jsonResponse(res, 200, { runs });
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

    this.dynamicRoutes.push(parseDynamicRoute('POST', '/api/tasks/:id/complete', async (_req, res, params) => {
      const taskManager = engine.getTaskManager();
      if (!taskManager) { errorResponse(res, 503, 'Task manager not initialized'); return; }
      const task = taskManager.complete(params['id']!);
      if (!task) { errorResponse(res, 404, 'Task not found'); return; }
      jsonResponse(res, 200, task);
    }));
  }
}
