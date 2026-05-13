// === calendar_create tool (Phase 1b) ===
//
// Creates a single VEVENT on the resolved target account. Write-tool —
// permission-guard blocks it in autonomous mode (PRD §A2,
// `permission-guard.ts:551` CALENDAR_WRITE_TOOLS); interactive mode runs
// the engine's standard confirmation flow ahead of the call.
//
// Default-account resolution (PRD §U2 fallback):
//   • `account_id` explicit → use it (UUID v4 validated)
//   • `account_id` omitted →
//       1 writable account total       → use it (no question)
//       2+ + one flagged as default    → use the flagged one
//       2+ + no default                → return ambiguity error; user
//                                        decides via IntegrationsView
//                                        "Set as Default" or re-prompts
//                                        with explicit account_id
//       0 writable                     → return "no writable calendar"

import type { IAgent, ToolEntry } from '../../../types/index.js';
import { CalendarError } from '../provider.js';
import { hasDangerousFreq } from '../providers/rrule-safety.js';
import type { CalendarEventInput, CalendarProvider } from '../../../types/calendar.js';
import type { CalendarRegistry } from './registry.js';

interface CalendarCreateInput {
  summary: string;
  start: string;
  end: string;
  account_id?: string | undefined;
  description?: string | undefined;
  location?: string | undefined;
  all_day?: boolean | undefined;
  attendees?: Array<{ email: string; name?: string | undefined }> | undefined;
  status?: 'confirmed' | 'tentative' | undefined;
  recurrence?: string[] | undefined;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_V4_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

export interface CalendarWritableResolver {
  /** Returns the UUID of the account flagged as default-writable, if any. */
  getDefaultWritableId(): string | null;
  /** Returns all account UUIDs that can accept writes (CalDAV only — ICS is read-only). */
  listWritableIds(): ReadonlyArray<string>;
}

export function createCalendarCreateTool(
  registry: CalendarRegistry,
  resolver: CalendarWritableResolver,
): ToolEntry<CalendarCreateInput> {
  return {
    definition: {
      name: 'calendar_create',
      description:
        'Create an event on a connected calendar account. Requires confirmation before execution. Pass `account_id` (UUID) explicitly when multiple writable accounts are connected; omit to use the user-selected default. Use ISO 8601 timestamps for start/end.',
      input_schema: {
        type: 'object' as const,
        properties: {
          summary: { type: 'string', description: 'Event title.' },
          start: { type: 'string', description: 'ISO 8601 start (e.g. 2026-05-20T14:00:00Z).' },
          end: { type: 'string', description: 'ISO 8601 end. Must be ≥ start.' },
          account_id: {
            type: 'string',
            pattern: UUID_V4_PATTERN,
            description: 'Target account UUID. Omit to use the default writable account.',
          },
          description: { type: 'string', description: 'Optional event body / notes.' },
          location: { type: 'string', description: 'Optional location (free text or address).' },
          all_day: { type: 'boolean', description: 'True for date-only events; start/end then use date-precision.' },
          attendees: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                email: { type: 'string', format: 'email' },
                name: { type: 'string' },
              },
              required: ['email'],
            },
            description: 'Attendees to invite. Invitations are sent by the CalDAV server if it supports iMIP.',
          },
          status: { type: 'string', enum: ['confirmed', 'tentative'], description: 'Default confirmed.' },
          recurrence: {
            type: 'array',
            items: { type: 'string' },
            description: 'RFC 5545 RRULE strings (e.g. "FREQ=WEEKLY;BYDAY=MO,WE,FR").',
          },
        },
        required: ['summary', 'start', 'end'],
      },
    },
    requiresConfirmation: true,
    handler: async (input: CalendarCreateInput, agent: IAgent): Promise<string> => {
      // Fail-closed: write-tools require interactive user confirmation. The
      // permission-guard already blocks `calendar_create` in autonomous mode
      // (PRD §A2 + permission-guard.ts), but a missing promptUser hook
      // would otherwise let the call slip through in environments that
      // bypass the guard. Match the mail_send pattern (mail-send.ts:92).
      if (!agent.promptUser) {
        return 'calendar_create error: writing to a calendar requires interactive user confirmation, which is not available in this mode.';
      }
      const promptUser = agent.promptUser;

      // Validate inputs BEFORE building the preview. Each helper returns null
      // on success or an error message string. Order is least-to-most-expensive
      // so cheap rejects (empty summary, bad date) short-circuit before SQL.
      const inputError = validateCreateInput(input);
      if (inputError) return inputError;

      let provider: CalendarProvider;
      try {
        provider = resolveCreateTarget(registry, resolver, input.account_id);
      } catch (err) {
        return errorMessage(err);
      }
      if (provider.create === undefined) {
        return `Account ${provider.accountId} is read-only (provider=${provider.name}). Use a CalDAV account for new events.`;
      }

      const event: CalendarEventInput = {
        summary: input.summary.trim(),
        start: input.start,
        end: input.end,
      };
      if (input.description) event.description = input.description;
      if (input.location) event.location = input.location;
      if (input.all_day === true) event.all_day = true;
      if (input.status) event.status = input.status;
      if (input.recurrence && input.recurrence.length > 0) event.recurrence = input.recurrence;
      if (input.attendees && input.attendees.length > 0) {
        event.attendees = input.attendees.map((a) => (a.name ? { email: a.email, name: a.name } : { email: a.email }));
      }

      const preview = buildCreatePreview(provider.accountId, event);
      const answer = await promptUser(preview, ['Yes', 'No']);
      if (!isApproval(answer)) {
        return 'calendar_create: User declined the event-creation prompt — no event was written.';
      }

      try {
        const created = await provider.create(event);
        const lines = [
          `✓ Termin angelegt`,
          `Account: ${provider.accountId}`,
          `UID: ${created.uid}`,
          `${created.start} → ${created.end}`,
        ];
        if (created.source.etag) lines.push(`etag: ${created.source.etag}`);
        if (event.attendees && event.attendees.length > 0) {
          lines.push(`Einladungen versandt: ${event.attendees.map((a) => a.email).join(', ')} (via Server, sofern unterstützt)`);
        }
        return lines.join('\n');
      } catch (err) {
        return errorMessage(err);
      }
    },
  };
}

