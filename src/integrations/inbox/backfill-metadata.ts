// === Inbox envelope-metadata backfill ===
//
// One-time per-account operator pass that fills the v11 envelope columns
// (from_address, from_name, subject, mail_date, snippet, message_id,
// in_reply_to) on inbox_items rows created before migration v11 landed.
//
// The pre-v11 rows expose `''` for the NOT NULL string columns; the
// classifier was never asked to write the envelope to the row, so the
// item-card UI fell back to account_id + classified_at. Per PRD-3 §Problem
// item 1+2, this is the canary's most-painful UX regression.
//
// Mechanics: re-run provider.list({ limit: listLimit }) per account, key
// by thread_key, UPDATE the envelope columns in place. No classify,
// no audit-row (the original `classified` row already records the
// verdict). New mails arriving during the backfill take the normal
// watcher path and write the v11 columns on first insert.
//
// Concurrency: callers serialise with `withInstanceMutex` — running
// two backfills concurrently against the same provider would double
// the IMAP load with no behavioural benefit. The endpoint that exposes
// this returns 409 when a backfill is already in flight.

import type { MailProvider } from '../mail/provider.js';
import { envelopeToItemInputFields, type InboxStateDb, type ThreadMessageInput } from './state.js';
import { resolveThreadKey } from './watcher-hook.js';
import { DEFAULT_BACKFILL_LIMIT } from './cold-start-adapter.js';

export interface BackfillMetadataOptions {
  provider: MailProvider;
  state: InboxStateDb;
  /** Single tenant scope; defaults to the repo's `'default'` sentinel. */
  tenantId?: string | undefined;
  /** Override the provider.list() batch size. Default 200. */
  listLimit?: number | undefined;
}

export interface BackfillMetadataReport {
  accountId: string;
  scanned: number;
  updated: number;
  /** Envelopes whose thread_key did not match any existing inbox_items row. */
  unmatched: number;
  /** True when the batch hit `listLimit` — older items beyond the window were not visited. */
  windowReached: boolean;
  /** The window value actually used (`listLimit` or DEFAULT_BACKFILL_LIMIT). */
  windowSize: number;
}

/**
 * Walk a backfill batch and update existing rows' envelope columns.
 * The full pass runs inside one SQLite transaction so the 200 row-by-row
 * UPDATEs share a single fsync and don't race the watcher's concurrent
 * writes. Errors propagate; the handler returns the cleared mutex via
 * its `finally`.
 */
export async function backfillMetadata(
  opts: BackfillMetadataOptions,
): Promise<BackfillMetadataReport> {
  const accountId = opts.provider.accountId;
  const tenantId = opts.tenantId;
  const listLimit = opts.listLimit ?? DEFAULT_BACKFILL_LIMIT;

  const envelopes = await opts.provider.list({ limit: listLimit });
  let scanned = 0;
  let updated = 0;
  let unmatched = 0;

  opts.state.runBackfillMetadataBatch(() => {
    for (const env of envelopes) {
      scanned += 1;
      const threadKey = resolveThreadKey(env);
      const fields = envelopeToItemInputFields(env);
      const ok = opts.state.updateItemEnvelopeByThreadKey(
        accountId,
        threadKey,
        {
          fromAddress: fields.fromAddress ?? '',
          fromName: fields.fromName,
          subject: fields.subject ?? '',
          mailDate: fields.mailDate,
          snippet: fields.snippet,
          messageId: fields.messageId,
          inReplyTo: fields.inReplyTo,
        },
        tenantId,
      );
      if (ok) updated += 1;
      else unmatched += 1;
      // v12: also populate inbox_thread_messages so the Reading-Pane
      // sees per-message envelope history. The UNIQUE(message_id)
      // index dedups against existing rows (rerun-safe).
      if (env.messageId && env.messageId.length > 0) {
        const matchingItem = opts.state.findItemByThread(accountId, threadKey);
        const tmInput: ThreadMessageInput = {
          accountId,
          threadKey,
          messageId: env.messageId,
          fromAddress: fields.fromAddress ?? '',
          subject: fields.subject ?? '',
          direction: 'inbound',
        };
        if (tenantId !== undefined) tmInput.tenantId = tenantId;
        if (fields.fromName !== undefined) tmInput.fromName = fields.fromName;
        if (fields.inReplyTo !== undefined) tmInput.inReplyTo = fields.inReplyTo;
        if (fields.mailDate !== undefined) tmInput.mailDate = fields.mailDate;
        if (fields.snippet !== undefined) tmInput.snippet = fields.snippet;
        if (matchingItem !== null) tmInput.inboxItemId = matchingItem.id;
        opts.state.insertThreadMessage(tmInput);
      }
    }
  });

  return {
    accountId,
    scanned,
    updated,
    unmatched,
    windowReached: envelopes.length >= listLimit,
    windowSize: listLimit,
  };
}
