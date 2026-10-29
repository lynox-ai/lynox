// The owner's stamp of a schedule, as the view asks for it (641 4b (ii-a), ii-c-min).
//
// `GET /api/tasks/:id/stamp-preview` answers with the schedule the stamp would be held to
// (`subject`, field for field what its `expect` digests), whom the plan acts for, the workflow it
// runs and whether that is confirmed, and the connections the mandate made with its own login.
// The view shows the schedule from the preview, never from the list it polls, and confirms with the
// preview's `expect`: what the owner reads is what is stamped, or the engine answers 409 `changed`.

import { t, tf } from '../i18n.svelte.js';
import { markHidden, watchOf } from './trigger-consent.js';

/** `GET /api/tasks/:id/stamp-preview` (owner only). */
export interface StampPreview {
	expect: string;
	subject: {
		id: string;
		effect: string | null;
		/** `watch`: the run fetches a page and never receives the text. */
		source: string | null;
		title: string;
		description: string | null;
		schedule_cron: string | null;
		/** The watch's config without its baseline, as a JSON string. */
		watch: string | null;
		pipeline_id: string | null;
		pipeline_params: string | null;
		model_tier: string | null;
		wf: string | null;
	};
	/** The address of the mandate the plan acts for; null when it acts for none. */
	by: string | null;
	/** For a workflow schedule: its name, and whether it is confirmed. Null for any other. */
	workflow: { name: string | null; confirmed: boolean } | null;
	connections: { id: string; profile: string; provider: string; account: string | null }[];
}

const MANDATE_TAG = 'mandate:';

/** The fields of a trigger row the stamp predicates read (`GET /api/triggers`). */
export interface StampRow {
	effect?: string | undefined;
	confirmed_at?: string | null | undefined;
	created_by?: string | undefined;
	edited_by?: string | undefined;
	paused?: boolean | undefined;
}

/**
 * Whether the engine holds this schedule until the owner stamps it because a mandate set it up or
 * last changed it: `mandateNeedsOwnerStamp` (engine `request-principal.ts`), the same three
 * fields. An unconfirmed agent run waits too, for its own reason (`awaitsConfirmation`).
 */
export function awaitsOwnerStamp(row: StampRow): boolean {
	return !row.confirmed_at && (row.edited_by ?? row.created_by ?? '').startsWith(MANDATE_TAG);
}

/**
 * Whether the view offers the owner a stamp of this row at all. Not at a paused plan (the confirm
 * route refuses it as paused; the takeover is its way), and not at a bulk effect (it locks its
 * confirmation).
 */
export function stampable(row: StampRow): boolean {
	return row.paused !== true && !(row.effect ?? '').startsWith('bulk_');
}

/**
 * Effects whose run can use a connection: the ones "Check connections" is offered at, once a
 * schedule is confirmed. A run of any other effect never reads one, so a list would mean nothing.
 */
export function usesConnections(row: StampRow): boolean {
	return row.effect === 'run_agent' || row.effect === 'run_workflow';
}

/** A provider with the account, or "account unknown" (legal POS-069: the line never stays empty). */
function connectionText(c: StampPreview['connections'][number]): string {
	return `${markHidden(c.provider)} (${c.account !== null && c.account !== '' ? markHidden(c.account) : t('stamp.account_unknown')})`;
}

/**
 * The sentence the owner confirms beside (legal POS-069, a binding text): whose own logins the plan
 * would use, and which. Null when the list is empty.
 */
export function connectionsSentence(p: StampPreview): string | null {
	if (p.connections.length === 0) return null;
	return tf('stamp.connections', {
		person: markHidden(p.by ?? t('takeover.connection_someone')),
		connections: p.connections.map(connectionText).join(', '),
	});
}

/** What the preview's workflow parameters say, one `name: value` per entry; none when unreadable. */
export function paramsOf(raw: string | null): string[] {
	if (raw === null || raw === '') return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [markHidden(raw)];
		return Object.entries(parsed as Record<string, unknown>).map(([k, v]) => `${markHidden(k)}: ${markHidden(typeof v === 'string' ? v : JSON.stringify(v) ?? '')}`);
	} catch {
		return [markHidden(raw)];
	}
}

