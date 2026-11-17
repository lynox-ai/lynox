import { t, tf } from '../i18n.svelte.js';
import { visible } from './workflow-stamp.js';

/** How many characters of a value someone else wrote a sentence shows, the cut one included. */
export const SHOWN_VALUE_MAX = 80;

/** Where a value someone else wrote starts and ends inside a sentence of lynox's (Private Use). */
export const VALUE_OPEN = '\uE000';
export const VALUE_CLOSE = '\uE001';
const VALUE_MARK = /[\uE000\uE001]/g;

/**
 * A value someone else wrote (a plan's title, a name, an account) as a sentence of lynox's shows
 * it: on one line, cut to {@link SHOWN_VALUE_MAX} characters, with the characters that change how
 * text reads without being seen printed as their code point (`visible`), and between the two
 * marks the view draws as a value set apart ({@link segments}). A mark inside the value is printed
 * as its code point too, so a value can neither close its own marks nor open new ones: whatever
 * it says, it cannot read as lynox's own words.
 */
export function shownValue(text: string): string {
	const chars = Array.from(text.replace(/\s+/g, ' ').trim());
	const cut = chars.length > SHOWN_VALUE_MAX ? `${chars.slice(0, SHOWN_VALUE_MAX - 1).join('')}…` : chars.join('');
	const shown = visible(cut).replace(VALUE_MARK, (c) => `<U+${c.codePointAt(0)!.toString(16).toUpperCase()}>`);
	return `${VALUE_OPEN}${shown}${VALUE_CLOSE}`;
}

/** One piece of a sentence: lynox's words, or a value someone else wrote (`foreign`). */
export interface Segment { text: string; foreign: boolean }

/**
 * A sentence split at the marks {@link shownValue} sets. A mark without its partner is dropped and
 * what follows it stays lynox's text: only a whole pair sets a value apart.
 */
export function segments(line: string): Segment[] {
	const out: Segment[] = [];
	const push = (text: string, foreign: boolean): void => {
		const clean = text.replace(VALUE_MARK, '');
		if (clean !== '' || foreign) out.push({ text: clean, foreign });
	};
	const pair = /\uE000([^\uE000\uE001]*)\uE001/g;
	let at = 0;
	for (let m = pair.exec(line); m !== null; m = pair.exec(line)) {
		push(line.slice(at, m.index), false);
		push(m[1]!, true);
		at = m.index + m[0].length;
	}
	push(line.slice(at), false);
	return out;
}

/** A sentence as plain text, without its marks: for a label, a title or a log. */
export function plainText(line: string): string {
	return segments(line).map((s) => s.text).join('');
}

/**
 * The owner's takeover of a paused plan, as the Triggers view shows it: the lines of the
 * confirmation, built from `GET /api/triggers/:id/takeover-preview` (engine `plan-takeover.ts`),
 * and what each refusal of `POST …/takeover` says. Pure, so every form of a sentence has its test.
 * The wording is ux's and business-planning's (PRD 641c "Texte", ux U-037/U-039), word for word.
 */

export type PauseRole = 'created' | 'edited' | 'workflow-created' | 'workflow-edited';

export interface TakeoverMember {
	name: string;
	roles: PauseRole[];
	ended: boolean;
	reason: 'expired' | 'revoked' | null;
}

export interface TakeoverMemberChange {
	id: string;
	title: string;
	/** Tags (`mandate:<email>`), null for the owner. */
	before: string | null;
	after: string | null;
	runsNoMore: boolean;
}

export interface TakeoverConnection {
	id: string;
	profile: string;
	provider: string;
	account: string | null;
	/** The address of the helper whose connection it is; null when the engine does not know. */
	by: string | null;
}

export type TakeoverSchedule = 'kept' | 'next_cron' | 'run_now_only_missed' | 'run_now_only_partial';

export interface TakeoverPreview {
	expect: string;
	members: TakeoverMember[];
	/** `owner`, or the tag of the workflow's member that stays. */
	runsAs: string;
	/** `from`: whose mark on the workflow the takeover reads, by address and role (engine `planMandate`). */
	workflow: { id: string; name: string; takenOver: boolean; from?: { name: string; role: 'workflow-edited' | 'workflow-created' } | null } | null;
	memberChanges: TakeoverMemberChange[];
	alsoReleased: Array<{ id: string; title: string }>;
	connections: TakeoverConnection[];
	schedule: TakeoverSchedule;
	dueAt: string | null;
}

