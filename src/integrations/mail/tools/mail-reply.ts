// === mail_reply tool ===
//
// Thread-aware reply. Fetches the original message to populate In-Reply-To
// and References headers, derives a sensible default recipient (the original
// sender), then sends via SMTP. PERMISSION-GUARDED.

import type { IAgent, PromptText, ToolEntry } from '../../../types/index.js';
import { getErrorMessage } from '../../../core/utils.js';
import {
  MailError,
  isReceiveOnlyType,
  personaFor,
  type MailAddress,
  type MailProvider,
  type MailSendInput,
  type MailSendResult,
} from '../provider.js';
import type { MailContext } from '../context.js';
import { buildBodyBlock, checkSendAccount, previewAddressList, recipientFieldTargets, previewSendingAccount, quotedPreviewValue, resolveSendingAddress, writeSentLog } from '../send-core.js';
import { reflowMailBody } from '../body-reflow.js';
import { pv, singleLine } from '../../../core/prompt-value.js';
import { resolveThreadKey } from '../thread-key.js';
import { resolveProvider, type MailRegistry, accountForRow } from './registry.js';
import {
  checkMailRateLimit,
  checkRecipientDedup,
  recordMailSend,
} from './rate-limit.js';
import { isInputRequired } from '../../../core/input-required.js';
import { namedTarget, withoutAddresses } from '../../../core/audit-log.js';
import { currentCallFiling, currentCallOwnerKnownFor, currentCallTargetOrigin } from '../../../core/call-connection.js';
import { UNATTENDED_BLOCK_ANSWER } from '../../../core/prompt-store.js';
import { noticeLanguage } from '../../../core/notice-language.js';
import { originAsk, originDenied, originRefusedMandate, originRefusedUnattended, originReplyAsk, originReplyToAsk, originUnreadable, type OriginTargets, type SendOrigin } from '../../../core/origin-notices.js';
import { normalizeMailTarget } from '../../../core/send-target.js';
import { NOT_MARKED_MESSAGE } from '../../../core/approval-filing.js';
import type { MailReplyPayload, StoredAddress } from '../../../core/approval-store.js';

export interface MailReplyToolInput {
  account?: string | undefined;
  uid: number;
  body: string;
  /** Optional override for the recipient. Defaults to the original sender. */
  to?: string | undefined;
  cc?: string | undefined;
  folder?: string | undefined;
  /** Reply-all behaviour: include all original To and Cc recipients. */
  reply_all?: boolean | undefined;
}

/**
 * mail_reply needs more than a bare MailRegistry — it looks up account types
 * (to enforce the receive-only hard block) and derives the sending account
 * from the original recipient. The MailContext bundles everything.
 */
