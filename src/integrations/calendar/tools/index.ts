// === Calendar tools factory ===
//
// Single entry point consumed by `engine.ts:611` loop and tests. Mirrors
// `core/src/integrations/mail/tools/index.ts`. Phase 1a ships two tools;
// Phase 1b adds `calendar_create`, Phase 2 adds `calendar_update` and
// `calendar_delete`.

import type { ToolEntry } from '../../../types/index.js';
import { createCalendarListTool } from './calendar-list.js';
import { createCalendarFreeBusyTool } from './calendar-free-busy.js';
import { InMemoryCalendarRegistry, type CalendarRegistry } from './registry.js';

export { InMemoryCalendarRegistry, type CalendarRegistry } from './registry.js';

export function createCalendarTools(registry: CalendarRegistry): ToolEntry[] {
  return [
    createCalendarListTool(registry) as ToolEntry,
    createCalendarFreeBusyTool(registry) as ToolEntry,
  ];
}
