// === mail_triage tool ===
//
// Lightweight inbox overview: list recent messages, run the deterministic
// prefilter, group into threads, return a compact summary the agent uses to
// decide which messages need a deeper read. No LLM call inside this tool —
// it's pure orchestration.
//
// Phase 0: read-only, no classification. Phase 1 will route the survivors
// through a Haiku-tier classifier and emit web-push notifications.

import type { IAgent, ToolEntry } from '../../../types/index.js';
import { getErrorMessage } from '../../../core/utils.js';
import { MailError, type MailEnvelope, type MailListOptions, type MailProvider } from '../provider.js';
import { renderTriageList } from '../triage/envelope.js';
import { wrapUntrustedData } from '../../../core/data-boundary.js';
import { oneBlockLine } from '../block-line.js';
import { groupByThread } from '../triage/thread.js';
import { prefilter } from '../triage/rules.js';
import { resolveProviders, type MailRegistry, accountForRow } from './registry.js';
import { namedTarget, withoutAddresses } from '../../../core/audit-log.js';
import type { MailHooks, InboxLabel } from '../context.js';

interface MailTriageInput {
  account?: string | undefined;
  folder?: string | undefined;
  since?: string | undefined; // ISO date
  limit?: number | undefined;
  unseen_only?: boolean | undefined;
  /** Skip the noise filter — useful when debugging "where did message X go?". */
  include_noise?: boolean | undefined;
}

const BUCKETS = new Set(['requires_user', 'draft_ready', 'auto_handled']);
const USER_ACTIONS = new Set(['archived', 'replied', 'snoozed', 'unhandled']);

/**
 * The header text for an inbox verdict: the bucket, and the user's action once there is
 * one. Only known enum values pass, so nothing a sender wrote can reach the header.
 */
export function inboxLabelText(label: InboxLabel | null): string | null {
  if (!label || !BUCKETS.has(label.bucket)) return null;
  return label.userAction && USER_ACTIONS.has(label.userAction) ? `${label.bucket}/${label.userAction}` : label.bucket;
}

/** What the `inbox:` labels mean, shown once above the list when any message carries one. */
export const INBOX_LABEL_LEGEND =
  'inbox: is what the inbox classifier decided for that message, after reading all of it (the snippets below are cut at 200 characters): ' +
  'requires_user and draft_ready mean it needs the user\'s answer or decision, auto_handled means it was dealt with; ' +
  'a /replied, /archived or /snoozed suffix is what the user has done since. Answer from these verdicts. ' +
  'Where you judge a message differently, say so and name the inbox\'s verdict.';

