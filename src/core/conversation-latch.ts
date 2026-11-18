/**
 * A thread's record that its conversation took in content from outside (history.db,
 * `thread_read_outside`, v74): the agent's sticky latch (`Agent.conversationSawUntrusted`), kept
 * beyond the life of the agent.
 *
 * The agent's own latch is re-derived on a resume from what the loaded history still shows. A
 * compaction summarizes the read away, and a restart loses the agent: the latch would come back
 * clear on a conversation that did read outside content, and a write from it would count as clean
 * (`_written_untrusted`). This record is read on every load (`Agent.loadMessages`) next to the
 * history scan, and a resume counts as having read outside content when either says so.
 *
 * Only set, never cleared: a new conversation is a new thread, which has no record. Set
 * synchronously when the agent's latch is set, which is before the message that carries the read
 * is written. One object per conversation: a sub-agent and every workflow step of the
 * conversation get the same, by reference, and set it under the conversation's thread.
 *
 * Fail-closed both ways: a record that cannot be read counts as set, and a write that fails is
 * kept in memory, where this conversation still reads it as set.
 */

/** Where a thread's record is kept (`ThreadStore`). */
export interface ConversationLatchSink {
  markReadOutside(threadId: string): void;
  readOutside(threadId: string): boolean;
}

export class ConversationLatch {
  private _set = false;

  private constructor(
    readonly threadId: string | undefined,
    private readonly _sink: ConversationLatchSink | undefined,
  ) {}

  /** A record held in memory only (a run with no thread). */
  static detached(): ConversationLatch {
    return new ConversationLatch(undefined, undefined);
  }

  static forThread(threadId: string, sink: ConversationLatchSink): ConversationLatch {
    return new ConversationLatch(threadId, sink);
  }

  /** Record it. Written before this returns; a failed write keeps it in memory. */
  set(): void {
    if (this._set) return;
    this._set = true;
    if (this.threadId === undefined || this._sink === undefined) return;
    try {
      this._sink.markReadOutside(this.threadId);
    } catch {
      // Kept in memory: this conversation still reads it as set.
    }
  }

  /** Whether it is recorded. A record that cannot be read counts as set. */
  isSet(): boolean {
    if (this._set) return true;
    if (this.threadId === undefined || this._sink === undefined) return false;
    try {
      return this._sink.readOutside(this.threadId);
    } catch {
      return true;
    }
  }
}
