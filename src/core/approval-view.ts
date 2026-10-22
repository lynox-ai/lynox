/**
 * An approval entry as its card shows it: what the list route answers with, built from the
 * entry and the marks on the trigger and workflow it came from. Pure; the route reads the rows.
 *
 * The card carries the mail as it will go out, what the owner should weigh before sending it
 * (a mass send, a reply to someone the original did not name, a run that read foreign content),
 * where it came from, who set that up, and a code for how it ended. It never carries the
 * entry's hashed keys (dedup, family), its binding, or the stored result: those hold recipients
 * and subjects in a form that can be enumerated, or a provider's text that can name a recipient.
 * The card is built field by field from an allowlist, so a column added to the entry later
 * does not reach it.
 */

import type { ApprovalEntry, ApprovalKind, ApprovalListScope, ApprovalSource, ApprovalStatus, StoredAddress } from './approval-store.js';
import { isMandateTag, MANDATE_TAG_PREFIX, unhandledPrincipal, type RequestPrincipal } from './request-principal.js';
import { recipientSpread } from '../integrations/mail/send-core.js';

/** Whose list is read: the owner sees every entry, a mandate only the ones filed under its own grant. */
export type ApprovalScope =
  | { readonly viewer: 'owner' }
  | { readonly viewer: 'mandate'; readonly mandateId: string };

/**
 * The scope a principal reads the list in, or null when it reads nothing: a mandate whose login
 * names no grant (its entries cannot be told from another grant's), and any principal that is
 * neither the owner nor a mandate. Entries are matched by grant id, never by the mandate's tag:
 * a later grant for the same address is another grant and does not see the earlier one's.
 */
export function approvalScopeOf(p: RequestPrincipal): ApprovalScope | null {
  switch (p.kind) {
    case 'owner': return { viewer: 'owner' };
    case 'mandate': return typeof p.mandateId === 'string' && p.mandateId !== '' ? { viewer: 'mandate', mandateId: p.mandateId } : null;
    case 'cp-admin': return null;
    default: return unhandledPrincipal(p);
  }
}

/** The store's filter for a scope: the owner reads every entry, a mandate its own grant's. */
export function listScopeOf(scope: ApprovalScope): ApprovalListScope {
  return scope.viewer === 'owner' ? { kind: 'all' } : { kind: 'grant', mandateId: scope.mandateId };
}

/**
 * How an entry ended, as a code; null while it is open. Read from the stored result's reason or
 * the decision's, only when it is one of these; anything else is `other`. The result's text is
 * never passed on: a provider's error can name a recipient.
 */
export const APPROVAL_OUTCOMES = [
  'sent', 'discarded', 'moved_to_chat', 'mandate_ended', 'cleared_unknown',
  // The executor's reasons.
  'not_executable', 'checksum', 'mail_unavailable', 'account_not_configured', 'receive_only', 'account_changed',
  'sending_address_unavailable', 'dedup_window', 'deadline_before_send', 'trail_unavailable', 'send_timeout',
  'send_threw', 'executor_error', 'invalid_recipients', 'secret_in_body', 'cancelled', 'queued', 'rate_limit',
  'provider_error',
  // The sweep's reasons.
  'stale_claim', 'ttl', 'claim_window', 'flag_off', 'send_limit', 'retry',
  'other',
] as const;
export type ApprovalOutcome = (typeof APPROVAL_OUTCOMES)[number];
const OUTCOME_SET: ReadonlySet<string> = new Set(APPROVAL_OUTCOMES);

const DECIDED_OUTCOME: ReadonlyMap<string, ApprovalOutcome> = new Map([
  ['owner', 'discarded'],
  ['moved_to_chat', 'moved_to_chat'],
  ['mandate_ended', 'mandate_ended'],
  ['cleared_unknown', 'cleared_unknown'],
]);

/** The reason code in a stored result (`{ reason: … }`), or `other`. */
function resultReason(resultJson: string | null): ApprovalOutcome {
  if (resultJson === null) return 'other';
  let v: unknown;
  try { v = JSON.parse(resultJson); } catch { return 'other'; }
  if (typeof v !== 'object' || v === null) return 'other';
  const reason = (v as Record<string, unknown>)['reason'];
  return typeof reason === 'string' && OUTCOME_SET.has(reason) ? reason as ApprovalOutcome : 'other';
}

