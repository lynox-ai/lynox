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
	/** The thread a change in chat continues; null (or absent, from an older engine) opens a new chat. */
	chatThreadId?: string | null | undefined;
}

/** Whose session reads the list: the owner decides; a mandate, or a session the engine names no
 *  grant for, only reads. */
export type ApprovalViewer = 'owner' | 'mandate' | 'none';

export interface ApprovalList {
	entries: ApprovalCardData[];
	pending: number;
	/** Absent from an engine that predates the field: read as not the owner. */
	viewer?: ApprovalViewer | undefined;
	/** How many days a completed entry stays listed (the engine's own limit). Absent from an
	 *  engine that predates the field: the page then names no limit. */
	retentionDays?: number | undefined;
	/** Whether a mail with an unclear outcome stays until it is closed (the engine has a vault
	 *  key). Absent from an engine that predates the field: the page then says nothing of them. */
	unclearStays?: boolean | undefined;
}

/** The i18n key for the retention line under the all tab. Only the owner reads about mails with
 *  an unclear outcome, worded by whether they stay until closed; everyone else, and an engine
 *  that does not say, gets the completed mails' line alone. */
export function approvalRetentionKey(viewer: ApprovalViewer, unclearStays: boolean | undefined): string {
	if (viewer !== 'owner' || unclearStays === undefined) return 'approvals.retention';
	return unclearStays ? 'approvals.retention_owner_kept' : 'approvals.retention_owner_deleted';
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

/** What moving an entry to chat needs from the page: the decision and the chat store. */
export interface ApprovalChatSteps {
	/** Posts `move_to_chat`; a refusal carries the server's code. */
	decide: (id: string) => Promise<{ ok: true } | { ok: false; code: unknown }>;
	newChat: () => void;
	resumeThread: (threadId: string) => Promise<void>;
	send: (framing: string, context: { kind: 'approval'; id: string }) => void;
	goto: (path: string) => Promise<void>;
}

/**
 * Opens the chat on an entry's draft: the run's thread only where the engine names it
 * (`chatThreadId`: a task the owner filed in a thread the owner opened, not contained), else a new
 * chat — a workflow run has no thread, and a mandate's thread is the mandate's conversation, not
 * the owner's. The engine loads the draft only once the entry was moved to chat.
 */
export async function openApprovalChat(
	card: Pick<ApprovalCardData, 'id' | 'chatThreadId'>,
	framing: string,
	steps: Omit<ApprovalChatSteps, 'decide'>,
): Promise<void> {
	const context = { kind: 'approval' as const, id: card.id };
	const thread = typeof card.chatThreadId === 'string' && card.chatThreadId !== '' ? card.chatThreadId : null;
	if (thread !== null) {
		await steps.goto('/app');
		await steps.resumeThread(thread);
		steps.send(framing, context);
	} else {
		steps.newChat();
		steps.send(framing, context);
		await steps.goto('/app');
	}
}

/**
 * Moves an entry to chat. The decision comes first: once it is `moved_to_chat` the card can no
 * longer send it, and only then does the chat load it — the engine loads no draft that still
 * waits, so the chat and the card never both send. A refused decision opens no chat.
 */
export async function moveApprovalToChat(
	card: Pick<ApprovalCardData, 'id' | 'chatThreadId'>,
	framing: string,
	steps: ApprovalChatSteps,
): Promise<{ ok: true } | { ok: false; code: unknown }> {
	const decided = await steps.decide(card.id);
	if (!decided.ok) return decided;
	await openApprovalChat(card, framing, steps);
	return { ok: true };
}

/** Whether the card offers to open its draft in chat again: an entry the owner moved there, on
 *  the owner's card (the one the engine hands the checksum to), with a draft to load. It decides
 *  nothing; it is the way back when the first chat turn did not go through. */
export function approvalReopensInChat(card: ApprovalCardData): boolean {
	return card.status === 'rejected' && card.outcome === 'moved_to_chat'
		&& typeof card.checksum === 'string' && card.checksum !== '' && card.mail !== null;
}

/** Whether sending takes a second click: a mass send, or a reply to someone the original did
 *  not name. Every other mail goes with one. */
export function approvalNeedsSecondClick(card: Pick<ApprovalCardData, 'massSend' | 'recipientDiffers'>): boolean {
	return card.massSend || card.recipientDiffers;
}

/** Whether the card offers to close an entry whose outcome is unclear: only to the owner, the
 *  one session the engine lets decide. */
export function approvalClosable(card: Pick<ApprovalCardData, 'status'>, viewer: ApprovalViewer): boolean {
	return card.status === 'unknown' && viewer === 'owner';
}

/** The outcome codes that name who decided: the owner reads "you", every other session "the owner". */
const DECIDED_BY_OWNER: ReadonlySet<string> = new Set(['discarded', 'moved_to_chat', 'cleared_unknown']);

/** The codes an entry whose outcome is unclear carries. Under that status, any other code reads
 *  as the bare "unclear": every other code's sentence says the mail was not sent. */
const UNCLEAR: ReadonlySet<string> = new Set(['send_timeout', 'send_threw', 'provider_error', 'stale_claim']);

/** Every code the page has a sentence for. A code a newer engine adds reads as `other`. */
export const APPROVAL_OUTCOME_SENTENCES: readonly string[] = [
	'discarded', 'moved_to_chat', 'mandate_ended', 'cleared_unknown',
	'not_executable', 'checksum', 'mail_unavailable', 'account_not_configured', 'receive_only', 'account_changed',
	'sending_address_unavailable', 'dedup_window', 'deadline_before_send', 'trail_unavailable', 'send_timeout',
	'send_threw', 'executor_error', 'invalid_recipients', 'secret_in_body', 'cancelled', 'queued', 'rate_limit',
	'provider_error', 'stale_claim', 'ttl', 'claim_window', 'flag_off', 'send_limit', 'retry', 'other',
];
const SENTENCES: ReadonlySet<string> = new Set(APPROVAL_OUTCOME_SENTENCES);

/** The i18n key for the sentence under a closed entry's status, or null: an open entry has no
 *  outcome yet, and a sent one needs none beyond its status. */
export function approvalOutcomeKey(card: Pick<ApprovalCardData, 'status' | 'outcome'>, viewer: ApprovalViewer): string | null {
	const code = card.outcome;
	// The status decides first: an unclear outcome never reads as anything else.
	if (card.status === 'unknown') return code !== null && UNCLEAR.has(code) ? `approvals.outcome.${code}` : 'approvals.outcome.unclear';
	if (code === null || card.status === 'done' || code === 'sent') return null;
	const known = SENTENCES.has(code) && !UNCLEAR.has(code) ? code : 'other';
	if (DECIDED_BY_OWNER.has(known)) return `approvals.outcome.${known}.${viewer === 'owner' ? 'owner' : 'other'}`;
	return `approvals.outcome.${known}`;
}

/** The codes whose next step is a sentence of their own; every other mail that failed or expired
 *  gets the general one, to write it again in a chat. */
const NEXT_STEP: ReadonlySet<string> = new Set(['account_not_configured', 'receive_only', 'invalid_recipients', 'secret_in_body', 'rate_limit', 'checksum', 'account_changed']);

/** The i18n key for what can be done next, or null. Every step is the owner's: a mandate's session
 *  can neither close an entry nor write the owner's mail again, so where the owner has a step,
 *  every other session is told to ask the owner instead of being left without one. Every status
 *  that has a step also has an outcome sentence, which the step follows. */
export function approvalNextStepKey(card: Pick<ApprovalCardData, 'status' | 'outcome'>, viewer: ApprovalViewer): string | null {
	let step: string;
	if (card.status === 'unknown') step = 'approvals.next.unknown';
	else if (card.status !== 'failed' && card.status !== 'expired') return null;
	else step = card.outcome !== null && NEXT_STEP.has(card.outcome) ? `approvals.next.${card.outcome}` : 'approvals.next.recreate';
	return viewer === 'owner' ? step : 'approvals.next.ask_owner';
}

/** The entry and outcome a chat note about an approved mail carries (core `render-projection.ts`). */
export interface ApprovalNoteRef {
	id: string;
	outcome: string;
}

/** What a chat note about an approved mail shows: its sentence, the next step, and where its entry is. */
export interface ApprovalNoteLines {
	bodyKey: string;
	nextKey: string | null;
	href: string | null;
}

/** The page's path with one entry picked out: the "all" tab, that card marked. */
export function approvalEntryHref(id: string): string {
	return `/app/approvals?entry=${encodeURIComponent(id)}`;
}

/**
 * Whether an outcome code reads right under the note's title: one the page has a sentence for,
 * not the unrecorded `other`, not a decision (an entry the owner closed after it ended unclear is no
 * longer "not sent"), and on a "not sent" note none of the codes that say the outcome is unclear.
 */
function noteOutcomeFits(status: 'failed' | 'unknown', outcome: string): boolean {
	if (!SENTENCES.has(outcome) || outcome === 'other' || DECIDED_BY_OWNER.has(outcome)) return false;
	return status === 'unknown' || !UNCLEAR.has(outcome);
}

/**
 * The lines of a chat note about an approved mail that did not go out (`approval_failed`) or may
 * have (`approval_unknown`), or null for any other note. The reason is the sentence the page shows
 * for the same entry when the note was written, and the next step the page's, for the same viewer.
 * A note whose reason does not fit its title (`noteOutcomeFits`) keeps its own sentence, which already
 * says what to do. Without a viewer, no next step: whether it is the owner's or "ask the owner"
 * depends on it. The note is written once; the entry may be closed or purged since, and the link
 * then opens the page without a marked card.
 */
export function approvalNoteLines(code: string, ref: ApprovalNoteRef | undefined, viewer: ApprovalViewer | null): ApprovalNoteLines | null {
	let status: 'failed' | 'unknown';
	if (code === 'approval_failed') status = 'failed';
	else if (code === 'approval_unknown') status = 'unknown';
	else return null;
	const own = `chat.note.${code}`;
	if (ref === undefined) return { bodyKey: own, nextKey: null, href: null };
	const href = approvalEntryHref(ref.id);
	if (!noteOutcomeFits(status, ref.outcome)) return { bodyKey: own, nextKey: null, href };
	const card = { status, outcome: ref.outcome };
	return {
		// The sentences of the codes that fit read the same for every viewer.
		bodyKey: approvalOutcomeKey(card, 'none') ?? own,
		nextKey: viewer === null ? null : approvalNextStepKey(card, viewer),
		href,
	};
}

/** The decide refusals the page has a sentence for; anything else reads as the general one. */
export const APPROVAL_DECIDE_REFUSALS: readonly string[] = ['not_found', 'not_pending', 'not_unknown', 'expired', 'checksum', 'not_executable', 'mandate_ended'];
const DECIDE_REFUSALS: ReadonlySet<string> = new Set(APPROVAL_DECIDE_REFUSALS);

/** The i18n key for a decide refusal's code. The server's sentence is never shown. */
export function approvalDecideErrorKey(code: unknown): string {
	return typeof code === 'string' && DECIDE_REFUSALS.has(code) ? `approvals.error.${code}` : 'approvals.error.other';
}

/** Whether a refusal means the list the owner decided from is stale and is read again. */
export function approvalRefusalReloads(code: unknown): boolean {
	return code === 'checksum' || code === 'not_pending' || code === 'not_unknown' || code === 'expired' || code === 'mandate_ended' || code === 'not_found';
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
