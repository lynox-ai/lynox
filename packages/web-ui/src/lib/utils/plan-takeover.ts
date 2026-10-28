import { t, tf } from '../i18n.svelte.js';

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
	workflow: { id: string; name: string; takenOver: boolean } | null;
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
	if (titles.length <= 5) return titles.join(', ');
	return tf('takeover.plans_more', { plans: titles.slice(0, 5).join(', '), n: String(titles.length - 5) });
}

/** The role lines of one member (Fassung 4): every role that applies. */
function roleLines(m: TakeoverMember, workflow: string | null): TakeoverLine[] {
	return m.roles.map((role) => ({
		kind: 'role' as const,
		text: role === 'created' || role === 'edited'
			? tf(`takeover.role.${role}`, { name: m.name })
			: tf(`takeover.role.${role}`, { name: m.name, workflow: workflow ?? '' }),
	}));
}

/**
 * F2: the workflow is taken over with the plan. Named after the member it is taken over from: the
 * one with a workflow role, its change before its creation. Without plans released, the last
 * sentence goes.
 */
function f2Line(p: TakeoverPreview): TakeoverLine | null {
	if (p.workflow === null || !p.workflow.takenOver) return null;
	const by = p.members.find((m) => m.roles.includes('workflow-edited')) ?? p.members.find((m) => m.roles.includes('workflow-created'));
	if (by === undefined) return null;
	const changed = by.roles.includes('workflow-edited');
	const vars = { workflow: p.workflow.name, name: by.name };
	const head = tf(changed ? 'takeover.f2.changed' : 'takeover.f2.created', vars);
	if (p.alsoReleased.length === 0) return { kind: 'f2', text: head };
	return { kind: 'f2', text: `${head} ${tf('takeover.f2.released', { plans: planList(p.alsoReleased.map((r) => r.title)) })}` };
}

/**
 * T-2: other plans on the workflow that then run for someone else, grouped by (before, after).
 * Only a change of whom a plan runs for is said (N3); a plan that will not run again by itself is
 * left out of what is shown (N7) — the digest still holds it.
 */
function memberChangeLines(p: TakeoverPreview): TakeoverLine[] {
	const groups = new Map<string, { before: string; after: string | null; titles: string[] }>();
	for (const c of p.memberChanges) {
		if (c.runsNoMore || c.before === null || c.before === c.after) continue;
		const key = `${c.before}\u0000${c.after ?? ''}`;
		const g = groups.get(key) ?? { before: c.before, after: c.after, titles: [] };
		g.titles.push(c.title);
		groups.set(key, g);
	}
	return [...groups.values()].map((g) => {
		const one = g.titles.length === 1;
		const before = nameOfTag(g.before);
		const text = g.after === null
			? (one ? tf('takeover.change.owner_one', { plan: g.titles[0]!, before }) : tf('takeover.change.owner_many', { plans: planList(g.titles), before }))
			: (one ? tf('takeover.change.member_one', { plan: g.titles[0]!, before, after: nameOfTag(g.after) }) : tf('takeover.change.member_many', { plans: planList(g.titles), before, after: nameOfTag(g.after) }));
		return { kind: 'member_change' as const, text };
	});
}

/** T-3: a connection a helper made with their own account no longer counts once the owner takes over. */
function connectionLines(p: TakeoverPreview): TakeoverLine[] {
	return p.connections.map((c) => ({
		kind: 'connection' as const,
		text: tf('takeover.connection', {
			connection: c.account !== null && c.account !== '' ? `${c.provider}: ${c.account}` : c.provider,
			name: c.by ?? t('takeover.connection_someone'),
		}),
	}));
}

/** T-4 or T-5: who the plan runs for afterwards. Exactly one of the two. */
function runsAsLine(p: TakeoverPreview): TakeoverLine {
	if (p.runsAs === 'owner') return { kind: 'runs_as_owner', text: t('takeover.runs_as_owner') };
	const name = nameOfTag(p.runsAs);
	const member = p.members.find((m) => m.name === name);
	const changed = member?.roles.includes('workflow-edited') === true;
	return {
		kind: 'runs_as_member',
		text: tf(changed ? 'takeover.runs_as_member.changed' : 'takeover.runs_as_member.created', { name, workflow: p.workflow?.name ?? '' }),
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
	for (const m of p.members) lines.push(...roleLines(m, p.workflow?.name ?? null));
	const f2 = f2Line(p);
	if (f2 !== null) lines.push(f2);
	lines.push(...memberChangeLines(p));
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
		const text = tf(`takeover.notice.${ended.reason}_${form}`, { name: ended.email, date: formatDate(ended.ends_at), count: String(titles.length), plan: titles[0] ?? '' });
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
			return opts.workflow !== null && opts.workflow !== '' ? tf('takeover.refused.unreadable_named', { workflow: opts.workflow }) : t('takeover.refused.unreadable');
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
