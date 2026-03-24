// === Telegram Session Store ===
// Per-chat conversation persistence + serialized run queue.
// Each chat maintains its own message history (sliding window),
// swapped in/out of the shared Nodyn instance between runs.
// Runs are serialized across all chats to prevent handler corruption.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SESSIONS = 50;
const STALE_SESSION_MS = 30 * 60 * 1000; // 30 minutes idle → evict
const MAX_MESSAGES_PER_CHAT = 20;         // ~10 turns — older messages drop off

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatSession {
  messages: unknown[];
  lastActivityAt: number;
  trimNotified: boolean;
}

/** Minimal interface for the Nodyn methods we need. */
export interface SessionNodyn {
  reset(): void;
  saveMessages(): unknown[];
  loadMessages(msgs: unknown[]): void;
}

// ---------------------------------------------------------------------------
// ChatSessionStore — per-chat conversation history
// ---------------------------------------------------------------------------

export class ChatSessionStore {
  private readonly sessions = new Map<number, ChatSession>();

  /** Load a chat's saved messages into the nodyn instance. Resets agent first. */
  load(chatId: number, nodyn: SessionNodyn): void {
    const session = this.sessions.get(chatId);
    nodyn.reset();
    if (session && session.messages.length > 0) {
      nodyn.loadMessages(session.messages);
    }
  }

  /** Save the current nodyn messages as this chat's history (sliding window). Returns true if messages were trimmed. */
  save(chatId: number, nodyn: SessionNodyn): boolean {
    let messages = nodyn.saveMessages();
    // Sliding window: keep only the most recent messages.
    // Messages are user/assistant pairs — trim from the front to preserve recent context.
    const trimmed = messages.length > MAX_MESSAGES_PER_CHAT;
    if (trimmed) {
      messages = messages.slice(-MAX_MESSAGES_PER_CHAT);
    }
    const existing = this.sessions.get(chatId);
    if (existing) {
      existing.messages = messages;
      existing.lastActivityAt = Date.now();
    } else {
      this.evictIfFull();
      this.sessions.set(chatId, { messages, lastActivityAt: Date.now(), trimNotified: false });
    }
    return trimmed;
  }

  /** Whether the user has already been notified about context trimming in this session. */
  wasTrimNotified(chatId: number): boolean {
    return this.sessions.get(chatId)?.trimNotified ?? false;
  }

  /** Mark that the user has been notified about context trimming. */
  markTrimNotified(chatId: number): void {
    const session = this.sessions.get(chatId);
    if (session) session.trimNotified = true;
  }

  /** Clear a chat's conversation history. */
  clear(chatId: number): void {
    this.sessions.delete(chatId);
  }

  /** Evict sessions idle longer than maxAgeMs. Returns count evicted. */
  evictStale(maxAgeMs: number = STALE_SESSION_MS): number {
    const cutoff = Date.now() - maxAgeMs;
    let evicted = 0;
    for (const [chatId, session] of this.sessions) {
      if (session.lastActivityAt < cutoff) {
        this.sessions.delete(chatId);
        evicted++;
      }
    }
    return evicted;
  }

  get size(): number {
    return this.sessions.size;
  }

  has(chatId: number): boolean {
    return this.sessions.has(chatId);
  }

  /** Clear all sessions. */
  clearAll(): void {
    this.sessions.clear();
  }

  /** If at capacity, evict the oldest session. */
  private evictIfFull(): void {
    if (this.sessions.size < MAX_SESSIONS) return;
    let oldestId: number | undefined;
    let oldestTime = Infinity;
    for (const [chatId, session] of this.sessions) {
      if (session.lastActivityAt < oldestTime) {
        oldestTime = session.lastActivityAt;
        oldestId = chatId;
      }
    }
    if (oldestId !== undefined) this.sessions.delete(oldestId);
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

export const chatSessions = new ChatSessionStore();
export const runQueue = new RunQueue();

// ---------------------------------------------------------------------------
// Eviction timer management
// ---------------------------------------------------------------------------

const EVICT_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes
let evictTimer: ReturnType<typeof setInterval> | null = null;

export function startEvictionTimer(): void {
  if (evictTimer) return;
  evictTimer = setInterval(() => {
    chatSessions.evictStale();
  }, EVICT_INTERVAL_MS);
  evictTimer.unref();
}

export function stopEvictionTimer(): void {
  if (evictTimer) {
    clearInterval(evictTimer);
    evictTimer = null;
  }
}
