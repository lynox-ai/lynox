import type { ThreadStore } from './thread-store.js';
import type { NotificationRouter } from './notification-router.js';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';

export interface EscalateOpts {
  /** Stable source key — one escalation thread per key, bumped on repeat
   *  (e.g. a scheduled task id, so a flaky daily cron = one thread, not N). */
  key: string;
  title: string;
  /** The context the user needs — becomes the thread's seed message. */
  body: string;
  /** Channel passthrough merged into the push (`threadId` is always added). */
  data?: Record<string, string> | undefined;
}

/**
 * The reusable Agent→User escalation primitive (Slice B3): open (or BUMP) an
 * UNREAD chat thread seeded with `body` as context, and fire a push that merely
 * POINTS at it (the wakeup, not the content). One thread per `key`, bumped on
 * repeat. The thread is a normal resumable chat thread — the user opens it and
 * replies (Slice C adds the fix/retry tools). Returns the thread id, or null
 * when there is no ThreadStore (a headless setup) — in which case it degrades to
 * a bare push so the user is still notified.
 *
 * A free function (not just an Engine method) so it is unit-testable with a real
 * ThreadStore + a stub router, and so future consumers (the post-sprint Triggers
 * primitive) can reuse it directly.
 */
export function escalateToUser(
  threadStore: ThreadStore | null,
  router: NotificationRouter,
  opts: EscalateOpts,
): { threadId: string } | null {
  if (!threadStore) {
    void router.notify({ title: opts.title, body: opts.body, priority: 'high', ...(opts.data ? { data: opts.data } : {}) });
    return null;
  }
  const threadId = `escalation-${opts.key}`;
  // INSERT OR IGNORE — first event creates the thread (+ its title); later events
  // keep the same row and just append + re-unread below.
  threadStore.createThread(threadId, { title: opts.title });
  // Seed the agent's detail as an `assistant` turn, fronted by a user-role
  // "subject" ONLY when needed to keep the thread a VALID, RESUMABLE Anthropic
  // conversation (the Messages API requires the first message to be `user` and
  // roles to alternate). The leading user turn is required iff the thread is
  // empty (first escalation) OR its last API turn is already `assistant`. If the
  // last API turn is already `user` — a reply the user just sent, or a
  // concurrent bump that landed in that reply's persist window — we append the
  // assistant body ALONE, so no two consecutive `user` rows can ever reach the
  // API (which would 400 on the next cold resume). seq via getNextSeq
  // (MAX(seq)+1, deletion-safe) — not a count-based seq that would collide once
  // Slice C prunes a turn.
  const apiMsgs = threadStore.getMessages(threadId, { apiOnly: true });
  const lastRole = apiMsgs.length > 0 ? apiMsgs[apiMsgs.length - 1]!.role : null;
  const startSeq = threadStore.getNextSeq(threadId);
  const currentCount = threadStore.getThread(threadId)?.message_count ?? 0;
  const seeds: BetaMessageParam[] = [];
  if (lastRole === null || lastRole === 'assistant') {
    seeds.push({ role: 'user', content: [{ type: 'text', text: opts.title }] });
  }
  seeds.push({ role: 'assistant', content: [{ type: 'text', text: opts.body }] });
  threadStore.appendMessages(threadId, seeds, startSeq, { message_count: currentCount + seeds.length });
  // Re-mark unread + bump updated_at → floats to the top of the thread list.
  threadStore.updateThread(threadId, { is_unread: true });
  // The push is the wakeup that points at the thread (not the payload).
  void router.notify({
    title: opts.title,
    body: opts.body.length > 200 ? opts.body.slice(0, 197) + '…' : opts.body,
    priority: 'high',
    data: { ...(opts.data ?? {}), threadId },
  });
  return { threadId };
}
