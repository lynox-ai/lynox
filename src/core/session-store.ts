import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import type { Session, SessionOptions } from './session.js';
import type { Engine } from './engine.js';
import { normalizeTier } from '../types/index.js';
import type { ThreadRecord } from './thread-store.js';

const VERBATIM_THRESHOLD = 80;
const RECENT_COUNT = 40;
// Hard cap on how many post-summary messages a resume loads verbatim. The delta
// slice below normally loads EVERY message after the summary's coverage point (so
// no turn between the summarized point and now is silently dropped), but a
// pathological session that ran hundreds of turns since its last compaction
// without re-compacting would otherwise load an unbounded tail — cap it here.
// `_truncateHistory` + auto-compaction bound the rest.
const MAX_RESUME_DELTA = 120;

export function buildResumeContext(thread: ThreadRecord, messages: BetaMessageParam[]): BetaMessageParam[] {
  if (thread.summary) {
    // Slice B (#86/#80): load [summary + every message SINCE the summary's
    // coverage point], not a fixed recent window. `compact()` (durable-summary
    // write) and the resume-time generateThreadSummary both set `summary_up_to`
    // to the boundary the summary covers up to; slicing from there loads the
    // mid-section the fixed last-40 window used to silently drop whenever the
    // summary lagged the tail (a session that compacted, then ran more turns
    // before eviction). Guard the value: trust only a positive in-range integer
    // (a legacy row with summary set but `summary_up_to` unset/0 falls back to
    // the previous fixed-window behavior). The delta is capped at
    // MAX_RESUME_DELTA — strictly more coverage than the old 40 window, but NOT
    // an unconditional "no turn dropped": a tail longer than the cap still falls
    // back to the recent window (rare — occupancy-triggered auto-compaction
    // normally re-fires first; a freshness-triggered re-summarize to close that
    // residual gap is a deferred follow-up).
    const len = messages.length;
    const upTo = thread.summary_up_to;
    const recent = Number.isInteger(upTo) && upTo > 0 && upTo <= len
      ? messages.slice(Math.max(upTo, len - MAX_RESUME_DELTA))
      : messages.slice(-RECENT_COUNT);
    return [
      { role: 'user' as const, content: '[This conversation is being resumed. Below is a summary of earlier messages.]' },
      { role: 'assistant' as const, content: thread.summary },
      ...recent,
    ];
  }

  // No summary yet — load recent messages with a placeholder
  const recent = messages.slice(-RECENT_COUNT);
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
    const summarySession = engine.createSession({ model: 'fast' });
    const formatted = formatMessagesForSummary(messages.slice(0, -RECENT_COUNT));
    const prompt = `Summarize this conversation concisely in 3-5 paragraphs. Focus on: what was discussed, decisions made, current state of work, and any pending items.\n\n${formatted.slice(0, 30_000)}`;
    // Run as an INTERNAL summary (mirror compact()): a budget/credit guard block is
    // then THROWN (InternalRunBlockedError) instead of RETURNED as a string, so a
    // guard block ("Daily spending cap reached…") can never be persisted as the
    // thread's authoritative summary — which would replace the real conversation
    // summary on every future resume (permanent context loss). A throw lands in the
    // catch → nothing persisted → retried on the next resume.
    let summary = await summarySession.run(prompt, { noTools: true, internal: true });
    if (!summary) return; // empty reply / provider blip — leave prior summary, retry next resume

    // Mask any secret the summarizer echoed from the conversation BEFORE persisting:
    // threads.summary rides backup / migration-export / debug-export and is read back
    // on resume, so a raw secret must not live there (mirror compact()'s pre-persist mask).
    const secretStore = engine.getSecretStore();
    if (secretStore) summary = secretStore.maskSecrets(summary);

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
        // Resume: load messages from persisted thread. `apiOnly` excludes
        // B-full display-only rows (failed-turn notes + the failed user
        // message) so they never re-enter the model's API context — they
        // exist purely for the render history.
        const messageRecords = threadStore!.getMessages(sessionId, { apiOnly: true });
        const messages: BetaMessageParam[] = messageRecords.map(r => ({
          role: r.role as 'user' | 'assistant',
          content: JSON.parse(r.content_json) as BetaMessageParam['content'],
        }));

        session = engine.createSession({
          ...opts,
          sessionId,
          // Normalize the persisted tier at this restore boundary. Threads
          // created before the 2026-05-29 tier rename store legacy
          // Anthropic-brand names (`sonnet`/`opus`/`haiku`) in `model_tier`;
          // an un-normalized cast let those reach `MODEL_MAP[tier]` (→
          // undefined → `normalizeModelId(undefined).replace` → 500) on the
          // POST /api/sessions resume path, so clicking a pre-rename thread
          // showed an empty chat until a full refresh (which uses the GET
          // messages path that skips this lookup). normalizeTier falls back
          // to opts/config default for anything unrecognized.
          model: normalizeTier(thread.model_tier) ?? opts?.model,
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
