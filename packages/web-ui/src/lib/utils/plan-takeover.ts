import { t, tf } from '../i18n.svelte.js';
import { visible } from './workflow-stamp.js';

/** How many characters of a value someone else wrote a sentence shows, the cut one included. */
export const SHOWN_VALUE_MAX = 80;

/** Where a value someone else wrote starts and ends inside a sentence of lynox's (Private Use). */
export const VALUE_OPEN = '\uE000';
export const VALUE_CLOSE = '\uE001';
/**
 * Where the titles a list of plans keeps folded start and end ({@link planList}): the view shows
 * a button in their place and puts them in when it is pressed.
 */
export const MORE_OPEN = '\uE002';
export const MORE_CLOSE = '\uE003';
const VALUE_MARK = /[\uE000-\uE003]/g;

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
	return setApart(visible(cut));
}

/**
 * A value between the two marks the view draws as a value set apart, on one line and not cut, with
 * a mark inside it printed as its code point: the box alone, with no character marking of its own.
 * For a sentence that marks characters its own way (the stamp's, by `markHidden`, which its
 * "marked above" note points at), and where a host is read from its end, which a cut would take.
 */
export function setApart(text: string): string {
	const flat = text.replace(/\s+/g, ' ').trim().replace(VALUE_MARK, (c) => `<U+${c.codePointAt(0)!.toString(16).toUpperCase()}>`);
	return `${VALUE_OPEN}${flat}${VALUE_CLOSE}`;
}

/**
 * Whose access ended, for a line that cannot draw a box (Run now's toast): the addresses people
 * with access chose, each with its hidden characters printed instead of read, its whitespace
 * folded, joined by commas. Empty when the list names no one.
 */
export function pausedWhoText(names: readonly string[] | undefined): string {
	return (names ?? []).map((name) => visible(name.replace(/\s+/g, ' ').trim())).filter((name) => name !== '').join(', ');
}

/**
 * {@link shownValue} without the cut: for a heading where the owner confirms which item they act on,
 * so a long name is read to its end and two names that share a beginning stay apart.
 */
export function shownWhole(text: string): string {
	return setApart(visible(text));
}

/**
 * One piece of a sentence: lynox's words, or a value someone else wrote (`foreign`). A piece with
 * `more` is the folded rest of a list of plans ({@link planList}): `n` titles, the pieces that name
 * them once the list is opened, and `key`, the same for the same list in another sentence.
 */
export interface Segment { text: string; foreign: boolean; more?: { n: number; pieces: Segment[]; key: string } }

function valuePieces(line: string): Segment[] {
	const out: Segment[] = [];
	const push = (text: string, foreign: boolean): void => {
		const clean = text.replace(VALUE_MARK, '');
		if (clean !== '' || foreign) out.push({ text: clean, foreign });
	};
	const pair = /\uE000([^\uE000-\uE003]*)\uE001/g;
	let at = 0;
	for (let m = pair.exec(line); m !== null; m = pair.exec(line)) {
		push(line.slice(at, m.index), false);
		push(m[1]!, true);
		at = m.index + m[0].length;
	}
	push(line.slice(at), false);
	return out;
}

/**
 * A sentence split at the marks {@link shownValue} and {@link planList} set. A mark without its
 * partner is dropped and what follows it stays lynox's text: only a whole pair sets a value apart,
 * and only a whole pair with at least one value in it folds a list's rest. A value cannot carry a mark of either kind
 * ({@link setApart} prints it as its code point).
 */
