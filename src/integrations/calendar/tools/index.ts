// === Calendar tools factory ===
//
// Single entry point consumed by `engine.ts:611` loop and tests. Mirrors
// `core/src/integrations/mail/tools/index.ts`. Phase 1a ships read-only;
// Phase 1b adds `calendar_create`; Phase 2 adds `calendar_update` +
// `calendar_delete`.

import type { ToolEntry } from '../../../types/index.js';
import { createCalendarListTool } from './calendar-list.js';
import { createCalendarFreeBusyTool } from './calendar-free-busy.js';
import { createCalendarCreateTool, type CalendarWritableResolver } from './calendar-create.js';
import { InMemoryCalendarRegistry, type CalendarRegistry } from './registry.js';

export { InMemoryCalendarRegistry, type CalendarRegistry } from './registry.js';
export type { CalendarWritableResolver } from './calendar-create.js';

export interface CalendarToolsDeps {
  registry: CalendarRegistry;
  writableResolver: CalendarWritableResolver;
}

export function createCalendarTools(deps: CalendarToolsDeps): ToolEntry[] {
  return [
    createCalendarListTool(deps.registry) as ToolEntry,
    createCalendarFreeBusyTool(deps.registry) as ToolEntry,
    createCalendarCreateTool(deps.registry, deps.writableResolver) as ToolEntry,
  ];
}
