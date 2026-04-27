// === mail_search tool ===
//
// IMAP SEARCH with envelope-only result shape. Read-only — no permission
// guard. Token cost ~2K for 20 messages (snippet + headers).

import type { IAgent, ToolEntry } from '../../../types/index.js';
import { getErrorMessage } from '../../../core/utils.js';
import { MailError, type MailEnvelope, type MailSearchOptions, type MailSearchQuery } from '../provider.js';
import { renderTriageList } from '../triage/envelope.js';
import { resolveProviders, type MailRegistry } from './registry.js';

interface MailSearchInput {
  account?: string | undefined;
  text?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  subject?: string | undefined;
  since?: string | undefined; // ISO date string
  before?: string | undefined;
  unseen?: boolean | undefined;
  flagged?: boolean | undefined;
  has_attachment?: boolean | undefined;
  folder?: string | undefined;
  limit?: number | undefined;
}

export function createMailSearchTool(registry: MailRegistry): ToolEntry<MailSearchInput> {
  return {
    definition: {
      name: 'mail_search',
      description:
        'Search the user\'s mail accounts via IMAP SEARCH. Returns up to N compact envelopes (subject, from, date, snippet, attachment hint) — never full bodies. Use mail_read for the full body of a specific message. Combine fields freely (e.g. from + subject + since).',
      input_schema: {
        type: 'object' as const,
        properties: {
          account: { type: 'string', description: 'Account id. Omit to use the default account.' },
          text: { type: 'string', description: 'Free-text search across headers and body.' },
          from: { type: 'string', description: 'Match the From: address (substring).' },
          to: { type: 'string', description: 'Match the To: address (substring).' },
          subject: { type: 'string', description: 'Match the Subject: header (substring).' },
          since: { type: 'string', description: 'ISO date — only messages received on or after this date.' },
          before: { type: 'string', description: 'ISO date — only messages received before this date (exclusive).' },
          unseen: { type: 'boolean', description: 'Only unread (\\Seen flag absent).' },
          flagged: { type: 'boolean', description: 'Only \\Flagged messages.' },
          has_attachment: { type: 'boolean', description: 'Only messages with at least one attachment.' },
          folder: { type: 'string', description: 'Mailbox folder. Default: INBOX.' },
          limit: { type: 'number', description: 'Max envelopes to return. Default 20, hard cap 50.' },
        },
        required: [],
      },
    },
    handler: async (input: MailSearchInput, _agent: IAgent): Promise<string> => {
      try {
        const providers = resolveProviders(registry, input.account);

        const query: MailSearchQuery = {};
        if (input.text) query.text = input.text;
        if (input.from) query.from = input.from;
        if (input.to) query.to = input.to;
        if (input.subject) query.subject = input.subject;
        const since = parseDate(input.since);
        if (since) query.since = since;
        const before = parseDate(input.before);
        if (before) query.before = before;
        if (input.unseen) query.unseen = true;
        if (input.flagged) query.flagged = true;
        if (input.has_attachment) query.hasAttachment = true;

        const opts: MailSearchOptions = {};
        if (input.folder) opts.folder = input.folder;
        // When fanning out across N accounts, divide the user-requested limit.
        // Guarantee at least 5 per account so small N stays useful.
        const userLimit = input.limit !== undefined ? Math.min(Math.max(1, input.limit), 50) : 20;
        const perAccountLimit = Math.max(5, Math.floor(userLimit / providers.length));
        if (perAccountLimit > 0) opts.limit = perAccountLimit;

        // Fan out across all resolved providers, tagging each envelope with
        // its owning account for rendering. Errors in one account are reported
        // inline but never abort the whole call — partial results are valuable.
        interface Tagged { accountId: string; envelope: MailEnvelope }
        const tagged: Tagged[] = [];
        const perAccountErrors: string[] = [];
        await Promise.all(providers.map(async (provider) => {
          try {
            const envelopes = await provider.search(query, opts);
            for (const e of envelopes) tagged.push({ accountId: provider.accountId, envelope: e });
          } catch (err) {
            const msg = err instanceof MailError ? `${err.code}: ${err.message}` : getErrorMessage(err);
            perAccountErrors.push(`${provider.accountId}: ${msg}`);
          }
        }));

        if (tagged.length === 0 && perAccountErrors.length === 0) {
          return 'No messages found.';
        }

        return renderFanoutResult('search', providers.length, tagged, perAccountErrors);
      } catch (err: unknown) {
        if (err instanceof MailError) return `mail_search error (${err.code}): ${err.message}`;
        return `mail_search error: ${getErrorMessage(err)}`;
      }
    },
  };
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return d;
}

/**
 * Render fan-out results grouped by account. Shared between mail_search and
 * (later) mail_triage so the agent always sees a consistent shape.
 */
export function renderFanoutResult(
  toolName: 'search' | 'triage',
  accountCount: number,
  tagged: ReadonlyArray<{ accountId: string; envelope: MailEnvelope }>,
  errors: ReadonlyArray<string>,
): string {
  if (accountCount === 1) {
    // Single-account path — don't add group headers, render as before
    const envelopes = tagged.map(t => t.envelope);
    if (envelopes.length === 0 && errors.length === 0) return 'No messages found.';
    const lines: string[] = [];
    if (envelopes.length > 0) {
      lines.push(`Found ${String(envelopes.length)} message(s):`);
      lines.push('');
      lines.push(renderTriageList(envelopes, tagged[0]?.accountId));
    }
    if (errors.length > 0) {
      lines.push('');
      lines.push(`Errors: ${errors.join('; ')}`);
    }
    return lines.join('\n');
  }

  // Fan-out path — group by account
  const byAccount = new Map<string, MailEnvelope[]>();
  for (const t of tagged) {
    const list = byAccount.get(t.accountId) ?? [];
    list.push(t.envelope);
    byAccount.set(t.accountId, list);
  }

  const total = tagged.length;
  const header = toolName === 'search'
    ? `Found ${String(total)} message(s) across ${String(accountCount)} account(s):`
    : `Triage across ${String(accountCount)} account(s) — ${String(total)} survivor(s):`;

  const lines: string[] = [header, ''];
  for (const [accountId, envelopes] of byAccount.entries()) {
    lines.push(`### ${accountId} (${String(envelopes.length)})`);
    lines.push(renderTriageList(envelopes, accountId));
    lines.push('');
  }
  if (errors.length > 0) {
    lines.push('Errors:');
    for (const e of errors) lines.push(`  - ${e}`);
  }
  return lines.join('\n').trimEnd();
}