export function segments(line: string): Segment[] {
	const out: Segment[] = [];
	const fold = /\uE002([^\uE002\uE003]*)\uE003/g;
	let at = 0;
	for (let m = fold.exec(line); m !== null; m = fold.exec(line)) {
		out.push(...valuePieces(line.slice(at, m.index)));
		const pieces = valuePieces(m[1]!);
		const n = pieces.filter((p) => p.foreign).length;
		// Only what `planList` folds is a fold: titles in their boxes and the commas between them.
		// Marks around anything else (a raw error that reached a sentence) stay inline, so none of
		// lynox's words, and no sentence without a title, can hide behind "and {n} more".
		const listOnly = pieces.every((p) => p.foreign || p.text === ', ');
		if (n > 0 && listOnly) out.push({ text: '', foreign: false, more: { n, pieces, key: m[1]! } });
		else out.push(...pieces);
		at = m.index + m[0].length;
	}
	out.push(...valuePieces(line.slice(at)));
	return out;
}

/** What the button in place of a folded list's rest says: "and {n} more". */
export function moreText(n: number): string {
	return n === 1 ? t('takeover.plans_more_one') : tf('takeover.plans_more', { n: String(n) });
}

/** The button's name for a screen reader: "and {n} more, show them". */
export function moreLabel(n: number): string {
	return n === 1 ? t('takeover.plans_more_show_one') : tf('takeover.plans_more_show', { n: String(n) });
}

