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
 */
export class CalendarError extends Error {
  constructor(
    public readonly code: CalendarErrorCode,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'CalendarError';
  }
}
