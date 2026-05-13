// === Calendar types — public contract ===
//
// All calendar backends (CalDAV via tsdav, ICS-Feed via node-ical, plus the
// pre-existing google_calendar tool) flow through the CalendarProvider
// interface. Adapters live in `core/src/integrations/calendar/providers/`.
//
// Phase 1a ships `list` (read-only) for both CalDAV + ICS-Feed.
// Phase 1b adds `create` for CalDAV.
// Phase 2 adds `update` + `delete`.

// ── Untrusted-wrap brand (PRD §S2) ──────────────────────────────────────────
//
// All server-origin string fields on CalendarEvent must be passed through
// `wrap<T>()` (see `core/src/core/data-boundary.ts`) before they reach LLM
// context assembly. The brand makes the requirement compile-time enforced:
// a raw `string` cannot satisfy `Wrapped<string>`.
//
// Persistence (KG, state DB cache) stores the RAW value to keep the database
// queryable; the retrieval-for-LLM path re-wraps on read.

declare const __wrapped: unique symbol;
export type Wrapped<T extends string = string> = T & { readonly [__wrapped]: true };

// ── Error contract ──────────────────────────────────────────────────────────

export type CalendarErrorCode =
  | 'auth_failed'
  | 'network'
  | 'parse_error'
  | 'conflict_412'
  | 'rate_limited'
  | 'not_found'
  | 'read_only'
  | 'malformed_event'
  | 'quota_exceeded';

// ── Account configuration ───────────────────────────────────────────────────
//
// `id` is a server-generated UUID v4 — never user-typed (PRD §S6). Vault keys
// for credentials follow `vault://calendar/{id}/{password|ics_url}`.

export type CalendarProviderKind = 'caldav' | 'ics-feed';
export type CalDavAuthType = 'basic' | 'app-password';

export interface CalendarAccount {
  id: string;
  provider: CalendarProviderKind;
  display_name: string;
  /** User-settable in IntegrationsView; resolves the default for `calendar_create` (Phase 1b, U2). */
  is_default_writable?: boolean | undefined;
  /** User-selected collection slugs at Account-Add (U19). Empty array = all calendars. */
  enabled_calendars?: string[] | undefined;
  default_calendar?: string | undefined;
  timezone?: string | undefined;
  // CalDAV-only
  server_url?: string | undefined;
  username?: string | undefined;
  preset_slug?: CalDavPresetSlug | 'custom' | undefined;
  // ICS-feed-only — URL lives in Vault (token-bearing). The key here is the lookup handle.
  ics_url_vault_key?: string | undefined;
  poll_interval_minutes?: number | undefined;
}

// ── Event ───────────────────────────────────────────────────────────────────

export interface CalendarAttendee {
  email: string;
  name?: Wrapped<string> | undefined;
  rsvp?: 'accepted' | 'declined' | 'tentative' | 'needs-action' | undefined;
}

export interface CalendarEvent {
  id: string;
  /** iCalendar UID, stable across edits. */
  uid: string;
  summary: Wrapped<string>;
  description?: Wrapped<string> | undefined;
  location?: Wrapped<string> | undefined;
  /** ISO 8601 with explicit TZ. */
  start: string;
  end: string;
  all_day?: boolean | undefined;
  attendees?: ReadonlyArray<CalendarAttendee> | undefined;
  organizer?: { email: string; name?: Wrapped<string> | undefined } | undefined;
  /** RFC 5545 RRULE strings — expansion capped by date window AND iteration count (PRD §S14). */
  recurrence?: ReadonlyArray<string> | undefined;
  status?: 'confirmed' | 'tentative' | 'cancelled' | undefined;
  source: {
    account_id: string;
    provider: CalendarProviderKind | 'google_calendar';
    etag?: string | undefined;
  };
}

// ── Free/busy ───────────────────────────────────────────────────────────────

export interface FreeBusyInterval {
  account_id: string;
  start: string;
  end: string;
  /** Server-reported availability. CalDAV returns `busy`; ICS derived from events. */
  status: 'busy' | 'tentative' | 'oof';
}

// ── Provider interface ──────────────────────────────────────────────────────
//
// Note: no `watch()` — CalDAV has no push; polling lives in the WorkerLoop
// TaskRecord layer (see `integrations/calendar/watch.ts`).

export interface CalendarListOptions {
  /** Optional filter to specific calendar collection URLs (CalDAV-only; ICS is single-collection). */
  calendars?: ReadonlyArray<string> | undefined;
}

export interface CalendarProvider {
  readonly name: CalendarProviderKind;
  /** Multi-account-binding source-of-truth (PRD §S11). Tool-wrapper asserts equality. */
  readonly accountId: string;
  readonly authType: 'basic' | 'token' | 'none';
  list(time_min: string, time_max: string, opts?: CalendarListOptions): Promise<ReadonlyArray<CalendarEvent>>;
  create?(event: Omit<CalendarEvent, 'id' | 'uid' | 'source'>): Promise<CalendarEvent>;
  update?(event_id: string, updates: Partial<CalendarEvent>): Promise<CalendarEvent>;
  delete?(event_id: string): Promise<void>;
  close(): Promise<void>;
}

// ── CalDAV presets ──────────────────────────────────────────────────────────
//
// Pre-filled server URLs + auth-style metadata for the 8 supported providers.
// `data_residency` drives the inline 🌍-warning at account-add (PRD §S10).

export type CalDavPresetSlug =
  | 'icloud'
  | 'fastmail'
  | 'nextcloud'
  | 'mailbox-org'
  | 'posteo'
  | 'zoho-eu'
  | 'zoho-us'
  | 'yahoo';

export type DataResidency = 'EU' | 'US' | 'AU' | 'user-controlled';

export interface CalDavPreset {
  slug: CalDavPresetSlug;
  display_name: string;
  /** Empty for `custom` style (user types URL); set for known providers. */
  server_url: string | undefined;
  auth_style: CalDavAuthType;
  /** When true, presets skip RFC 6764 well-known lookup (pre-verified URL). */
  skip_discovery: boolean;
  data_residency: DataResidency;
  /** Link to the provider's app-password generation flow (U18). */
  app_password_help_url: string | undefined;
}
