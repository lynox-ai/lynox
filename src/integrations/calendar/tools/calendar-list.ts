// === calendar_list tool ===
//
// Read-only fan-out across one or more calendar accounts. Returns a compact
// text rendering for the agent context. Wrapped strings are already
// untrusted-data-marked by the provider adapters (PRD §S2).

import type { IAgent, ToolEntry } from '../../../types/index.js';
import { CalendarError } from '../provider.js';
import { resolveProviders, type CalendarRegistry } from './registry.js';
import type { CalendarEvent, Wrapped } from '../../../types/calendar.js';

interface CalendarListInput {
  time_min: string;
  time_max: string;
  account_ids?: string[] | undefined;
  limit?: number | undefined;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const UUID_V4_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

export function createCalendarListTool(registry: CalendarRegistry): ToolEntry<CalendarListInput> {
  return {
    definition: {
      name: 'calendar_list',
      description:
        'List events in a time window from one or more connected calendar accounts. Read-only — no confirmation needed. Returns up to `limit` events sorted by start time. Use ISO 8601 timestamps for time_min/time_max.',
      input_schema: {
        type: 'object' as const,
        properties: {
          time_min: { type: 'string', description: 'ISO 8601 start of window (inclusive). Example: 2026-05-13T00:00:00Z' },
          time_max: { type: 'string', description: 'ISO 8601 end of window (exclusive). Example: 2026-05-20T00:00:00Z' },
          account_ids: {
            type: 'array',
            items: { type: 'string', pattern: UUID_V4_PATTERN },
            description: 'Optional list of account UUIDs to query. Omit to fan out across all connected accounts. NEVER pass an email address here.',
          },
          limit: { type: 'number', description: `Max events to return. Default ${DEFAULT_LIMIT}, hard cap ${MAX_LIMIT}.` },
        },
        required: ['time_min', 'time_max'],
      },
    },
    handler: async (input: CalendarListInput, _agent: IAgent): Promise<string> => {
      const limit = clampLimit(input.limit);

      let providers;
      try {
        providers = resolveProviders(registry, input.account_ids);
      } catch (err) {
        return renderError(err, 'resolve providers');
      }

      if (providers.length === 0) {
        return 'No calendar accounts configured. Open Settings → Integrations → Calendar to add one.';
      }

      interface Tagged { accountId: string; event: CalendarEvent }
      const collected: Tagged[] = [];
      const failures: Array<{ accountId: string; error: string }> = [];

      for (const provider of providers) {
        try {
          const events = await provider.list(input.time_min, input.time_max);
          for (const ev of events) collected.push({ accountId: provider.accountId, event: ev });
        } catch (err) {
          failures.push({ accountId: provider.accountId, error: errorMessage(err) });
        }
      }

      collected.sort((a, b) => a.event.start.localeCompare(b.event.start));
      const visible = collected.slice(0, limit);

      return renderEventList(visible, collected.length, failures, input.time_min, input.time_max);
    },
  };
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(raw));
}

function renderEventList(
  visible: ReadonlyArray<{ accountId: string; event: CalendarEvent }>,
  total: number,
  failures: ReadonlyArray<{ accountId: string; error: string }>,
  time_min: string,
  time_max: string,
): string {
  const lines: string[] = [];
  lines.push(`# Calendar events (${time_min} → ${time_max})`);
  lines.push(`Found ${total} event${total === 1 ? '' : 's'}${visible.length < total ? `, showing ${visible.length}` : ''}.`);
  lines.push('');

  if (visible.length === 0 && failures.length === 0) {
    lines.push('_No events in this window._');
  }

  for (const { accountId, event } of visible) {
    lines.push(`- **${unwrap(event.summary)}**`);
    lines.push(`  ${event.start} → ${event.end}${event.all_day ? ' (all-day)' : ''}`);
    if (event.location) lines.push(`  📍 ${unwrap(event.location)}`);
    if (event.attendees && event.attendees.length > 0) {
      const names = event.attendees.map((a) => a.name ? `${unwrap(a.name)} <${a.email}>` : a.email).join(', ');
      lines.push(`  👥 ${names}`);
    }
    if (event.recurrence && event.recurrence.length > 0) lines.push(`  🔁 ${event.recurrence.join('; ')}`);
    if (event.status && event.status !== 'confirmed') lines.push(`  ⚠ status: ${event.status}`);
    lines.push(`  _account=${accountId} uid=${event.uid}_`);
  }

  if (failures.length > 0) {
    lines.push('');
    lines.push('## Errors');
    for (const f of failures) lines.push(`- account ${f.accountId}: ${f.error}`);
  }

  return lines.join('\n');
}

function renderError(err: unknown, where: string): string {
  return `calendar_list error in ${where}: ${errorMessage(err)}`;
}

function errorMessage(err: unknown): string {
  if (err instanceof CalendarError) {
    const debug = process.env['LYNOX_DEBUG'] === '1' ? ` [debug: ${err.message}]` : '';
    return `${err.publicMessage()} (${err.code})${debug}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * `Wrapped<T>` is `T` at runtime — the brand is purely structural. Casting
 * back to `string` for rendering is sound; the LLM still sees the
 * `<untrusted_data>` markers inside the wrapped string.
 */
function unwrap(w: Wrapped<string>): string {
  return w as unknown as string;
}
