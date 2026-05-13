// === CalendarContext — engine-facing bundle ===
//
// Mirror of `core/src/integrations/mail/context.ts`. Holds:
//
//   stateDb  — SQLite (calendar-state.db)
//   vault    — credential store (per-account password / ICS URL)
//   registry — accountId → live CalendarProvider
//   watcher  — ICS poller (one setInterval per ICS account)
//
// Lifecycle:
//   const ctx = new CalendarContext(stateDb, vault)
//   await ctx.init()                           // load accounts → spin up providers
//   const account = await ctx.addAccount(...)
//   const tools = ctx.tools()                  // engine registers these
//   await ctx.removeAccount(id)
//   await ctx.close()
//
// Vault key namespace (PRD §S6):
//   calendar/{accountId}/password   — CalDAV credential
//   calendar/{accountId}/ics_url    — ICS-Feed Secret-URL (token-bearing)

import { randomUUID } from 'node:crypto';
import type { ToolEntry } from '../../types/index.js';
import type { SecretVault } from '../../core/secret-vault.js';
import { CalDavCalendarProvider, type CalDavCredentials } from './providers/caldav.js';
import { IcsFeedCalendarProvider, testIcsFeed } from './providers/ics-feed.js';
import { getCalDavPreset, isCalDavPresetSlug } from './providers/presets.js';
import { CalendarError } from './provider.js';
import { CalendarStateDb } from './state.js';
import { createCalendarTools, InMemoryCalendarRegistry } from './tools/index.js';
import { CalendarWatcher } from './watch.js';
import type {
  CalendarAccount,
  CalendarProvider,
  CalDavPresetSlug,
} from '../../types/calendar.js';

// ── Safe projections for HTTP API responses ─────────────────────────────────

export interface CalendarAccountView {
  id: string;
  provider: 'caldav' | 'ics-feed';
  display_name: string;
  is_default_writable: boolean;
  data_residency?: 'EU' | 'US' | 'AU' | 'user-controlled' | undefined;
  /** True when credentials/URL are present in vault. */
  has_credentials: boolean;
  // CalDAV-only
  server_url?: string | undefined;
  username?: string | undefined;
  preset_slug?: CalDavPresetSlug | 'custom' | undefined;
  // ICS-only
  poll_interval_minutes?: number | undefined;
  // Both
  enabled_calendars?: string[] | undefined;
  default_calendar?: string | undefined;
}

// ── Add-account inputs (HTTP layer translates request bodies into these) ────

export interface AddCalDavAccountInput {
  provider: 'caldav';
  display_name: string;
  preset_slug: CalDavPresetSlug | 'custom';
  /** Required when preset_slug='custom'; ignored otherwise. */
  server_url?: string | undefined;
  username: string;
  password: string;
  enabled_calendars?: string[] | undefined;
  is_default_writable?: boolean | undefined;
}

export interface AddIcsFeedAccountInput {
  provider: 'ics-feed';
  display_name: string;
  /** Secret-iCal URL (token-bearing). Stored in vault, never in account row. */
  ics_url: string;
  poll_interval_minutes?: number | undefined;
}

export type AddAccountInput = AddCalDavAccountInput | AddIcsFeedAccountInput;

export interface TestAccountResult {
  ok: boolean;
  error?: string | undefined;
  code?: string | undefined;
}

// ── CalendarContext ─────────────────────────────────────────────────────────

export class CalendarContext {
  private readonly state: CalendarStateDb;
  private readonly vault: SecretVault;
  private readonly registry = new InMemoryCalendarRegistry();
  private readonly watcher: CalendarWatcher;

