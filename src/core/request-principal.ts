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
 * A principal is stored on rows as a TAG: `owner`, `cp-admin`, or `mandate:<address>`. The
 * address is the mandate's identity across its renewals — not its id — so a person
 * who sets up and later accompanies the same account stays the same author.
 *
 * `cp-admin` is the control plane's admin bearer on an instance it provisioned (PRD
 * cp-admin-line §3.1). It is neither the owner nor a mandate: it reaches only the routes
 * registered for it, and every rule below names what it gets. A rule that asks "is this the
 * owner?" refuses it; a rule that reads a mandate's fields must not see it. The rules in this file
 * that tell the kinds apart switch on `kind` with a `never` check, so a new kind does not compile
 * until each of them is decided.
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
    }
  | { readonly kind: 'cp-admin' };

/** The prefix every mandate tag carries; the due query matches on it in SQL. */
export const MANDATE_TAG_PREFIX = 'mandate:';

/** The tag of the control plane's admin bearer. Never a mandate tag, never the owner's. */
export const CP_ADMIN_TAG = 'cp-admin';

export const OWNER_PRINCIPAL: RequestPrincipal = Object.freeze({ kind: 'owner' as const });

export const CP_ADMIN_PRINCIPAL: RequestPrincipal = Object.freeze({ kind: 'cp-admin' as const });

/** Fails the compile where a switch over `RequestPrincipal['kind']` leaves a kind out. */
export function unhandledPrincipal(p: never): never {
  throw new Error(`Unhandled principal kind: ${String((p as { kind?: unknown }).kind)}`);
}

export function isOwnerPrincipal(p: RequestPrincipal): boolean {
  return p.kind === 'owner';
}

/** The tag a row records for who created, changed or stamped it. */
export function principalTag(p: RequestPrincipal): string {
  switch (p.kind) {
    case 'owner': return 'owner';
    case 'mandate': return `${MANDATE_TAG_PREFIX}${p.email}`;
    case 'cp-admin': return CP_ADMIN_TAG;
    default: return unhandledPrincipal(p);
  }
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
  switch (p.kind) {
    case 'owner': return true;
    case 'mandate': return row !== undefined && row.created_by === principalTag(p);
    // The control plane owns no row: it creates none on the routes it reaches.
    case 'cp-admin': return false;
    default: return unhandledPrincipal(p);
  }
}

/**
 * Whether the grant a principal acts under has ended (PRD customer-granted-operator-access
 * §3.13 B8): never for the owner; for a mandate, when it names no grant or its grant is not
 * live. A mandate without a grant cannot be told apart from an ended one, so it counts as
 * ended, and so does the control plane's admin bearer, which acts under no grant. `isLive` is
 * `MandateEnds.isLive`.
 */
export function principalHasEnded(p: RequestPrincipal, isLive: (mandateId: string) => boolean): boolean {
  switch (p.kind) {
    case 'owner': return false;
    case 'mandate': return p.mandateId === undefined || !isLive(p.mandateId);
    // It acts under no grant, so it counts as ended, like a mandate that names none: nothing that
    // asks for a live grant passes for it.
    case 'cp-admin': return true;
    default: return unhandledPrincipal(p);
  }
}

/**
 * The principal a recorded tag names, for a run that resumes after its request is gone. Only
 * ever narrows: a mandate tag gives the mandate (whose runs carry the tool lock), the control
 * plane's tag the control plane, anything else the owner. Never a proof of a hand: nothing that
 * grants a hand run may read it.
 */
export function principalFromTag(tag: string | null | undefined): RequestPrincipal {
  if (tag === CP_ADMIN_TAG) return CP_ADMIN_PRINCIPAL;
  return isMandateTag(tag) ? { kind: 'mandate', email: tag!.slice(MANDATE_TAG_PREFIX.length) } : OWNER_PRINCIPAL;
}
