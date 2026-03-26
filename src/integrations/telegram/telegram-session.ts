// === Telegram Session Map ===
// Per-chat Session isolation via engine.createSession().
// Each chat owns its own Session (Agent + message history).
// Runs are serialized across all chats to prevent concurrent API calls.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SESSIONS = 50;
const STALE_SESSION_MS = 30 * 60 * 1000; // 30 minutes idle → evict

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal interface for the Session returned by engine.createSession(). */
export interface TelegramSession {
  run(task: string | unknown[]): Promise<string>;
  abort(): void;
  reset(): void;
  saveMessages(): unknown[];
  loadMessages(msgs: unknown[]): void;
  onStream: ((event: import('../../types/index.js').StreamEvent) => void | Promise<void>) | null;
  get promptUser(): ((question: string, options?: string[]) => Promise<string>) | null;
  set promptUser(fn: ((question: string, options?: string[]) => Promise<string>) | null);
  readonly usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number };
  getModelTier(): string;
}

/** Minimal interface for the Engine used by SessionMap. */
export interface TelegramEngine {
  createSession(opts?: Record<string, unknown>): TelegramSession;
  getWorkerLoop(): { resolveTaskInput(taskId: string, answer: string): boolean } | null;
  getGoogleAuth(): import('../google/google-auth.js').GoogleAuth | null;
}

// ---------------------------------------------------------------------------
// SessionMap — per-chat Session isolation
// ---------------------------------------------------------------------------

export class SessionMap {
  private readonly sessions = new Map<number, TelegramSession>();
  private readonly lastActivity = new Map<number, number>();

  /** Get an existing session or create a new one for this chat. */
  getOrCreate(chatId: number, engine: TelegramEngine, systemPromptSuffix: string): TelegramSession {
    let session = this.sessions.get(chatId);
    if (!session) {
      this.evictIfFull();
      session = engine.createSession({ systemPromptSuffix });
      this.sessions.set(chatId, session);
    }
    this.lastActivity.set(chatId, Date.now());
    return session;
  }

  /** Clear a chat's session. */
  clear(chatId: number): void {
    this.sessions.delete(chatId);
    this.lastActivity.delete(chatId);
  }

  has(chatId: number): boolean {
    return this.sessions.has(chatId);
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Clear all sessions. */
  clearAll(): void {
    this.sessions.clear();
    this.lastActivity.clear();
  }

  /** Evict sessions idle longer than maxAgeMs. Returns count evicted. */
  evictStale(maxAgeMs: number = STALE_SESSION_MS): number {
    const cutoff = Date.now() - maxAgeMs;
    let evicted = 0;
    for (const [chatId, ts] of this.lastActivity) {
      if (ts < cutoff) {
        this.sessions.delete(chatId);
        this.lastActivity.delete(chatId);
        evicted++;
      }
    }
    return evicted;
  }

  /** If at capacity, evict the oldest session. */
  private evictIfFull(): void {
    if (this.sessions.size < MAX_SESSIONS) return;
    let oldestId: number | undefined;
    let oldestTime = Infinity;
    for (const [chatId, ts] of this.lastActivity) {
      if (ts < oldestTime) {
        oldestTime = ts;
        oldestId = chatId;
      }
    }
    if (oldestId !== undefined) {
      this.sessions.delete(oldestId);
      this.lastActivity.delete(oldestId);
    }
  }
}

// ---------------------------------------------------------------------------
// RunQueue — serializes all runs to prevent handler corruption
// ---------------------------------------------------------------------------

interface QueueItem {
  fn: () => Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

export class RunQueue {
  private readonly queue: QueueItem[] = [];
  private running = false;

  /** Enqueue a function to run serially. Returns when the function completes. */
  enqueue(fn: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      if (!this.running) void this.drain();
    });
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Reset queue state. For testing only. */
  reset(): void {
    this.queue.length = 0;
    this.running = false;
  }

  private async drain(): Promise<void> {
    this.running = true;
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      try {
        await item.fn();
        item.resolve();
      } catch (err: unknown) {
        item.reject(err);
      }
    }
    this.running = false;
  }
}

// ---------------------------------------------------------------------------
// Module-level singletons
// ---------------------------------------------------------------------------

export const sessionMap = new SessionMap();
export const runQueue = new RunQueue();

// ---------------------------------------------------------------------------
// Eviction timer management
// ---------------------------------------------------------------------------

const EVICT_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes
let evictTimer: ReturnType<typeof setInterval> | null = null;

export function startEvictionTimer(): void {
  if (evictTimer) return;
  evictTimer = setInterval(() => {
    sessionMap.evictStale();
  }, EVICT_INTERVAL_MS);
  evictTimer.unref();
}

export function stopEvictionTimer(): void {
  if (evictTimer) {
    clearInterval(evictTimer);
    evictTimer = null;
  }
}