function resolveCreateTarget(
  registry: CalendarRegistry,
  resolver: CalendarWritableResolver,
  account_id: string | undefined,
): CalendarProvider {
  if (account_id !== undefined) {
    if (!UUID_V4.test(account_id)) {
      throw new CalendarError('malformed_event', `account_id "${account_id}" is not a UUID. PRD §S8: only account UUIDs accepted.`);
    }
    const provider = registry.get(account_id);
    if (!provider) throw new CalendarError('not_found', `No calendar account with id ${account_id}`);
    if (provider.accountId !== account_id) throw new CalendarError('not_found', `Provider binding mismatch (PRD §S11)`);
    return provider;
  }

  const writable = resolver.listWritableIds();
  if (writable.length === 0) {
    throw new CalendarError('not_found', 'No writable calendar account configured. Open Settings → Integrations → Calendar to add a CalDAV account.');
  }
  if (writable.length === 1) {
    const provider = registry.get(writable[0]!);
    if (!provider) throw new CalendarError('not_found', `Default writable provider missing from registry`);
    return provider;
  }
  const defaultId = resolver.getDefaultWritableId();
  if (defaultId) {
    const provider = registry.get(defaultId);
    if (provider) return provider;
  }
  // Ambiguous + no default: surface a helpful error rather than picking arbitrarily.
  // The agent can re-prompt with explicit account_id or the user can set a default in IntegrationsView.
  throw new CalendarError(
    'malformed_event',
    `Multiple writable accounts (${writable.length}) and no default set. Set one as default in Settings → Integrations → Calendar, or pass account_id explicitly. Available: ${writable.join(', ')}.`,
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof CalendarError) return `calendar_create error: ${err.code} — ${err.message}`;
  return `calendar_create error: ${err instanceof Error ? err.message : String(err)}`;
}

// ── Input validation (PRD §S1/§S2/§S3/§S4/§K3) ──────────────────────────────
//
// All agent-supplied text flows into the CalDAV server's iCal payload. The
// adapter's `escapeIcalText` handles RFC 5545 TEXT escapes, but two surfaces
// bypass it: email-shaped fields go directly into `mailto:` lines, and RRULE
// strings go directly into `RRULE:` lines. Validate both at write-time to
// close VEVENT-smuggling via CRLF injection and CPU-DoS via FREQ=SECONDLY.

const MAX_SUMMARY = 512;
const MAX_DESCRIPTION = 32 * 1024;
const MAX_LOCATION = 512;
const MAX_ATTENDEES = 100;
const MAX_RRULES = 25;
const MAX_RRULE_LEN = 512;

