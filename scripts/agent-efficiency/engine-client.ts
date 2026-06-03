/**
 * Minimal HTTP client for the lynox engine, used by the Agent-Efficiency
 * measurement protocol.
 *
 * Drives the same endpoints the Web UI uses:
 *   POST /api/sessions               → create a session (a thread)
 *   POST /api/sessions/:id/run       → run one turn (SSE stream)
 *   GET  /api/threads/:id/messages   → read the persisted messages
 *   GET  /api/health                 → engine build / version probe
 *
 * Per-turn `usage` is read from the messages projection: the engine
 * stamps each run's token/cost rollup onto that run's final assistant
 * message (`thread_messages.usage_json`, migration v30 in
 * `src/core/run-history.ts`; surfaced by `projectMessages` in
 * `src/core/render-projection.ts`). Capturing the highest `seq` before a
 * run and re-reading after it isolates exactly the turn that just ran —
 * the per-turn (not aggregate) signal Phase 0 requires.
 */
import type { TurnUsage } from './types.js';

export interface EngineHealth {
  readonly buildSha: string;
  readonly version: string;
}

export interface RenderedUsageWire {
  tokensIn?: number;
  tokensOut?: number;
  cacheRead?: number;
  cacheWrite?: number;
  costUsd?: number;
  model?: string;
}

export interface RenderedMessageWire {
  seq: number;
  role: 'user' | 'assistant';
  content: string;
  usage?: RenderedUsageWire;
}

/** Outcome of one `/run` SSE stream. */
export interface RunOutcome {
  /** `true` when the stream ended with a `done` event. */
  readonly completed: boolean;
  /** Error text when the stream ended with an `error` event / transport failure. */
  readonly error?: string;
  /** Wall time of the SSE stream, ms. */
  readonly wallMs: number;
}

