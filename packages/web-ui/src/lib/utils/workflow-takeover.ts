import { t, tf } from '../i18n.svelte.js';
import { memberChangeLines, planList, type TakeoverMemberChange } from './plan-takeover.js';
import { parseStampPreview, type StampPreview, type StampStep } from './workflow-stamp.js';

/**
 * The owner's takeover of a workflow from the library, as the view shows it: the preview of
 * `GET /api/workflows/:id/takeover-preview` read whole, the lines of the dialog in their order, and
 * what each refusal of `POST …/takeover` says. Pure, so every form of a sentence has its test (a
 * Svelte component cannot be imported in every test here, `run-notice.ts`).
 */

export interface WorkflowTakeoverMark {
	name: string;
	role: 'workflow-created' | 'workflow-edited';
	ended: boolean;
	/** A mark without a grant id: whose access it was cannot be told. */
	undetermined: boolean;
}

export interface WorkflowTakeoverConnection {
	profileId: string;
	provider: string;
	account: string | null;
	/** The address of the person who connected it. */
	by: string;
}

export interface WorkflowTakeoverStep extends StampStep {
	/** The step's call goes to a profile someone with access connected. */
	foreignConnection: boolean;
	/** That profile's id, when the engine could read it off the call. */
	connectionProfile: string | null;
}

