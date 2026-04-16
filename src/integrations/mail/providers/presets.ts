// === Provider presets ===
//
// Pure-config builders that return a fully-configured ImapSmtpProvider for
// each supported preset. The agent and rest of the engine never see this —
// they get back the same MailProvider interface.
//
// Each preset hardcodes host/port/secure values verified against the
// provider's current documentation as of 2026-04. Custom (autodiscover) is
// the escape hatch for everything else.

import { ImapSmtpProvider, type CredentialsResolver } from './imap-smtp.js';
import {
  MailError,
  type MailAccountConfig,
  type MailAccountType,
  type MailPresetSlug,
  type MailProvider,
  type MailServerConfig,
} from '../provider.js';

// ── Preset table ───────────────────────────────────────────────────────────
//
// Source of truth: each preset's published IMAP/SMTP server documentation.
// Prefer implicit TLS (993 / 465) over STARTTLS where both are offered, since
// implicit TLS removes the cleartext upgrade race.

interface PresetServers {
  imap: MailServerConfig;
  smtp: MailServerConfig;
  /** Public URL the user visits to generate an app-password. */
  appPasswordUrl: string;
  /** True when the provider gates app-passwords behind 2FA enrolment. */
  requires2FA: boolean;
  /** Short, human-readable label for UI. */
  label: string;
}

const PRESETS: Record<Exclude<MailPresetSlug, 'custom'>, PresetServers> = {
  gmail: {
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    appPasswordUrl: 'https://myaccount.google.com/apppasswords',
    requires2FA: true,
    label: 'Gmail',
  },
  icloud: {
    // Apple recommends mail.me.com hostnames; the account name is the address local-part.
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false }, // STARTTLS — Apple does not expose 465
    appPasswordUrl: 'https://account.apple.com/account/manage',
    requires2FA: true,
    label: 'iCloud Mail',
  },
  fastmail: {
    imap: { host: 'imap.fastmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.fastmail.com', port: 465, secure: true },
    appPasswordUrl: 'https://www.fastmail.com/settings/security/devicekeys',
    requires2FA: false,
    label: 'Fastmail',
  },
  yahoo: {
    imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
    appPasswordUrl: 'https://login.yahoo.com/myaccount/security/app-passwords/list',
    requires2FA: true,
    label: 'Yahoo Mail',
  },
  outlook: {
    // Personal Outlook (hotmail.com / live.com / outlook.com). M365 Business is OAuth-only — Phase 1b.
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false }, // STARTTLS only
    appPasswordUrl: 'https://account.live.com/proofs/AppPassword',
    requires2FA: true,
    label: 'Outlook (personal)',
  },
};

// ── Public describe API (used by onboarding UI) ────────────────────────────

export interface PresetDescriptor {
  slug: MailPresetSlug;
  label: string;
  imap: MailServerConfig;
  smtp: MailServerConfig;
  appPasswordUrl: string | undefined;
  requires2FA: boolean;
  /** True for the custom slug — UI must collect host/port. */
  custom: boolean;
}

export function describePreset(slug: MailPresetSlug): PresetDescriptor {
  if (slug === 'custom') {
    return {
      slug: 'custom',
      label: 'Custom IMAP/SMTP',
      imap: { host: '', port: 993, secure: true },
      smtp: { host: '', port: 465, secure: true },
      appPasswordUrl: undefined,
      requires2FA: false,
      custom: true,
    };
  }
  const preset = PRESETS[slug];
  return {
    slug,
    label: preset.label,
    imap: preset.imap,
    smtp: preset.smtp,
    appPasswordUrl: preset.appPasswordUrl,
    requires2FA: preset.requires2FA,
    custom: false,
  };
}

export function listPresets(): ReadonlyArray<PresetDescriptor> {
  return [
    describePreset('gmail'),
    describePreset('icloud'),
    describePreset('fastmail'),
    describePreset('yahoo'),
    describePreset('outlook'),
    describePreset('custom'),
  ];
}

// ── Account builder ────────────────────────────────────────────────────────

export interface PresetAccountInput {
  id: string;
  displayName: string;
  address: string;
  /** Semantic role. Default: 'personal'. */
  type?: MailAccountType | undefined;
  /** Optional custom persona instruction. */
  personaPrompt?: string | undefined;
}

/**
 * Build a MailAccountConfig from a preset slug + the minimal user-supplied
 * fields. For 'custom', use buildCustomAccount() instead.
 */
export function buildPresetAccount(slug: Exclude<MailPresetSlug, 'custom'>, input: PresetAccountInput): MailAccountConfig {
  const preset = PRESETS[slug];
  return {
    id: input.id,
    displayName: input.displayName,
    address: input.address,
    preset: slug,
    imap: preset.imap,
    smtp: preset.smtp,
    auth: 'app-password',
    type: input.type ?? 'personal',
    personaPrompt: input.personaPrompt,
  };
}

export interface CustomAccountInput extends PresetAccountInput {
  imap: MailServerConfig;
  smtp: MailServerConfig;
}

