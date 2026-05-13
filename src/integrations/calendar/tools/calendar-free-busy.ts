// === calendar_free_busy tool ===
//
// Derives free/busy intervals from the same `list()` call CalDAV + ICS expose.
// Returns a compact list of BUSY intervals (events with status != cancelled)
// — the agent infers free slots by complementing against the requested window.
//
// PRD §S8 — inputs accept ONLY account UUIDs. Never raw attendee emails:
// the agent could otherwise be used to enumerate org email-addresses against
// an attacker-controlled set of names.

import type { IAgent, ToolEntry } from '../../../types/index.js';
import { CalendarError } from '../provider.js';
import { resolveProviders, type CalendarRegistry } from './registry.js';
import type { CalendarEvent, FreeBusyInterval } from '../../../types/calendar.js';

interface CalendarFreeBusyInput {
  time_min: string;
  time_max: string;
  account_ids?: string[] | undefined;
}

const UUID_V4_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

export function createCalendarFreeBusyTool(registry: CalendarRegistry): ToolEntry<CalendarFreeBusyInput> {
  return {
    definition: {
      name: 'calendar_free_busy',
      description:
        'Return BUSY intervals from one or more connected calendar accounts. The agent infers FREE slots by complementing the busy list against the requested window. Read-only. NEVER pass an email address here — only account UUIDs.',
      input_schema: {
        type: 'object' as const,
        properties: {
          time_min: { type: 'string', description: 'ISO 8601 start of window.' },
          time_max: { type: 'string', description: 'ISO 8601 end of window.' },
          account_ids: {
            type: 'array',
            items: { type: 'string', pattern: UUID_V4_PATTERN },
            description: 'Optional account UUIDs. Omit to query ALL connected accounts. Email addresses are rejected (PRD §S8).',
          },
        },
        required: ['time_min', 'time_max'],
      },
    },
    handler: async (input: CalendarFreeBusyInput, _agent: IAgent): Promise<string> => {
      let providers;
      try {
        providers = resolveProviders(registry, input.account_ids);
      } catch (err) {
        return renderError(err, 'resolve providers');
      }

      if (providers.length === 0) {
        return 'No calendar accounts configured. Open Settings → Integrations → Calendar to add one.';
      }

      const busy: FreeBusyInterval[] = [];
      const failures: Array<{ accountId: string; error: string }> = [];

      for (const provider of providers) {
        try {
          const events = await provider.list(input.time_min, input.time_max);
          for (const ev of events) {
            if (ev.status === 'cancelled') continue;
            busy.push(toBusyInterval(ev, provider.accountId));
          }
        } catch (err) {
          failures.push({ accountId: provider.accountId, error: errorMessage(err) });
        }
      }

      busy.sort((a, b) => a.start.localeCompare(b.start));

      const lines: string[] = [];
      lines.push(`# Free/Busy intervals (${input.time_min} → ${input.time_max})`);
      lines.push(`${busy.length} busy interval${busy.length === 1 ? '' : 's'} across ${providers.length} account${providers.length === 1 ? '' : 's'}.`);
      lines.push('');
      if (busy.length === 0 && failures.length === 0) {
        lines.push('_No busy intervals — the entire window is free._');
      }
      for (const b of busy) {
        lines.push(`- ${b.start} → ${b.end} (${b.status}, account=${b.account_id})`);
      }
      if (failures.length > 0) {
        lines.push('');
        lines.push('## Errors');
        for (const f of failures) lines.push(`- account ${f.accountId}: ${f.error}`);
      }
      return lines.join('\n');
    },
  };
}

function toBusyInterval(ev: CalendarEvent, accountId: string): FreeBusyInterval {
  return {
    account_id: accountId,
    start: ev.start,
    end: ev.end,
    status: ev.status === 'tentative' ? 'tentative' : 'busy',
  };
}

function renderError(err: unknown, where: string): string {
  return `calendar_free_busy error in ${where}: ${errorMessage(err)}`;
}

function errorMessage(err: unknown): string {
  if (err instanceof CalendarError) {
    const debug = process.env['LYNOX_DEBUG'] === '1' ? ` [debug: ${err.message}]` : '';
    return `${err.publicMessage()} (${err.code})${debug}`;
  }
  return err instanceof Error ? err.message : String(err);
}
