import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { takeoverLines, refusalText, endedNotices, planList, nameOfTag, type TakeoverPreview, type TakeoverMember } from './plan-takeover.js';
import { setLocale, getLocale } from '../i18n.svelte.js';

const before = getLocale();
beforeEach(() => setLocale('de'));
afterEach(() => setLocale(before));

// Total, so a date where none belongs shows in the text (`[null]`) instead of throwing.
const fmt = (iso: string | null): string => `[${String(iso).slice(0, 10)}]`;

function preview(over: Partial<TakeoverPreview> = {}): TakeoverPreview {
	return {
		expect: 'digest',
		members: [{ name: 'ida@x.ch', roles: ['created'], ended: true, reason: 'expired' }],
		runsAs: 'owner',
		workflow: null,
		memberChanges: [],
		alsoReleased: [],
		connections: [],
		schedule: 'kept',
		dueAt: null,
		...over,
	};
}

const texts = (p: TakeoverPreview): string[] => takeoverLines(p, fmt).map((l) => l.text);
const kinds = (p: TakeoverPreview): string[] => takeoverLines(p, fmt).map((l) => l.kind);
const wfMember = (roles: TakeoverMember['roles'], name = 'ida@x.ch'): TakeoverMember => ({ name, roles, ended: true, reason: 'expired' });

describe('the role lines (T-1, Fassung 4)', () => {
	it('says every role that applies, in DE and EN', () => {
		const p = preview({
			members: [wfMember(['created', 'edited', 'workflow-created', 'workflow-edited'])],
			workflow: { id: 'w', name: 'Rechnungen', takenOver: false },
		});
		expect(texts(p).slice(0, 4)).toEqual([
			'Angelegt von ida@x.ch',
			'Bearbeitet von ida@x.ch',
			'Nutzt den Workflow „Rechnungen“, den ida@x.ch angelegt hat',
			'Nutzt den Workflow „Rechnungen“, den ida@x.ch geändert hat',
		]);
		setLocale('en');
		expect(texts(p).slice(0, 4)).toEqual([
			'Created by ida@x.ch',
			'Edited by ida@x.ch',
			'Uses the workflow “Rechnungen”, which ida@x.ch created',
			'Uses the workflow “Rechnungen”, which ida@x.ch changed',
		]);
	});
});

describe('F2: the workflow is taken over with the plan', () => {
	const wf = { id: 'w', name: 'Rechnungen', takenOver: true };
	it('names the change before the creation, and the plans released', () => {
		const p = preview({ members: [wfMember(['workflow-created', 'workflow-edited'])], workflow: wf, alsoReleased: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] });
		expect(takeoverLines(p, fmt).find((l) => l.kind === 'f2')?.text).toBe(
			'Dieser Plan nutzt den Workflow „Rechnungen“, den ida@x.ch geändert hat. Übernimmst du den Plan, übernimmst du auch den Workflow. Dann laufen auch diese Pläne wieder: A, B.',
		);
	});
	it('with two members, it names the one who changed the workflow, not the one who created it', () => {
		const p = preview({ members: [wfMember(['workflow-created'], 'a@x.ch'), wfMember(['workflow-edited'], 'b@x.ch')], workflow: wf });
		expect(takeoverLines(p, fmt).find((l) => l.kind === 'f2')?.text).toBe(
			'Dieser Plan nutzt den Workflow „Rechnungen“, den b@x.ch geändert hat. Übernimmst du den Plan, übernimmst du auch den Workflow.',
		);
	});
	it('without plans released, the last sentence goes', () => {
		const p = preview({ members: [wfMember(['workflow-created'])], workflow: wf });
		expect(takeoverLines(p, fmt).find((l) => l.kind === 'f2')?.text).toBe(
			'Dieser Plan nutzt den Workflow „Rechnungen“, den ida@x.ch angelegt hat. Übernimmst du den Plan, übernimmst du auch den Workflow.',
		);
	});
	it('takes the place of the role line it says, for that member only (ux)', () => {
		const one = preview({ members: [wfMember(['created', 'workflow-created', 'workflow-edited'])], workflow: wf });
		expect(texts(one).slice(0, 2)).toEqual(['Angelegt von ida@x.ch', 'Nutzt den Workflow „Rechnungen“, den ida@x.ch angelegt hat']);
		expect(kinds(one).slice(0, 3)).toEqual(['role', 'role', 'f2']);
		const two = preview({ members: [wfMember(['workflow-created'], 'a@x.ch'), wfMember(['workflow-edited'], 'b@x.ch')], workflow: wf });
		expect(texts(two)[0]).toBe('Nutzt den Workflow „Rechnungen“, den a@x.ch angelegt hat');
		expect(kinds(two).slice(0, 2)).toEqual(['role', 'f2']);
		// Another member with the same role keeps its line: F2 names one member.
		const same = preview({ members: [wfMember(['workflow-edited'], 'a@x.ch'), wfMember(['workflow-edited'], 'b@x.ch')], workflow: wf });
		expect(texts(same)[0]).toBe('Nutzt den Workflow „Rechnungen“, den b@x.ch geändert hat');
		expect(kinds(same).slice(0, 2)).toEqual(['role', 'f2']);
		// Not taken over: no F2, every role line stays.
		expect(kinds(preview({ members: [wfMember(['workflow-created'])], workflow: { ...wf, takenOver: false } })).slice(0, 1)).toEqual(['role']);
	});
	it('is not said when the workflow is not taken over, or no member is one of the workflow', () => {
		expect(kinds(preview({ members: [wfMember(['workflow-created'])], workflow: { ...wf, takenOver: false } }))).not.toContain('f2');
		expect(kinds(preview({ members: [wfMember(['created'])], workflow: wf }))).not.toContain('f2');
	});
});