/** One sentence of the confirmation; `kind` names the text it is (T-1 … T-6, F2), for tests and markup. */
export interface TakeoverLine {
	kind: 'role' | 'f2' | 'member_change' | 'connection' | 'runs_as_owner' | 'runs_as_member' | 'missed' | 'partial';
	text: string;
}

const MANDATE_TAG = 'mandate:';

/** The address in a mandate tag; the tag itself when it is none. */
export function nameOfTag(tag: string): string {
	return tag.startsWith(MANDATE_TAG) ? tag.slice(MANDATE_TAG.length) : tag;
}

/** At most five plans by name, the rest as "and {n} more" (U-037 Nachtrag 2). */
export function planList(titles: readonly string[]): string {
	const shown = titles.map(shownValue);
	if (shown.length <= 5) return shown.join(', ');
	return tf('takeover.plans_more', { plans: shown.slice(0, 5).join(', '), n: String(shown.length - 5) });
}

/**
 * The role lines of one member (Fassung 4): every role that applies, except the workflow role F2
 * already says for this member (ux, review of the dialog: the two lines said the same).
 */
function roleLines(m: TakeoverMember, workflow: string | null, saidByF2: TakeoverMember['roles'][number] | null): TakeoverLine[] {
	return m.roles.filter((role) => role !== saidByF2).map((role) => ({
		kind: 'role' as const,
		text: role === 'created' || role === 'edited'
			? tf(`takeover.role.${role}`, { name: shownValue(m.name) })
			: tf(`takeover.role.${role}`, { name: shownValue(m.name), workflow: workflow === null ? '' : shownValue(workflow) }),
	}));
}

/**
 * F2: the workflow is taken over with the plan. Named after the member it is taken over from: the
 * one whose mark the takeover reads (`workflow.from`); without it, the one with a workflow role,
 * its change before its creation. Without plans released, the last sentence goes.
 */
function f2Line(p: TakeoverPreview): { line: TakeoverLine; by: TakeoverMember; role: 'workflow-edited' | 'workflow-created' } | null {
	if (p.workflow === null || !p.workflow.takenOver) return null;
	const from = p.workflow.from ?? null;
	const marked = from === null ? undefined : p.members.find((m) => m.name === from.name && m.roles.includes(from.role));
	const by = marked
		?? p.members.find((m) => m.roles.includes('workflow-edited')) ?? p.members.find((m) => m.roles.includes('workflow-created'));
	if (by === undefined) return null;
	const role = marked !== undefined && from !== null ? from.role : by.roles.includes('workflow-edited') ? 'workflow-edited' : 'workflow-created';
	const changed = role === 'workflow-edited';
	const vars = { workflow: shownValue(p.workflow.name), name: shownValue(by.name) };
	const head = tf(changed ? 'takeover.f2.changed' : 'takeover.f2.created', vars);
	const text = p.alsoReleased.length === 0 ? head : `${head} ${tf('takeover.f2.released', { plans: planList(p.alsoReleased.map((r) => r.title)) })}`;
	return { line: { kind: 'f2', text }, by, role };
}

/**
 * T-2: other plans on the workflow that then run for someone else, grouped by (before, after).
 * Only a change of whom a plan runs for is said (N3); a plan that will not run again by itself is
 * left out of what is shown (N7) — the digest still holds it.
 */
export function memberChangeLines(changes: readonly TakeoverMemberChange[]): TakeoverLine[] {
	const groups = new Map<string, { before: string; after: string | null; titles: string[] }>();
	for (const c of changes) {
		if (c.runsNoMore || c.before === null || c.before === c.after) continue;
		const key = `${c.before}\u0000${c.after ?? ''}`;
		const g = groups.get(key) ?? { before: c.before, after: c.after, titles: [] };
		g.titles.push(c.title);
		groups.set(key, g);
	}
	return [...groups.values()].map((g) => {
		const one = g.titles.length === 1;
		const before = shownValue(nameOfTag(g.before));
		const plan = shownValue(g.titles[0]!);
		const text = g.after === null
			? (one ? tf('takeover.change.owner_one', { plan, before }) : tf('takeover.change.owner_many', { plans: planList(g.titles), before }))
			: (one ? tf('takeover.change.member_one', { plan, before, after: shownValue(nameOfTag(g.after)) }) : tf('takeover.change.member_many', { plans: planList(g.titles), before, after: shownValue(nameOfTag(g.after)) }));
		return { kind: 'member_change' as const, text };
	});
}

