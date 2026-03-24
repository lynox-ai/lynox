import type { ToolEntry, IAgent } from '../../types/index.js';
import type { GoogleAuth } from './google-auth.js';
import { SCOPES } from './google-auth.js';
import { getErrorMessage } from '../../core/utils.js';
import { wrapUntrustedData } from '../../core/data-boundary.js';

// === Types ===

interface CalendarInput {
  action: 'list_events' | 'create_event' | 'update_event' | 'delete_event' | 'free_busy';
  calendar_id?: string | undefined;
  event_id?: string | undefined;
  time_min?: string | undefined;
  time_max?: string | undefined;
  summary?: string | undefined;
  description?: string | undefined;
  location?: string | undefined;
  start?: string | undefined;
  end?: string | undefined;
  attendees?: string[] | undefined;
  all_day?: boolean | undefined;
  timezone?: string | undefined;
  recurrence?: string[] | undefined;
  updates?: Record<string, unknown> | undefined;
  calendars?: string[] | undefined;
  max_results?: number | undefined;
}

interface CalendarEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: Array<{ email: string; responseStatus?: string; displayName?: string }>;
  status?: string;
  htmlLink?: string;
  organizer?: { email: string; displayName?: string };
  recurrence?: string[];
  created?: string;
  updated?: string;
}

interface EventListResponse {
  items?: CalendarEvent[];
  summary?: string;
  timeZone?: string;
}

interface FreeBusyResponse {
  calendars: Record<string, { busy: Array<{ start: string; end: string }> }>;
  timeMin: string;
  timeMax: string;
}

// === Constants ===

const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';
const CONFIRM_ACTIONS = new Set(['create_event', 'update_event', 'delete_event']);
const WRITE_ACTIONS = new Set(['create_event', 'update_event', 'delete_event']);

// === Helpers ===

async function calendarFetch(auth: GoogleAuth, url: string, options?: RequestInit): Promise<Response> {
  const token = await auth.getAccessToken();
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    signal: options?.signal ?? AbortSignal.timeout(30_000),
  });
  return response;
}

function formatEventTime(ev: CalendarEvent): string {
  if (ev.start.date) {
    // All-day event
    const endDate = ev.end.date ?? ev.start.date;
    return ev.start.date === endDate ? ev.start.date : `${ev.start.date} – ${endDate}`;
  }
  const start = ev.start.dateTime ? new Date(ev.start.dateTime) : null;
  const end = ev.end.dateTime ? new Date(ev.end.dateTime) : null;
  if (!start) return '(no time)';

  const startStr = start.toISOString().slice(0, 16).replace('T', ' ');
  if (!end) return startStr;

  // Same day?
  if (start.toDateString() === end.toDateString()) {
    return `${startStr} – ${end.toISOString().slice(11, 16)}`;
  }
  return `${startStr} – ${end.toISOString().slice(0, 16).replace('T', ' ')}`;
}

function formatAttendees(attendees: CalendarEvent['attendees']): string {
  if (!attendees || attendees.length === 0) return '';
  return '\n  Attendees: ' + attendees.map(a => {
    const name = a.displayName ? `${a.displayName} <${a.email}>` : a.email;
    const status = a.responseStatus ? ` (${a.responseStatus})` : '';
    return `${name}${status}`;
  }).join(', ');
}

// === Tool Creation ===