export function createMailReplyTool(registry: MailRegistry, ctx?: MailContext): ToolEntry<MailReplyToolInput> {
  return {
    outwardWrite: () => 'reply',
    // A reply reads the mail it answers before it writes: that read is a row of its own.
    outwardRead: (input) => namedTarget([['account', accountForRow(registry, input.account)], ['folder', input.folder === undefined ? undefined : withoutAddresses(input.folder)], ['uid', input.uid]]),
    // Only the recipients the call names: the `to` and `cc` overrides, parsed with this tool's
    // own parser. The default recipients (the original sender, and everyone on reply_all) come
    // from the mail being answered, which the input does not hold.
    sendTargets: (input) => recipientFieldTargets([input.to, input.cc], parseAddressList),
    definition: {
      name: 'mail_reply',
      description:
        'Reply to an existing message by UID. Fetches the original to copy In-Reply-To and References headers (preserving the thread). Default recipient is the original sender; pass to= to override or reply_all=true to include the full To+Cc list. Requires user confirmation before sending.',
      input_schema: {
        type: 'object' as const,
        properties: {
          account: { type: 'string', description: 'Account id or its mail address. Omit to use the default account.' },
          uid: { type: 'number', description: 'IMAP UID of the message to reply to. Required.' },
          body: { type: 'string', description: 'Plain-text reply body. Required.' },
          to: { type: 'string', description: 'Override recipient(s), comma-separated. Defaults to original sender.' },
          cc: { type: 'string', description: 'Override CC, comma-separated.' },
          folder: { type: 'string', description: 'Folder of the original message. Default: INBOX.' },
          reply_all: { type: 'boolean', description: 'Include all original To and Cc recipients. Default false.' },
        },
        required: ['uid', 'body'],
      },
    },
    requiresConfirmation: true,
    queueable: true,
    redactInputForAudit: (input: MailReplyToolInput) => {
      const { body: _body, ...rest } = input;
      return { ...rest, body_chars: typeof input.body === 'string' ? input.body.length : 0 };
    },
    handler: async (input: MailReplyToolInput, agent: IAgent): Promise<string> => {
      try {
        if (typeof input.uid !== 'number' || !Number.isFinite(input.uid)) {
          return 'mail_reply error: "uid" must be a number';
        }
        if (!input.body) return 'mail_reply error: "body" is required';
        // A call the danger check let through to be filed has no one to ask: it files at the
        // consent step below, after every check of `prepareReply`.
        const filing = currentCallFiling();
        if (!filing && !agent.promptUser) {
          return 'mail_reply error: sending requires interactive user confirmation, which is not available in this mode.';
        }

        const prepared = await prepareReply(registry, ctx, input);
        if (!prepared.ok) return prepared.message;

        if (filing) {
          // The card names where a recipient the owner did not name comes from (`Agent.fileApproval`).
          if (!agent.fileApproval) return NOT_MARKED_MESSAGE;
          return agent.fileApproval({ kind: 'mail_reply', payload: prepared.filing }).message;
        }
        if (!agent.promptUser) {
          return 'mail_reply error: sending requires interactive user confirmation, which is not available in this mode.';
        }

        // The recipients the dispatcher did not check: a reply's default recipients come from the
        // mail it answers, which the input does not name. One the owner did not name is said in the
        // confirmation, which is then a blocked question: a run nobody watches refuses it, and a
        // session of someone else the owner let in does not send to it at all.
        const recipients = [...prepared.commit.to, ...prepared.commit.cc].map((a) => a.address);
        const origin: SendOrigin = { kind: 'readMail', sender: prepared.filing.original.from };
        // A recipient of the mail being answered that does not read as an address refuses the
        // whole reply, unasked, as the dispatcher does for one the input names.
        if (recipients.some((r) => normalizeMailTarget(r) === null)) {
          try { agent.onOriginRefused?.({ targets: { values: [], unreadable: true }, noun: 'mail', origin }); } catch { /* the refusal stands */ }
          return originUnreadable('mail');
        }
        const unnamed = replyRecipientsNotOwnerKnown(agent, recipients);
        const targets: OriginTargets = { values: unnamed, unreadable: false };
        const refused = (text: string): string => {
          try { agent.onOriginRefused?.({ targets, noun: 'mail', origin }); } catch { /* the refusal stands */ }
          return text;
        };
        if (unnamed.length > 0 && agent.principal.kind !== 'owner') {
          return refused(originRefusedMandate(targets, origin, 'mail'));
        }
        const lang = agent.noticeLanguage ?? noticeLanguage(undefined);
        // A reply whose one unnamed recipient is the address it goes to by default says so in its
        // own words, and only where those words are true:
        //  - that address is the mail's sender: the sender's sentence;
        //  - it is a Reply-To, the mail has one readable sender, and the sender gets no copy: the
        //    question names both, the reply does not go to the person who wrote;
        //  - otherwise (the sender gets a copy, or the sender cannot be read as one address): the
        //    general question, which lists the recipient with where it came from.
        const defaultTo = input.to ? undefined : normalizeMailTarget(prepared.commit.to[0]?.address ?? '')?.value;
        const fromAddresses = prepared.filing.original.from.split(',')
          .map((a) => normalizeMailTarget(a.trim())?.value).filter((a): a is string => a !== undefined);
        const normalizedRecipients = new Set(recipients.map((r) => normalizeMailTarget(r)?.value));
        const onlyDefault = unnamed.length === 1 && defaultTo !== undefined && unnamed[0] === defaultTo;
        const sender = fromAddresses.length === 1 ? fromAddresses[0] : undefined;
        const ask = onlyDefault && fromAddresses.includes(defaultTo)
          ? originReplyAsk(defaultTo, lang)
          : onlyDefault && sender !== undefined && !normalizedRecipients.has(sender)
            ? originReplyToAsk(defaultTo, sender, lang)
            : originAsk('mail_reply', input, 'mail', targets, origin, lang);
        const question = unnamed.length > 0 ? pv`${prepared.preview}\n\n${ask}` : prepared.preview;
        const answer = await agent.promptUser(question, ['Yes', 'No'], unnamed.length > 0 ? { blocked: true } : undefined);
        if (answer === UNATTENDED_BLOCK_ANSWER) return refused(originRefusedUnattended(targets, origin));
        if (!isApproval(answer)) {
          // A no to the question where a recipient comes from is said as such, so the model does
          // not try another recipient.
          return unnamed.length > 0 ? originDenied(targets, origin, 'mail') : 'mail_reply cancelled by user.';
        }

        // Owner-named in the log only when the dispatcher checked every recipient and found it
        // named before any question; a reply's default recipients never are.
        return await commitReply(prepared.sendProvider, prepared.commit, ctx, { originOwnerKnown: currentCallOwnerKnownFor(recipients) });
      } catch (err: unknown) {
        // A confirmation nobody can answer ends the run; as text, the model would work around it.
        if (isInputRequired(err)) throw err;
        if (err instanceof MailError) return `mail_reply error (${err.code}): ${err.message}`;
        return `mail_reply error: ${getErrorMessage(err)}`;
      }
    },
  };
}