describe('T-2: plans that then run for someone else', () => {
	const change = (id: string, beforeTag: string | null, after: string | null, runsNoMore = false) => ({ id, title: `P${id}`, before: beforeTag, after, runsNoMore });
	it('groups by before and after: to the owner, to another member, one plan alone', () => {
		const p = preview({
			memberChanges: [
				change('1', 'mandate:ida@x.ch', null),
				change('2', 'mandate:ida@x.ch', null),
				change('3', 'mandate:ida@x.ch', 'mandate:bo@x.ch'),
			],
		});
		expect(takeoverLines(p, fmt).filter((l) => l.kind === 'member_change').map((l) => l.text)).toEqual([
			'Diese Pläne laufen danach unter deinem Namen statt unter dem von ida@x.ch: P1, P2.',
			'Der Plan „P3“ läuft danach unter dem Namen von bo@x.ch statt unter dem von ida@x.ch.',
		]);
		setLocale('en');
		expect(takeoverLines(p, fmt).filter((l) => l.kind === 'member_change').map((l) => l.text)).toEqual([
			"These plans then run under your name instead of ida@x.ch's: P1, P2.",
			'The plan “P3” then runs under bo@x.ch\'s name instead of ida@x.ch\'s.',
		]);
	});
	it('the other forms: one plan to the owner, several to another member', () => {
		const p = preview({ memberChanges: [change('1', 'mandate:ida@x.ch', null), change('2', 'mandate:ida@x.ch', 'mandate:bo@x.ch'), change('3', 'mandate:ida@x.ch', 'mandate:bo@x.ch')] });
		expect(takeoverLines(p, fmt).filter((l) => l.kind === 'member_change').map((l) => l.text)).toEqual([
			'Der Plan „P1“ läuft danach unter deinem Namen statt unter dem von ida@x.ch.',
			'Diese Pläne laufen danach unter dem Namen von bo@x.ch statt unter dem von ida@x.ch: P2, P3.',
		]);
	});
	it('names five plans and counts the rest, without a plan that runs no more (N7)', () => {
		const p = preview({ memberChanges: ['1', '2', '3', '4', '5', '6', '7'].map((i) => change(i, 'mandate:ida@x.ch', null, i === '7')) });
		expect(takeoverLines(p, fmt).filter((l) => l.kind === 'member_change').map((l) => l.text)).toEqual([
			'Diese Pläne laufen danach unter deinem Namen statt unter dem von ida@x.ch: P1, P2, P3, P4, P5 und 1 weitere.',
		]);
	});
	it('says nothing where whom the plan runs for does not change (N3), or it runs for the owner already', () => {
		const p = preview({ memberChanges: [change('1', 'mandate:ida@x.ch', 'mandate:ida@x.ch'), change('2', null, null), change('3', 'mandate:ida@x.ch', null, true)] });
		expect(kinds(p)).not.toContain('member_change');
	});
});