export class EngineClient {
  constructor(
    private readonly baseUrl: string,
    private readonly cookie: string,
  ) {}

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      // The minted `lynox_session` cookie authenticates the HTTP API.
      Cookie: `lynox_session=${this.cookie}`,
      ...extra,
    };
  }

  /** Probe `/api/health` — pins a baseline to a concrete engine build. */
  async health(): Promise<EngineHealth> {
    const res = await fetch(`${this.baseUrl}/api/health`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`/api/health → HTTP ${res.status}`);
    const body = (await res.json()) as { build_sha?: unknown; version?: unknown };
    return {
      buildSha: typeof body.build_sha === 'string' ? body.build_sha : 'unknown',
      version: typeof body.version === 'string' ? body.version : 'unknown',
    };
  }

  /**
   * Poll `/api/health` until the engine reports `status: ok`, or give up.
   *
   * A managed engine can briefly 404/502 while a redeploy swaps the
   * container (the SvelteKit fallback serves 404 before the API mounts).
   * Without this guard a redeploy mid-batch cascades into a wall of
   * false scenario failures. Returns the healthy build, or `undefined`
   * when the engine never recovered inside `maxWaitMs`.
   */
  async waitForHealthy(maxWaitMs: number): Promise<EngineHealth | undefined> {
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      try {
        const h = await this.health();
        return h;
      } catch {
        if (Date.now() >= deadline) return undefined;
        await new Promise<void>((r) => setTimeout(r, 10_000));
      }
    }
  }

  /** Create a session (thread). Returns the session/thread id. */
  async createSession(): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status !== 201) {
      throw new Error(`POST /api/sessions → HTTP ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as { sessionId?: unknown };
    if (typeof body.sessionId !== 'string') {
      throw new Error('POST /api/sessions returned no sessionId');
    }
    return body.sessionId;
  }

  /**
   * Run one turn as an SSE stream and drain it to completion.
   *
   * The stream is consumed only to detect the terminal `done` / `error`
   * event; the per-turn usage is read afterwards from
   * `getLatestAssistantUsage`. A hard wall-clock cap (`timeoutMs`)
   * aborts a stuck turn so one bad scenario can never hang the batch.
   */
  async runTurn(
    sessionId: string,
    task: string,
    timeoutMs: number,
  ): Promise<RunOutcome> {
    const started = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/api/sessions/${sessionId}/run`, {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        // protocol:1 — sequential prompts; this client never answers a
        // prompt, so a scenario that triggers ask_user will time out and
        // be recorded as a failure (acceptable: it is still a real signal).
        body: JSON.stringify({ task, protocol: 1, tz: 'Europe/Zurich' }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        return {
          completed: false,
          error: `POST /run → HTTP ${res.status}`,
          wallMs: Date.now() - started,
        };
      }
      return await this.drainSse(res.body, started);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTimeout = msg.includes('abort') || msg.includes('timeout');
      return {
        completed: false,
        error: isTimeout ? `turn exceeded ${timeoutMs}ms wall cap` : msg,
        wallMs: Date.now() - started,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Consume an SSE byte stream until a terminal `done` / `error` event. */
  private async drainSse(
    body: ReadableStream<Uint8Array>,
    started: number,
  ): Promise<RunOutcome> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let outcome: RunOutcome | undefined;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line.
        let sep: number;
        while ((sep = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const parsed = parseSseFrame(frame);
          if (!parsed) continue;
          if (parsed.event === 'done') {
            outcome = { completed: true, wallMs: Date.now() - started };
          } else if (parsed.event === 'error') {
            outcome = {
              completed: false,
              error: extractErrorText(parsed.data),
              wallMs: Date.now() - started,
            };
          }
        }
        if (outcome) break;
      }
    } finally {
      // Release the stream; ignore cancel races.
      void reader.cancel().catch(() => undefined);
    }
    return (
      outcome ?? {
        completed: false,
        error: 'SSE stream ended without a done/error event',
        wallMs: Date.now() - started,
      }
    );
  }

  /**
   * Read the per-turn usage for the just-completed turn.
   *
   * `sinceSeq` is the highest message `seq` observed BEFORE the turn ran.
   * We return the usage of the highest-seq assistant message whose
   * `seq > sinceSeq` — that is the run the engine just stamped via
   * `setMessageUsage` (which self-targets the newest assistant row).
   * `undefined` when the new turn produced no usage-stamped message
   * (e.g. the run errored before run-end persistence).
   */
  async getTurnUsage(
    threadId: string,
    sinceSeq: number,
  ): Promise<{ usage: TurnUsage; finalText: string } | undefined> {
    const messages = await this.getMessages(threadId);
    let best: RenderedMessageWire | undefined;
    for (const m of messages) {
      if (m.role !== 'assistant') continue;
      if (m.seq <= sinceSeq) continue;
      if (!best || m.seq > best.seq) best = m;
    }
    if (!best || !best.usage) return undefined;
    const u = best.usage;
    return {
      usage: {
        tokensIn: u.tokensIn ?? 0,
        tokensOut: u.tokensOut ?? 0,
        tokensCacheRead: u.cacheRead ?? 0,
        tokensCacheWrite: u.cacheWrite ?? 0,
        costUsd: u.costUsd ?? 0,
        ...(typeof u.model === 'string' ? { model: u.model } : {}),
      },
      finalText: best.content,
    };
  }

  /**
   * Abort an in-flight run on a session — best effort, never throws.
   *
   * When a turn overruns the wall cap, the client aborts its SSE stream
   * but the engine-side run keeps executing, leaving the session locked
   * (subsequent `/run` on the same thread 409s). Calling `/abort`
   * releases the lock so the next turn in a multi-turn thread can start.
   */
  async abortSession(sessionId: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/api/sessions/${sessionId}/abort`, {
        method: 'POST',
        headers: this.headers(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      // Best effort — a failed abort is not worse than not calling it.
    }
  }

  /** Highest message `seq` currently in a thread; 0 when empty/unknown. */
  async maxSeq(threadId: string): Promise<number> {
    const messages = await this.getMessages(threadId);
    let max = 0;
    for (const m of messages) if (m.seq > max) max = m.seq;
    return max;
  }

  private async getMessages(threadId: string): Promise<RenderedMessageWire[]> {
    const res = await fetch(`${this.baseUrl}/api/threads/${threadId}/messages`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`GET /api/threads/${threadId}/messages → HTTP ${res.status}`);
    }
    const body = (await res.json()) as { messages?: unknown };
    if (!Array.isArray(body.messages)) return [];
    return body.messages.filter(isRenderedMessage);
  }
}

function isRenderedMessage(v: unknown): v is RenderedMessageWire {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { seq?: unknown }).seq === 'number' &&
    typeof (v as { role?: unknown }).role === 'string'
  );
}

interface SseFrame {
  event: string;
  data: string;
}

/** Parse one `event:`/`data:` SSE frame. Returns undefined for comments/blank. */
function parseSseFrame(frame: string): SseFrame | undefined {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return undefined;
  return { event, data: dataLines.join('\n') };
}

/** Pull a human-readable message out of an `error` SSE frame's data. */
function extractErrorText(data: string): string {
  try {
    const v = JSON.parse(data) as { error?: unknown };
    if (typeof v.error === 'string') return v.error;
  } catch {
    /* not JSON — fall through */
  }
  return data.slice(0, 300);
}