export function buildCustomAccount(input: CustomAccountInput): MailAccountConfig {
  if (!input.imap.host || !input.smtp.host) {
    throw new MailError('unsupported', 'Custom account requires non-empty imap.host and smtp.host');
  }
  return {
    id: input.id,
    displayName: input.displayName,
    address: input.address,
    preset: 'custom',
    imap: input.imap,
    smtp: input.smtp,
    auth: 'app-password',
    type: input.type ?? 'personal',
    personaPrompt: input.personaPrompt,
  };
}

// ── Provider factory ───────────────────────────────────────────────────────

export function createPresetProvider(
  slug: Exclude<MailPresetSlug, 'custom'>,
  input: PresetAccountInput,
  resolveCredentials: CredentialsResolver,
): MailProvider {
  return new ImapSmtpProvider(buildPresetAccount(slug, input), resolveCredentials);
}

export function createCustomProvider(
  input: CustomAccountInput,
  resolveCredentials: CredentialsResolver,
): MailProvider {
  return new ImapSmtpProvider(buildCustomAccount(input), resolveCredentials);
}

// ── Autodiscover (Thunderbird ISPDB) ───────────────────────────────────────
//
// For 'custom' onboarding the UI can call this with the user's email address
// to suggest IMAP/SMTP servers automatically. We hit autoconfig.thunderbird.net
// only — self-hosted autoconfig.<domain>/mail/config-v1.1.xml is a Phase 1
// addition since it requires DNS lookups + extra parsing.

export interface AutodiscoverResult {
  imap: MailServerConfig;
  smtp: MailServerConfig;
  /** Username template provided by the autoconfig record (e.g. '%EMAILADDRESS%'). */
  usernamePattern: string;
}

const AUTOCONFIG_URL = 'https://autoconfig.thunderbird.net/v1.1';
const AUTOCONFIG_TIMEOUT_MS = 5_000;

export async function autodiscover(emailAddress: string, fetchImpl: typeof fetch = fetch): Promise<AutodiscoverResult> {
  const at = emailAddress.lastIndexOf('@');
  if (at < 1 || at === emailAddress.length - 1) {
    throw new MailError('unsupported', `Invalid email address: ${emailAddress}`);
  }
  const domain = emailAddress.slice(at + 1).toLowerCase();
  const url = `${AUTOCONFIG_URL}/${encodeURIComponent(domain)}`;

  let xml: string;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(AUTOCONFIG_TIMEOUT_MS) });
    if (!res.ok) {
      throw new MailError('not_found', `Autodiscover failed: ${url} returned ${String(res.status)}`);
    }
    xml = await res.text();
  } catch (err) {
    if (err instanceof MailError) throw err;
    throw new MailError('connection_failed', `Autodiscover failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }

  return parseAutoconfigXml(xml);
}

/**
 * Parse a Mozilla autoconfig XML payload. Picks the first IMAP+SMTP pair
 * that uses TLS or STARTTLS (any plain-text option is rejected outright).
 *
 * Exposed for unit tests.
 */
export function parseAutoconfigXml(xml: string): AutodiscoverResult {
  const imap = pickFirstServer(xml, 'imap');
  const smtp = pickFirstServer(xml, 'smtp');
  if (!imap || !smtp) {
    throw new MailError('not_found', 'Autoconfig payload missing IMAP or SMTP server entry');
  }
  return {
    imap: { host: imap.host, port: imap.port, secure: imap.secure },
    smtp: { host: smtp.host, port: smtp.port, secure: smtp.secure },
    usernamePattern: imap.username ?? '%EMAILADDRESS%',
  };
}

interface ParsedServer {
  host: string;
  port: number;
  secure: boolean;
  username: string | undefined;
}

function pickFirstServer(xml: string, kind: 'imap' | 'smtp'): ParsedServer | null {
  const blockTag = kind === 'imap' ? 'incomingServer' : 'outgoingServer';
  const blockRegex = new RegExp(`<${blockTag}\\s[^>]*type="${kind}"[^>]*>([\\s\\S]*?)<\\/${blockTag}>`, 'gi');
  const matches = xml.matchAll(blockRegex);
  for (const match of matches) {
    const inner = match[1] ?? '';
    const host = innerTag(inner, 'hostname');
    const portStr = innerTag(inner, 'port');
    const sslType = (innerTag(inner, 'socketType') ?? '').toUpperCase();
    if (!host || !portStr) continue;
    if (sslType !== 'SSL' && sslType !== 'STARTTLS') continue; // refuse plain
    const port = Number.parseInt(portStr, 10);
    if (!Number.isFinite(port) || port <= 0 || port > 65_535) continue;
    return {
      host,
      port,
      secure: sslType === 'SSL',
      username: innerTag(inner, 'username') ?? undefined,
    };
  }
  return null;
}

function innerTag(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}>\\s*([^<]+?)\\s*<\\/${tag}>`, 'i'));
  return m?.[1];
}