export function createCalendarTool(auth: GoogleAuth): ToolEntry<CalendarInput> {
  return {
    definition: {
      name: 'google_calendar',
      description: 'Interact with Google Calendar: list upcoming events, create/update/delete events, check free/busy times. Use action "list_events" to see upcoming events (default: next 7 days), "create_event" with summary, start, end times, "update_event" to modify an existing event, "delete_event" to remove an event, "free_busy" to check availability across calendars.',
      eager_input_streaming: true,
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['list_events', 'create_event', 'update_event', 'delete_event', 'free_busy'],
            description: 'Calendar action to perform',
          },
          calendar_id: {
            type: 'string',
            description: 'Calendar ID (default: "primary")',
          },
          event_id: {
            type: 'string',
            description: 'Event ID (required for: update_event, delete_event)',
          },
          time_min: {
            type: 'string',
            description: 'Start of time range (ISO 8601). Default: now',
          },
          time_max: {
            type: 'string',
            description: 'End of time range (ISO 8601). Default: 7 days from now',
          },
          summary: {
            type: 'string',
            description: 'Event title (for: create_event)',
          },
          description: {
            type: 'string',
            description: 'Event description',
          },
          location: {
            type: 'string',
            description: 'Event location',
          },
          start: {
            type: 'string',
            description: 'Event start time (ISO 8601) or date (YYYY-MM-DD for all-day). Required for: create_event',
          },
          end: {
            type: 'string',
            description: 'Event end time (ISO 8601) or date (YYYY-MM-DD for all-day). Required for: create_event',
          },
          attendees: {
            type: 'array',
            items: { type: 'string' },
            description: 'Email addresses of attendees',
          },
          all_day: {
            type: 'boolean',
            description: 'Create as all-day event (use date format for start/end)',
          },
          timezone: {
            type: 'string',
            description: 'Timezone (e.g. "Europe/Berlin"). Default: calendar default',
          },
          recurrence: {
            type: 'array',
            items: { type: 'string' },
            description: 'RRULE strings for recurring events, e.g. ["RRULE:FREQ=WEEKLY;COUNT=10"]',
          },
          updates: {
            type: 'object',
            description: 'Fields to update (for: update_event). Keys: summary, description, location, start, end, attendees',
          },
          calendars: {
            type: 'array',
            items: { type: 'string' },
            description: 'Calendar IDs to check (for: free_busy). Default: ["primary"]',
          },
          max_results: {
            type: 'number',
            description: 'Max events to return (default: 25, max: 100)',
          },
        },
        required: ['action'],
      },
    },
    handler: async (input: CalendarInput, agent: IAgent): Promise<string> => {
      try {
        // Check write scope
        if (WRITE_ACTIONS.has(input.action) && !auth.hasScope(SCOPES.CALENDAR_EVENTS)) {
          return `Error: This action requires calendar write permissions. Run /google auth to grant access.`;
        }

        // Confirmation — fail-safe: block if no prompt available
        if (CONFIRM_ACTIONS.has(input.action) && !agent.promptUser) {
          return `Error: "${input.action}" requires user confirmation but no interactive prompt is available (autonomous/background mode). Use assistant mode for this action.`;
        }
        if (CONFIRM_ACTIONS.has(input.action) && agent.promptUser) {
          let confirmMsg = '';
          switch (input.action) {
            case 'create_event': {
              const attendeeStr = input.attendees?.length ? ` with ${input.attendees.join(', ')}` : '';
              confirmMsg = `Create event "${input.summary ?? '(untitled)'}"\nTime: ${input.start ?? '?'} – ${input.end ?? '?'}${attendeeStr}${input.attendees?.length ? '\nThis will send calendar invites.' : ''}`;
              break;
            }
            case 'update_event': confirmMsg = `Update event ${input.event_id ?? '(unknown)'}?`; break;
            case 'delete_event': confirmMsg = `Delete event ${input.event_id ?? '(unknown)'}? This cannot be undone.`; break;
          }
          const answer = await agent.promptUser(confirmMsg, ['Yes', 'No']);
          if (answer.toLowerCase() !== 'yes' && answer !== '1') {
            return 'Action cancelled by user.';
          }
        }

        switch (input.action) {
          case 'list_events': return await handleListEvents(auth, input);
          case 'create_event': return await handleCreateEvent(auth, input);
          case 'update_event': return await handleUpdateEvent(auth, input);
          case 'delete_event': return await handleDeleteEvent(auth, input);
          case 'free_busy': return await handleFreeBusy(auth, input);
          default: return `Error: Unknown action "${input.action}".`;
        }
      } catch (err: unknown) {
        return `Calendar error: ${getErrorMessage(err)}`;
      }
    },
  };
}

// === Action Handlers ===

async function handleListEvents(auth: GoogleAuth, input: CalendarInput): Promise<string> {
  const calendarId = input.calendar_id ?? 'primary';
  const now = new Date();
  const timeMin = input.time_min ?? now.toISOString();
  const timeMax = input.time_max ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const maxResults = Math.min(input.max_results ?? 25, 100);

  const params = new URLSearchParams({
    timeMin,
    timeMax,
    maxResults: String(maxResults),
    singleEvents: 'true',
    orderBy: 'startTime',
  });

  const response = await calendarFetch(auth, `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params}`);
  if (!response.ok) return `Error: Failed to list events (${response.status}).`;

  const data = await response.json() as EventListResponse;
  if (!data.items || data.items.length === 0) {
    return `No events found between ${timeMin.slice(0, 10)} and ${timeMax.slice(0, 10)}.`;
  }

  const lines = data.items.map(ev => {
    const time = formatEventTime(ev);
    const loc = ev.location ? `\n  Location: ${ev.location}` : '';
    const attendees = formatAttendees(ev.attendees);
    const desc = ev.description ? `\n  ${ev.description.slice(0, 200)}` : '';
    return `- **${ev.summary ?? '(No title)'}**\n  ${time}${loc}${attendees}${desc}\n  ID: ${ev.id}`;
  });

  const listing = `Calendar: ${data.summary ?? calendarId} (${data.timeZone ?? ''})\nEvents (${data.items.length}):\n\n${lines.join('\n\n')}`;
  // Wrap as untrusted — event summaries/descriptions are attacker-controlled via calendar invites
  return wrapUntrustedData(listing, 'google_calendar:events');
}