describe('T-3: a helper\'s own connection', () => {
	it('names the service, the account and whose it is, verbatim in DE and EN', () => {
		const p = preview({ connections: [{ id: 'c', profile: 'apf_1', provider: 'Shopify', account: 'laden.myshopify.com', by: 'ida@x.ch' }] });
		const de = takeoverLines(p, fmt).find((l) => l.kind === 'connection')?.text;
		expect(de).toBe('ida@x.ch hat Shopify mit einem eigenen Konto verbunden (laden.myshopify.com). Nach dem Übernehmen nutzt der Plan diese Verbindung nicht mehr. Braucht er sie, verbinde das Programm selbst mit deinem Konto: in den Einstellungen unter „APIs“ über „Neue API“. Sonst kann der Plan diesen Schritt nicht ausführen.');
		setLocale('en');
		expect(takeoverLines(p, fmt).find((l) => l.kind === 'connection')?.text).toBe('ida@x.ch connected Shopify with an account of their own (laden.myshopify.com). After you take over, the plan no longer uses this connection. If it needs it, connect the service yourself with your own account: in Settings under “APIs”, via “New API”. Otherwise the plan cannot run this step.');
	});
	it('without an account says the service alone, and without an owner someone with access', () => {
		const p = preview({ connections: [{ id: 'c', profile: 'apf_1', provider: 'bexio', account: null, by: null }] });
		expect(takeoverLines(p, fmt).find((l) => l.kind === 'connection')?.text.startsWith('Jemand mit Zugang hat bexio mit einem eigenen Konto verbunden. Nach')).toBe(true);
		const empty = preview({ connections: [{ id: 'c', profile: 'apf_1', provider: 'bexio', account: '', by: 'ida@x.ch' }] });
		expect(takeoverLines(empty, fmt).find((l) => l.kind === 'connection')?.text.startsWith('ida@x.ch hat bexio mit einem eigenen Konto verbunden. Nach')).toBe(true);
	});
	it('leaves the account out when it is the helper\'s own address, already named (ux)', () => {
		const p = preview({ connections: [{ id: 'c', profile: 'apf_1', provider: 'Google Sheets', account: 'ida@x.ch', by: 'ida@x.ch' }] });
		expect(takeoverLines(p, fmt).find((l) => l.kind === 'connection')?.text.startsWith('ida@x.ch hat Google Sheets mit einem eigenen Konto verbunden. Nach')).toBe(true);
		const cased = preview({ connections: [{ id: 'c', profile: 'apf_1', provider: 'Google Sheets', account: 'Ida@X.ch', by: 'ida@x.ch' }] });
		expect(takeoverLines(cased, fmt).find((l) => l.kind === 'connection')?.text.startsWith('ida@x.ch hat Google Sheets mit einem eigenen Konto verbunden. Nach')).toBe(true);
		setLocale('en');
		const unknown = preview({ connections: [{ id: 'c', profile: 'apf_1', provider: 'Google Sheets', account: 'ida@x.ch', by: null }] });
		expect(takeoverLines(unknown, fmt).find((l) => l.kind === 'connection')?.text.startsWith('Someone with access connected Google Sheets with an account of their own (ida@x.ch). After')).toBe(true);
	});
});

describe('T-4 or T-5: whom the plan runs for afterwards', () => {
	it('T-4 for the owner, and not T-5', () => {
		const k = kinds(preview());
		expect([k.includes('runs_as_owner'), k.includes('runs_as_member')]).toEqual([true, false]);
		expect(takeoverLines(preview(), fmt).find((l) => l.kind === 'runs_as_owner')?.text).toBe('Der Plan läuft danach unter deinem Namen.');
		setLocale('en');
		expect(takeoverLines(preview(), fmt).find((l) => l.kind === 'runs_as_owner')?.text).toBe('The plan then runs under your name.');
	});
	it('T-5 for the workflow\'s member that stays, created or changed, and not T-4', () => {
		const stays = (roles: TakeoverMember['roles']) => preview({
			members: [wfMember(['created']), { name: 'bo@x.ch', roles, ended: false, reason: null }],
			runsAs: 'mandate:bo@x.ch',
			workflow: { id: 'w', name: 'Rechnungen', takenOver: false },
		});
		const k = kinds(stays(['workflow-created']));
		expect([k.includes('runs_as_owner'), k.includes('runs_as_member')]).toEqual([false, true]);
		expect(takeoverLines(stays(['workflow-created']), fmt).find((l) => l.kind === 'runs_as_member')?.text).toBe(
			'Den Workflow „Rechnungen“ hat bo@x.ch angelegt, und bo@x.ch hat weiter Zugang. Darum läuft der Plan danach unter dem Namen von bo@x.ch, nicht unter deinem. Endet dieser Zugang, pausiert der Plan wieder, und du kannst ihn dann noch einmal übernehmen.',
		);
		setLocale('en');
		expect(takeoverLines(stays(['workflow-created', 'workflow-edited']), fmt).find((l) => l.kind === 'runs_as_member')?.text).toBe(
			'bo@x.ch changed the workflow “Rechnungen” and still has access. So after you take over, the plan runs under bo@x.ch\'s name, not yours. If that access ends, the plan pauses again, and you can take it over once more.',
		);
	});
});

