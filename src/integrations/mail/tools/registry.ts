// === MailRegistry ===
//
// Lookup table that maps account ids to live MailProvider instances. The
// engine populates it at startup; the tools resolve providers from it on
// every call so account rotation is a single registry update.
//
// Phase 0 ships an in-memory implementation. Phase 1+ may persist + lazy-
// instantiate, but the interface stays the same.

import { MailError, type MailProvider } from '../provider.js';

export interface MailRegistry {
  /** Look up a provider by account id. Returns null if not registered. */
  get(accountId: string): MailProvider | null;
  /** All registered account ids in registration order. */
  list(): ReadonlyArray<string>;
  /** Default account id, or null if no accounts are registered. */
  default(): string | null;
}

/** Mutable extension used by the engine to populate the registry. */
export interface MutableMailRegistry extends MailRegistry {
  add(provider: MailProvider): void;
  remove(accountId: string): void;
  setDefault(accountId: string): void;
  clear(): void;
}

/**
 * Resolve one or more providers for a tool call.
 *
 * - If `requested` is set, return just that one provider.
 * - If `requested` is unset and multiple accounts are registered, return all
 *   of them (fan-out). Tools are expected to iterate and merge results.
 * - If exactly one account is registered, return just that one.
 * - If nothing is registered, throw.
 *
 * This is the primary path for fan-out triage/search. The single-provider
 * variant `resolveProvider()` below remains for tools that MUST target one
 * account (send/reply).
 */
export function resolveProviders(registry: MailRegistry, requested: string | undefined): ReadonlyArray<MailProvider> {
  if (requested) {
    const provider = registry.get(requested);
    if (!provider) {
      throw new MailError('not_found', `No mail account "${requested}" configured. Available: ${registry.list().join(', ') || '(none)'}`);
    }
    return [provider];
  }

  const ids = registry.list();
  if (ids.length === 0) {
    throw new MailError('not_found', 'No mail account configured. Add one in Settings → Channels → Mail.');
  }
  return ids.map(id => registry.get(id)!).filter((p): p is MailProvider => p !== null);
}

/**
 * Resolve the requested account id, or fall back to the default. Throws a
 * typed MailError when nothing matches — tools turn this into a friendly
 * "no mail account configured" message.
 */
export function resolveProvider(registry: MailRegistry, requested: string | undefined): MailProvider {
  if (requested) {
    const provider = registry.get(requested);
    if (!provider) {
      throw new MailError('not_found', `No mail account "${requested}" configured. Available: ${registry.list().join(', ') || '(none)'}`);
    }
    return provider;
  }

  const fallback = registry.default();
  if (!fallback) {
    throw new MailError('not_found', 'No mail account configured. Add one in Settings → Channels → Mail.');
  }
  const provider = registry.get(fallback);
  if (!provider) {
    throw new MailError('not_found', `Default mail account "${fallback}" is registered but its provider is missing — possible engine init bug.`);
  }
  return provider;
}

export class InMemoryMailRegistry implements MutableMailRegistry {
  private readonly providers = new Map<string, MailProvider>();
  private defaultId: string | null = null;

  /**
   * Register a provider. Does NOT auto-assign default — the caller (MailContext)
   * is responsible for default selection because that decision needs to consult
   * the persisted `is_default` column. Auto-defaulting in registration order
   * was the bug behind "DEFAULT-Badge wandert auf das letzte Konto".
   */
  add(provider: MailProvider): void {
    this.providers.set(provider.accountId, provider);
  }

  remove(accountId: string): void {
    this.providers.delete(accountId);
    // Clear the in-memory default when its provider is gone. The caller must
    // call setDefault() with a replacement (and persist it) — we no longer
    // silently promote a sibling because that hides the missing-default case.
    if (this.defaultId === accountId) {
      this.defaultId = null;
    }
  }

  setDefault(accountId: string): void {
    if (!this.providers.has(accountId)) {
      throw new MailError('not_found', `Cannot set default — account "${accountId}" not registered`);
    }
    this.defaultId = accountId;
  }

  get(accountId: string): MailProvider | null {
    return this.providers.get(accountId) ?? null;
  }

  list(): ReadonlyArray<string> {
    return [...this.providers.keys()];
  }

  default(): string | null {
    return this.defaultId;
  }

  clear(): void {
    this.providers.clear();
    this.defaultId = null;
  }
}
