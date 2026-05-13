// === Calendar tool registry ===
//
// Tools resolve provider instances via this registry. Mirror of
// `core/src/integrations/mail/tools/registry.ts`. The CalendarContext owns
// the canonical registry; `resolveProviders()` enforces the multi-account
// binding check (PRD §S11): the returned provider's `accountId` matches
// the input.

import { CalendarError } from '../provider.js';
import type { CalendarProvider } from '../../../types/calendar.js';

export interface CalendarRegistry {
  has(accountId: string): boolean;
  get(accountId: string): CalendarProvider | undefined;
  listIds(): ReadonlyArray<string>;
}

export class InMemoryCalendarRegistry implements CalendarRegistry {
  private readonly providers = new Map<string, CalendarProvider>();

  register(provider: CalendarProvider): void {
    this.providers.set(provider.accountId, provider);
  }

  remove(accountId: string): void {
    this.providers.delete(accountId);
  }

  has(accountId: string): boolean {
    return this.providers.has(accountId);
  }

  get(accountId: string): CalendarProvider | undefined {
    return this.providers.get(accountId);
  }

  listIds(): ReadonlyArray<string> {
    return Array.from(this.providers.keys());
  }
}

// UUID v4 input-validation regex per PRD §S8. Tool input schemas declare
// the pattern; this guard re-checks at runtime in case a caller skipped
// schema validation (e.g. internal callers, tests).
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve providers for a tool call. If `accountIds` is undefined or empty,
 * returns ALL registered providers (fan-out across all accounts). Otherwise
 * returns only the explicitly named accounts.
 *
 * Throws `CalendarError('malformed_event')` on non-UUID strings — this is
 * the runtime guard for PRD §S8 (no raw emails or other identifiers).
 * Throws `CalendarError('not_found')` if a requested ID is not registered.
 */
export function resolveProviders(
  registry: CalendarRegistry,
  accountIds: ReadonlyArray<string> | undefined,
): ReadonlyArray<CalendarProvider> {
  if (!accountIds || accountIds.length === 0) {
    return registry.listIds().map((id) => {
      const p = registry.get(id);
      if (!p) throw new CalendarError('not_found', `Provider ${id} vanished mid-resolution`);
      return p;
    });
  }

  const out: CalendarProvider[] = [];
  for (const id of accountIds) {
    if (typeof id !== 'string' || !UUID_V4.test(id)) {
      throw new CalendarError('malformed_event', `account_id "${id}" is not a UUID. PRD §S8: only account UUIDs accepted, never raw emails.`);
    }
    const provider = registry.get(id);
    if (!provider) {
      throw new CalendarError('not_found', `No calendar account with id ${id}`);
    }
    // PRD §S11: defense-in-depth binding check.
    if (provider.accountId !== id) {
      throw new CalendarError('not_found', `Provider binding mismatch: requested ${id}, got ${provider.accountId}`);
    }
    out.push(provider);
  }
  return out;
}
