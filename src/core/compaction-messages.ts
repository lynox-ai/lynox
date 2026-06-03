// Pure assembly of the message history that replaces the full conversation
// after a compaction. Extracted from `Session.compact()` so the post-reset
// shape — summary, recall-handle descriptors, and the optional scope-confirm
// steer — is unit-testable without driving a real summary run.

import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';

/** A large tool result evicted into the blob store, re-fetchable until the
 *  next compaction. */
export interface RecallHandle {
  id: string;
  descriptor: string;
}

export interface PostCompactionOpts {
  /** Inject a one-time steer telling the agent to restate the task and
   *  confirm scope before continuing — used by AUTO-compaction (which fires
   *  mid-task, unprompted) so the agent doesn't silently rebuild from a lossy
   *  summary. Not set for an explicit user `/compact` (the user initiated it). */
  confirmScope?: boolean | undefined;
}

export function buildPostCompactionMessages(
  summary: string,
  handles: RecallHandle[],
  opts: PostCompactionOpts = {},
): BetaMessageParam[] {
  const messages: BetaMessageParam[] = [
    { role: 'user', content: 'What have we discussed so far?' },
    { role: 'assistant', content: `[Conversation summary]\n${summary}` },
  ];

  // D2 stub-with-a-handle: tell the agent which large tool results from before
  // the summary are still re-fetchable, one descriptor per id.
  if (handles.length > 0) {
    const lines = handles.map(h => `- recall_tool_result("${h.id}") — ${h.descriptor}`);
    messages.push(
      {
        role: 'user',
        content: 'Are any large tool results from before the summary still available?',
      },
      {
        role: 'assistant',
        content:
          `[Recallable tool results]\nThese large tool outputs from before the summary were set aside and can be re-fetched verbatim with recall_tool_result("<id>"). They remain available only until the next compaction:\n${lines.join('\n')}`,
      },
    );
  }

  // Scope-confirm steer for auto-compaction: bake a self-commitment into the
  // post-compaction context so the agent's NEXT turn opens by restating the
  // task and confirming scope instead of silently continuing from the summary.
  if (opts.confirmScope) {
    messages.push(
      {
        role: 'user',
        content: 'The history was just summarized to free up context. What should you do before continuing?',
      },
      {
        role: 'assistant',
        content:
          `[Post-compaction check]\nThe earlier conversation was summarized to free up context, so I'm now working from the summary above, not the full history. Before any significant further work I'll briefly restate the current task and the immediate next step in my own words and confirm that's still the right scope — rather than silently continuing and risking drift from what was actually asked. If something important looks missing from the summary, I'll ask instead of guessing. For a trivial direct follow-up I'll just answer.`,
      },
    );
  }

  return messages;
}