/**
 * T-3: a connection a helper made with their own account no longer counts once the owner takes over.
 * The account follows in brackets, unless it is the helper's own address, already named (ux); an
 * address is compared without case.
 */
function connectionLines(p: TakeoverPreview): TakeoverLine[] {
	return p.connections.map((c) => ({
		kind: 'connection' as const,
		text: tf('takeover.connection', {
			name: c.by !== null ? shownValue(c.by) : t('takeover.connection_someone'),
			provider: shownValue(c.provider),
			account: c.account !== null && c.account !== '' && c.account.toLowerCase() !== c.by?.toLowerCase() ? ` (${shownValue(c.account)})` : '',
		}),
	}));
}

/** T-4 or T-5: who the plan runs for afterwards. Exactly one of the two. */
function runsAsLine(p: TakeoverPreview): TakeoverLine {
	if (p.runsAs === 'owner') return { kind: 'runs_as_owner', text: t('takeover.runs_as_owner') };
	const name = nameOfTag(p.runsAs);
	// The same person can be listed once per access (an ended one and the live one): the member that
	// stays is the one whose access still runs, and its own roles say how it came to the workflow.
	const member = p.members.find((m) => m.name === name && !m.ended) ?? p.members.find((m) => m.name === name);
	const changed = member?.roles.includes('workflow-edited') === true;
	return {
		kind: 'runs_as_member',
		text: tf(changed ? 'takeover.runs_as_member.changed' : 'takeover.runs_as_member.created', { name: shownValue(name), workflow: p.workflow === null ? '' : shownValue(p.workflow.name) }),
	};
}

/** T-6: a one-shot that runs only on "Run now" afterwards, with the reason. */
function scheduleLines(p: TakeoverPreview, formatDate: (iso: string) => string): TakeoverLine[] {
	if (p.schedule !== 'run_now_only_missed' && p.schedule !== 'run_now_only_partial') return [];
	// Without a date (a one-shot whose time was never set) the sentence says only what the owner does.
	const missed: TakeoverLine = { kind: 'missed', text: p.dueAt !== null ? tf('takeover.missed', { date: formatDate(p.dueAt) }) : t('takeover.missed_undated') };
	return p.schedule === 'run_now_only_partial' ? [missed, { kind: 'partial', text: t('takeover.partial') }] : [missed];
}

/** Every line of the confirmation, in the order of the design (T-1, F2, T-2, T-3, T-4|T-5, T-6). */
export function takeoverLines(p: TakeoverPreview, formatDate: (iso: string) => string): TakeoverLine[] {
	const lines: TakeoverLine[] = [];
	const f2 = f2Line(p);
	// One person can be listed once per access, and the roles an ended access was paused with are
	// a copy from the pause: the same role under two accesses is one sentence, said once.
	const said = new Set<string>();
	// The workflow role F2 says for its member counts as said, also for the same person's other access.
	if (f2 !== null) for (const line of roleLines({ ...f2.by, roles: [f2.role] }, p.workflow?.name ?? null, null)) said.add(line.text);
	for (const m of p.members) {
		for (const line of roleLines(m, p.workflow?.name ?? null, f2 !== null && f2.by === m ? f2.role : null)) {
			if (said.has(line.text)) continue;
			said.add(line.text);
			lines.push(line);
		}
	}
	if (f2 !== null) lines.push(f2.line);
	lines.push(...memberChangeLines(p.memberChanges));
	lines.push(...connectionLines(p));
	lines.push(runsAsLine(p));
	lines.push(...scheduleLines(p, formatDate));
	return lines;
}

/** One ended access behind a paused plan (`GET /api/triggers`, owner only, `paused_ended`). */
export interface PausedEnded {
	email: string;
	reason: 'expired' | 'revoked';
	ends_at: string;
	/** Whether the advance notice before this end reached the owner (641c-2b sets it). */
	warned: boolean;
}