async function handleCreateEvent(auth: GoogleAuth, input: CalendarInput): Promise<string> {
  if (!input.start) return 'Error: "start" is required for action "create_event".';
  if (!input.end) return 'Error: "end" is required for action "create_event".';

  const calendarId = input.calendar_id ?? 'primary';
  const isAllDay = input.all_day ?? (input.start.length === 10); // YYYY-MM-DD

  const event: Record<string, unknown> = {
    summary: input.summary ?? 'Untitled Event',
    description: input.description,
    location: input.location,
    start: isAllDay
      ? { date: input.start }
      : { dateTime: input.start, timeZone: input.timezone },
    end: isAllDay
      ? { date: input.end }
      : { dateTime: input.end, timeZone: input.timezone },
  };

  if (input.attendees?.length) {
    event['attendees'] = input.attendees.map(email => ({ email }));
  }
  if (input.recurrence?.length) {
    event['recurrence'] = input.recurrence;
  }

  const response = await calendarFetch(auth, `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST',
    body: JSON.stringify(event),
  });

  if (!response.ok) {
    const text = await response.text();
    return `Error: Failed to create event (${response.status}): ${text}`;
  }

  const result = await response.json() as CalendarEvent;
  return `Event created.\nTitle: ${result.summary}\nTime: ${formatEventTime(result)}\nID: ${result.id}\nLink: ${result.htmlLink}`;
}

async function handleUpdateEvent(auth: GoogleAuth, input: CalendarInput): Promise<string> {
  if (!input.event_id) return 'Error: "event_id" is required for action "update_event".';

  const calendarId = input.calendar_id ?? 'primary';
  const updates: Record<string, unknown> = {};

  // Apply updates from the updates field or individual fields
  if (input.updates) {
    Object.assign(updates, input.updates);
  }
  if (input.summary) updates['summary'] = input.summary;
  if (input.description) updates['description'] = input.description;
  if (input.location) updates['location'] = input.location;
  if (input.start) {
    const isAllDay = input.all_day ?? (input.start.length === 10);
    updates['start'] = isAllDay ? { date: input.start } : { dateTime: input.start, timeZone: input.timezone };
  }
  if (input.end) {
    const isAllDay = input.all_day ?? (input.end.length === 10);
    updates['end'] = isAllDay ? { date: input.end } : { dateTime: input.end, timeZone: input.timezone };
  }
  if (input.attendees) {
    updates['attendees'] = input.attendees.map(email => ({ email }));
  }

  const response = await calendarFetch(auth, `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${input.event_id}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });

  if (!response.ok) {
    const text = await response.text();
    return `Error: Failed to update event (${response.status}): ${text}`;
  }

  const result = await response.json() as CalendarEvent;
  return `Event updated.\nTitle: ${result.summary}\nTime: ${formatEventTime(result)}\nLink: ${result.htmlLink}`;
}

async function handleDeleteEvent(auth: GoogleAuth, input: CalendarInput): Promise<string> {
  if (!input.event_id) return 'Error: "event_id" is required for action "delete_event".';

  const calendarId = input.calendar_id ?? 'primary';
  const response = await calendarFetch(auth, `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${input.event_id}`, {
    method: 'DELETE',
  });

  if (!response.ok) return `Error: Failed to delete event (${response.status}).`;
  return `Event ${input.event_id} deleted.`;
}

async function handleFreeBusy(auth: GoogleAuth, input: CalendarInput): Promise<string> {
  const now = new Date();
  const timeMin = input.time_min ?? now.toISOString();
  const timeMax = input.time_max ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const calendarIds = input.calendars ?? ['primary'];

  const response = await calendarFetch(auth, `${CALENDAR_BASE}/freeBusy`, {
    method: 'POST',
    body: JSON.stringify({
      timeMin,
      timeMax,
      items: calendarIds.map(id => ({ id })),
    }),
  });

  if (!response.ok) return `Error: Failed to check free/busy (${response.status}).`;

  const data = await response.json() as FreeBusyResponse;
  const lines: string[] = [`Free/Busy: ${timeMin.slice(0, 10)} – ${timeMax.slice(0, 10)}\n`];

  for (const [calId, cal] of Object.entries(data.calendars)) {
    if (cal.busy.length === 0) {
      lines.push(`**${calId}**: All free`);
    } else {
      lines.push(`**${calId}**: ${cal.busy.length} busy slots`);
      for (const slot of cal.busy) {
        const start = new Date(slot.start).toISOString().slice(0, 16).replace('T', ' ');
        const end = new Date(slot.end).toISOString().slice(11, 16);
        lines.push(`  - ${start} – ${end}`);
      }
    }
  }

  return lines.join('\n');
}
