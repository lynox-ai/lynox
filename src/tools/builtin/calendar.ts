/**
 * `calendar_read` — the operator's appointments, from a subscribed ICS feed.
 *
 * Takes NO url. The feed address is the credential (Google/Outlook/Apple hand out a "secret
 * address" whose secrecy is the entire access control), so it lives in the vault under a
 * `CALENDAR_FEED_*` name, is classed as an infrastructure secret, and is resolved here —
 * engine-side, never as a tool parameter. A URL the model can name is a URL that reaches the
 * run history, and one that grants read access to someone's whole calendar.
 *
 * Read-only by construction: an ICS feed has no write side. That is not a limitation dressed
 * up as a feature — it is why this works at all without OAuth, a Google Cloud project, and the
 * unresettable 100-user cap that comes with an unverified app on a sensitive scope.
 */
import type { ToolEntry, IAgent } from '../../types/index.js';
import { parseIcsEvents, DEFAULT_MAX_EVENTS, type CalendarEvent } from '../../integrations/calendar/ics.js';
import { fetchIcsFeed } from '../../integrations/calendar/fetch.js';
import { getErrorMessage } from '../../core/utils.js';

/** Vault-name prefix for a calendar feed. The label after it is what the operator sees. */
export const CALENDAR_FEED_PREFIX = 'CALENDAR_FEED_';

/** Window default when the model names neither end — "what is coming up". */
const DEFAULT_WINDOW_DAYS = 7;
/** Ceiling on the requested window. A year of a busy calendar is not an answer to a question. */
const MAX_WINDOW_DAYS = 92;

interface CalendarReadInput {
  from?: string | undefined;
  to?: string | undefined;
  calendar?: string | undefined;
}

/** Feed labels the operator has configured. Names only — never the addresses. */
function configuredFeeds(agent: IAgent): string[] {
  const store = agent.secretStore;
  if (!store) return [];
  return store.listNames()
    .filter(n => n.startsWith(CALENDAR_FEED_PREFIX))
    .map(n => n.slice(CALENDAR_FEED_PREFIX.length))
    .filter(label => label.length > 0)
    .sort();
}

function parseBound(value: string | undefined, fallback: Date): Date | null {
  if (value === undefined || value.trim() === '') return fallback;
  // A bare date means the operator's whole day, not midnight UTC — but the engine has no
  // business guessing their zone here, so a date-only bound is read as UTC midnight and the
  // window is generous enough that the distinction does not move an appointment out of view.
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? `${value.trim()}T00:00:00Z` : value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const calendarReadTool: ToolEntry<CalendarReadInput> = {
  definition: {
    name: 'calendar_read',
    description:
      'Read the operator\'s appointments from their connected calendar for a time window. '
      + 'Use when the answer depends on what is actually scheduled — availability, conflicts, '
      + 'what is coming up, whether a proposed time is free. Read-only: it cannot create or '
      + 'move appointments. Defaults to the next 7 days.',
    input_schema: {
      type: 'object' as const,
      properties: {
        from: { type: 'string', description: 'Window start, ISO date or date-time. Default: now.' },
        to: { type: 'string', description: 'Window end, ISO date or date-time. Default: 7 days after `from`.' },
        calendar: { type: 'string', description: 'Which calendar, when several are connected. Omit to read all of them.' },
      },
      required: [],
    },
  },
  handler: async (input: CalendarReadInput, agent: IAgent): Promise<string> => {
    const store = agent.secretStore;
    const labels = configuredFeeds(agent);
    if (!store || labels.length === 0) {
      return 'No calendar is connected. The operator can connect one by adding its private iCal address '
        + '(Google Calendar → Settings → "Secret address in iCal format"; Outlook and Apple have the same) '
        + `as a secret named ${CALENDAR_FEED_PREFIX}MAIN. It is read-only and needs no Google sign-in.`;
    }

    const wanted = input.calendar?.trim();
    const selected = wanted
      ? labels.filter(l => l.toLowerCase() === wanted.toLowerCase())
      : labels;
    if (selected.length === 0) {
      return `No calendar named "${wanted ?? ''}". Connected: ${labels.join(', ')}.`;
    }

    const now = new Date();
    const from = parseBound(input.from, now);
    if (!from) return `Could not read "${input.from ?? ''}" as a date.`;
    const to = parseBound(input.to, new Date(from.getTime() + DEFAULT_WINDOW_DAYS * 86_400_000));
    if (!to) return `Could not read "${input.to ?? ''}" as a date.`;
    if (to.getTime() <= from.getTime()) return 'The window ends before it starts.';
    const days = (to.getTime() - from.getTime()) / 86_400_000;
    if (days > MAX_WINDOW_DAYS) {
      return `That window is ${String(Math.round(days))} days. Ask for at most ${String(MAX_WINDOW_DAYS)} at a time.`;
    }

    const all: Array<CalendarEvent & { calendar: string }> = [];
    const failed: string[] = [];
    let truncated = false;
    for (const label of selected) {
      try {
        const url = store.resolve(`${CALENDAR_FEED_PREFIX}${label}`);
        if (!url) { failed.push(label); continue; }
        const feed = await fetchIcsFeed(url, agent.toolContext);
        const parsed = parseIcsEvents(feed.ics, { from, to, maxEvents: DEFAULT_MAX_EVENTS });
        if (feed.truncated || parsed.truncated) truncated = true;
        for (const e of parsed.events) all.push({ ...e, calendar: label });
      } catch (err) {
        // Named, not swallowed: "I could not reach your calendar" is a different answer from
        // "you have nothing on", and only one of them is safe to act on. The message from
        // `fetchIcsFeed` never carries the address.
        failed.push(`${label} (${getErrorMessage(err)})`);
      }
    }

    all.sort((a, b) => a.start.localeCompare(b.start));
    const lines = all.map(e => {
      const when = e.allDay
        ? `${e.start.slice(0, 10)} (all day)`
        : `${e.start.slice(0, 16).replace('T', ' ')}–${e.end.slice(11, 16)} UTC`;
      const where = e.location ? ` @ ${e.location}` : '';
      const which = selected.length > 1 ? ` [${e.calendar}]` : '';
      return `- ${when} ${e.summary || '(no title)'}${where}${which}`;
    });

    const header = all.length === 0
      ? `No appointments between ${from.toISOString().slice(0, 10)} and ${to.toISOString().slice(0, 10)}.`
      : `${String(all.length)} appointment${all.length === 1 ? '' : 's'} between ${from.toISOString().slice(0, 10)} and ${to.toISOString().slice(0, 10)}:`;

    const notes: string[] = [];
    // Both of these change what the answer MEANS, so they travel with it rather than being
    // dropped: an unreachable calendar makes "nothing on" unsafe to rely on, and a truncated
    // list is not a complete one.
    if (truncated) notes.push('The list was cut short — ask for a narrower window to see the rest.');
    if (failed.length > 0) notes.push(`Could not read: ${failed.join(', ')}. Times below may be incomplete.`);

    return [header, ...lines, ...(notes.length ? ['', ...notes] : [])].join('\n');
  },
};