export function approvalOutcome(entry: Pick<ApprovalEntry, 'status' | 'resultJson' | 'decidedReason'>): ApprovalOutcome | null {
  switch (entry.status) {
    case 'pending': case 'approved': case 'executing': return null;
    case 'done': return 'sent';
    case 'rejected': return DECIDED_OUTCOME.get(entry.decidedReason ?? '') ?? 'other';
    case 'failed': case 'unknown': case 'expired': return resultReason(entry.resultJson);
    default: return 'other';
  }
}

/** The addresses in a stored list or a comma-joined string, trimmed and lower-cased. */
const comparable = (a: string): string => a.trim().toLowerCase();

/**
 * Whether a reply goes to someone the original did not name: its To or Cc holds an address
 * that is not among the original's From, To, Cc and Reply-To (a reply goes to the Reply-To by
 * default). An entry filed before the Reply-To was stored is compared without it. Always false
 * for a new mail, which has no original.
 */
export function replyRecipientDiffers(entry: Pick<ApprovalEntry, 'filing'>): boolean {
  const f = entry.filing;
  if (f === null || f.kind !== 'mail_reply') return false;
  const o = f.payload.original;
  const known = new Set([...o.from.split(','), ...o.to, ...o.cc, ...(o.replyTo ?? [])].map(comparable).filter((a) => a !== ''));
  return [...f.payload.to, ...f.payload.cc].some((a) => !known.has(comparable(a.address)));
}

/**
 * The plain addresses in a stored sender line: each comma-separated part that holds an address,
 * taken from inside its angle brackets when a display name precedes it. A comma inside quotes
 * does not split. Parts without an `@` (a display name split at a bare comma) are dropped.
 */
export function plainAddresses(line: string): string[] {
  return line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((part) => {
      const bracketed = /<([^<>]*)>\s*$/.exec(part);
      return (bracketed !== null ? bracketed[1]! : part).trim();
    })
    .filter((a) => a.includes('@'));
}

/** The original's Reply-To addresses a reply goes to, when they are not its sender's. */
export interface ReplyToElsewhere {
  /** Each address in the reply's To or Cc that the original named as its Reply-To and not as its From. */
  replyTo: string[];
  /** The original's From addresses. */
  from: string[];
}

/**
 * Whether a reply goes to a Reply-To address of the original that is not the original's sender:
 * every address of the reply's To and Cc that is among the original's Reply-To and is not its
 * first From address, compared whole and case-insensitively (an address at the sender's
 * domain is still another address). Null for a new mail, for an original filed before its
 * Reply-To was stored, and when no such address is among the reply's recipients.
 */
export function replyToElsewhere(entry: Pick<ApprovalEntry, 'filing'>): ReplyToElsewhere | null {
  const f = entry.filing;
  if (f === null || f.kind !== 'mail_reply') return null;
  const o = f.payload.original;
  if (o.replyTo === undefined) return null;
  // The sender is the first From address, the same one a direct reply falls back to; a second
  // From address is not taken as the sender, so a Reply-To naming it still shows.
  const from = plainAddresses(o.from).slice(0, 1);
  const fromSet = new Set(from.map(comparable));
  const replyToSet = new Set(o.replyTo.flatMap(plainAddresses).map(comparable));
  const seen = new Set<string>();
  const hits: string[] = [];
  for (const a of [...f.payload.to, ...f.payload.cc]) {
    const key = comparable(a.address);
    if (seen.has(key) || !replyToSet.has(key) || fromSet.has(key)) continue;
    seen.add(key);
    hits.push(a.address.trim());
  }
  return hits.length === 0 ? null : { replyTo: hits, from };
}

/** A mandate's mark on the trigger or workflow an entry came from. */
export interface SetupMarks {
  /** The creating request's tag, and its grant id when that was a mandate. */
  createdBy: string | null;
  createdMandateId: string | null;
  /** The last mandate that changed it, and its grant id. */
  mandateEditor: string | null;
  mandateEditorId: string | null;
}

