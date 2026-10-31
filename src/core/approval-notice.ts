/**
 * Tells the instance that a mail waits for the owner's approval.
 *
 * The pushes carry no values and no free text, so a lock screen shows nothing from the mail:
 * - the owner's devices read „Eine Mail wartet auf deine Freigabe", for every filed entry, with
 *   `data.approvals` for a page to route on (no page reads it yet: a tap opens `/`, like every
 *   push without an `itemId` or `threadId`);
 * - when a mandate's run filed the entry, that grant's devices read „Deine Mail wartet auf die
 *   Freigabe des Inhabers." — the decision is the owner's, so the push carries no mark that could
 *   lead to an approval and its sentence says whose it is. A mandate hears only of its own grant's
 *   entries; an entry the owner's run filed reaches no mandate. A grant that
 *   ended is not reached (the push channel drops it).
 *
 * All pushes of one side share one tag, so a device keeps one notification however many entries
 * arrive, and at most one round leaves per minute. A filing inside that minute is not dropped: one
 * round follows when the minute is up and announces the last entry to the owner and to every grant
 * that filed since the last round. That held round is dropped when the queue was turned off before
 * it fired, and lost with a restart: the stamp and the timer live in the engine process, and a
 * restart starts a fresh minute.
 *
 * The sentences follow {@link noticeLanguage}: the configured language when it is German or
 * English, otherwise German on an instance the control plane provisioned and English on a
 * self-hosted one. The value is read per round, though the engine only takes a new one at restart.
 */
import type { NotificationMessage, NotificationRouter } from './notification-router.js';
import type { FiledEntry } from './approval-store.js';
import { runOutsideGroup } from './run-group.js';
import { noticeLanguage } from './notice-language.js';

/** The owner's push, in German. */
export const APPROVAL_NOTICE_OWNER: Readonly<NotificationMessage> = Object.freeze({
  title: 'lynox',
  body: 'Eine Mail wartet auf deine Freigabe',
  priority: 'normal',
  // The tag the push channel gives the notification: one for all entries, so they collapse.
  taskId: 'lynox-approval-queue',
  audience: 'owner',
  data: Object.freeze({ approvals: '1' }),
});

/**
 * A mandate's push, in German: the owner's decision, named as such, and nothing that opens an
 * approval. Sent with the filing grant's `mandateId`; without one the push channel reaches nobody.
 */
export const APPROVAL_NOTICE_MANDATE: Readonly<NotificationMessage> = Object.freeze({
  title: 'lynox',
  body: 'Deine Mail wartet auf die Freigabe des Inhabers.',
  priority: 'normal',
  taskId: 'lynox-approval-queue-mandate',
  audience: 'mandates',
});

/** The owner's push for an instance set to English: the same message, the sentence translated. */
export const APPROVAL_NOTICE_OWNER_EN: Readonly<NotificationMessage> = Object.freeze({
  ...APPROVAL_NOTICE_OWNER,
  body: 'An email is waiting for your approval.',
});

/** A mandate's push for an instance set to English. */
export const APPROVAL_NOTICE_MANDATE_EN: Readonly<NotificationMessage> = Object.freeze({
  ...APPROVAL_NOTICE_MANDATE,
  body: "Your email is waiting for the owner's approval.",
});

/** The two pushes for the instance's language ({@link noticeLanguage}). */
export function approvalNotices(
  language: string | undefined,
  provisioned?: boolean,
): readonly [Readonly<NotificationMessage>, Readonly<NotificationMessage>] {
  return noticeLanguage(language, provisioned) === 'en'
    ? [APPROVAL_NOTICE_OWNER_EN, APPROVAL_NOTICE_MANDATE_EN]
    : [APPROVAL_NOTICE_OWNER, APPROVAL_NOTICE_MANDATE];
}

/** At most one round of approval pushes per this many milliseconds. */
export const APPROVAL_NOTICE_MIN_GAP_MS = 60_000;

export interface ApprovalNotifierDeps {
  readonly router: Pick<NotificationRouter, 'notify'>;
  /** Whether the queue is on; read at each filing and before a held round, so turning it off stops the pushes at once. */
  readonly enabled: () => boolean;
  /** The instance's configured language, read per round; see {@link noticeLanguage}. */
  readonly language?: (() => string | undefined) | undefined;
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
  // run-group-starter: the held round fires up to a minute later, after the run that filed the
  // entry may have ended; it belongs to no run, so it starts outside any run's group.
  runOutsideGroup(() => setTimeout(run, delayMs)).unref();
}

/** The store's `onFiled` listener: tells the owner and the filing grant, never throws, never waits. */
export function createApprovalNotifier(deps: ApprovalNotifierDeps): (entry: FiledEntry) => void {
  const now = deps.now ?? (() => performance.now());
  const schedule = deps.schedule ?? scheduleUnref;
  let lastSentAt: number | undefined;
  // Each round has a number; a held round remembers the one it follows and stands down when
  // another round went out first, so a late timer cannot send a second round inside the minute.
  let round = 0;
  let heldAfter: number | undefined;
  // The grants that filed since the last round; each hears once in the next one.
  let grants = new Set<string>();

  const notify = (msg: NotificationMessage): void => {
    void deps.router.notify(msg).catch(() => {
      // The router reports a failed channel itself; nothing here can do more.
    });
  };

  const sendRound = (): void => {
    round++;
    lastSentAt = now();
    heldAfter = undefined;
    const due = grants;
    grants = new Set();
    const [owner, mandate] = approvalNotices(deps.language?.());
    notify(copy(owner));
    for (const mandateId of due) notify({ ...copy(mandate), mandateId });
  };

  return (entry: FiledEntry): void => {
    if (!deps.enabled()) return;
    if (entry.mandateId !== null) grants.add(entry.mandateId);
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
      // Turned off meanwhile: the held grants are not carried into a round after it is on again.
      else grants = new Set();
    }, lastSentAt + APPROVAL_NOTICE_MIN_GAP_MS - now());
  };
}