/** A sentence as plain text, without its marks, a folded list as the button reads: for a label, a title or a log. */
export function plainText(line: string): string {
	return segments(line).map((s) => (s.more === undefined ? s.text : ` ${moreText(s.more.n)}`)).join('');
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

/**
 * At most five plans by name; past five, the rest folded between {@link MORE_OPEN} and
 * {@link MORE_CLOSE}: the view shows "and {n} more" as a button in the sentence and, once it is
 * pressed, the remaining titles in its place, each in its own box (U-037).
 */
export function planList(titles: readonly string[]): string {
	const shown = titles.map(shownValue);
	if (shown.length <= 5) return shown.join(', ');
	return `${shown.slice(0, 5).join(', ')}${MORE_OPEN}, ${shown.slice(5).join(', ')}${MORE_CLOSE}`;
}

type WorkflowRole = 'workflow-created' | 'workflow-edited';

/**
 * The role lines of one member (Fassung 4): each role on the plan, then one line for the workflow:
 * `workflowRoles` are the person's roles on it over all of their accesses, and both read as
 * one sentence. Where F2 names the person, F2 says the workflow and no line here does.
 */
function roleLines(m: TakeoverMember, workflow: string | null, workflowRoles: ReadonlySet<WorkflowRole>): TakeoverLine[] {
	const lines: TakeoverLine[] = m.roles
		.filter((role): role is 'created' | 'edited' => role === 'created' || role === 'edited')
		.map((role) => ({ kind: 'role' as const, text: tf(`takeover.role.${role}`, { name: shownValue(m.name) }) }));
	if (!m.roles.some((role) => role === 'workflow-created' || role === 'workflow-edited') || workflowRoles.size === 0) return lines;
	const key = workflowRoles.size === 2 ? 'takeover.role.workflow-created-edited' : `takeover.role.${[...workflowRoles][0]}`;
	lines.push({ kind: 'role', text: tf(key, { name: shownValue(m.name), workflow: workflow === null ? '' : shownValue(workflow) }) });
	return lines;
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
 * `listed`: the plans the sentence right above these lines lists (F2's plans that run again). The
 * first line only, and only if its plans run under the owner's name and are exactly those, points
 * back to that list instead of repeating it: below another sentence, "these plans" would read as
 * that sentence's. Every other line keeps its own list.
 */
export function memberChangeLines(changes: readonly TakeoverMemberChange[], listed: ReadonlySet<string> = new Set()): TakeoverLine[] {
	const groups = new Map<string, { before: string; after: string | null; titles: string[]; ids: Set<string> }>();
	for (const c of changes) {
		if (c.runsNoMore || c.before === null || c.before === c.after) continue;
		const key = `${c.before}\u0000${c.after ?? ''}`;
		const g = groups.get(key) ?? { before: c.before, after: c.after, titles: [], ids: new Set<string>() };
		g.titles.push(c.title);
		g.ids.add(c.id);
		groups.set(key, g);
	}
	const sameAsListed = (ids: ReadonlySet<string>): boolean => ids.size === listed.size && [...ids].every((id) => listed.has(id));
	return [...groups.values()].map((g, i) => {
		const one = g.titles.length === 1;
		const before = shownValue(nameOfTag(g.before));
		const plan = shownValue(g.titles[0]!);
		const text = g.after === null
			? (one ? tf('takeover.change.owner_one', { plan, before })
				: i === 0 && sameAsListed(g.ids) ? tf('takeover.change.owner_many_listed', { before })
					: tf('takeover.change.owner_many', { plans: planList(g.titles), before }))
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
	// A person's roles on the workflow over all of their accesses; none for the person F2 names,
	// also under their other access. A person is who the owner reads, uncut: two names that differ
	// only in whitespace read alike, so they are one person here too, and a hidden character is
	// printed, so a name that carries one is a person of its own.
	const person = (name: string): string => visible(name.replace(/\s+/g, ' ').trim());
	const workflowRoles = new Map<string, Set<WorkflowRole>>();
	for (const m of p.members) {
		const roles = workflowRoles.get(person(m.name)) ?? new Set<WorkflowRole>();
		if (f2 === null || person(f2.by.name) !== person(m.name)) {
			for (const role of m.roles) if (role === 'workflow-created' || role === 'workflow-edited') roles.add(role);
		}
		workflowRoles.set(person(m.name), roles);
	}
	for (const m of p.members) {
		for (const line of roleLines(m, p.workflow?.name ?? null, workflowRoles.get(person(m.name)) ?? new Set())) {
			if (said.has(line.text)) continue;
			said.add(line.text);
			lines.push(line);
		}
	}
	if (f2 !== null) lines.push(f2.line);
	// F2's last sentence lists the plans that run again; the T-2 line right below it may point back to that list.
	lines.push(...memberChangeLines(p.memberChanges, f2 === null ? new Set() : new Set(p.alsoReleased.map((r) => r.id))));
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

/**
 * A plan's title as the trigger list carries it. `title_workflow`: the workflow's name, where the
 * engine titled the plan with that name (scheduled without a title); the list sets it only then.
 */
export interface PlanTitle {
	title: string;
	title_workflow?: string | undefined;
}

/** A plan's title for a list line: lynox's words in the reader's language before a workflow's name. */
export function planTitle(plan: PlanTitle): string {
	const name = plan.title_workflow;
	return name !== undefined ? tf('triggers.scheduled_title', { workflow: name }) : plan.title;
}

/** Who set a plan up and changed it, as the trigger list carries it (tags: `owner`, `mandate:<address>`). */
export interface PlanAuthorship {
	created_by?: string | undefined;
	edited_by?: string | undefined;
	mandate_editor?: string | undefined;
}

/**
 * Whether a person with access set the plan up or changed it, now or before the owner's last
 * change (`mandate_editor`): its title may then be that person's words, and the owner's plan list
 * sets it apart ({@link pausedTitleLine}) on the plan's card, not only where a takeover is offered.
 */
export function writtenByMember(plan: PlanAuthorship): boolean {
	return [plan.created_by, plan.edited_by, plan.mandate_editor].some((tag) => (tag ?? '').startsWith('mandate:'));
}

/**
 * The title of a plan with a takeover to give, as a line with the value set apart. The title is
 * someone else's value on every such plan: even one the owner set up runs a workflow a person with
 * access made or changed. Where the engine titled the plan with its workflow's name, lynox's words
 * stand outside and the name is the value; any other title is the value whole, a title that starts
 * with "Scheduled: " included, so a person with access cannot borrow lynox's words. Whether the
 * title is the name is the list's to say (`title_workflow`), never read from the title's text.
 * Sentences that name plans (`planList`, the dialog's lines) keep every title whole in its box.
 */
export function pausedTitleLine(plan: PlanTitle): string {
	const name = plan.title_workflow;
	if (name !== undefined) return tf('triggers.scheduled_title', { workflow: shownValue(name) });
	return shownValue(plan.title);
}
