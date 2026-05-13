// === CalDAV provider presets ===
//
// Pre-filled server URLs + auth-style metadata for the 8 supported providers
// (PRD-CALENDAR-INTEGRATION §Presets). The Web UI account-add wizard renders
// these as a Step-1 Card-Grid (PRD §U15).
//
// Data-residency drives an inline 🌍-warning chip at account-add when the
// provider stores data outside the EU (PRD §S10). Non-EU presets remain
// visible (per Q4 decision) — only the chip surfaces the constraint.

import type { CalDavPreset, CalDavPresetSlug } from '../../../types/calendar.js';

const PRESETS: Record<CalDavPresetSlug, CalDavPreset> = {
  icloud: {
    slug: 'icloud',
    display_name: 'iCloud',
    server_url: 'https://caldav.icloud.com/',
    auth_style: 'app-password',
    skip_discovery: false,
    data_residency: 'US',
    app_password_help_url: 'https://account.apple.com/account/manage',
  },
  fastmail: {
    slug: 'fastmail',
    display_name: 'Fastmail',
    server_url: 'https://caldav.fastmail.com/',
    auth_style: 'app-password',
    skip_discovery: false,
    data_residency: 'AU',
    app_password_help_url: 'https://www.fastmail.com/settings/security/devicekeys',
  },
  nextcloud: {
    slug: 'nextcloud',
    display_name: 'Nextcloud',
    // User-typed: each Nextcloud instance has its own host. UI leaves the
    // server_url field empty and asks for the full URL.
    server_url: undefined,
    auth_style: 'basic',
    skip_discovery: false,
    data_residency: 'user-controlled',
    app_password_help_url: 'https://docs.nextcloud.com/server/latest/user_manual/en/session_management.html#managing-devices',
  },
  'mailbox-org': {
    slug: 'mailbox-org',
    display_name: 'mailbox.org',
    server_url: 'https://dav.mailbox.org/caldav/',
    auth_style: 'basic',
    skip_discovery: true,
    data_residency: 'EU',
    app_password_help_url: undefined,
  },
  posteo: {
    slug: 'posteo',
    display_name: 'Posteo',
    server_url: 'https://posteo.de:8443/',
    auth_style: 'basic',
    skip_discovery: true,
    data_residency: 'EU',
    app_password_help_url: undefined,
  },
  'zoho-eu': {
    slug: 'zoho-eu',
    display_name: 'Zoho (EU)',
    server_url: 'https://calendar.zoho.eu/',
    auth_style: 'app-password',
    skip_discovery: false,
    data_residency: 'EU',
    app_password_help_url: 'https://accounts.zoho.eu/home#security/app-passwords',
  },
  'zoho-us': {
    slug: 'zoho-us',
    display_name: 'Zoho (US)',
    server_url: 'https://calendar.zoho.com/',
    auth_style: 'app-password',
    skip_discovery: false,
    data_residency: 'US',
    app_password_help_url: 'https://accounts.zoho.com/home#security/app-passwords',
  },
  yahoo: {
    slug: 'yahoo',
    display_name: 'Yahoo Mail',
    server_url: 'https://caldav.calendar.yahoo.com/',
    auth_style: 'app-password',
    skip_discovery: false,
    data_residency: 'US',
    app_password_help_url: 'https://login.yahoo.com/myaccount/security/app-passwords/list',
  },
};

export function listCalDavPresets(): ReadonlyArray<CalDavPreset> {
  return Object.values(PRESETS);
}

export function getCalDavPreset(slug: CalDavPresetSlug): CalDavPreset {
  return PRESETS[slug];
}

/**
 * Type-guard for HTTP-API + Web UI inputs. The slug enum is exhaustive so we
 * can match strings safely against the runtime table.
 */
export function isCalDavPresetSlug(value: string): value is CalDavPresetSlug {
  return Object.prototype.hasOwnProperty.call(PRESETS, value);
}