describe('T-6: a one-shot that runs only on "Run now"', () => {
	it('(a) the date was missed', () => {
		const lines = takeoverLines(preview({ schedule: 'run_now_only_missed', dueAt: '2026-11-02T08:00:00.000Z' }), fmt);
		expect(lines.filter((l) => l.kind === 'missed' || l.kind === 'partial').map((l) => l.text)).toEqual([
			'Der Termin am [2026-11-02] ist während der Pause verstrichen. Nach dem Übernehmen läuft der Plan erst, wenn du auf „Jetzt ausführen“ tippst.',
		]);
	});
	it('(b) a run had started, in DE and EN', () => {
		const p = preview({ schedule: 'run_now_only_partial', dueAt: '2026-11-02T08:00:00.000Z' });
		expect(takeoverLines(p, fmt).filter((l) => l.kind === 'missed' || l.kind === 'partial').map((l) => l.text)).toEqual([
			'Der Termin am [2026-11-02] ist während der Pause verstrichen. Nach dem Übernehmen läuft der Plan erst, wenn du auf „Jetzt ausführen“ tippst.',
			'Ein Lauf hatte schon begonnen, als der Zugang endete. „Jetzt ausführen“ startet ihn von vorn; prüf vorher, was davon schon erledigt ist.',
		]);
		setLocale('en');
		expect(takeoverLines(p, fmt).filter((l) => l.kind === 'missed' || l.kind === 'partial').map((l) => l.text)).toEqual([
			'The run due on [2026-11-02] was missed during the pause. After you take over, the plan runs only once you tap “Run now”.',
			'A run had already started when the access ended. “Run now” starts it from the beginning; check first what it already did.',
		]);
	});
	it('(a) without a date says only what the owner does, never an empty date', () => {
		const lines = takeoverLines(preview({ schedule: 'run_now_only_missed', dueAt: null }), fmt).filter((l) => l.kind === 'missed');
		expect(lines.map((l) => l.text)).toEqual(['Nach dem Übernehmen läuft der Plan erst, wenn du auf „Jetzt ausführen“ tippst.']);
		setLocale('en');
		expect(takeoverLines(preview({ schedule: 'run_now_only_partial', dueAt: null }), fmt)[2]?.text).toBe('After you take over, the plan runs only once you tap “Run now”.');
	});
	it('a kept schedule and the next cron run say nothing', () => {
		for (const schedule of ['kept', 'next_cron'] as const) {
			const k = kinds(preview({ schedule, dueAt: '2026-11-02T08:00:00.000Z' }));
			expect(k.some((x) => x === 'missed' || x === 'partial')).toBe(false);
		}
	});
});

describe('the order of the confirmation', () => {
	it('is T-1, F2, T-2, T-3, T-4|T-5, T-6', () => {
		const p = preview({
			members: [wfMember(['created', 'workflow-created'])],
			workflow: { id: 'w', name: 'W', takenOver: true },
			memberChanges: [{ id: '1', title: 'P1', before: 'mandate:ida@x.ch', after: null, runsNoMore: false }],
			connections: [{ id: 'c', profile: 'apf_1', provider: 'S', account: 'a', by: 'ida@x.ch' }],
			schedule: 'run_now_only_partial',
			dueAt: '2026-11-02T08:00:00.000Z',
		});
		// The member's workflow role is said by F2, so its own line goes (ux).
		expect(kinds(p)).toEqual(['role', 'f2', 'member_change', 'connection', 'runs_as_owner', 'missed', 'partial']);
	});
});

describe('helpers', () => {
	it('a mandate tag reads as its address', () => {
		expect([nameOfTag('mandate:ida@x.ch'), nameOfTag('owner')]).toEqual(['ida@x.ch', 'owner']);
	});
	it('five plans are named in full, six are cut', () => {
		expect(planList(['1', '2', '3', '4', '5'])).toBe('1, 2, 3, 4, 5');
		setLocale('en');
		expect(planList(['1', '2', '3', '4', '5', '6', '7'])).toBe('1, 2, 3, 4, 5 and 2 more');
	});
});

