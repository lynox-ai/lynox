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

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  getOrCreate(sessionId: string, engine: Engine, opts?: SessionOptions): Session {
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
    return this.sessions.get(sessionId);
  }

  reset(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
