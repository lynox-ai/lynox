// === mail_connect tool ===
//
// Agent-driven mailbox onboarding. The tool does DISCOVERY + CONFIG only —
// it resolves the IMAP/SMTP servers (provider preset, or Thunderbird ISPDB
// autodiscover, or explicit host/port) and then hands off to an in-chat
// consent step (`connect_mail` prompt) where the USER enters the app-password.
//
// SECURITY (SEC-3): the password is NEVER collected, seen, or returned by this
// tool. The consent step posts it straight to POST /api/mail/accounts (which is
// not walled by the infra-secret deny-list, so it works on managed) → vault.
// The agent only ever receives a `connected | canceled` outcome. That is the
// whole reason this is a bespoke prompt and not `ask_secret`: ask_secret for a
// MAIL_ACCOUNT_* name is managed-blocked, and the account config (host/port)
// can't ride a secret prompt anyway.

import type { IAgent, ToolEntry, MailConnectPromptData, MailConnectServer } from '../../../types/index.js';
import { assertPublicHost } from '../../../core/network-guard.js';
import { describePreset } from '../providers/presets.js';
import { autodiscover } from '../providers/presets.js';
import type { MailPresetSlug } from '../provider.js';

interface MailConnectInput {
  email: string;
  /** Human-friendly account label. Defaults to the email address. */
  display_name?: string | undefined;
  /** Account id (vault key derives from it). Defaults to a slug of the address. */
  account_id?: string | undefined;
  /** Semantic role (a MailAccountType, e.g. 'personal'). Defaults to 'personal'. */
  account_type?: string | undefined;
  /** Explicit IMAP host — supply (with smtp_host) to force a custom account
   * instead of preset/autodiscover (e.g. a non-mainstream provider). */
  imap_host?: string | undefined;
  imap_port?: number | undefined;
  smtp_host?: string | undefined;
  smtp_port?: number | undefined;
}

// Common consumer-domain → provider-preset aliases. The preset table is keyed
// by slug, not domain, and there is no domain lookup elsewhere — so build it
// here. Unknown domains fall through to autodiscover.
const DOMAIN_PRESET: Readonly<Record<string, Exclude<MailPresetSlug, 'custom'>>> = {
  'gmail.com': 'gmail',
  'googlemail.com': 'gmail',
  'icloud.com': 'icloud',
  'me.com': 'icloud',
  'mac.com': 'icloud',
  'fastmail.com': 'fastmail',
  'fastmail.fm': 'fastmail',
  'yahoo.com': 'yahoo',
  'yahoo.co.uk': 'yahoo',
  'ymail.com': 'yahoo',
  'rocketmail.com': 'yahoo',
  'outlook.com': 'outlook',
  'hotmail.com': 'outlook',
  'hotmail.co.uk': 'outlook',
  'live.com': 'outlook',
  'msn.com': 'outlook',
};

function deriveId(address: string): string {
  const slug = address.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return slug || 'mailbox';
}

/** Reject private/loopback hosts on the agent-supplied (custom/autodiscover)
 * connect path — mirrors the assertPublicHost the HTTP mail-account route runs
 * for custom presets (http-api custom branch). Preset hosts are trusted
 * constants and skip this. Throws on a private host. */
async function assertPublicServers(imap: MailConnectServer, smtp: MailConnectServer): Promise<void> {
  await assertPublicHost(imap.host);
  await assertPublicHost(smtp.host);
}