describe('the refusals at the button', () => {
	const opts = { workflow: null, managed: false, fallback: 'engine text' };
	it('each code has its sentence; the plan stays paused where it is paused', () => {
		expect(refusalText('changed', opts)).toBe('Der Plan hat sich geändert, während du ihn angesehen hast. Unten steht der neue Stand. Prüf ihn und übernimm ihn dann.');
		expect(refusalText('running', opts)).toBe('Ein Lauf dieses Plans oder eines anderen Plans auf demselben Workflow ist noch nicht zu Ende. Versuch es in ein paar Minuten noch einmal. Der Plan bleibt pausiert.');
		expect(refusalText('nothing_to_take_over', opts)).toBe('Dieser Plan muss nicht mehr übernommen werden. Die Liste ist aktualisiert.');
		expect(refusalText('bulk', opts)).toBe('Einen Massenlauf musst du nicht übernehmen: Ihn hat kein Helfer eingerichtet.');
	});
	it('unreadable names the workflow when the preview had one', () => {
		expect(refusalText('unreadable', { ...opts, workflow: 'Rechnungen' })).toBe('lynox kann nicht lesen, wer den Workflow „Rechnungen“ eingerichtet hat, und kann den Plan darum nicht übernehmen. Du kannst ihn abschliessen oder löschen. Der Plan bleibt pausiert.');
		expect(refusalText('unreadable', opts)).toBe('lynox kann nicht lesen, wer den Workflow dieses Plans eingerichtet hat, und kann den Plan darum nicht übernehmen. Du kannst ihn abschliessen oder löschen. Der Plan bleibt pausiert.');
	});
	it('a lasting failure points to support only on a managed instance', () => {
		const self = refusalText('unrecorded', opts);
		expect(self).toBe('Die Übernahme lässt sich gerade nicht im Instanz-Protokoll festhalten. Darum hat lynox den Plan nicht übernommen; er bleibt pausiert. Versuch es in ein paar Minuten noch einmal.');
		expect(refusalText('unrecorded', { ...opts, managed: true })).toBe(`${self} Bleibt es so, schreib an support@lynox.ai.`);
		expect(refusalText('prompts', opts)).not.toContain('support@');
		expect(refusalText('prompts', { ...opts, managed: true }).endsWith('Bleibt es so, schreib an support@lynox.ai.')).toBe(true);
	});
	it('a code the view does not know keeps the engine\'s text', () => {
		expect(refusalText('not_available', opts)).toBe('engine text');
		expect(refusalText('something_new', opts)).toBe('engine text');
	});
});

describe('the notices above the plans, with the full address', () => {
	const end = (email: string, reason: 'expired' | 'revoked', warned = false) => ({ email, reason, ends_at: '2026-10-31T00:00:00.000Z', warned });
	it('one per ended access, counted over the paused plans', () => {
		const plans = [{ title: 'A', paused_ended: [end('ida@treuhand-mueller-partner.ch', 'expired')] }, { title: 'B', paused_ended: [end('ida@treuhand-mueller-partner.ch', 'expired'), end('bo@x.ch', 'revoked')] }, { title: 'C' }];
		expect(endedNotices(plans, fmt)).toEqual([
			'Für ida@treuhand-mueller-partner.ch war ein Zugang bis zum [2026-10-31] eingetragen. Seitdem sind 2 Pläne pausiert, an denen ida@treuhand-mueller-partner.ch etwas angelegt oder geändert hat. Übernimm jeden Plan, der weiterlaufen soll. Das gilt auch, wenn der Zugang inzwischen verlängert wurde: Die Pläne laufen erst wieder, wenn du sie übernimmst. Eine Vorwarnung gab es nicht.',
			'Der Zugang von bo@x.ch wurde widerrufen. Am Plan „B“ hat bo@x.ch etwas angelegt oder geändert, er ist darum pausiert. Übernimm ihn, wenn er weiterlaufen soll.',
		]);
	});
	it('an expiry says there was no advance notice only when none came; a revocation never', () => {
		setLocale('en');
		const [unwarned, warned, revoked] = [end('a@x.ch', 'expired'), end('b@x.ch', 'expired', true), end('c@x.ch', 'revoked')].map((e) => endedNotices([{ title: 'Wochenreport', paused_ended: [e] }], fmt)[0]!);
		expect(unwarned.endsWith(' There was no advance notice.')).toBe(true);
		expect(warned).toBe('b@x.ch had access until [2026-10-31]. Since then, the plan “Wochenreport” in which b@x.ch created or changed something is paused. Take it over if it should keep running. This also applies if the access has since been extended: the plan only runs again once you take it over.');
		expect(revoked).not.toContain('advance notice');
	});
});