  constructor(state: CalendarStateDb, vault: SecretVault) {
    this.state = state;
    this.vault = vault;
    this.watcher = new CalendarWatcher({
      state: this.state,
      resolveIcsUrl: (account) => this.icsUrlFromVault(account.id),
      onError: (accountId, err) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[calendar:watch] account=${accountId} error: ${msg}\n`);
      },
    });
  }

  /** Load persisted accounts, instantiate providers, start ICS pollers. */
  async init(): Promise<void> {
    for (const account of this.state.listAccounts()) {
      let provider: CalendarProvider | null = null;
      try {
        provider = this.instantiate(account);
        if (provider) this.registry.register(provider);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[calendar:init] skipping account ${account.id}: ${msg}\n`);
        continue;
      }
      // Only start the ICS watcher when the provider was actually instantiated
      // — orphan accounts (vault credentials vanished, instantiate returned
      // null) must not produce endless "URL not in vault" errors every tick.
      if (provider && account.provider === 'ics-feed') this.watcher.start(account);
    }
  }

  tools(): ToolEntry[] {
    return createCalendarTools(this.registry);
  }

  listAccounts(): ReadonlyArray<CalendarAccountView> {
    return this.state.listAccounts().map((a) => this.projectAccount(a));
  }

  getAccount(id: string): CalendarAccountView | null {
    const row = this.state.getAccount(id);
    return row ? this.projectAccount(row) : null;
  }

  /**
   * Persist + spin up. CalDAV credentials and ICS URLs land in vault BEFORE
   * the state row is written, so a crash mid-add never leaves an orphan
   * account without retrievable secrets.
   */
  async addAccount(input: AddAccountInput): Promise<CalendarAccountView> {
    if (input.provider === 'caldav') return this.addCalDavAccount(input);
    return this.addIcsFeedAccount(input);
  }

  private async addCalDavAccount(input: AddCalDavAccountInput): Promise<CalendarAccountView> {
    const { serverUrl, skipDiscovery } = resolveCalDavServer(input);

    // Phase 1a doesn't validate credentials at add-time. The Web UI test-connection
    // endpoint (`POST /api/calendar/accounts/test`) is the explicit live-probe path.

    // Pre-allocate the account id so the vault write can target the final key
    // BEFORE the state row exists (PRD §S12 — vault BEFORE state, so a crash
    // mid-add leaves at most an orphan vault entry, never an account row with
    // unrecoverable creds).
    const id = randomUUID();
    this.vault.set(vaultPasswordKey(id), input.password);

    // Always insert with is_default_writable=false; the partial UNIQUE index
    // `idx_calendar_account_default` only allows one default at a time, and
    // setDefaultWritable below clears the previous default atomically.
    const created = this.state.createAccount({
      id,
      provider: 'caldav',
      display_name: input.display_name,
      preset_slug: input.preset_slug,
      server_url: serverUrl,
      username: input.username,
      ...(input.enabled_calendars !== undefined ? { enabled_calendars: input.enabled_calendars } : {}),
    });

    if (input.is_default_writable) this.state.setDefaultWritable(created.id);

    const provider = new CalDavCalendarProvider({
      accountId: created.id,
      serverUrl,
      credentials: { username: input.username, password: input.password },
      skipDiscovery,
      ...(input.enabled_calendars ? { enabledCalendars: input.enabled_calendars } : {}),
    });
    this.registry.register(provider);
    return this.projectAccount(this.state.getAccount(created.id)!);
  }

  private async addIcsFeedAccount(input: AddIcsFeedAccountInput): Promise<CalendarAccountView> {
    // PRD §S12 — vault BEFORE state row (see addCalDavAccount for rationale).
    const id = randomUUID();
    this.vault.set(vaultIcsUrlKey(id), input.ics_url);

    const created = this.state.createAccount({
      id,
      provider: 'ics-feed',
      display_name: input.display_name,
      ...(input.poll_interval_minutes !== undefined ? { poll_interval_minutes: input.poll_interval_minutes } : {}),
    });

    const provider = new IcsFeedCalendarProvider({ accountId: created.id, state: this.state });
    this.registry.register(provider);
    this.watcher.start(this.state.getAccount(created.id)!);

    return this.projectAccount(this.state.getAccount(created.id)!);
  }

  /**
   * Delete account. Order matters (PRD §S12): Vault FIRST (idempotent), then
   * SQLite transaction (cache + poll-state + account cascade). Watcher + registry
   * are torn down between the two.
   */
  async removeAccount(id: string): Promise<boolean> {
    const account = this.state.getAccount(id);
    if (!account) return false;

    this.vault.delete(vaultPasswordKey(id));
    this.vault.delete(vaultIcsUrlKey(id));

    this.watcher.stop(id);
    const provider = this.registry.get(id);
    if (provider) {
      try { await provider.close(); } catch { /* best-effort */ }
      this.registry.remove(id);
    }

    this.state.dropAccount(id);
    return true;
  }

  setDefaultWritable(id: string | null): void {
    this.state.setDefaultWritable(id);
  }

  /**
   * Live-probe an account WITHOUT persisting. Used by
   * `POST /api/calendar/accounts/test` to verify credentials + URL before
   * committing to the state DB.
   */
  async testAccount(input: AddAccountInput): Promise<TestAccountResult> {
    try {
      if (input.provider === 'caldav') {
        const { serverUrl, skipDiscovery } = resolveCalDavServer(input);
        const probe = new CalDavCalendarProvider({
          accountId: '00000000-0000-0000-0000-000000000000',
          serverUrl,
          credentials: { username: input.username, password: input.password },
          skipDiscovery,
        });
        // `list()` runs login + fetchCalendars; if those fail we surface auth_failed.
        const now = new Date().toISOString();
        const later = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        await probe.list(now, later);
        await probe.close();
        return { ok: true };
      }
      await testIcsFeed(input.ics_url);
      return { ok: true };
    } catch (err) {
      if (err instanceof CalendarError) return { ok: false, error: err.message, code: err.code };
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async close(): Promise<void> {
    this.watcher.stopAll();
    for (const id of this.registry.listIds()) {
      const p = this.registry.get(id);
      if (!p) continue;
      try { await p.close(); } catch { /* best-effort */ }
    }
    // Close the SQLite handle so WAL/SHM files release; otherwise test runs
    // and engine restarts leak the better-sqlite3 binding.
    this.state.close();
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private instantiate(account: CalendarAccount): CalendarProvider | null {
    if (account.provider === 'caldav') {
      const password = this.vault.get(vaultPasswordKey(account.id));
      const username = account.username ?? '';
      const serverUrl = account.server_url ?? '';
      if (password === null || username === '' || serverUrl === '') return null;
      return new CalDavCalendarProvider({
        accountId: account.id,
        serverUrl,
        credentials: { username, password },
        skipDiscovery: account.preset_slug ? presetSkipsDiscovery(account.preset_slug) : false,
        ...(account.enabled_calendars ? { enabledCalendars: account.enabled_calendars } : {}),
      });
    }
    return new IcsFeedCalendarProvider({ accountId: account.id, state: this.state });
  }

  private icsUrlFromVault(accountId: string): string | null {
    return this.vault.get(vaultIcsUrlKey(accountId));
  }

  private projectAccount(a: CalendarAccount): CalendarAccountView {
    const hasCreds = a.provider === 'caldav'
      ? this.vault.get(vaultPasswordKey(a.id)) !== null
      : this.vault.get(vaultIcsUrlKey(a.id)) !== null;

    const view: CalendarAccountView = {
      id: a.id,
      provider: a.provider,
      display_name: a.display_name,
      is_default_writable: !!a.is_default_writable,
      has_credentials: hasCreds,
    };
    if (a.preset_slug) {
      view.preset_slug = a.preset_slug;
      if (a.preset_slug !== 'custom' && isCalDavPresetSlug(a.preset_slug)) {
        view.data_residency = getCalDavPreset(a.preset_slug).data_residency;
      }
    }
    if (a.server_url) view.server_url = a.server_url;
    if (a.username) view.username = a.username;
    if (a.enabled_calendars) view.enabled_calendars = [...a.enabled_calendars];
    if (a.default_calendar) view.default_calendar = a.default_calendar;
    if (a.poll_interval_minutes) view.poll_interval_minutes = a.poll_interval_minutes;
    return view;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function vaultPasswordKey(accountId: string): string {
  return `calendar/${accountId}/password`;
}

function vaultIcsUrlKey(accountId: string): string {
  return `calendar/${accountId}/ics_url`;
}

function resolveCalDavServer(input: AddCalDavAccountInput): { serverUrl: string; skipDiscovery: boolean } {
  if (input.preset_slug === 'custom') {
    if (!input.server_url) {
      throw new CalendarError('malformed_event', 'custom preset requires server_url');
    }
    return { serverUrl: input.server_url, skipDiscovery: false };
  }
  if (!isCalDavPresetSlug(input.preset_slug)) {
    throw new CalendarError('malformed_event', `unknown preset_slug: ${input.preset_slug}`);
  }
  const preset = getCalDavPreset(input.preset_slug);
  const serverUrl = preset.server_url ?? input.server_url;
  if (!serverUrl) {
    throw new CalendarError('malformed_event', `preset ${input.preset_slug} requires a server_url`);
  }
  return { serverUrl, skipDiscovery: preset.skip_discovery };
}

function presetSkipsDiscovery(slug: CalDavPresetSlug | 'custom'): boolean {
  if (slug === 'custom') return false;
  return getCalDavPreset(slug).skip_discovery;
}