// Strict email shape: no whitespace, no CRLF, no `,`/`;`/`<>`/`"` that would
// break a mailto: or CN= parameter. Pragmatic — not RFC 5321 in full — but
// closes the smuggling surface for ATTENDEE/ORGANIZER lines.
const EMAIL_RE = /^[^\s@,;:<>"]+@[^\s@,;:<>"]+$/;
// Forbids any line-break or smuggling delimiter in RRULE strings.
const RRULE_FORBIDDEN_RE = /[\r\n]/;

function validateCreateInput(input: CalendarCreateInput): string | null {
  if (!input.summary || !input.summary.trim()) {
    return 'calendar_create error: summary is required';
  }
  if (input.summary.length > MAX_SUMMARY) {
    return `calendar_create error: summary exceeds ${MAX_SUMMARY} chars`;
  }
  if (input.description !== undefined && input.description.length > MAX_DESCRIPTION) {
    return `calendar_create error: description exceeds ${MAX_DESCRIPTION} chars`;
  }
  if (input.location !== undefined && input.location.length > MAX_LOCATION) {
    return `calendar_create error: location exceeds ${MAX_LOCATION} chars`;
  }

  const startMs = Date.parse(input.start);
  const endMs = Date.parse(input.end);
  if (!Number.isFinite(startMs)) return `calendar_create error: invalid start "${input.start}"`;
  if (!Number.isFinite(endMs)) return `calendar_create error: invalid end "${input.end}"`;
  if (endMs < startMs) {
    return `calendar_create error: end (${input.end}) must be on or after start (${input.start})`;
  }

  if (input.attendees) {
    if (input.attendees.length > MAX_ATTENDEES) {
      return `calendar_create error: max ${MAX_ATTENDEES} attendees per event`;
    }
    for (const a of input.attendees) {
      if (typeof a.email !== 'string' || !EMAIL_RE.test(a.email)) {
        return `calendar_create error: attendee email "${a.email}" is not a valid address (no whitespace/CRLF/<>;,: allowed — PRD §S1)`;
      }
      if (a.name !== undefined && /[\r\n]/.test(a.name)) {
        return `calendar_create error: attendee name must not contain newlines (PRD §S1)`;
      }
    }
  }

  if (input.recurrence) {
    if (input.recurrence.length > MAX_RRULES) {
      return `calendar_create error: max ${MAX_RRULES} RRULE entries per event`;
    }
    for (const rule of input.recurrence) {
      if (typeof rule !== 'string' || rule.length === 0) {
        return 'calendar_create error: recurrence entries must be non-empty RRULE strings';
      }
      if (rule.length > MAX_RRULE_LEN) {
        return `calendar_create error: RRULE entry exceeds ${MAX_RRULE_LEN} chars`;
      }
      if (RRULE_FORBIDDEN_RE.test(rule)) {
        return `calendar_create error: RRULE must not contain line breaks (PRD §S2 — VEVENT-smuggling)`;
      }
      if (hasDangerousFreq(rule)) {
        return `calendar_create error: sub-hourly recurrences (FREQ=SECONDLY/MINUTELY) are not allowed (PRD §S4 — CPU-DoS)`;
      }
    }
  }

  return null;
}

// ── Confirmation flow ───────────────────────────────────────────────────────

function buildCreatePreview(accountId: string, event: CalendarEventInput): string {
  const lines = [
    'Termin anlegen?',
    `Titel:       ${event.summary}`,
    `Zeitraum:    ${event.start} → ${event.end}${event.all_day ? ' (ganztägig)' : ''}`,
    `Kalender:    ${accountId}`,
  ];
  if (event.location) lines.push(`Ort:         ${event.location}`);
  if (event.description) {
    const preview = event.description.length > 200 ? `${event.description.slice(0, 200)}…` : event.description;
    lines.push(`Beschreibung: ${preview}`);
  }
  if (event.attendees && event.attendees.length > 0) {
    const list = event.attendees.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ');
    lines.push(`Teilnehmer:  ${list}`);
    lines.push('             (Einladungen werden via CalDAV-Server verschickt, sofern unterstützt)');
  }
  if (event.recurrence && event.recurrence.length > 0) {
    lines.push(`Wiederholung: ${event.recurrence.join('; ')}`);
  }
  return lines.join('\n');
}

function isApproval(answer: string | null | undefined): boolean {
  if (!answer) return false;
  const normalized = answer.trim().toLowerCase();
  return normalized === 'yes' || normalized === 'y' || normalized === 'ja';
}
