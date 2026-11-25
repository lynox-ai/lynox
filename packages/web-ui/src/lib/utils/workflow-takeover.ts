import { t, tf } from '../i18n.svelte.js';
import { memberChangeLines, nameOfTag, planList, shownValue, type TakeoverMemberChange } from './plan-takeover.js';
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
	/** The call's target is set only when it runs: it may use a connection someone with access made. */
	targetAtRun: boolean;
}

export interface WorkflowTakeoverPreview extends Omit<StampPreview, 'steps'> {
	workflow: { id: string; name: string };
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
	const wf = body['workflow'];
	if (!isRecord(wf) || typeof wf['id'] !== 'string' || typeof wf['name'] !== 'string') return null;
	const workflow = { id: wf['id'], name: wf['name'] };
	const rawSteps = body['steps'] as unknown[];
	const steps: WorkflowTakeoverStep[] = [];
	for (let i = 0; i < stamp.steps.length; i++) {
		const raw = rawSteps[i];
		if (!isRecord(raw) || typeof raw['foreignConnection'] !== 'boolean') return null;
		const profile = raw['connectionProfile'];
		if (profile !== undefined && profile !== null && typeof profile !== 'string') return null;
		const atRun = raw['targetAtRun'];
		if (atRun !== undefined && typeof atRun !== 'boolean') return null;
		// A target set only when it runs is a marked step without a profile, nothing else.
		if (atRun === true && (!raw['foreignConnection'] || typeof profile === 'string')) return null;
		steps.push({ ...stamp.steps[i]!, foreignConnection: raw['foreignConnection'], connectionProfile: typeof profile === 'string' ? profile : null, targetAtRun: atRun === true });
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
	return { ...stamp, workflow, steps, marks, memberChanges, alsoReleased, stillPaused, lapsing, connections };
}

/** The line of one mark in the dialog's head: who, in which role, and whether their access ended. */
export function markLine(m: WorkflowTakeoverMark): string {
	if (m.undetermined) return t(m.role === 'workflow-created' ? 'workflow_library.takeover.undetermined.created' : 'workflow_library.takeover.undetermined.edited');
	const who = tf(m.role === 'workflow-created' ? 'takeover.role.created' : 'takeover.role.edited', { name: shownValue(m.name) });
	return `${who} · ${m.ended ? t('workflow_library.takeover.access_ended') : t('workflow_library.takeover.still_access')}`;
}

/** The one person whose connections the preview names, when it names exactly one; otherwise none. */
function onlyPerson(p: Pick<WorkflowTakeoverPreview, 'connections'>): string | undefined {
	const people = new Set(p.connections.map((c) => c.by.toLowerCase()));
	return people.size === 1 ? p.connections[0]!.by : undefined;
}

/**
 * The sentence for the steps whose target is set only when they run: each by its task, the list
 * folded past five, or none when it is every step of the workflow. Whose connection it may be is
 * named when the preview's connections are one person's. Without a sentence on a connection before
 * it, it says where to connect the service.
 */
function atRunSentence(p: Pick<WorkflowTakeoverPreview, 'connections' | 'steps'>, steps: readonly WorkflowTakeoverStep[], afterConnection: boolean): string {
	const only = onlyPerson(p);
	const who = only === undefined ? t('workflow_library.takeover.at_run.who_unnamed') : tf('workflow_library.takeover.at_run.who', { name: shownValue(only) });
	const all = steps.length === p.steps.length && steps.length > 1;
	const one = steps.length === 1 || all;
	const end = afterConnection ? t('workflow_library.takeover.at_run.end') : t(one ? 'workflow_library.takeover.at_run.end_where_one' : 'workflow_library.takeover.at_run.end_where_many');
	if (all) return tf('workflow_library.takeover.at_run.all', { who, end });
	if (steps.length === 1) return tf('workflow_library.takeover.at_run.one', { step: shownValue(steps[0]!.task), who, end });
	return tf('workflow_library.takeover.at_run.many', { steps: planList(steps.map((s) => s.task)), who, end });
}

/** The note at a step whose call uses a connection someone with access made; named only when that connection is one the preview names. */
export function stepConnectionNote(p: Pick<WorkflowTakeoverPreview, 'connections'>, step: WorkflowTakeoverStep): string | null {
	if (!step.foreignConnection) return null;
	// Which connection it uses shows only when it runs: the sentence below names it, not a note.
	if (step.targetAtRun) return null;
	const by = step.connectionProfile === null ? undefined : p.connections.find((c) => c.profileId === step.connectionProfile)?.by;
	return by === undefined ? t('workflow_library.takeover.step_connection_unnamed') : tf('workflow_library.takeover.step_connection', { name: shownValue(by) });
}

/** One sentence below the steps; `kind` names the part of the dialog it is. */
export interface WorkflowTakeoverLine {
	kind: 'connection' | 'connection_at_run' | 'member_change' | 'lapsing' | 'released' | 'paused' | 'afterwards';
	text: string;
}

/**
 * Every sentence below the steps, in the order of the design: the connections that are no longer
 * used, the plans that then run for someone else, the plans whose allowed connections lapse, the
 * plans that run again, the plans that stay paused, and who may start the workflow afterwards.
 * A connection gets its sentence only where a marked step uses it: the sentence speaks of the
 * marked steps. Steps whose target is set only when it runs get one sentence of their own,
 * after those. A plan that stays paused runs for no one, so it is not one that runs for someone
 * else: it gets only its sentence that it stays paused. A plan that runs again and then runs under
 * the owner's name instead of a person's gets one sentence that says both. A plan that runs again
 * and then runs under another person's name is said twice: once among the plans that run again,
 * once with whom it runs for. A plan whose allowed connections lapse is said right after the
 * sentence that names it among the plans that run again; one that does not run again gets its own
 * sentence before those.
 */
export function workflowTakeoverLines(p: WorkflowTakeoverPreview): WorkflowTakeoverLine[] {
	const lines: WorkflowTakeoverLine[] = [];
	const used = new Set(p.steps.filter((s) => s.foreignConnection && s.connectionProfile !== null).map((s) => s.connectionProfile));
	for (const c of p.connections) {
		if (!used.has(c.profileId)) continue;
		lines.push({
			kind: 'connection',
			text: tf('workflow_library.takeover.connection', {
				name: shownValue(c.by),
				provider: shownValue(c.provider),
				// The account in brackets, unless it is the person's own address, already named.
				account: c.account !== null && c.account !== '' && c.account.toLowerCase() !== c.by.toLowerCase() ? ` (${shownValue(c.account)})` : '',
			}),
		});
	}
	// Steps whose target is set only when it runs: which connection they use shows only then. One
	// sentence names them all, after the ones above, and only when there is such a step: a step
	// without a note is either named here or reaches no one's connection.
	const atRun = p.steps.filter((s) => s.foreignConnection && s.targetAtRun);
	if (atRun.length > 0) lines.push({ kind: 'connection_at_run', text: atRunSentence(p, atRun, lines.length > 0) });
	const paused = new Set(p.stillPaused.map((s) => s.id));
	const released = new Set(p.alsoReleased.map((r) => r.id));
	// Released and then run under the owner's name instead of a person's: one sentence for both.
	const toOwner = p.memberChanges.filter((c) => released.has(c.id) && !paused.has(c.id) && !c.runsNoMore && c.before !== null && c.after === null);
	const saidWithRelease = new Set(toOwner.map((c) => c.id));
	for (const line of memberChangeLines(p.memberChanges.filter((c) => !paused.has(c.id) && !saidWithRelease.has(c.id)))) lines.push({ kind: 'member_change', text: line.text });
	// A plan that lapses and is named in a sentence of plans that run again is said right after that
	// sentence; the others in a sentence of their own, here.
	const lapsingIds = new Set(p.lapsing.map((l) => l.id));
	const lapsingAlone = p.lapsing.filter((l) => !released.has(l.id));
	if (lapsingAlone.length === 1) lines.push({ kind: 'lapsing', text: tf('workflow_library.takeover.lapsing_one', { plan: shownValue(lapsingAlone[0]!.title) }) });
	else if (lapsingAlone.length > 1) lines.push({ kind: 'lapsing', text: tf('workflow_library.takeover.lapsing_many', { plans: planList(lapsingAlone.map((l) => l.title)) }) });
	const saidLapsing = new Set<string>();
	// After a sentence naming `named`, the plans among them whose allowed connections lapse.
	const lapsingAfter = (named: ReadonlyArray<{ id: string; title: string }>): void => {
		const these = named.filter((n) => lapsingIds.has(n.id) && !saidLapsing.has(n.id));
		for (const n of these) saidLapsing.add(n.id);
		if (these.length === 0) return;
		const text = named.length === 1
			? t('workflow_library.takeover.lapsing_after_same')
			: these.length === 1
				? tf('workflow_library.takeover.lapsing_after_one', { plan: shownValue(these[0]!.title) })
				: tf('workflow_library.takeover.lapsing_after_many', { plans: planList(these.map((n) => n.title)) });
		lines.push({ kind: 'lapsing', text });
	};
	const byPerson = new Map<string, Array<{ id: string; title: string }>>();
	for (const c of toOwner) byPerson.set(c.before!, [...(byPerson.get(c.before!) ?? []), { id: c.id, title: c.title }]);
	for (const [before, named] of byPerson) {
		const person = shownValue(nameOfTag(before));
		lines.push({
			kind: 'released',
			text: named.length === 1
				? tf('workflow_library.takeover.released_owner_one', { plan: shownValue(named[0]!.title), person })
				: tf('workflow_library.takeover.released_owner_many', { plans: planList(named.map((n) => n.title)), person }),
		});
		lapsingAfter(named);
	}
	const rest = p.alsoReleased.filter((r) => !saidWithRelease.has(r.id));
	if (rest.length === 1) lines.push({ kind: 'released', text: tf('takeover.f2.released_one', { plan: shownValue(rest[0]!.title) }) });
	else if (rest.length > 1) lines.push({ kind: 'released', text: tf('takeover.f2.released', { plans: planList(rest.map((r) => r.title)) }) });
	lapsingAfter(rest);
	const where = { tab: t('hub.automation.triggers'), button: t('takeover.button') };
	if (p.stillPaused.length === 1) lines.push({ kind: 'paused', text: tf('workflow_library.takeover.paused_one', { plan: shownValue(p.stillPaused[0]!.title), ...where }) });
	else if (p.stillPaused.length > 1) lines.push({ kind: 'paused', text: tf('workflow_library.takeover.paused_many', { plans: planList(p.stillPaused.map((s) => s.title)), ...where }) });
	lines.push({ kind: 'afterwards', text: t('workflow_library.takeover.afterwards') });
	return lines;
}

/** What an answer of `POST /api/workflows/:id/takeover` means for the view. */
export type WorkflowTakeoverOutcome =
	| { kind: 'taken_over'; stillOff: unknown }
	/** Something shown moved: the view loads the preview again and puts `text` above it. */
	| { kind: 'changed'; text: string }
	| { kind: 'failed'; text: string };

/** The refusals after which the dialog loads the preview again: what was shown moved. */
const RELOADS = new Set(['changed', 'stamp_refused']);
/** The refusals that do not pass by waiting or acting, and so name support where lynox hosts the instance. */
const TO_SUPPORT = new Set(['prompts', 'unrecorded', 'unreadable']);

/** Whether the sentence of `code` carries the support line where lynox hosts the instance: only then is it worth asking. */
export function refusalNamesSupport(code: string | undefined): boolean {
	return code !== undefined && TO_SUPPORT.has(code);
}

/**
 * Only a 2xx takes over. `changed` and `stamp_refused` reload; every other code has its sentence,
 * and a code the view does not know keeps the engine's text. `managed`: lynox hosts the instance,
 * so a lasting failure goes to support.
 */
export function takeoverOutcome(status: number, body: { code?: string; error?: string; stillOff?: unknown } | null, managed: boolean): WorkflowTakeoverOutcome {
	if (status >= 200 && status < 300) return { kind: 'taken_over', stillOff: body?.stillOff };
	const code = body?.code;
	const text = takeoverRefusalText(code, managed, body?.error ?? t('common.save_failed'));
	return code !== undefined && RELOADS.has(code) ? { kind: 'changed', text } : { kind: 'failed', text };
}

/** A refusal in the reader's language; `fallback` (the engine's sentence) for a code without one. */
export function takeoverRefusalText(code: string | undefined, managed: boolean, fallback: string): string {
	switch (code) {
		case 'mandate_live':
			// The answer does not say who has access again: the sentence without a name.
			return t('workflow_library.takeover.refused.mandate_live_unnamed');
		case 'changed':
		case 'stamp_refused':
		case 'running':
		case 'nothing_to_take_over':
			return t(`workflow_library.takeover.refused.${code}`);
		case 'prompts':
		case 'unrecorded':
		case 'unreadable':
			return managed ? `${t(`workflow_library.takeover.refused.${code}`)} ${t('takeover.refused.support')}` : t(`workflow_library.takeover.refused.${code}`);
		default:
			return fallback;
	}
}
