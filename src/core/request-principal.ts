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
  | { readonly kind: 'mandate'; readonly email: string };

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
