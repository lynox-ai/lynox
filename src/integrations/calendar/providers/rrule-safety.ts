// === RRULE safety helpers ===
//
// Two defensive checks used by both CalDAV and ICS adapters to avoid CPU-DoS
// when expanding RFC 5545 RRULEs over a 90-day window:
//
//   • `hasDangerousFreq()` — reject sub-hourly recurrences before any
//     expansion. `FREQ=SECONDLY` over 90 days = ~7.7M instances, enough to
//     stall the event loop. `FREQ=MINUTELY` is still 130K. Phase 1a defers
//     safe sampling to a later sprint; we conservatively assume "may occur"
//     for these to keep them visible to the agent without enumerating.
//     [PRD §S4 / §S14]
//
//   • `recurrenceEndedBefore()` — quick UNTIL-clause parse to drop master
//     events whose recurrence ended before the requested window. Catches
//     the common case where a recurring meeting has UNTIL=<past> and the
//     ICS-feed still ships the master row. [PRD §K7]
//
// COUNT-based RRULEs need actual expansion to bound — out of Phase 1a scope.

const DANGEROUS_FREQ_RE = /FREQ=(SECONDLY|MINUTELY)\b/i;
const UNTIL_RE = /UNTIL=([0-9]+(?:T[0-9]+Z?)?)/i;
const RFC5545_DATE_RE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/;

export function hasDangerousFreq(rule: string): boolean {
  return DANGEROUS_FREQ_RE.test(rule);
}

/**
 * Parse the RFC 5545 UNTIL clause from a RRULE string and return true when
 * the recurrence definitively ended before `date`. Returns false when the
 * clause is missing (open-ended), malformed, or the UNTIL date is on/after
 * `date` — i.e. "may still occur".
 */
export function recurrenceEndedBefore(rules: ReadonlyArray<string>, date: Date): boolean {
  for (const rule of rules) {
    const match = rule.match(UNTIL_RE);
    if (!match) return false; // any open-ended rule keeps the event live
    const until = parseRfc5545Datetime(match[1] ?? '');
    if (until === null) return false; // unparseable — be conservative
    if (until >= date) return false;
  }
  return true;
}

/**
 * Parse RFC 5545 DATE / DATE-TIME (e.g. "20251231T235959Z" or "20260513").
 * Returns null on malformed input.
 */
function parseRfc5545Datetime(value: string): Date | null {
  const m = value.match(RFC5545_DATE_RE);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    h ? Number(h) : 0,
    mi ? Number(mi) : 0,
    s ? Number(s) : 0,
  ));
  return Number.isFinite(date.getTime()) ? date : null;
}