/**
 * What the stamp holds, as the view shows it, decided the way the run decides it: a workflow by its
 * workflow, a watch (`source`) by the page it fetches, anything else by its text. A watch whose page
 * cannot be read shows nothing, and is offered no confirm (`offersConfirmation`'s rule): there
 * would be nothing to agree to.
 */
export function shownAs(p: StampPreview): 'workflow' | 'watch' | 'unreadable_watch' | 'instruction' {
	if (p.subject.effect === 'run_workflow') return 'workflow';
	if (p.subject.source === 'watch') return watchOf({ watch_config: p.subject.watch ?? undefined }) ? 'watch' : 'unreadable_watch';
	return 'instruction';
}

/** B3: what the owner's stamp of a confirmed plan lists (`GET /api/triggers`, owner only). */
export interface StampListed {
	lapsed: boolean;
	ended: boolean;
	/** Where the member whose access ended sits: its workflow side needs a copy of the workflow too. */
	ended_on?: 'plan' | 'workflow' | null;
	entries: { provider: string | null; account: string | null; state: 'listed' | 'changed' | 'waits' | 'new' }[];
}

/** One entry of {@link StampListed} as the row says it: provider, account, and how it stands. */
export function listedLine(e: StampListed['entries'][number]): string {
	const provider = e.provider !== null ? markHidden(e.provider) : t('stamp.state_removed');
	const account = e.account !== null && e.account !== '' ? markHidden(e.account) : t('stamp.account_unknown');
	return `${provider} (${account}): ${t(`stamp.state_${e.state}`)}`;
}

/**
 * The note below the list, or none: an ended access first (nothing runs, and a new stamp would not
 * change that), then a list that no longer holds, then an entry the plan may not use. The ended
 * note names "Take over" only at a paused plan: an end the engine cannot prove does not pause it,
 * and then there is no such button (`plan-pause.ts`).
 */
export function listedNote(l: StampListed, paused: boolean): string | null {
	if (l.ended) return t(paused ? 'stamp.ended' : l.ended_on === 'workflow' ? 'stamp.ended_unpaused_workflow' : 'stamp.ended_unpaused');
	if (l.lapsed) return t('stamp.lapsed');
	if (l.entries.some((e) => e.state === 'changed' || e.state === 'new')) return t('stamp.not_listed');
	return null;
}

const hides = (x: string | null | undefined): boolean => typeof x === 'string' && markHidden(x) !== x.replace(/\u00AD/gu, '');

/**
 * Where text the block shows hid characters (`markHidden` marks them), or null. The run hands the
 * title and description to the model as they are stored, so a clause hidden in invisible
 * characters would run although the owner never read it: such a plan is not offered a confirm.
 * `workflow` when the workflow's name hides them: the model reads a workflow raw, so a new plan
 * needs the workflow gone too, not just the plan.
 */
export function hiddenIn(p: StampPreview): 'plan' | 'workflow' | null {
	if (hides(p.workflow?.name)) return 'workflow';
	const s = p.subject;
	const shown = [s.title, s.description, s.schedule_cron, s.watch, s.pipeline_id, s.pipeline_params, s.model_tier, p.by,
		...p.connections.flatMap((c) => [c.provider, c.account])];
	return shown.some(hides) ? 'plan' : null;
}

export function hidesText(p: StampPreview): boolean {
	return hiddenIn(p) !== null;
}

/**
 * Whether a confirm may be offered on this preview: not on a watch whose page cannot be shown, not
 * when shown text had invisible characters (`hidesText`), and a workflow schedule only on a
 * confirmed workflow (an unconfirmed one switches it off at its run).
 */
export function confirmable(p: StampPreview): boolean {
	if (shownAs(p) === 'unreadable_watch' || hidesText(p)) return false;
	return p.workflow === null || p.workflow.confirmed;
}