/**
 * The recipients of a reply that are neither among the targets the dispatcher checked for this
 * call (the `to`/`cc` overrides, asked about there when foreign) nor owner-known now. The caller
 * refuses a reply with a recipient that does not read as an address before this.
 */
function replyRecipientsNotOwnerKnown(agent: IAgent, recipients: readonly string[]): string[] {
  const checked = currentCallTargetOrigin();
  const seen = new Set<string>([...(checked?.known ?? []), ...(checked?.unnamed?.targets ?? [])]);
  const unnamed: string[] = [];
  for (const r of recipients) {
    const target = normalizeMailTarget(r);
    if (target === null) continue;
    if (seen.has(target.value)) continue;
    if ((agent.ownerKnown?.known(target) ?? 'foreign') !== 'known') unnamed.push(target.value);
  }
  return unnamed;
}

/**
 * What a reply sends, fixed before the consent step from the same values the confirmation shows.
 * Today the commit follows the consent within the same call. Not a record that can wait:
 * it names no sending account (the provider travels beside it), and {@link commitReply}
 * re-runs none of the checks of {@link prepareReply}.
 */
export interface ReplyCommit {
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  /** The body as the model wrote it; {@link commitReply} reflows it for the wire. */
  body: string;
  inReplyTo?: string | undefined;
  references?: string | undefined;
  /** The thread key of the mail answered, for the inbox reconcile after the send. */
  originalThreadKey: string;
}

export type PreparedReply =
  | { ok: true; preview: PromptText; sendProvider: MailProvider; commit: ReplyCommit; filing: MailReplyPayload }
  | { ok: false; message: string };

/**
 * The reply's first step, before consent: every check that can refuse it (rate, secret
 * content, auto-reply, sending account, recipients, the sending address, dedup) and the
 * confirmation text. Reads the original mail; sends nothing.
 */
