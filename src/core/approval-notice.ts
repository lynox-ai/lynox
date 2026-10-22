/**
 * Tells the instance that a mail waits for the owner's approval (PRD unattended-approval-queue
 * §4.9).
 *
 * Two pushes per filed entry, both without values and without free text, so a lock screen shows
 * nothing from the mail:
 * - the owner's devices read „Eine Mail wartet auf deine Freigabe", with `data.approvals` for the
 *   approval list to route on once it exists (today a tap opens `/`, like every push without an
 *   `itemId` or `threadId`);
 * - a live mandate's devices read „Eine Mail wartet auf die Freigabe des Inhabers" — a mandate is
 *   told what the instance tells the owner, but the decision is the owner's, so its push carries no
 *   mark that could lead to an approval and its sentence says whose it is. A mandate whose grant
 *   ended is not reached (the push channel drops it).
 *
 * All pushes of one side share one tag, so a device keeps one notification however many entries
 * arrive, and at most one round leaves per minute. A filing inside that minute is not dropped: one
 * round follows when the minute is up, so the last entry is always announced. The stamp lives in
 * the engine process; a restart starts a fresh minute.
 */
import type { NotificationMessage, NotificationRouter } from './notification-router.js';
import type { FiledEntry } from './approval-store.js';

/** The owner's push. Fixed German text, like every push of the engine today. */
export const APPROVAL_NOTICE_OWNER: Readonly<NotificationMessage> = Object.freeze({
  title: 'lynox',
  body: 'Eine Mail wartet auf deine Freigabe',
  priority: 'normal',
  // The tag the push channel gives the notification: one for all entries, so they collapse.
  taskId: 'lynox-approval-queue',
  audience: 'owner',
  data: Object.freeze({ approvals: '1' }),
});

/** A mandate's push: the owner's decision, named as such, and nothing that opens an approval. */
export const APPROVAL_NOTICE_MANDATE: Readonly<NotificationMessage> = Object.freeze({
  title: 'lynox',
  body: 'Eine Mail wartet auf die Freigabe des Inhabers',
  priority: 'normal',
  taskId: 'lynox-approval-queue-mandate',
  audience: 'mandates',
});

/** At most one round of approval pushes per this many milliseconds. */
export const APPROVAL_NOTICE_MIN_GAP_MS = 60_000;

export interface ApprovalNotifierDeps {
  readonly router: Pick<NotificationRouter, 'notify'>;
  /** Whether the queue is on; read at each filing and before a held round, so turning it off stops the pushes at once. */
  readonly enabled: () => boolean;
  /** A clock that does not step back; `performance.now` by default, so a wall-clock correction cannot hold pushes back. */
  readonly now?: (() => number) | undefined;
  /** Schedules the held round; an unref'd `setTimeout` by default. */
  readonly schedule?: ((run: () => void, delayMs: number) => void) | undefined;
}

/** A fresh copy, so a channel that edits what it was handed cannot change the next push. */
function copy(msg: Readonly<NotificationMessage>): NotificationMessage {
  return { ...msg, ...(msg.data ? { data: { ...msg.data } } : {}) };
}

function scheduleUnref(run: () => void, delayMs: number): void {
  setTimeout(run, delayMs).unref();
}

/** The store's `onFiled` listener: sends both pushes, never throws, never waits. */
export function createApprovalNotifier(deps: ApprovalNotifierDeps): (entry: FiledEntry) => void {
  const now = deps.now ?? (() => performance.now());
  const schedule = deps.schedule ?? scheduleUnref;
  let lastSentAt: number | undefined;
  // Each round has a number; a held round remembers the one it follows and stands down when
  // another round went out first, so a late timer cannot send a second round inside the minute.
  let round = 0;
  let heldAfter: number | undefined;

  const sendRound = (): void => {
    round++;
    lastSentAt = now();
    heldAfter = undefined;
    for (const msg of [APPROVAL_NOTICE_OWNER, APPROVAL_NOTICE_MANDATE]) {
      void deps.router.notify(copy(msg)).catch(() => {
        // The router reports a failed channel itself; nothing here can do more.
      });
    }
  };

  return (_entry: FiledEntry): void => {
    if (!deps.enabled()) return;
    if (lastSentAt === undefined || now() - lastSentAt >= APPROVAL_NOTICE_MIN_GAP_MS) {
      sendRound();
      return;
    }
    // Inside the minute: one round follows when it is up, however many entries arrive meanwhile.
    if (heldAfter === round) return;
    const after = round;
    heldAfter = after;
    schedule(() => {
      // A round went out since this one was held (a filing after the minute): it covered it.
      if (round !== after) return;
      heldAfter = undefined;
      if (deps.enabled()) sendRound();
    }, lastSentAt + APPROVAL_NOTICE_MIN_GAP_MS - now());
  };
}
