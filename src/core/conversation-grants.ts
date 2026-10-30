/**
 * The grants a conversation took data from (PRD connection-attribution A5).
 *
 * One set per conversation. A sub-agent and every step of a pipeline the conversation runs get
 * the SAME object, by reference, so what they fetch is in the set before a later step or the
 * parent writes. A member is a connection's `grant_id`, or {@link UNKNOWN_GRANT} for data from a
 * source that resolved no grant. Members are only ever added.
 *
 * A set that belongs to a thread writes every new member through to history.db
 * (`conversation_grants`, v67) at the moment it enters, synchronously, so the row lands before
 * the message that carries the data. The set holds its thread id and sink itself: a sub-agent
 * has no thread row of its own and writes under its root's. A pipeline started outside a
 * conversation (a schedule) holds a set without a thread, kept in memory for the run only.
 *
 * `add` must stay synchronous: parallel children add to one set, and needing no lock rests on
 * an add and its insert running without an await between them.
 */

/** The member for data whose source resolved no grant. */
export const UNKNOWN_GRANT = 'unknown';

/** Where a thread's set is recorded (history.db, `RunHistory`). */
export interface ConversationGrantSink {
  insertConversationGrant(threadId: string, grantId: string): void;
  getConversationGrants(threadId: string): string[];
}

export class ConversationGrants {
  private readonly _members = new Set<string>();

  private constructor(
    readonly threadId: string | undefined,
    private readonly _sink: ConversationGrantSink | undefined,
  ) {}

  /** A set held in memory only (a pipeline with no conversation). */
  static detached(): ConversationGrants {
    return new ConversationGrants(undefined, undefined);
  }

  /**
   * The set of a thread, with the members already recorded for it. A thread whose rows cannot
   * be read starts with {@link UNKNOWN_GRANT}: what it read before is not known, and reading as
   * clean would under-attribute.
   */
  static forThread(threadId: string, sink: ConversationGrantSink): ConversationGrants {
    const set = new ConversationGrants(threadId, sink);
    try {
      for (const id of sink.getConversationGrants(threadId)) set._members.add(id);
    } catch {
      set.add(UNKNOWN_GRANT);
    }
    return set;
  }

  /**
   * A new object for the same thread, with its recorded members and this one's.
   * `Agent.reset()` replaces its set with this instead of clearing it, so a sub-agent still
   * holding the old object keeps
   * adding under the thread it started in. The thread's members stay: a reset of the same
   * thread (compaction) does not make what the thread already read go away.
   */
  renewed(): ConversationGrants {
    const next = this.threadId === undefined || this._sink === undefined
      ? ConversationGrants.detached()
      : ConversationGrants.forThread(this.threadId, this._sink);
    // A member whose write failed is only in memory; it stays a member.
    for (const id of this._members) next._members.add(id);
    return next;
  }

  /** Add a member. Recorded before this returns; a failed write keeps it in memory. */
  add(grantId: string): void {
    if (this._members.has(grantId)) return;
    this._members.add(grantId);
    if (this.threadId === undefined || this._sink === undefined) return;
    try {
      this._sink.insertConversationGrant(this.threadId, grantId);
    } catch {
      // Like the tool-call recorder: a thread whose row failed fails its appends the same way.
    }
  }

  has(grantId: string): boolean {
    return this._members.has(grantId);
  }

  /** The members, in the order they entered. */
  members(): string[] {
    return [...this._members];
  }
}
