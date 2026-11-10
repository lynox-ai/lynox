// === Inbound mail deferral — "not now, hand it over again next tick" ===
//
// An `onInboundMail` hook that cannot take a mail right now throws this. MailContext swallows
// every other hook error (a crashing classifier must not stall the watcher), but lets this one
// through, so the watcher leaves the whole batch unseen and the next tick hands it over again.
// A hook that returned instead would count as handled: the watcher marks the mail seen, and it
// is never classified.

export class InboundMailDeferred extends Error {
  constructor(reason: string) {
    super(`inbound mail deferred: ${reason}`);
    this.name = 'InboundMailDeferred';
  }
}