/**
 * A line on the card about who set the entry up. `set_up_by`: a mandate created the trigger or
 * the workflow; `last_changed_by`: a mandate changed it last; `test_run_by`: the entry was filed
 * for a mandate whose mark is on neither, so the run was its own try.
 */
export interface SetupLine {
  kind: 'set_up_by' | 'last_changed_by' | 'test_run_by';
  name: string;
}

interface Mark { kind: 'set_up_by' | 'last_changed_by'; tag: string; mandateId: string | null }

function marksOf(m: SetupMarks | undefined): Mark[] {
  if (m === undefined) return [];
  const out: Mark[] = [];
  if (isMandateTag(m.createdBy)) out.push({ kind: 'set_up_by', tag: m.createdBy!, mandateId: m.createdMandateId });
  if (isMandateTag(m.mandateEditor)) out.push({ kind: 'last_changed_by', tag: m.mandateEditor!, mandateId: m.mandateEditorId });
  return out;
}

/** How a mandate is named: by its grant id and its tag, which `nameOf` turns into a name. */
export type MandateNamer = (mandateId: string | null, tag: string | null) => string;

/**
 * Who set an entry up, from stored columns only. An entry filed for a mandate always names that
 * mandate: as the one who set it up or changed it last when its grant's mark is on the trigger
 * or the workflow, otherwise as the one whose test run it was. The marks of every other mandate
 * follow as lines of their own. The owner's own setup has no line.
 */
export function setupLines(
  entry: Pick<ApprovalEntry, 'mandateId' | 'createdBy'>,
  trigger: SetupMarks | undefined,
  workflow: SetupMarks | undefined,
  nameOf: MandateNamer,
): SetupLine[] {
  const marks = [...marksOf(trigger), ...marksOf(workflow)];
  const lines: SetupLine[] = [];
  const seen = new Set<string>();
  const add = (kind: SetupLine['kind'], mandateId: string | null, tag: string | null): void => {
    const key = `${kind}\u0000${mandateId ?? `tag:${tag ?? ''}`}`;
    if (seen.has(key)) return;
    seen.add(key);
    lines.push({ kind, name: nameOf(mandateId, tag) });
  };
  const forMandate = entry.mandateId !== null || isMandateTag(entry.createdBy);
  const own = (m: Mark): boolean => entry.mandateId !== null && m.mandateId === entry.mandateId;
  if (forMandate) {
    const matching = marks.filter(own);
    if (matching.length === 0) add('test_run_by', entry.mandateId, entry.createdBy);
    for (const m of matching) add(m.kind, entry.mandateId, entry.createdBy);
  }
  for (const m of marks) if (!own(m)) add(m.kind, m.mandateId, m.tag);
  return lines;
}

/** The address in a mandate tag, or null when the tag names no mandate. */
export function mandateAddressOf(tag: string | null): string | null {
  return isMandateTag(tag) ? tag!.slice(MANDATE_TAG_PREFIX.length) : null;
}

/** The name of a mandate that has neither a name it may be shown under nor an address. */
export const UNNAMED_MANDATE = 'unnamed mandate';

/** The name a grant was last shown under in the actor trail, or null when it has none. */
export type DisplayNameOf = (mandateId: string) => string | null;

/**
 * How a scope names a mandate: by the name its grant was shown under, else by the address in
 * its tag, else {@link UNNAMED_MANDATE}, never by the raw grant id. The owner sees every grant's
 * name. A mandate sees its own grant's name, and another grant only by its address: the name a
 * grant is shown under comes from the owner's trail and is not another mandate's to read.
 */
export function mandateNamer(scope: ApprovalScope, displayNameOf: DisplayNameOf): MandateNamer {
  return (mandateId, tag) => {
    const mayShow = mandateId !== null && (scope.viewer === 'owner' || mandateId === scope.mandateId);
    const display = mayShow ? displayNameOf(mandateId) : null;
    if (display !== null && display !== '') return display;
    return mandateAddressOf(tag) ?? UNNAMED_MANDATE;
  };
}

export interface ApprovalCardMail {
  accountId: string;
  from: string;
  persona?: string | undefined;
  to: StoredAddress[];
  cc: StoredAddress[];
  bcc: StoredAddress[];
  subject: string;
  bodyText: string;
  /** For a reply: the mail it answers. */
  original?: { from: string; subject: string; date: string } | undefined;
}

