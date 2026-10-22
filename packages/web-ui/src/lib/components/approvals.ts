// Shapes and pure helpers for the approval queue (ApprovalsView, ApprovalCard). The shapes mirror
// what core's `GET /api/approvals` answers with; only the fields the page reads. The translator
// comes in as an argument: i18n is a Svelte module, and these stay testable without it.

export interface ApprovalAddress {
	name?: string | undefined;
	address: string;
}

export interface ApprovalMail {
	accountId: string;
	from: string;
	persona?: string | undefined;
	to: ApprovalAddress[];
	cc: ApprovalAddress[];
	bcc: ApprovalAddress[];
	subject: string;
	bodyText: string;
	original?: { from: string; subject: string; date: string } | undefined;
}

export type ApprovalStatus = 'pending' | 'approved' | 'executing' | 'done' | 'rejected' | 'failed' | 'unknown' | 'expired';

export interface ApprovalSetupLine {
	kind: 'set_up_by' | 'last_changed_by' | 'test_run_by';
	name: string;
}

export interface ApprovalCardData {
	id: string;
	kind: 'mail_send' | 'mail_reply';
	status: ApprovalStatus;
	createdAt: string;
	expiresAt: string;
	decidedAt: string | null;
	executedAt: string | null;
	ageMs: number;
	/** Sent to the owner only: a mandate's session reads the list but cannot decide. */
	checksum?: string | undefined;
	executable: boolean;
	tombstoned: boolean;
	held: 'send_limit' | 'retry' | null;
	mail: ApprovalMail | null;
	massSend: boolean;
	recipientDiffers: boolean;
	/** Absent from an engine that predates the field. */
	replyToElsewhere?: { replyTo: string[]; from: string[] } | null | undefined;
	afterUntrusted: boolean;
	origin: { source: 'workflow' | 'task'; triggerId: string; runId: string; threadId?: string | undefined; eventId?: string | undefined } | null;
	outcome: string | null;
	setup: ApprovalSetupLine[];
}

export interface ApprovalList {
	entries: ApprovalCardData[];
	pending: number;
}

/** The most entries one list answer carries (the engine's cap). */
export const APPROVAL_LIST_LIMIT = 200;

/** The engine's neutral name for a mandate it has neither a name nor an address for. */
export const UNNAMED_MANDATE = 'unnamed mandate';

/** The two i18n lookups the helpers need, `t` and `tf` from `i18n.svelte.ts`. */
export interface ApprovalsI18n {
	t: (key: string) => string;
	tf: (key: string, vars: Record<string, string>) => string;
}

/** Whether the card offers its actions: only a waiting entry, and only to a session the engine
 *  handed the checksum to (the owner's; a mandate's card has none and is read-only). */
export function approvalActionable(card: ApprovalCardData): boolean {
	return card.status === 'pending' && typeof card.checksum === 'string' && card.checksum !== '';
}

/** Whether the card offers to send: an entry the owner may decide on that the engine can also
 *  send. A waiting entry it cannot send (its content is gone, or this version cannot send it)
 *  offers only to discard it. */
export function approvalSendable(card: ApprovalCardData): boolean {
	return approvalActionable(card) && card.executable === true;
}

/** Whether sending takes a second click: a mass send, or a reply to someone the original did
 *  not name. Every other mail goes with one. */
export function approvalNeedsSecondClick(card: Pick<ApprovalCardData, 'massSend' | 'recipientDiffers'>): boolean {
	return card.massSend || card.recipientDiffers;
}

/** The decide refusals the page has a sentence for; anything else reads as the general one. */
export const APPROVAL_DECIDE_REFUSALS: readonly string[] = ['not_found', 'not_pending', 'expired', 'checksum', 'not_executable', 'mandate_ended'];
const DECIDE_REFUSALS: ReadonlySet<string> = new Set(APPROVAL_DECIDE_REFUSALS);

/** The i18n key for a decide refusal's code. The server's sentence is never shown. */
export function approvalDecideErrorKey(code: unknown): string {
	return typeof code === 'string' && DECIDE_REFUSALS.has(code) ? `approvals.error.${code}` : 'approvals.error.other';
}

/** Whether a refusal means the list the owner decided from is stale and is read again. */
export function approvalRefusalReloads(code: unknown): boolean {
	return code === 'checksum' || code === 'not_pending' || code === 'expired' || code === 'mandate_ended' || code === 'not_found';
}

/** A setup line's name, with the engine's neutral label translated. */
export function approvalSetupName(name: string, i18n: Pick<ApprovalsI18n, 't'>): string {
	return name === UNNAMED_MANDATE ? i18n.t('approvals.unnamed_mandate') : name;
}

/** The line under a list the engine cut at its cap, or null when it is whole. The open tab says
 *  how many of the waiting mails it shows; the other only that it is cut. */
export function approvalCutNotice(view: 'open' | 'all', list: ApprovalList, i18n: ApprovalsI18n): string | null {
	const shown = list.entries.length;
	if (shown < APPROVAL_LIST_LIMIT) return null;
	if (view === 'open' && list.pending > shown) return i18n.tf('approvals.cut_of', { shown: String(shown), total: String(list.pending) });
	return i18n.tf('approvals.cut', { shown: String(shown) });
}
