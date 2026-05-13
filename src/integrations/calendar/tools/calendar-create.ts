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
    handler: async (input: CalendarCreateInput, _agent: IAgent): Promise<string> => {
      let provider: CalendarProvider;
      try {
        provider = resolveCreateTarget(registry, resolver, input.account_id);
      } catch (err) {
        return errorMessage(err);
      }
      if (provider.create === undefined) {
        return `Account ${provider.accountId} is read-only (provider=${provider.name}). Use a CalDAV account for new events.`;
      }
      // Basic input sanity — fields are agent-supplied raw strings; the
      // adapter handles iCal escaping. Date-shape validation reuses Date.parse.
      if (!input.summary.trim()) return 'calendar_create error: summary is required';
      if (!Number.isFinite(Date.parse(input.start))) return `calendar_create error: invalid start "${input.start}"`;
      if (!Number.isFinite(Date.parse(input.end))) return `calendar_create error: invalid end "${input.end}"`;

      const event: CalendarEventInput = {
        summary: input.summary,
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
    requiresConfirmation: true,
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
