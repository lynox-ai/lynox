/**
 * Who sent a request — the principal an HTTP request acts as.
 *
 * The owner of the instance, or a person the owner let in for a bounded time (a
 * mandate). Until the recipient's login puts a principal into the session, every
 * authenticated request is the owner, so everything that reads this behaves as it
 * did before. The rules that read it are the ones that must hold the moment a
 * second kind of principal exists: only the owner stamps a schedule or approves a
 * run, and a schedule a mandate created or changed runs only after the owner
 * stamped it.
 *
 * A principal is stored on rows as a TAG: `owner`, or `mandate:<address>`. The
 * address is the mandate's identity across its renewals — not its id — so a person
 * who sets up and later accompanies the same account stays the same author.
 */
export type RequestPrincipal =
  | { readonly kind: 'owner' }
  | {
      readonly kind: 'mandate';
      readonly email: string;
      /** How the mandate is shown (one line, as the control plane folded it). For the actor
       *  trail only; identity, tags and comparisons stay on `email`. */
      readonly display?: string | undefined;
      /** Which grant this login came from. For the actor trail, and the key the engine
       *  records the mandate's end under (`mandate-ends.ts`). */
      readonly mandateId?: string | undefined;
      /** When the mandate itself ends, unix seconds, as the web UI signed it into the session
       *  (not the session's own end, which comes much sooner). Absent in a cookie minted
       *  before the web UI signed it. */
      readonly mandateExp?: number | undefined;
    };

/** The prefix every mandate tag carries; the due query matches on it in SQL. */
export const MANDATE_TAG_PREFIX = 'mandate:';

export const OWNER_PRINCIPAL: RequestPrincipal = Object.freeze({ kind: 'owner' as const });

export function isOwnerPrincipal(p: RequestPrincipal): boolean {
  return p.kind === 'owner';
}

/** The tag a row records for who created, changed or stamped it. */
export function principalTag(p: RequestPrincipal): string {
  return p.kind === 'owner' ? 'owner' : `${MANDATE_TAG_PREFIX}${p.email}`;
}

/**
 * Whether a trigger waits for the owner's stamp because a mandate created or last changed
 * it (PRD customer-granted-operator-access §3.12, §3.13). Pure and exported so the rule is
 * asserted directly; the due query, the dispatch backstops and the task manager's schedule
 * writes all apply it. The last party decides — `edited_by` when set, the creator
 * otherwise — and an owner's stamp makes the owner that party (TriggerStore.setConfirmedAt).
 */
export function mandateNeedsOwnerStamp(t: { confirmed_at?: string | undefined; created_by?: string | undefined; edited_by?: string | undefined }): boolean {
  return !t.confirmed_at && isMandateTag(t.edited_by ?? t.created_by);
}

/** Whether a recorded tag names a mandate. A missing tag (a row from before tags, or one
 *  the engine itself wrote) is not a mandate. */
export function isMandateTag(tag: string | null | undefined): boolean {
  return typeof tag === 'string' && tag.startsWith(MANDATE_TAG_PREFIX);
}

/**
 * Whether a request's principal may act on a row by who created it (PRD
 * customer-granted-operator-access §3.13 E1, E2, E7, E9, B6: a mandate reaches only what it set
 * up). The owner reaches every row. A mandate reaches a row only when the row records that very
 * mandate; a row with no tag, or the tag `owner`, is the owner's, since everything written before
 * tags existed was. A row that does not exist (`undefined`) belongs to no mandate: a mandate is
 * refused, so asking about something missing never reads as "its own".
 */
export function ownedBy(row: { readonly created_by?: string | null | undefined } | undefined, p: RequestPrincipal): boolean {
  if (isOwnerPrincipal(p)) return true;
  return row !== undefined && row.created_by === principalTag(p);
}

/**
 * The principal a recorded tag names, for a run that resumes after its request is gone. Only
 * ever narrows: a mandate tag gives the mandate (whose runs carry the tool lock), anything else
 * the owner. Never a proof of a hand: nothing that grants a hand run may read it.
 */
export function principalFromTag(tag: string | null | undefined): RequestPrincipal {
  return isMandateTag(tag) ? { kind: 'mandate', email: tag!.slice(MANDATE_TAG_PREFIX.length) } : OWNER_PRINCIPAL;
}