export interface ApprovalCard {
  id: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  executedAt: string | null;
  /** Milliseconds since filing, at the time of the read. */
  ageMs: number;
  /** What an approval presents. The owner's only: a mandate cannot decide. */
  checksum?: string | undefined;
  /** False for an entry this engine cannot send (unknown origin, unreadable payload, tombstone). */
  executable: boolean;
  /** The content was removed; the entry stays only to refuse the same mail again. */
  tombstoned: boolean;
  /** Why an approved entry waits: the send limit, or a retry after a failure that sent nothing. */
  held: 'send_limit' | 'retry' | null;
  /** Null when the payload is gone or does not read. */
  mail: ApprovalCardMail | null;
  massSend: boolean;
  recipientDiffers: boolean;
  /** For a reply that goes to the original's Reply-To where that is not its sender; else null. */
  replyToElsewhere: ReplyToElsewhere | null;
  afterUntrusted: boolean;
  origin: { source: ApprovalSource; triggerId: string; runId: string; threadId?: string | undefined; eventId?: string | undefined } | null;
  outcome: ApprovalOutcome | null;
  setup: SetupLine[];
}

export interface ApprovalCardSources {
  scope: ApprovalScope;
  /** The marks on the origin trigger and on the workflow it runs; undefined when there is none. */
  trigger?: SetupMarks | undefined;
  workflow?: SetupMarks | undefined;
  /** The trail's name for a grant; which grants the card may name by it is the scope's to say. */
  displayNameOf: DisplayNameOf;
  now: number;
}

const copyAddresses = (list: ReadonlyArray<StoredAddress>): StoredAddress[] =>
  list.map((a) => (a.name !== undefined ? { name: a.name, address: a.address } : { address: a.address }));

function cardMail(entry: ApprovalEntry): ApprovalCardMail | null {
  const f = entry.filing;
  if (f === null) return null;
  const p = f.payload;
  const common = {
    accountId: p.accountId, from: p.fromAddress, to: copyAddresses(p.to), cc: copyAddresses(p.cc),
    subject: p.subject, bodyText: p.bodyText,
  };
  if (f.kind === 'mail_reply') {
    const r = f.payload;
    return {
      ...common, bcc: [],
      ...(r.persona !== undefined ? { persona: r.persona } : {}),
      original: { from: r.original.from, subject: r.original.subject, date: r.original.date },
    };
  }
  return { ...common, bcc: copyAddresses(f.payload.bcc) };
}

/** The card for one entry, as the scope may see it. */
export function approvalCard(entry: ApprovalEntry, src: ApprovalCardSources): ApprovalCard {
  const mail = cardMail(entry);
  const o = entry.origin;
  const created = Date.parse(entry.createdAt);
  return {
    id: entry.id,
    kind: entry.kind,
    status: entry.status,
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
    decidedAt: entry.decidedAt,
    executedAt: entry.executedAt,
    ageMs: Number.isFinite(created) ? Math.max(0, src.now - created) : 0,
    ...(src.scope.viewer === 'owner' ? { checksum: entry.checksum } : {}),
    executable: entry.executable,
    tombstoned: entry.tombstonedAt !== null,
    held: entry.heldReason === 'send_limit' || entry.heldReason === 'retry' ? entry.heldReason : null,
    mail,
    massSend: mail !== null && recipientSpread([...mail.to, ...mail.cc, ...mail.bcc]).isMassSend,
    recipientDiffers: replyRecipientDiffers(entry),
    replyToElsewhere: replyToElsewhere(entry),
    afterUntrusted: o?.afterUntrusted === true,
    origin: o === null ? null : {
      source: o.source, triggerId: o.triggerId, runId: o.runId,
      ...(o.threadId !== undefined ? { threadId: o.threadId } : {}),
      ...(o.eventId !== undefined ? { eventId: o.eventId } : {}),
    },
    outcome: approvalOutcome(entry),
    setup: setupLines(entry, src.trigger, src.workflow, mandateNamer(src.scope, src.displayNameOf)),
  };
}