export interface WorkflowTakeoverPreview extends Omit<StampPreview, 'steps'> {
	steps: WorkflowTakeoverStep[];
	marks: WorkflowTakeoverMark[];
	memberChanges: TakeoverMemberChange[];
	alsoReleased: Array<{ id: string; title: string }>;
	stillPaused: Array<{ id: string; title: string }>;
	lapsing: Array<{ id: string; title: string }>;
	connections: WorkflowTakeoverConnection[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function plans(v: unknown): Array<{ id: string; title: string }> | null {
	if (!Array.isArray(v)) return null;
	const out: Array<{ id: string; title: string }> = [];
	for (const p of v) {
		if (!isRecord(p) || typeof p['id'] !== 'string' || typeof p['title'] !== 'string') return null;
		out.push({ id: p['id'], title: p['title'] });
	}
	return out;
}

/**
 * The preview as the view may show it, or null for an answer that is not one. As with the stamp
 * (`parseStampPreview`), anything it cannot read whole makes the whole preview unreadable: the
 * takeover is sent with a digest over everything shown, so nothing may be dropped silently.
 */
export function parseWorkflowTakeoverPreview(body: unknown): WorkflowTakeoverPreview | null {
	const stamp = parseStampPreview(body);
	if (stamp === null || !isRecord(body) || !Array.isArray(body['steps'])) return null;
	const rawSteps = body['steps'] as unknown[];
	const steps: WorkflowTakeoverStep[] = [];
	for (let i = 0; i < stamp.steps.length; i++) {
		const raw = rawSteps[i];
		if (!isRecord(raw) || typeof raw['foreignConnection'] !== 'boolean') return null;
		const profile = raw['connectionProfile'];
		if (profile !== undefined && profile !== null && typeof profile !== 'string') return null;
		steps.push({ ...stamp.steps[i]!, foreignConnection: raw['foreignConnection'], connectionProfile: typeof profile === 'string' ? profile : null });
	}
	if (!Array.isArray(body['marks'])) return null;
	const marks: WorkflowTakeoverMark[] = [];
	for (const m of body['marks'] as unknown[]) {
		if (!isRecord(m) || typeof m['name'] !== 'string' || typeof m['ended'] !== 'boolean') return null;
		if (m['role'] !== 'workflow-created' && m['role'] !== 'workflow-edited') return null;
		marks.push({ name: m['name'], role: m['role'], ended: m['ended'], undetermined: m['undetermined'] === true });
	}
	if (!Array.isArray(body['memberChanges'])) return null;
	const memberChanges: TakeoverMemberChange[] = [];
	for (const c of body['memberChanges'] as unknown[]) {
		if (!isRecord(c) || typeof c['id'] !== 'string' || typeof c['title'] !== 'string') return null;
		const before = c['before'];
		const after = c['after'];
		if ((before !== null && typeof before !== 'string') || (after !== null && typeof after !== 'string')) return null;
		memberChanges.push({ id: c['id'], title: c['title'], before, after, runsNoMore: c['runsNoMore'] === true });
	}
	const alsoReleased = plans(body['alsoReleased']);
	const stillPaused = plans(body['stillPaused']);
	const lapsing = plans(body['lapsing']);
	if (alsoReleased === null || stillPaused === null || lapsing === null) return null;
	if (!Array.isArray(body['connections'])) return null;
	const connections: WorkflowTakeoverConnection[] = [];
	for (const c of body['connections'] as unknown[]) {
		if (!isRecord(c) || typeof c['profileId'] !== 'string' || typeof c['by'] !== 'string' || typeof c['provider'] !== 'string') return null;
		const account = c['account'];
		if (account !== null && typeof account !== 'string') return null;
		connections.push({ profileId: c['profileId'], provider: c['provider'], account, by: c['by'] });
	}
	return { ...stamp, steps, marks, memberChanges, alsoReleased, stillPaused, lapsing, connections };
}

/** The line of one mark in the dialog's head: who, in which role, and whether their access ended. */
export function markLine(m: WorkflowTakeoverMark): string {
	if (m.undetermined) return t(m.role === 'workflow-created' ? 'workflow_library.takeover.undetermined.created' : 'workflow_library.takeover.undetermined.edited');
	const who = tf(m.role === 'workflow-created' ? 'takeover.role.created' : 'takeover.role.edited', { name: m.name });
	return `${who} · ${m.ended ? t('workflow_library.access_ended_unnamed') : t('workflow_library.takeover.still_access')}`;
}

/** The note at a step whose call uses a connection someone with access made; named only when that connection is one the preview names. */
export function stepConnectionNote(p: Pick<WorkflowTakeoverPreview, 'connections'>, step: WorkflowTakeoverStep): string | null {
	if (!step.foreignConnection) return null;
	const by = step.connectionProfile === null ? undefined : p.connections.find((c) => c.profileId === step.connectionProfile)?.by;
	return by === undefined ? t('workflow_library.takeover.step_connection_unnamed') : tf('workflow_library.takeover.step_connection', { name: by });
}

/** One sentence below the steps; `kind` names the part of the dialog it is. */
export interface WorkflowTakeoverLine {
	kind: 'connection' | 'member_change' | 'lapsing' | 'released' | 'paused' | 'afterwards';
	text: string;
}

/**
 * Every sentence below the steps, in the order of the design: the connections that are no longer
 * used, the plans that then run for someone else, the plans whose allowed connections lapse, the
 * plans that run again, the plans that stay paused, and who may start the workflow afterwards.
 */
export function workflowTakeoverLines(p: WorkflowTakeoverPreview): WorkflowTakeoverLine[] {
	const lines: WorkflowTakeoverLine[] = [];
	for (const c of p.connections) {
		lines.push({
			kind: 'connection',
			text: tf('workflow_library.takeover.connection', {
				name: c.by,
				provider: c.provider,
				// The account in brackets, unless it is the person's own address, already named.
				account: c.account !== null && c.account !== '' && c.account.toLowerCase() !== c.by.toLowerCase() ? ` (${c.account})` : '',
			}),
		});
	}
	for (const line of memberChangeLines(p.memberChanges)) lines.push({ kind: 'member_change', text: line.text });
	if (p.lapsing.length === 1) lines.push({ kind: 'lapsing', text: tf('workflow_library.takeover.lapsing_one', { plan: p.lapsing[0]!.title }) });
	else if (p.lapsing.length > 1) lines.push({ kind: 'lapsing', text: tf('workflow_library.takeover.lapsing_many', { plans: planList(p.lapsing.map((l) => l.title)) }) });
	if (p.alsoReleased.length === 1) lines.push({ kind: 'released', text: tf('takeover.f2.released_one', { plan: p.alsoReleased[0]!.title }) });
	else if (p.alsoReleased.length > 1) lines.push({ kind: 'released', text: tf('takeover.f2.released', { plans: planList(p.alsoReleased.map((r) => r.title)) }) });
	const where = { tab: t('hub.automation.triggers'), button: t('takeover.button') };
	if (p.stillPaused.length === 1) lines.push({ kind: 'paused', text: tf('workflow_library.takeover.paused_one', { plan: p.stillPaused[0]!.title, ...where }) });
	else if (p.stillPaused.length > 1) lines.push({ kind: 'paused', text: tf('workflow_library.takeover.paused_many', { plans: planList(p.stillPaused.map((s) => s.title)), ...where }) });
	lines.push({ kind: 'afterwards', text: t('workflow_library.takeover.afterwards') });
	return lines;
}

/** What an answer of `POST /api/workflows/:id/takeover` means for the view. */
export type WorkflowTakeoverOutcome =
	| { kind: 'taken_over'; stillOff: unknown }
	/** Something shown moved: the view loads the preview again and says so above it. */
	| { kind: 'changed' }
	| { kind: 'failed'; text: string };

/**
 * Only a 2xx takes over. `changed` reloads; every other code has its sentence, and a code the view
 * does not know keeps the engine's text. `managed`: lynox hosts the instance, so a lasting failure
 * goes to support.
 */
export function takeoverOutcome(status: number, body: { code?: string; error?: string; stillOff?: unknown } | null, managed: boolean): WorkflowTakeoverOutcome {
	if (status >= 200 && status < 300) return { kind: 'taken_over', stillOff: body?.stillOff };
	const code = body?.code;
	if (code === 'changed') return { kind: 'changed' };
	return { kind: 'failed', text: takeoverRefusalText(code, managed, body?.error ?? t('common.save_failed')) };
}

/** A refusal in the reader's language; `fallback` (the engine's sentence) for a code without one. */
export function takeoverRefusalText(code: string | undefined, managed: boolean, fallback: string): string {
	switch (code) {
		case 'changed':
			return t('workflow_library.takeover.refused.changed');
		case 'mandate_live':
			// The answer does not say who has access again: the sentence without a name.
			return t('workflow_library.takeover.refused.mandate_live_unnamed');
		case 'unrecorded':
		case 'stamp_refused':
			return managed ? `${t(`workflow_library.takeover.refused.${code}`)} ${t('takeover.refused.support')}` : t(`workflow_library.takeover.refused.${code}`);
		default:
			return fallback;
	}
}