export function createMailTriageTool(registry: MailRegistry, hooks?: MailHooks): ToolEntry<MailTriageInput> {
  return {
    // Which mailbox was listed.
    outwardRead: (input) => ['list', namedTarget([['account', accountForRow(registry, input.account)], ['folder', input.folder === undefined ? undefined : withoutAddresses(input.folder)]])].filter((s) => s !== '').join(' '),
    definition: {
      name: 'mail_triage',
      description:
        'Get a quick inbox overview: lists recent (unseen) messages, drops obvious noise (newsletters, no-reply notifications, list-unsubscribe), groups remaining messages by thread, and returns a token-efficient summary. Use this BEFORE mail_search/mail_read when the user asks "what\'s new" or "anything important". Read-only.',
      input_schema: {
        type: 'object' as const,
        properties: {
          account: { type: 'string', description: 'Account id or its mail address. Omit to use the default account.' },
          folder: { type: 'string', description: 'Mailbox folder. Default: INBOX.' },
          since: { type: 'string', description: 'ISO date — only consider messages received on or after this date.' },
          limit: { type: 'number', description: 'Max envelopes to consider per tick. Default 50, hard cap 50.' },
          unseen_only: { type: 'boolean', description: 'Only triage unread messages. Default true.' },
          include_noise: { type: 'boolean', description: 'Disable the deterministic noise filter. Default false.' },
        },
        required: [],
      },
    },
    handler: async (input: MailTriageInput, _agent: IAgent): Promise<string> => {
      try {
        const providers = resolveProviders(registry, input.account);

        const opts: MailListOptions = {
          unseenOnly: input.unseen_only ?? true,
        };
        if (input.folder) opts.folder = input.folder;
        const since = parseDate(input.since);
        if (since) opts.since = since;
        // Split the per-call limit across accounts, but keep a minimum of 10
        // per account so tiny N stays informative.
        const userLimit = input.limit !== undefined ? Math.min(Math.max(1, input.limit), 50) : 50;
        const perAccountLimit = Math.max(10, Math.floor(userLimit / providers.length));
        opts.limit = perAccountLimit;

        interface AccountReport {
          accountId: string;
          considered: number;
          noise: number;
          survivors: MailEnvelope[];
          noiseSenders: string[];
          threadCount: number;
        }
        const reports: AccountReport[] = [];
        const perAccountErrors: string[] = [];

        await Promise.all(providers.map(async (provider: MailProvider) => {
          try {
            const envelopes = await provider.list(opts);
            const survivors: MailEnvelope[] = [];
            const noiseSenders: string[] = [];
            let noiseCount = 0;
            for (const env of envelopes) {
              if (input.include_noise) {
                survivors.push(env);
                continue;
              }
              const decision = prefilter(env);
              if (decision.category === 'noise') {
                noiseCount++;
                noiseSenders.push(env.from[0]?.address ?? '(unknown)');
              } else {
                survivors.push(env);
              }
            }
            const threads = groupByThread(survivors);
            reports.push({
              accountId: provider.accountId,
              considered: envelopes.length,
              noise: noiseCount,
              survivors,
              noiseSenders,
              threadCount: threads.length,
            });
          } catch (err) {
            const msg = err instanceof MailError ? `${err.code}: ${err.message}` : getErrorMessage(err);
            perAccountErrors.push(`${provider.accountId}: ${msg}`);
          }
        }));

        const totalConsidered = reports.reduce((n, r) => n + r.considered, 0);
        const totalNoise = reports.reduce((n, r) => n + r.noise, 0);
        const totalSurvivors = reports.reduce((n, r) => n + r.survivors.length, 0);
        const totalThreads = reports.reduce((n, r) => n + r.threadCount, 0);

        if (totalConsidered === 0 && perAccountErrors.length === 0) {
          return providers.length === 1
            ? `Inbox is empty (${providers[0]!.accountId}).`
            : `All ${String(providers.length)} inbox(es) empty.`;
        }

        // The inbox's verdict per message, when the inbox is on and has classified it.
        const lookup = hooks?.inboxLabelOf;
        let labelled = 0;
        const labelFor = (accountId: string) => (env: MailEnvelope): string | null => {
          if (!lookup || !env.messageId) return null;
          let text: string | null = null;
          try { text = inboxLabelText(lookup(accountId, env.messageId)); } catch { text = null; }
          if (text) labelled++;
          return text;
        };
        const rendered = new Map(reports.map((r) => [r.accountId, r.survivors.length > 0 ? renderTriageList(r.survivors, r.accountId, labelFor(r.accountId)) : '']));

        const lines: string[] = [];
        if (labelled > 0) {
          lines.push(INBOX_LABEL_LEGEND);
          lines.push('');
        }
        if (providers.length === 1) {
          const r = reports[0]!;
          lines.push(`Triage summary (${r.accountId}):`);
          lines.push(`  Considered: ${String(r.considered)}`);
          lines.push(`  Noise filtered: ${String(r.noise)}`);
          lines.push(`  Survivors: ${String(r.survivors.length)}  in ${String(r.threadCount)} thread(s)`);
          lines.push('');
          if (r.survivors.length > 0) {
            lines.push('Survivors:');
            lines.push(rendered.get(r.accountId)!);
          }
          if (r.noise > 0 && input.include_noise !== true) {
            lines.push('');
            // The addresses are the senders' own text — the local part is whatever the
            // sender typed — so they are listed inside a wrapped block, one line, and only
            // the count stays in the framing.
            lines.push(`Filtered noise (${String(r.noise)}), senders:`);
            lines.push(wrapUntrustedData(oneBlockLine(r.noiseSenders.join(', ')), `mail:${r.accountId}:noise-senders`));
          }
        } else {
          lines.push(`Triage summary across ${String(providers.length)} account(s):`);
          lines.push(`  Considered: ${String(totalConsidered)}`);
          lines.push(`  Noise filtered: ${String(totalNoise)}`);
          lines.push(`  Survivors: ${String(totalSurvivors)}  in ${String(totalThreads)} thread(s)`);
          lines.push('');
          for (const r of reports) {
            const header = `### ${r.accountId} — ${String(r.survivors.length)} survivor(s), ${String(r.noise)} noise, ${String(r.threadCount)} thread(s)`;
            lines.push(header);
            if (r.survivors.length > 0) {
              lines.push(rendered.get(r.accountId)!);
            } else {
              lines.push('(nothing new)');
            }
            lines.push('');
          }
        }

        if (perAccountErrors.length > 0) {
          lines.push('Errors:');
          for (const e of perAccountErrors) lines.push(`  - ${e}`);
        }

        return lines.join('\n').trimEnd();
      } catch (err: unknown) {
        if (err instanceof MailError) return `mail_triage error (${err.code}): ${err.message}`;
        return `mail_triage error: ${getErrorMessage(err)}`;
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
