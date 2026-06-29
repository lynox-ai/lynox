// === mail_connect tool ===
//
// Agent-driven mailbox onboarding for KNOWN consumer providers ONLY. The tool
// does DISCOVERY + CONFIG for a recognised provider (Gmail, iCloud, Fastmail,
// Yahoo, Outlook/Hotmail) — it resolves that provider's TRUSTED CONSTANT
// IMAP/SMTP servers and hands off to an in-chat consent step (`connect_mail`
// prompt) where the USER enters the app-password.
//
// CAPABILITY-SCOPE — why the agent path is preset-only (see
// feedback_agent_tool_surface_is_attack_surface): the always-on tool registry
// IS prompt-injection attack surface — a malicious mail body / web-fetch result
// / uploaded doc the agent reads could invoke this tool on any turn. So the
// agent path is scoped to the PARAMETER-SAFE subset: a known provider has
// exactly ONE correct server set, bound from a constant, with ZERO agent host
// control. An injected agent therefore cannot point a "@gmail.com" login at an
// attacker's IMAP server to phish the user's real provider password. The
// arbitrary-target variant (a custom / non-mainstream provider with an
// attacker-influenceable IMAP/SMTP host) is deliberately NOT handled here — it
// goes through the Settings → Mail UI, which is not prompt-injectable.
//
// SECURITY (SEC-3): the password is NEVER collected, seen, or returned by this
// tool. The consent step posts it straight to POST /api/mail/accounts (which is
// not walled by the infra-secret deny-list, so it works on managed) → vault.
// The agent only ever receives a `connected | canceled` outcome. That is the
// whole reason this is a bespoke prompt and not `ask_secret`: ask_secret for a
// MAIL_ACCOUNT_* name is managed-blocked, and the account config can't ride a
// secret prompt anyway.

import type { IAgent, ToolEntry, MailConnectPromptData } from '../../../types/index.js';
import { describePreset } from '../providers/presets.js';
import type { MailPresetSlug } from '../provider.js';

interface MailConnectInput {
  email: string;
  /** Human-friendly account label. Defaults to the email address. */
  display_name?: string | undefined;
  /** Account id (vault key derives from it). Defaults to a slug of the address. */
  account_id?: string | undefined;
  /** Semantic role (a MailAccountType, e.g. 'personal'). Defaults to 'personal'. */
  account_type?: string | undefined;
}

// Common consumer-domain → provider-preset aliases. The preset table is keyed
// by slug, not domain, and there is no domain lookup elsewhere — so build it
// here. This IS the agent-tool's supported-provider allowlist: an unknown
// domain is routed to the Settings → Mail UI, never auto-discovered here.
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

export function createMailConnectTool(): ToolEntry<MailConnectInput> {
  return {
    definition: {
      name: 'mail_connect',
      description:
        'Connect an email mailbox for a KNOWN provider (Gmail, iCloud, Fastmail, Yahoo, ' +
        'Outlook/Hotmail) so it can be read, searched, and replied to. Give the user\'s email ' +
        'address; the tool detects the provider and opens a SECURE in-chat form where the user ' +
        'enters their app-password. NEVER ask the user to type their email password into chat — ' +
        'this tool collects it securely, and you only learn whether the connection succeeded. ' +
        'For ANY other or custom mail provider, tell the user to add the account in ' +
        'Settings → Mail — this chat tool only supports the major providers.',
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
      const slug = DOMAIN_PRESET[domain];
      if (!slug) {
        // Capability-scope: a non-preset domain implies an arbitrary mail host
        // the agent (and thus a prompt injection) could influence. Connecting it
        // would need IMAP/SMTP host parameters this tool deliberately does NOT
        // expose — that arbitrary-target variant lives in the deliberate
        // Settings → Mail UI, which is not prompt-injectable. Stage NOTHING and
        // raise no consent step; just route the user to the UI.
        return `mail_connect only supports the major providers (Gmail, iCloud, Fastmail, Yahoo, Outlook/Hotmail). "${domain}" isn't one of them. Ask the user to add this mailbox in Settings → Mail, where they can enter the custom IMAP/SMTP server details themselves. Do NOT ask the user to paste their email password into chat.`;
      }

      const id = (input.account_id ?? deriveId(email)).trim() || deriveId(email);
      const displayName = (input.display_name ?? email).trim() || email;
      const type = (input.account_type ?? 'personal').trim() || 'personal';

      // KNOWN consumer provider → ALWAYS its trusted constant hosts. A
      // "@gmail.com" login has exactly one correct server set; bind it from the
      // preset constant. The agent has no host parameter to influence, so this
      // is structurally un-phishable.
      const d = describePreset(slug);
      const data: MailConnectPromptData = {
        id, displayName, address: email, preset: slug, type,
        imap: d.imap, smtp: d.smtp,
        appPasswordUrl: d.appPasswordUrl,
        requires2FA: d.requires2FA,
      };

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