export async function prepareReply(
  registry: MailRegistry,
  ctx: MailContext | undefined,
  input: MailReplyToolInput,
): Promise<PreparedReply> {
  // Cross-session rate-limit check (see mail-send for rationale).
  const rateBlock = checkMailRateLimit('mail_reply');
  if (rateBlock) return { ok: false, message: rateBlock };

  // Block credential exfiltration via reply body — same defense as
  // mail_send. The reply path is in fact the more likely place for
  // a leak: an agent quoting an inbound mail's "API key:" line back
  // to the sender as part of a reply confirmation.
  const { detectSecretInContent, mailSecretRefusal } = await import('../../../tools/builtin/http.js');
  const secretMatch = detectSecretInContent(input.body);
  if (secretMatch) {
    return { ok: false, message: mailSecretRefusal('mail_reply', secretMatch) };
  }

  // For the initial fetch, resolve the requested reading account (or default).
  // The sending account may differ — smart reply-from derives it below.
  const readProvider = resolveProvider(registry, input.account);

  const fetchOpts: { uid: number; folder?: string } = { uid: input.uid };
  if (input.folder) fetchOpts.folder = input.folder;
  const original = await readProvider.fetch(fetchOpts);

  // ── Auto-reply loop protection ────────────────────────────────────
  //
  // RFC 3834 says: "Automatic responses SHOULD NOT be issued in response
  // to any message which contains an Auto-Submitted header field, where
  // that field has any value other than 'no'." We enforce this as a
  // hard block — no confirmation can override it. Prevents mail loops.
  if (original.envelope.isAutoReply) {
    return { ok: false, message: `mail_reply blocked: original message has Auto-Submitted header (auto-generated/auto-replied). ` +
      `RFC 3834 forbids automatic replies to automated messages to prevent mail loops. ` +
      `If this is a real message that needs a response, use mail_send instead.` };
  }

  // ── Smart reply-from ────────────────────────────────────────────
  //
  // Default sender = the account we read the message from. But if the
  // MailContext is available AND one of the original recipients matches
  // a different registered account by address, use THAT account as the
  // sender. This keeps "support reply" from support@, "personal reply"
  // from personal@, automatically.

  let sendProvider: MailProvider = readProvider;

  if (ctx) {
    const candidates = [...original.envelope.to, ...original.envelope.cc];
    for (const candidate of candidates) {
      const match = ctx.findAccountByAddress(candidate.address);
      if (!match) continue;
      // Receive-only types cannot send — skip as a candidate. The
      // permission check below is the hard boundary; this is just so
      // we don't surface a doomed confirmation prompt.
      if (isReceiveOnlyType(match.type)) continue;
      const matched = registry.get(match.id);
      if (!matched) continue;
      sendProvider = matched;
      break;
    }
  }

  // Receive-only hard block — no confirm, no override.
  // Same decision as sendMail's, including its fail-closed half: an
  // account with no stored configuration does not send.
  const sendVerdict = checkSendAccount(ctx, sendProvider.accountId);
  if (!sendVerdict.ok && sendVerdict.status === 'receive_only') {
    return { ok: false, message: `mail_reply blocked: ${sendVerdict.message}. ` +
      `Compliance and bulk mailboxes never auto-respond. Escalate this message to the user manually.` };
  }
  if (!sendVerdict.ok) {
    return { ok: false, message: `mail_reply blocked: ${sendVerdict.message}. ` +
      `The account is not set up for sending. Reconnect it in the mail settings.` };
  }

  // Determine recipients
  let toAddrs: MailAddress[];
  if (input.to) {
    toAddrs = parseAddressList(input.to);
  } else {
    // Default: the original sender (Reply-To if set, else From)
    const sender = original.envelope.replyTo[0] ?? original.envelope.from[0];
    toAddrs = sender ? [sender] : [];
  }
  if (toAddrs.length === 0) return { ok: false, message: 'mail_reply error: could not determine recipient — original message has no From or Reply-To, and no "to" override was given.' };

  // The address the reply goes out from, read from the same source the
  // provider sends from — not from the stored account row, which can lag
  // behind a reconnected Gmail account. Reply-all leaves it out and the
  // confirmation shows it.
  let sendingAddress: string;
  try {
    sendingAddress = await resolveSendingAddress(sendProvider);
  } catch (err) {
    return { ok: false, message: `mail_reply error: could not read the sending address: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Reply-all: union with original To + Cc, minus our own address and
  // minus whoever the explicit cc already names (that entry is kept as given)
  let ccAddrs: MailAddress[] = input.cc ? parseAddressList(input.cc) : [];
  if (input.reply_all) {
    const ourAddress = sendingAddress;
    const seen = new Set<string>([
      ...toAddrs.map(a => a.address.toLowerCase()),
      ...ccAddrs.map(a => a.address.toLowerCase()),
      ourAddress.toLowerCase(),
    ]);
    for (const addr of [...original.envelope.to, ...original.envelope.cc]) {
      const key = addr.address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      ccAddrs.push(addr);
    }
  }

  // Build References chain: existing references + original Message-ID
  const origMessageId = original.envelope.messageId;
  const newReferences = [original.references, origMessageId].filter((s): s is string => typeof s === 'string' && s.length > 0).join(' ');

  const subject = original.envelope.subject.startsWith('Re:')
    ? original.envelope.subject
    : `Re: ${original.envelope.subject || '(no subject)'}`;

  // Per-recipient dedup window — block before showing the confirm
  // prompt so a retry storm can't pile up approval requests.
  const dedupBlock = checkRecipientDedup([...toAddrs, ...ccAddrs], subject);
  if (dedupBlock) return { ok: false, message: dedupBlock };

  // Persona hint shown in the confirmation prompt so the user knows
  // what voice will be used. Phase 1 will inject this as a compose-time
  // system prompt; Phase 0.1 is just the advisory render.
  const smartNote = sendProvider.accountId !== readProvider.accountId
    ? ` _(smart reply-from, read via ${quotedPreviewValue(readProvider.accountId)})_` : '';
  const sendAccountConfig = sendVerdict.accountConfig;
  const personaNote = sendAccountConfig
    ? ` · _${singleLine(truncate(personaFor(sendAccountConfig), 80))}_` : '';
  // Shared with mail_send's preview: an oversized body must state its
  // real size instead of ending in a bare "…". Reply is the likelier
  // injection path of the two — the untrusted inbound mail is already in
  // context when the body gets composed. Both subject renders go through
  // `singleLine` for the same reason: here the value is the REMOTE
  // sender's subject, and a newline in it can swallow the rest of this
  // prompt (see singleLine's doc).
  const bodyPreview = buildBodyBlock(input.body);

  const preview = pv`**Reply to "${singleLine(original.envelope.subject || '(no subject)')}"?**

**To:** ${previewAddressList(toAddrs)}${ccAddrs.length > 0 ? pv`
**Cc:** ${previewAddressList(ccAddrs)}` : ''}
**Subject:** ${singleLine(subject)}
**From:** ${previewSendingAccount(sendProvider, sendingAddress)}${smartNote}${personaNote}

${bodyPreview}`;

  const stored = (list: ReadonlyArray<MailAddress>): StoredAddress[] =>
    list.map(a => (a.name !== undefined ? { name: a.name, address: a.address } : { address: a.address }));
  const originalThreadKey = resolveThreadKey(original.envelope);
  // What the approval queue stores when this reply is filed instead of confirmed (PRD §4.3a):
  // the same values the confirmation shows, the body as it will go out.
  const filing: MailReplyPayload = {
    accountId: sendProvider.accountId,
    fromAddress: sendingAddress,
    to: stored(toAddrs),
    cc: stored(ccAddrs),
    subject,
    bodyText: reflowMailBody(input.body),
    ...(origMessageId ? { inReplyTo: origMessageId } : {}),
    ...(newReferences ? { references: newReferences } : {}),
    originalThreadKey,
    ...(origMessageId ? { originalMessageId: origMessageId } : {}),
    originalFolderUid: `${original.envelope.folder}:${String(original.envelope.uid)}`,
    // The provider the original was fetched through, resolved from whatever the call named: the
    // uid above is this mailbox's.
    readAccountId: readProvider.accountId,
    original: {
      from: original.envelope.from.map(a => a.address).join(', '),
      to: original.envelope.to.map(a => a.address),
      cc: original.envelope.cc.map(a => a.address),
      // A reply goes to the Reply-To by default, so the card counts it as named by the original.
      replyTo: original.envelope.replyTo.map(a => a.address),
      subject: original.envelope.subject,
      date: original.envelope.date instanceof Date && !Number.isNaN(original.envelope.date.getTime()) ? original.envelope.date.toISOString() : '',
    },
    ...(sendAccountConfig ? { persona: personaFor(sendAccountConfig) } : {}),
  };

  return {
    ok: true,
    preview,
    sendProvider,
    filing,
    commit: {
      to: toAddrs,
      cc: ccAddrs,
      subject,
      body: input.body,
      ...(origMessageId ? { inReplyTo: origMessageId } : {}),
      ...(newReferences ? { references: newReferences } : {}),
      // Always carry the thread key so the inbox reconcile can match a
      // message-id-less original (no Message-ID header → originalMessageId
      // absent); resolveThreadKey falls back to folder:uid.
      originalThreadKey,
    },
  };
}

/**
 * The reply's last step, after consent: send exactly what {@link prepareReply} fixed, count
 * it, write it to the sent log, and reconcile the inbox.
 */
export async function commitReply(
  sendProvider: MailProvider,
  c: ReplyCommit,
  ctx: MailContext | undefined,
  opts: { originOwnerKnown?: boolean | undefined } = {},
): Promise<string> {
  const sendInput: MailSendInput = {
    to: c.to,
    subject: c.subject,
    // Same wire rule as the send-core pipeline: reflow the model's hard
    // editing-wrap (mail_reply sends directly, NOT via sendMail — the
    // review found reflow placed in send-core covered mail_send + the
    // scheduled poller but left this path, which is where agent-authored
    // hard-wrapped bodies are most common).
    text: reflowMailBody(c.body),
  };
  if (c.cc.length > 0) sendInput.cc = c.cc;
  if (c.inReplyTo) sendInput.inReplyTo = c.inReplyTo;
  if (c.references) sendInput.references = c.references;

  const result: MailSendResult = await sendProvider.send(sendInput);
  recordMailSend([...c.to, ...c.cc], c.subject);
  // The sent log, as `sendMail` writes it: the outbound history and the export list replies too.
  // A reply's default recipients come from the original mail, not from the owner, so the row counts
  // them as owner-named only when the caller checked every recipient and says so (`originOwnerKnown`,
  // default false). An approval on a card is not that check.
  writeSentLog(ctx, {
    accountId: sendProvider.accountId,
    messageId: result.messageId || `local-${String(Date.now())}`,
    to: c.to,
    ...(c.cc.length > 0 ? { cc: c.cc } : {}),
    subject: c.subject,
    bodyChars: sendInput.text.length,
    ...(c.inReplyTo ? { inReplyTo: c.inReplyTo } : {}),
    originOwnerKnown: opts.originOwnerKnown === true,
  });
  // The reply HAS been sent. Reconcile the inbox (mark the open item
  // answered — its own source of truth) as a best-effort, fully isolated
  // step: an absent hook method (a minimal ctx) or a throwing reconcile
  // must NEVER turn a delivered reply into a reported error, which would
  // invite a duplicate re-send. Optional-chain the METHOD (not just ctx)
  // and swallow, mirroring MailContext.notifyOutboundSent's own internal
  // swallow so the invariant holds for any ctx shape.
  try {
    await ctx?.notifyOutboundSent?.(sendProvider.accountId, {
      input: sendInput,
      result,
      isReply: true,
      originalThreadKey: c.originalThreadKey,
      ...(c.inReplyTo ? { originalMessageId: c.inReplyTo } : {}),
    });
  } catch { /* reconcile is best-effort — never fail an already-sent reply */ }
  return `Reply sent from ${sendProvider.accountId}.\nMessage-ID: ${result.messageId}\nAccepted: ${result.accepted.join(', ') || '(none)'}${result.rejected.length > 0 ? `\nRejected: ${result.rejected.join(', ')}` : ''}`;
}

function parseAddressList(input: string | undefined): MailAddress[] {
  if (!input) return [];
  return input
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(parseAddress)
    .filter((a): a is MailAddress => a !== null);
}

function parseAddress(raw: string): MailAddress | null {
  const angle = raw.match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/);
  if (angle) {
    const name = angle[1]?.trim();
    const address = angle[2]?.trim();
    if (!address || !address.includes('@')) return null;
    return name ? { name, address } : { address };
  }
  if (raw.includes('@')) return { address: raw };
  return null;
}

/** Accept yes/ja/ok/1/y as approval — anything else is denial. */
function isApproval(answer: string): boolean {
  const a = answer.toLowerCase().trim();
  return ['yes', 'ja', 'ok', 'y', 'j', '1', 'sure', 'send', 'senden'].includes(a);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
