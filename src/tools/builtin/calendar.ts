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
 *
 * The RESULT is untrusted content, and this is not a formality. Anyone who can send the
 * operator a calendar invitation can choose the SUMMARY and LOCATION text that this tool reads
 * back into the model's context — an injection channel that needs no compromise of anything,
 * only the operator's address. So the listing is wrapped like any other external content, and
 * `calendar_read` is named in `Agent.EXTERNAL_CONTENT_TOOLS` so a turn that touched a calendar
 * counts as untrusted for durable-knowledge purposes.
 */
import type { ToolEntry, IAgent } from '../../types/index.js';
import { parseIcsEvents, DEFAULT_MAX_EVENTS, type CalendarEvent } from '../../integrations/calendar/ics.js';
import { fetchIcsFeed } from '../../integrations/calendar/fetch.js';
import { wrapUntrustedData } from '../../core/data-boundary.js';
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

/**
 * Read a window bound.
 *
 * A bare `to` date means the operator's whole day. Reading it as midnight drops that day's
 * appointments while the answer still says "between … and the 31st", so a date-only end bound
 * is advanced to the following midnight. The start bound stays at midnight, which is the same
 * intent read from the other end.
 */
function parseBound(value: string | undefined, fallback: Date, endOfDay: boolean): Date | null {
  if (value === undefined || value.trim() === '') return fallback;
  const raw = value.trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const d = new Date(dateOnly ? `${raw}T00:00:00Z` : raw);
  if (Number.isNaN(d.getTime())) return null;
  return dateOnly && endOfDay ? new Date(d.getTime() + 86_400_000) : d;
}

/** `HH:MM` out of an ISO wall time, or null when the value carries no clock at all. */
function clockOf(iso: string): string | null {
  const m = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2})/.exec(iso);
  return m?.[1] ?? null;
}

/**
 * Render one appointment the way the operator wrote it.
 *
 * The times are the feed's own wall times, with the zone named — NOT normalised to UTC. An
 * operator in Zurich has "14:00" in their calendar and should be told 14:00; being told 12:00 UTC
 * is a correct timestamp and a wrong answer.
 */
function renderWhen(e: CalendarEvent): string {
  if (e.allDay) {
    // Not every all-day event has a DATE-valued end. `DTSTART;VALUE=DATE` with a timestamped
    // DTEND violates RFC 5545 §3.8.2.2 and ical.js accepts it anyway, which made this branch
    // build `2026-08-15T10:00:00ZT00:00:00Z` — an Invalid Date whose `toISOString()` throws.
    // Nothing in the handler catches it, so one malformed entry in one feed took down the whole
    // call including every healthy calendar in it. A shape that cannot be reasoned about gets
    // the start date and no invented span.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.end)) return `${e.start} (all day)`;
    // DTEND is exclusive for a DATE-valued event: a one-day event ends the following day, and
    // saying "14.–15." for a single day's holiday would be wrong in the direction that costs a
    // missed appointment.
    const lastDay = new Date(`${e.end}T00:00:00Z`);
    lastDay.setUTCDate(lastDay.getUTCDate() - 1);
    const last = lastDay.toISOString().slice(0, 10);
    return last > e.start ? `${e.start}–${last} (all day)` : `${e.start} (all day)`;
  }
  const zone = e.timezone ? ` ${e.timezone}` : '';
  const startDay = e.start.slice(0, 10);
  const startClock = clockOf(e.start) ?? '';
  const endClock = clockOf(e.end);
  const endDay = e.end.slice(0, 10);
  if (endClock === null) {
    // The mirror of the all-day case above, arriving the same way: `DTSTART` with a time and a
    // DATE-valued `DTEND` is the same §3.8.2.2 violation and ical.js takes it. Slicing a clock
    // out of a bare date yields "", so an earlier version printed "12:00–2026-08-13 ".
    //
    // Dropping the end entirely was the wrong repair, and worse than the malformed string it
    // replaced: an eight-day block rendered as "12:00" reads as a lunchtime appointment, and
    // the operator concludes they are free all week. The end DATE is perfectly legible — only
    // its clock is missing — so it is reported, exclusive like the all-day branch.
    const parsedEnd = new Date(`${endDay}T00:00:00Z`);
    if (Number.isNaN(parsedEnd.getTime())) return `${startDay} ${startClock}${zone}`.replace(/\s+/gu, ' ').trimEnd();
    parsedEnd.setUTCDate(parsedEnd.getUTCDate() - 1);
    const last = parsedEnd.toISOString().slice(0, 10);
    // Compare the LAST COVERED day, not the raw end: an end on the following day covers only
    // the start day, and "2026-08-12 – 2026-08-12" is noise dressed as information.
    if (last <= startDay) return `${startDay} ${startClock}${zone}`.replace(/\s+/gu, ' ').trimEnd();
    return `${startDay} ${startClock} – ${last}${zone}`.replace(/\s+/gu, ' ');
  }
  // Naming the end date when it differs stops "22:00–02:00" from reading as a backwards range.
  const end = endDay === startDay ? endClock : `${endDay} ${endClock}`;
  return `${startDay} ${startClock}–${end}${zone}`;
}

