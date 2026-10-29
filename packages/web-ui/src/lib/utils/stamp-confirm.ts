// The owner's stamp of a schedule, as the view asks for it (641 4b (ii-a), ii-c-min).
//
// `GET /api/tasks/:id/stamp-preview` answers with the schedule the stamp would be held to
// (`subject`, field for field what its `expect` digests), whom the plan acts for, the workflow it
// runs and whether that is confirmed, and the connections the mandate made with its own login.
// The view shows the schedule from the preview, never from the list it polls, and confirms with the
// preview's `expect`: what the owner reads is what is stamped, or the engine answers 409 `changed`.

import { t, tf } from '../i18n.svelte.js';
import { displaySafe, watchOf } from './trigger-consent.js';

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
	return `${displaySafe(c.provider)} (${c.account !== null && c.account !== '' ? displaySafe(c.account) : t('stamp.account_unknown')})`;
}

/**
 * The sentence the owner confirms beside (legal POS-069, a binding text): whose own logins the plan
 * would use, and which. Null when the list is empty.
 */
export function connectionsSentence(p: StampPreview): string | null {
	if (p.connections.length === 0) return null;
	return tf('stamp.connections', {
		person: displaySafe(p.by ?? t('takeover.connection_someone')),
		connections: p.connections.map(connectionText).join(', '),
	});
}

/** What the preview's workflow parameters say, one `name: value` per entry; none when unreadable. */
export function paramsOf(raw: string | null): string[] {
	if (raw === null || raw === '') return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [displaySafe(raw)];
		return Object.entries(parsed as Record<string, unknown>).map(([k, v]) => `${displaySafe(k)}: ${displaySafe(typeof v === 'string' ? v : JSON.stringify(v) ?? '')}`);
	} catch {
		return [displaySafe(raw)];
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

/**
 * Whether a confirm may be offered on this preview: not on a watch whose page cannot be shown, and
 * a workflow schedule only on a confirmed workflow (an unconfirmed one switches it off at its run).
 */
export function confirmable(p: StampPreview): boolean {
	if (shownAs(p) === 'unreadable_watch') return false;
	return p.workflow === null || p.workflow.confirmed;
}