/**
 * The notices above the plans, one per ended access, with the full address: the push had to
 * shorten it to fit (engine `pauseNotice`). The wording is business-planning's G7 (Fassung 3, as of
 * 28.10.); an expiry without an advance notice says so (none comes before 641c-2b). The count
 * is of the paused plans in the list, so it follows each takeover.
 */
export function endedNotices(plans: ReadonlyArray<{ title: string; paused_ended?: PausedEnded[] | undefined }>, formatDate: (iso: string) => string): string[] {
	const byAccess = new Map<string, { ended: PausedEnded; titles: string[] }>();
	for (const p of plans) {
		for (const e of p.paused_ended ?? []) {
			const key = `${e.email}\u0000${e.reason}\u0000${e.ends_at}\u0000${String(e.warned)}`;
			const seen = byAccess.get(key);
			if (seen === undefined) byAccess.set(key, { ended: e, titles: [p.title] });
			else seen.titles.push(p.title);
		}
	}
	// One plan is named by its title: the notice stands above the whole list, not at the plan (ux).
	return [...byAccess.values()].map(({ ended, titles }) => {
		const form = titles.length === 1 ? 'one' : 'many';
		const text = tf(`takeover.notice.${ended.reason}_${form}`, { name: shownValue(ended.email), date: formatDate(ended.ends_at), count: String(titles.length), plan: titles[0] === undefined ? '' : shownValue(titles[0]) });
		return ended.reason === 'expired' && !ended.warned ? `${text} ${t('takeover.notice.no_advance')}` : text;
	});
}

export const TAKEOVER_REFUSAL_CODES =['not_available', 'bulk', 'nothing_to_take_over', 'unreadable', 'running', 'changed', 'prompts', 'unrecorded'] as const;
export type TakeoverRefusal = (typeof TAKEOVER_REFUSAL_CODES)[number];

/**
 * What the view says for a refusal, in the reader's language; the engine's English text stays the
 * fallback for a code this view does not know. `workflow`: the name the preview had, for `unreadable`.
 * `managed`: the instance is hosted by lynox, so a lasting failure goes to support.
 */
export function refusalText(code: string, opts: { workflow: string | null; managed: boolean; fallback: string }): string {
	switch (code) {
		case 'unreadable':
			return opts.workflow !== null && opts.workflow !== '' ? tf('takeover.refused.unreadable_named', { workflow: shownValue(opts.workflow) }) : t('takeover.refused.unreadable');
		case 'prompts':
		case 'unrecorded':
			return opts.managed ? `${t(`takeover.refused.${code}`)} ${t('takeover.refused.support')}` : t(`takeover.refused.${code}`);
		case 'bulk':
		case 'nothing_to_take_over':
		case 'running':
		case 'changed':
			return t(`takeover.refused.${code}`);
		default:
			return opts.fallback;
	}
}

/** The engine's start of a title it derives from a workflow's name (`SCHEDULED_TITLE_PREFIX`), kept equal by a test. */
export const SCHEDULED_TITLE_PREFIX = 'Scheduled: ';

/** Who set a plan up and changed it, as the trigger list carries it (tags: `owner`, `mandate:<address>`). */
export interface PlanAuthorship {
	title: string;
	created_by?: string | undefined;
	edited_by?: string | undefined;
	mandate_editor?: string | undefined;
}

/**
 * The title of a plan with a takeover to give, as a line with the value set apart. The title is
 * someone else's value on every such plan: even one the owner set up runs a workflow a person with
 * access made or changed, and its title may be that workflow's name, put there by lynox's agent or
 * by the engine. Only where the owner alone set up and changed the plan does a title the engine
 * starts with its own words keep those words outside the box; on any other plan the whole title is
 * the value, so a person with access cannot borrow them.
 */
export function pausedTitleLine(plan: PlanAuthorship): string {
	const ownerOnly = plan.created_by === 'owner' && (plan.edited_by ?? 'owner') === 'owner' && (plan.mandate_editor ?? '') === '';
	if (ownerOnly && plan.title.startsWith(SCHEDULED_TITLE_PREFIX)) return SCHEDULED_TITLE_PREFIX + shownValue(plan.title.slice(SCHEDULED_TITLE_PREFIX.length));
	return shownValue(plan.title);
}
