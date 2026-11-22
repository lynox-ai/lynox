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
 * Only set, never cleared: a new conversation is a new thread, which has no record. Setting it
 * arms the thread in its store (`ThreadStore.armReadOutside`); the record itself is written in
 * the same transaction as the next message of the thread, which is the message that carries the
 * read. A write that fails fails that message too: the message is not stored, and the turn ends
 * with an error (`ReadOutsideUnrecordedError`). One object per conversation: a sub-agent and every
 * workflow step of the conversation get the same, by reference, and arm the conversation's thread.
 *
 * A record that cannot be read counts as set.
 */

/** Where a thread's record is kept (`ThreadStore`). */
export interface ConversationLatchSink {
  /** Arm the thread: its next message is written together with the record. */
  armReadOutside(threadId: string): void;
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

  /** Record it: the thread's next message is written with the record, or not at all. */
  set(): void {
    if (this._set) return;
    this._set = true;
    if (this.threadId === undefined || this._sink === undefined) return;
    this._sink.armReadOutside(this.threadId);
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