export function createMailConnectTool(): ToolEntry<MailConnectInput> {
  return {
    definition: {
      name: 'mail_connect',
      description:
        'Connect an email mailbox (IMAP/SMTP) so it can be read, searched, and replied to. ' +
        'Give the user\'s email address; the tool auto-detects the provider (Gmail, iCloud, Fastmail, ' +
        'Yahoo, Outlook) or discovers servers via autoconfig, then opens a SECURE in-chat form where the ' +
        'user enters their app-password. NEVER ask the user to type their email password into the chat — ' +
        'this tool collects it securely. You only learn whether the connection succeeded. ' +
        'For an uncommon provider, pass imap_host + smtp_host explicitly.',
      input_schema: {
        type: 'object' as const,
        properties: {
          email: { type: 'string', description: 'The mailbox email address (e.g. anna@gmail.com). Required.' },
          display_name: { type: 'string', description: 'Optional friendly label for the account. Defaults to the address.' },
          account_id: { type: 'string', description: 'Optional account id. Defaults to a slug of the address.' },
          account_type: {
            type: 'string',
            description: 'Optional semantic role: personal, business, support, sales, info, etc. Defaults to personal.',
          },
          imap_host: { type: 'string', description: 'Explicit IMAP host (with imap_port) for an uncommon provider. Omit to auto-detect.' },
          imap_port: { type: 'number', description: 'IMAP port (default 993, implicit TLS).' },
          smtp_host: { type: 'string', description: 'Explicit SMTP host (with smtp_port) for an uncommon provider.' },
          smtp_port: { type: 'number', description: 'SMTP port (default 465, implicit TLS).' },
        },
        required: ['email'],
      },
    },
    // The in-chat consent step (connect_mail prompt) IS the confirmation, so opt
    // out of the generic Allow/Deny danger prompt — but stay BLOCKED in
    // autonomous mode via the MAIL_WRITE_TOOLS gate (no human to consent).
    requiresConfirmation: true,
    handler: async (input: MailConnectInput, agent: IAgent): Promise<string> => {
      const email = (input.email ?? '').trim();
      const at = email.lastIndexOf('@');
      if (at < 1 || at === email.length - 1) {
        return `mail_connect error: "${input.email}" is not a valid email address.`;
      }

      if (!agent.promptMailConnect) {
        return 'Secure mailbox connection is not available in this context. Ask the user to add the account in Settings → Mail instead. Do NOT ask the user to paste their email password into chat.';
      }

      const domain = email.slice(at + 1).toLowerCase();
      const id = (input.account_id ?? deriveId(email)).trim() || deriveId(email);
      const displayName = (input.display_name ?? email).trim() || email;
      const type = (input.account_type ?? 'personal').trim() || 'personal';

      let data: MailConnectPromptData;

      const slug = DOMAIN_PRESET[domain];
      if (slug) {
        // 1. KNOWN consumer provider → ALWAYS its trusted constant hosts.
        // This branch is checked FIRST and deliberately ignores any agent-
        // supplied imap_host/smtp_host: otherwise a prompt-injected agent could
        // stage `address=victim@gmail.com` + `imap_host=attacker.tld` and phish
        // the user's real provider password against an attacker's IMAP server
        // (a public attacker host passes assertPublicHost). A "@gmail.com" login
        // has exactly one correct server set — bind it, don't trust the agent's
        // hosts or rely on the user noticing the wrong host in the consent card.
        const d = describePreset(slug);
        data = {
          id, displayName, address: email, preset: slug, type,
          imap: d.imap, smtp: d.smtp,
          appPasswordUrl: d.appPasswordUrl,
          requires2FA: d.requires2FA,
        };
      } else if (input.imap_host && input.smtp_host) {
        // 2. Genuinely custom domain (no known preset) → explicit host/port.
        const imap: MailConnectServer = { host: input.imap_host.trim(), port: input.imap_port ?? 993, secure: (input.imap_port ?? 993) !== 143 };
        const smtp: MailConnectServer = { host: input.smtp_host.trim(), port: input.smtp_port ?? 465, secure: (input.smtp_port ?? 465) === 465 };
        try {
          await assertPublicServers(imap, smtp);
        } catch (err) {
          return `mail_connect blocked: ${err instanceof Error ? err.message : String(err)}. The mail server must be reachable on a public address.`;
        }
        data = { id, displayName, address: email, preset: 'custom', type, imap, smtp };
      } else {
        // 3. Unknown custom domain, no explicit hosts → autodiscover (Thunderbird ISPDB, constant host).
        let discovered;
        try {
          discovered = await autodiscover(email);
        } catch (err) {
          return `mail_connect could not auto-detect mail servers for "${domain}" (${err instanceof Error ? err.message : String(err)}). Ask the user for their IMAP and SMTP host, then call mail_connect again with imap_host + smtp_host.`;
        }
        const imap: MailConnectServer = { host: discovered.imap.host, port: discovered.imap.port, secure: discovered.imap.secure };
        const smtp: MailConnectServer = { host: discovered.smtp.host, port: discovered.smtp.port, secure: discovered.smtp.secure };
        try {
          await assertPublicServers(imap, smtp);
        } catch (err) {
          return `mail_connect blocked: ${err instanceof Error ? err.message : String(err)}. The discovered mail server must be reachable on a public address.`;
        }
        data = { id, displayName, address: email, preset: 'custom', type, imap, smtp };
      }

      const outcome = await agent.promptMailConnect(data);
      switch (outcome) {
        case 'connected':
          return `Mailbox "${email}" connected successfully and is now being watched for new mail. The user entered the app-password securely — you never received it.`;
        case 'canceled':
          return `The user dismissed the secure connect form for "${email}", so no account was added. Acknowledge briefly. DO NOT ask the user to paste their email password into chat — the secure form is the only way to connect a mailbox. If they want to retry, call mail_connect again.`;
      }
    },
  };
}