export const calendarReadTool: ToolEntry<CalendarReadInput> = {
  definition: {
    name: 'calendar_read',
    description:
      'Read the operator\'s appointments from their connected calendar for a time window. '
      + 'Read-only. Defaults to the next 7 days.',
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
  detailedGuidance:
    'Times come back as the operator wrote them, with the zone named (e.g. "14:00–15:00 Europe/Zurich") — '
    + 'repeat them in that zone rather than converting. A time with no zone is RFC 5545 "floating": '
    + 'it means that clock time locally. All-day entries carry a date and no clock.\n'
    + 'It cannot create, move or delete anything — an ICS feed has no write side. If asked to book '
    + 'something, read the calendar to find a free slot and tell the operator; do not claim to have booked it.\n'
    + 'A "could not read" note means the answer is incomplete: do not turn it into "nothing scheduled".',
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
    const from = parseBound(input.from, now, false);
    if (!from) return `Could not read "${input.from ?? ''}" as a date.`;
    const to = parseBound(input.to, new Date(from.getTime() + DEFAULT_WINDOW_DAYS * 86_400_000), true);
    if (!to) return `Could not read "${input.to ?? ''}" as a date.`;
    if (to.getTime() <= from.getTime()) return 'The window ends before it starts.';
    // Counts the days the window COVERS, which is why advancing a date-only end by a day also
    // moves this: `from: 2026-08-01, to: 2026-11-01` now genuinely covers 93 days, including
    // the whole 1st of November, and is refused for that reason rather than by accident.
    const days = (to.getTime() - from.getTime()) / 86_400_000;
    if (days > MAX_WINDOW_DAYS) {
      return `That window is ${String(Math.round(days))} days. Ask for at most ${String(MAX_WINDOW_DAYS)} at a time.`;
    }

    // Concurrently: each feed costs up to a 20 s timeout, and reading two calendars is a normal
    // setup. `allSettled` because one unreachable feed must not lose the other's appointments —
    // that is the same reason the failures are reported instead of thrown.
    const results = await Promise.allSettled(selected.map(async label => {
      const url = store.resolve(`${CALENDAR_FEED_PREFIX}${label}`);
      if (!url) throw new Error('no address stored');
      const feed = await fetchIcsFeed(url, agent.toolContext);
      const parsed = parseIcsEvents(feed.ics, { from, to, maxEvents: DEFAULT_MAX_EVENTS });
      return { label, feed, parsed };
    }));

    const all: Array<CalendarEvent & { calendar: string }> = [];
    const failed: string[] = [];
    let truncated = false;
    let skipped = 0;
    for (const [i, r] of results.entries()) {
      const label = selected[i] ?? '';
      if (r.status === 'rejected') {
        // Named, not swallowed: "I could not reach your calendar" is a different answer from
        // "you have nothing on", and only one of them is safe to act on. Every message out of
        // `fetchIcsFeed` is one of its own and carries no address.
        failed.push(`${label} (${getErrorMessage(r.reason)})`);
        continue;
      }
      if (r.value.feed.truncated || r.value.parsed.truncated) truncated = true;
      skipped += r.value.parsed.skipped;
      for (const e of r.value.parsed.events) all.push({ ...e, calendar: label });
    }

    all.sort((a, b) => a.sortKey - b.sortKey);
    const lines = all.map(e => {
      const where = e.location ? ` @ ${e.location}` : '';
      const which = selected.length > 1 ? ` [${e.calendar}]` : '';
      return `- ${renderWhen(e)} ${e.summary || '(no title)'}${where}${which}`;
    });

    // The window is half-open, so its exclusive end is the day AFTER the last one covered.
    // Naming that day tells the model the 1st is included when a 09:00 meeting on the 1st was
    // filtered out — an overstatement in the "you are free" direction.
    const lastCovered = new Date(to.getTime() - 1).toISOString().slice(0, 10);
    const window = `${from.toISOString().slice(0, 10)} and ${lastCovered}`;
    const header = all.length === 0
      ? `No appointments between ${window}.`
      : `${String(all.length)} appointment${all.length === 1 ? '' : 's'} between ${window}:`;

    const notes: string[] = [];
    // All three change what the answer MEANS, so they travel with it rather than being dropped:
    // an unreachable calendar makes "nothing on" unsafe to rely on, and neither a truncated list
    // nor one with unreadable entries is a complete one.
    if (truncated) notes.push('The list was cut short — ask for a narrower window to see the rest.');
    if (skipped > 0) notes.push(`${String(skipped)} entr${skipped === 1 ? 'y' : 'ies'} could not be read and ${skipped === 1 ? 'is' : 'are'} missing from this list.`);
    if (failed.length > 0) notes.push(`Could not read: ${failed.join(', ')}. The list above is incomplete.`);

    const listing = [header, ...lines, ...(notes.length ? ['', ...notes] : [])].join('\n');
    // Titles and locations are written by whoever sent the invitation. Same treatment the
    // Google Calendar tool gives the same data.
    return wrapUntrustedData(listing, 'calendar:ics');
  },
};
