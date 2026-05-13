// === Calendar provider — public contract ===
//
// Re-exports the type-surface from `core/src/types/calendar.ts` so adapters
// and tools have a single import root (`from './provider.js'`), plus the
// runtime CalendarError class and a `createCalendarProvider()` factory.
//
// Adapters live in `./providers/`:
//   - caldav.ts    (Phase 1a list + Phase 1b create + Phase 2 update/delete)
//   - ics-feed.ts  (Phase 1a list, polled via WorkerLoop TaskRecord)

export type {
  CalendarAccount,
  CalendarAttendee,
  CalendarEvent,
  CalendarEventInput,
  CalendarErrorCode,
  CalendarListOptions,
  CalendarProvider,
  CalendarProviderKind,
  CalDavAuthType,
  CalDavPreset,
  CalDavPresetSlug,
  DataResidency,
  FreeBusyInterval,
  Wrapped,
} from '../../types/calendar.js';

import type { CalendarErrorCode } from '../../types/calendar.js';

/**
 * Typed error contract for CalDAV + ICS-Feed adapters. Mirrors `MailError`
 * in `core/src/integrations/mail/provider.ts:444`. Code is consumed by the
 * Web UI account-error surface (PRD §U16): `auth_failed` → red-dot +
 * "Anmeldedaten prüfen" toast; `rate_limited`/`quota_exceeded` →
 * "Calendar-Polling pausiert" banner; etc.
 *
 * **Two message channels** (PRD §S5):
 *   • `.message` — verbose; may embed tsdav stack snippets, hostnames,
 *     status codes. Used in stderr logging and `LYNOX_DEBUG=1` output.
 *   • `.publicMessage()` — safe-to-surface; goes to the LLM tool output
 *     and the Web UI. Defaults to a code-keyed generic string; callers
 *     pass an optional `userFacing` override when the construct-site
 *     already has a friendly hint that's safe to emit (e.g. the ICS-404
 *     admin-block message per §S15).
 */
export class CalendarError extends Error {
  constructor(
    public readonly code: CalendarErrorCode,
    message: string,
    public override readonly cause?: unknown,
    private readonly userFacing?: string,
  ) {
    super(message);
    this.name = 'CalendarError';
  }

  /** Safe-to-leak message for LLM context + UI. No URLs, no stacks, no host info. */
  publicMessage(): string {
    return this.userFacing ?? DEFAULT_PUBLIC_MESSAGES[this.code];
  }
}

const DEFAULT_PUBLIC_MESSAGES: Record<CalendarErrorCode, string> = {
  auth_failed: 'Authentication with the calendar server failed. Please check the credentials in Settings.',
  network: 'Could not reach the calendar server. Verify network connection and try again.',
  parse_error: 'The calendar response could not be parsed. The server returned unexpected content.',
  conflict_412: 'The event was modified externally before this update landed. Please refresh and try again.',
  rate_limited: 'Rate limit reached. Wait a minute and try again.',
  not_found: 'The requested calendar account or event was not found.',
  read_only: 'This calendar account is read-only. Connect a CalDAV account to create events.',
  malformed_event: 'Event data is invalid. Check the dates, fields, and attendee emails.',
  quota_exceeded: 'Calendar data exceeded the allowed size cap.',
};
