import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import type { Session, SessionOptions } from './session.js';
import type { Engine } from './engine.js';
import type { ModelTier } from '../types/index.js';
import type { ThreadRecord } from './thread-store.js';

const VERBATIM_THRESHOLD = 80;
const RECENT_COUNT = 40;

function buildResumeContext(thread: ThreadRecord, messages: BetaMessageParam[]): BetaMessageParam[] {
  const recent = messages.slice(-RECENT_COUNT);

  if (thread.summary) {
    return [
      { role: 'user' as const, content: '[This conversation is being resumed. Below is a summary of earlier messages.]' },
      { role: 'assistant' as const, content: thread.summary },
      ...recent,
    ];
  }

  // No summary yet — load recent messages with a placeholder
  const dropped = messages.length - RECENT_COUNT;
  return [
    { role: 'user' as const, content: `[Resuming conversation — ${dropped} earlier messages not loaded]` },
    { role: 'assistant' as const, content: 'Understood. I can see our recent conversation. What would you like to continue with?' },
    ...recent,
  ];
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: Record<string, unknown>) => b['type'] === 'text')
      .map((b: Record<string, unknown>) => String(b['text'] ?? ''))
      .join('\n');
  }
  return '';
}

function formatMessagesForSummary(messages: BetaMessageParam[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const text = extractText(msg.content);
    if (text) {
      lines.push(`${msg.role}: ${text.slice(0, 500)}`);
    }
  }
  return lines.join('\n\n');
}

async function generateThreadSummary(
  engine: Engine, threadId: string, messages: BetaMessageParam[],
): Promise<void> {
  try {
    const summarySession = engine.createSession({ model: 'haiku' as ModelTier });
    const formatted = formatMessagesForSummary(messages.slice(0, -RECENT_COUNT));
    const prompt = `Summarize this conversation concisely in 3-5 paragraphs. Focus on: what was discussed, decisions made, current state of work, and any pending items.\n\n${formatted.slice(0, 30_000)}`;
    const summary = await summarySession.run(prompt);

    const threadStore = engine.getThreadStore();
    if (threadStore) {
      threadStore.updateThread(threadId, { summary, summary_up_to: messages.length - RECENT_COUNT });
    }
  } catch {
    // Fire-and-forget — summary will be generated on next resume
  }
}

const DEFAULT_MAX_IDLE_MS = 30 * 60_000; // 30 minutes
const DEFAULT_EVICT_INTERVAL_MS = 5 * 60_000; // check every 5 minutes

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly lastAccessed = new Map<string, number>();
  private evictTimer: ReturnType<typeof setInterval> | null = null;

  getOrCreate(sessionId: string, engine: Engine, opts?: SessionOptions): Session {
    this.lastAccessed.set(sessionId, Date.now());
    let session = this.sessions.get(sessionId);
    if (!session) {
      const threadStore = engine.getThreadStore();
      const thread = threadStore?.getThread(sessionId);

      if (thread) {
        // Resume: load messages from persisted thread
        const messageRecords = threadStore!.getMessages(sessionId);
        const messages: BetaMessageParam[] = messageRecords.map(r => ({
          role: r.role as 'user' | 'assistant',
          content: JSON.parse(r.content_json) as BetaMessageParam['content'],
        }));

        session = engine.createSession({
          ...opts,
          sessionId,
          model: (thread.model_tier as ModelTier) ?? opts?.model,
        });

        // Load messages: verbatim if short, summary + recent if long
        if (messages.length > 0) {
          const toLoad = messages.length <= VERBATIM_THRESHOLD
            ? messages
            : buildResumeContext(thread, messages);
          session.loadMessages(toLoad);
        }

        // Apply per-thread extraction toggle
        if (thread.skip_extraction) {
          session.setSkipMemoryExtraction(true);
        }

        // Fire-and-forget summary generation if needed
        if (messages.length > VERBATIM_THRESHOLD && !thread.summary) {
          void generateThreadSummary(engine, sessionId, messages);
        }
      } else {
        // New session — thread created in Session constructor
        session = engine.createSession({ ...opts, sessionId });
      }

      this.sessions.set(sessionId, session);
    }
    return session;
  }

  get(sessionId: string): Session | undefined {
    const s = this.sessions.get(sessionId);
    if (s) this.lastAccessed.set(sessionId, Date.now());
    return s;
  }

  reset(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.lastAccessed.delete(sessionId);
  }

  /** Number of cached sessions (for diagnostics). */
  get size(): number {
    return this.sessions.size;
  }

  /** Start periodic eviction of idle sessions. */
  startEviction(
    maxIdleMs = DEFAULT_MAX_IDLE_MS,
    intervalMs = DEFAULT_EVICT_INTERVAL_MS,
  ): void {
    if (this.evictTimer) return;
    this.evictTimer = setInterval(() => {
      const cutoff = Date.now() - maxIdleMs;
      for (const [id, ts] of this.lastAccessed) {
        if (ts < cutoff && !this.isRunning(id)) {
          this.sessions.delete(id);
          this.lastAccessed.delete(id);
        }
      }
    }, intervalMs);
    this.evictTimer.unref();
  }

  /** Stop eviction timer. */
  stopEviction(): void {
    if (this.evictTimer) {
      clearInterval(this.evictTimer);
      this.evictTimer = null;
    }
  }

  /** Hook for checking if a session is actively running (set externally). */
  private _isRunning: ((id: string) => boolean) | null = null;

  setRunningCheck(fn: (id: string) => boolean): void {
    this._isRunning = fn;
  }

  private isRunning(id: string): boolean {
    return this._isRunning ? this._isRunning(id) : false;
  }
}
