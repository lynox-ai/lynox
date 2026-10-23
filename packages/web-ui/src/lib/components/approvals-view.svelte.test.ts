import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// `svelte` resolves to its server entry under node, where `mount` throws. The component is compiled
// for the client, so it is mounted with the client entry, loaded by path.
const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

/** Every step of a decision and of opening the chat, in the order the page took them. */
const steps: string[] = [];
vi.mock('$app/navigation', () => ({ goto: vi.fn(async (path: string) => { steps.push(`goto ${path}`); }) }));
vi.mock('../stores/chat.svelte.js', () => ({
	newChat: vi.fn(() => { steps.push('newChat'); }),
	resumeThread: vi.fn(async (id: string) => { steps.push(`resume ${id}`); }),
	sendMessage: vi.fn(async (_task: string, _d?: unknown, _f?: unknown, o?: { context?: { kind: string; id: string } }) => {
		steps.push(`send ${o?.context?.kind ?? '-'}:${o?.context?.id ?? '-'}`);
	}),
}));

// The page the owner sends or discards a waiting mail from. What it must hold: one click sends,
// a second only for a mass send or a reply to someone the original did not name; the approval
// carries the checksum of the mail it showed; a stale list is read again; hidden characters are
// shown; a mandate's session and a decided entry offer no action.

type Card = Record<string, unknown>;

const card = (over: Card = {}): Card => ({
	id: 'e-1', kind: 'mail_send', status: 'pending',
	createdAt: '2026-10-21T08:00:00.000Z', expiresAt: '2026-10-24T08:00:00.000Z', decidedAt: null, executedAt: null,
	ageMs: 60_000, checksum: 'SHOWN-CHECKSUM', executable: true, tombstoned: false, held: null,
	mail: {
		accountId: 'acc-1', from: 'owner@example.com', to: [{ address: 'bob@example.com' }], cc: [], bcc: [],
		subject: 'Wochenbericht', bodyText: 'Hier der Bericht.',
	},
	massSend: false, recipientDiffers: false, replyToElsewhere: null, afterUntrusted: false,
	origin: { source: 'workflow', triggerId: 'trg-1', runId: 'run-1' }, outcome: null, setup: [],
	...over,
});

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
/** What the next list read answers, per view. */
let lists: Record<string, { entries: Card[]; pending: number }>;
/** Every list read, by view. */
let listReads: string[];
/** Every decide POST: the id and the parsed body. */
let decides: Array<{ id: string; body: Record<string, unknown> }>;
/** What the next decide answers. */
let decideAnswer: { status: number; body: unknown };

beforeEach(() => {
	lists = { open: { entries: [card()], pending: 1 }, all: { entries: [card()], pending: 1 } };
	listReads = [];
	decides = [];
	steps.length = 0;
	decideAnswer = { status: 200, body: { id: 'e-1', status: 'approved' } };
	vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
		const u = String(url);
		const decide = /\/approvals\/([^/]+)\/decide$/.exec(u);
		if (decide) {
			decides.push({ id: decodeURIComponent(decide[1]!), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
			steps.push(`decide ${String((JSON.parse(String(init?.body)) as { action?: unknown }).action)}`);
			return new Response(JSON.stringify(decideAnswer.body), { status: decideAnswer.status, headers: { 'Content-Type': 'application/json' } });
		}
		const list = /\/approvals\?view=(open|all)$/.exec(u);
		if (list) {
			listReads.push(list[1]!);
			return new Response(JSON.stringify(lists[list[1]!]), { status: 200, headers: { 'Content-Type': 'application/json' } });
		}
		if (u.endsWith('/approvals/count')) return new Response(JSON.stringify({ pending: 0, viewer: 'owner' }), { status: 200 });
		return new Response('{}', { status: 404 });
	}));
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

async function render(): Promise<void> {
	const { default: ApprovalsView } = await import('./ApprovalsView.svelte');
	component = mount(ApprovalsView, { target });
	await settle();
}

const q = (sel: string): HTMLElement | null => target.querySelector<HTMLElement>(sel);
async function click(sel: string): Promise<void> {
	const el = q(sel);
	expect(el, `${sel} is not on the page`).not.toBeNull();
	el!.click();
	await settle();
}

describe('sending takes one click, and a second only where the card says why', () => {
	it('a plain mail goes with one click', async () => {
		await render();
		await click('[data-action="send"]');
		expect(decides).toHaveLength(1);
		expect(q('[data-confirm]')).toBeNull();
	});

	it('a mass send asks once more before it goes', async () => {
		lists.open = { entries: [card({ massSend: true })], pending: 1 };
		await render();
		await click('[data-action="send"]');
		expect(decides).toHaveLength(0);
		expect(q('[data-confirm]')).not.toBeNull();
		await click('[data-action="confirm-send"]');
		expect(decides).toHaveLength(1);
	});

	it('cancelling the second step sends nothing, and the next Senden asks again', async () => {
		lists.open = { entries: [card({ massSend: true })], pending: 1 };
		await render();
		await click('[data-action="send"]');
		await click('[data-action="cancel"]');
		expect(q('[data-confirm]')).toBeNull();
		expect(decides).toHaveLength(0);
		await click('[data-action="send"]');
		expect(decides).toHaveLength(0);
		expect(q('[data-confirm]')).not.toBeNull();
	});

	it('a reply to someone the original did not name asks once more before it goes', async () => {
		lists.open = { entries: [card({ kind: 'mail_reply', recipientDiffers: true })], pending: 1 };
		await render();
		await click('[data-action="send"]');
		expect(decides).toHaveLength(0);
		expect(q('[data-confirm]')).not.toBeNull();
		await click('[data-action="confirm-send"]');
		expect(decides).toHaveLength(1);
	});

	it('the approval carries the checksum of the mail the card showed', async () => {
		await render();
		await click('[data-action="send"]');
		expect(decides[0]).toEqual({ id: 'e-1', body: { action: 'approve', checksum: 'SHOWN-CHECKSUM' } });
	});

	it('discarding is one click and carries no checksum', async () => {
		await render();
		await click('[data-action="discard"]');
		expect(decides[0]).toEqual({ id: 'e-1', body: { action: 'reject' } });
	});
});

describe('a refused decision', () => {
	it('reads the list again when the mail is not the one that was shown, and says so', async () => {
		await render();
		expect(listReads).toEqual(['open']);
		decideAnswer = { status: 409, body: { error: 'This mail is not the one you were shown; reload it and decide again.', code: 'checksum' } };
		await click('[data-action="send"]');
		expect(listReads).toEqual(['open', 'open']);
		expect(q('[data-notice="error"]')?.textContent).toBe('Diese Mail hat sich geändert, seit du sie gesehen hast. Die Liste ist neu geladen: prüfe sie und entscheide erneut.');
	});

	it('reads the list again for every code that means it is stale, and only for those', async () => {
		await render();
		const reloads: Record<string, boolean> = {};
		for (const code of ['checksum', 'not_pending', 'expired', 'mandate_ended', 'not_found', 'not_executable', 'something_new']) {
			const before = listReads.length;
			decideAnswer = { status: 409, body: { code } };
			await click('[data-action="send"]');
			reloads[code] = listReads.length > before;
		}
		expect(reloads).toEqual({
			checksum: true, not_pending: true, expired: true, mandate_ended: true, not_found: true, not_executable: false, something_new: false,
		});
	});

	it('shows the page\'s own sentence for the code, never the server\'s text', async () => {
		await render();
		decideAnswer = { status: 409, body: { error: 'Provider said: mailbox mallory@example.com full', code: 'not_executable' } };
		await click('[data-action="send"]');
		expect(q('[data-notice="error"]')?.textContent).toBe('Diese Version von lynox kann diese Mail nicht senden.');
		expect(target.textContent).not.toContain('mallory');
		decideAnswer = { status: 500, body: { error: 'mallory@example.com', code: 'something_new' } };
		await click('[data-action="send"]');
		expect(q('[data-notice="error"]')?.textContent).toBe('Das hat nicht geklappt. Bitte erneut versuchen.');
		expect(target.textContent).not.toContain('mallory');
	});
});

describe('what the card shows', () => {
	it('a hidden character in the body and the subject shows as its code point', async () => {
		lists.open = { entries: [card({ mail: { ...(card().mail as Card), subject: 'Rech​nung', bodyText: 'Bitte ‮zahlen​.' } })], pending: 1 };
		await render();
		expect(q('[data-body]')?.textContent).toBe('Bitte ⟨U+202E⟩zahlen⟨U+200B⟩.');
		expect(q('h2')?.textContent?.trim()).toBe('Rech⟨U+200B⟩nung');
	});

	it('names the Reply-To the reply goes to and the sender, as plain information', async () => {
		lists.open = { entries: [card({ kind: 'mail_reply', replyToElsewhere: { replyTo: ['help@service.example'], from: ['shop@example.com'] } })], pending: 1 };
		await render();
		const line = q('[data-note="reply-to"]');
		expect(line?.textContent).toBe('Die Antwort geht an help@service.example. Die Mail kam von shop@example.com und nennt für Antworten diese andere Adresse.');
		expect(line?.className).not.toMatch(/warning|danger/);
		// It is information, not a reason for a second click.
		await click('[data-action="send"]');
		expect(decides).toHaveLength(1);
	});

	it('shows a joiner inside an address, where running text would let it stand', async () => {
		const mail = { ...(card().mail as Card), from: 'pay\u200Cpal@x.example', to: [{ address: 'pay\u200Cpal@x.example' }],
			original: { from: 'pay\u200Cpal@x.example', subject: 'Hallo', date: '' } };
		lists.open = { entries: [card({ kind: 'mail_reply', mail,
			replyToElsewhere: { replyTo: ['pay\u200Cpal@x.example'], from: ['shop\u200Cping@x.example'] } })], pending: 1 };
		await render();
		expect(q('[data-addresses="to"] [data-address]')?.textContent).toBe('pay⟨U+200C⟩pal@x.example');
		expect(q('[data-note="reply-to"]')?.textContent).toContain('an pay⟨U+200C⟩pal@x.example.');
		expect(q('[data-note="reply-to"]')?.textContent).toContain('von shop⟨U+200C⟩ping@x.example');
		expect(target.textContent).not.toContain('pay\u200Cpal');
	});

	it('has no Reply-To line when the card carries none', async () => {
		await render();
		expect(q('[data-note="reply-to"]')).toBeNull();
	});

	it('a hidden character in a setup name shows as its code point', async () => {
		lists.open = { entries: [card({ setup: [{ kind: 'set_up_by', name: 'Anna\u202E\u200Bmoc.evil' }] })], pending: 1 };
		await render();
		expect(q('[data-setup]')?.textContent).toBe('Eingerichtet von Anna⟨U+202E⟩⟨U+200B⟩moc.evil');
	});

	it('a recipient\'s display name is a label beside its address, never in the address\'s place', async () => {
		const mail = { ...(card().mail as Card),
			to: [{ name: 'support@bank.ch <support@bank.ch>', address: 'evil@x.io' }, { address: 'bob@example.com' }],
			cc: [{ name: 'Te\u200Bam', address: 'te\u202Eam@example.com' }] };
		lists.open = { entries: [card({ mail })], pending: 1 };
		await render();
		const to = [...target.querySelectorAll('[data-addresses="to"] [data-recipient]')];
		expect(to).toHaveLength(2);
		// The first recipient: one name element, then exactly one address element, which is the real address.
		const first = to[0]!;
		expect([...first.querySelectorAll('[data-address]')].map((e) => e.textContent)).toEqual(['evil@x.io']);
		expect(first.querySelector('[data-address-name]')?.textContent).toBe('support@bank.ch <support@bank.ch>');
		const kids = [...first.children].map((e) => (e.hasAttribute('data-address') ? 'address' : e.hasAttribute('data-address-name') ? 'name' : '?'));
		expect(kids).toEqual(['name', 'address']);
		// The address element is not inside the name, and the name does not reach into it.
		expect(first.querySelector('[data-address-name] [data-address]')).toBeNull();
		expect(first.querySelector('[data-address]')!.className).not.toBe(first.querySelector('[data-address-name]')!.className);
		expect(first.textContent).toBe('support@bank.ch <support@bank.ch> <evil@x.io>');
		// Recipients are separated by a comma and a space, so a line breaks between addresses.
		expect(target.querySelector('[data-addresses="to"]')!.textContent).toContain('<evil@x.io>, bob@example.com');
		// Each recipient is kept together on a line; only one longer than the line breaks inside.
		for (const r of to) expect(r.classList.contains('inline-block')).toBe(true);
		// Without a name, only the address.
		expect(to[1]!.children).toHaveLength(1);
		expect(to[1]!.textContent).toBe('bob@example.com');
		// Names and addresses both show hidden characters.
		const cc = target.querySelector('[data-addresses="cc"] [data-recipient]')!;
		expect(cc.querySelector('[data-address-name]')?.textContent).toBe('Te⟨U+200B⟩am');
		expect(cc.querySelector('[data-address]')?.textContent).toBe('te⟨U+202E⟩am@example.com');
	});

	it('translates the engine\'s label for a mandate without a name', async () => {
		lists.open = { entries: [card({ setup: [{ kind: 'test_run_by', name: 'unnamed mandate' }, { kind: 'set_up_by', name: 'anna@example.com' }] })], pending: 1 };
		await render();
		const lines = [...target.querySelectorAll('[data-setup]')].map((e) => e.textContent);
		expect(lines).toEqual(['Aus einem Testlauf von (ohne Namen)', 'Eingerichtet von anna@example.com']);
		expect(target.textContent).not.toContain('unnamed mandate');
	});
});

describe('who may act, and on what', () => {
	it('a mandate\'s card (no checksum) offers no action', async () => {
		const { checksum: _shown, ...asMandate } = card();
		lists.open = { entries: [asMandate], pending: 1 };
		await render();
		expect(target.querySelectorAll('button[data-action]')).toHaveLength(0);
		expect(q('[data-note="read-only"]')).not.toBeNull();
	});

	it('an entry that no longer waits offers no action, even one the engine could still send', async () => {
		lists.open = { entries: [card({ id: 'a', status: 'approved' }), card({ id: 'u', status: 'unknown' }), card({ id: 'p' })], pending: 1 };
		await render();
		const withButtons = [...target.querySelectorAll('article')].filter((a) => a.querySelector('button[data-action]') !== null).map((a) => a.getAttribute('data-approval-id'));
		expect(withButtons).toEqual(['p']);
	});

	it('a card with an empty checksum offers no action', async () => {
		lists.open = { entries: [card({ checksum: '' })], pending: 1 };
		await render();
		expect(target.querySelectorAll('button[data-action]')).toHaveLength(0);
	});

	it('a waiting entry the engine cannot send offers only to discard it, and says why', async () => {
		lists.open = { entries: [card({ executable: false, mail: null })], pending: 1 };
		await render();
		expect(q('[data-action="send"]')).toBeNull();
		expect(q('[data-action="confirm-send"]')).toBeNull();
		expect(q('[data-note="not-executable"]')?.textContent).toBe('Diese Mail kann so nicht gesendet werden, nur verworfen.');
		await click('[data-action="discard"]');
		expect(decides).toEqual([{ id: 'e-1', body: { action: 'reject' } }]);
		// Twin: the same entry, executable, offers Senden and no such note.
		if (component) unmount(component);
		component = undefined;
		lists.open = { entries: [card({ executable: true })], pending: 1 };
		await render();
		expect(q('[data-action="send"]')).not.toBeNull();
		expect(q('[data-note="not-executable"]')).toBeNull();
	});

	it('nothing on the page approves more than one mail', async () => {
		lists.open = { entries: [card({ id: 'a' }), card({ id: 'b' }), card({ id: 'c', massSend: true })], pending: 3 };
		await render();
		const labels = [...target.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');
		expect(labels.filter((l) => /alle|all\b/i.test(l) && !/^Alle \(30 Tage\)$/.test(l))).toEqual([]);
		// Each Send button belongs to exactly one card.
		for (const b of target.querySelectorAll('button[data-action="send"]')) expect(b.closest('article')).not.toBeNull();
	});
});

describe('a list cut at the engine\'s cap', () => {
	const many = (n: number): Card[] => Array.from({ length: n }, (_, i) => card({ id: `e-${String(i)}` }));

	it('the open tab says how many of the waiting mails it shows', async () => {
		lists.open = { entries: many(200), pending: 250 };
		await render();
		expect(q('[data-cut]')?.textContent).toBe('Zeigt die neuesten 200 von 250 wartenden Mails.');
	});

	it('the all tab says only that it is cut', async () => {
		lists.all = { entries: many(200), pending: 3 };
		await render();
		await click('[data-tab="all"]');
		expect(listReads).toEqual(['open', 'all']);
		expect(q('[data-cut]')?.textContent).toBe('Die Liste zeigt nur die neuesten 200 Einträge.');
	});

	it('a whole list has no such line', async () => {
		lists.open = { entries: many(199), pending: 199 };
		await render();
		expect(q('[data-cut]')).toBeNull();
	});
});

describe('the badge follows the list', () => {
	it('takes the waiting count, not the number of open entries', async () => {
		const nav = await import('../stores/approvals.svelte.js');
		nav.resetApprovalsNavForTest();
		const stop = nav.startApprovalsNav(3_600_000);
		await settle();
		// One waiting, one whose outcome is unknown: both are open, one waits.
		lists.open = { entries: [card({ id: 'p' }), card({ id: 'u', status: 'unknown' })], pending: 1 };
		await render();
		expect(nav.getApprovalsBadge()).toBe(1);
		stop();
		nav.resetApprovalsNavForTest();
	});
});

describe('changing a mail in chat', () => {
	it('moves the entry to chat first, then opens a new chat with the entry as its context', async () => {
		await render();
		await click('[data-action="move-to-chat"]');
		expect(decides).toEqual([{ id: 'e-1', body: { action: 'move_to_chat' } }]);
		expect(steps).toEqual(['decide move_to_chat', 'newChat', 'send approval:e-1', 'goto /app']);
	});

	it('continues the run\'s thread only where the card names it', async () => {
		lists.open = { entries: [card({ origin: { source: 'task', triggerId: 'trg-1', runId: 'run-1', threadId: 'th-own' }, chatThreadId: 'th-own' })], pending: 1 };
		await render();
		await click('[data-action="move-to-chat"]');
		expect(steps).toEqual(['decide move_to_chat', 'goto /app', 'resume th-own', 'send approval:e-1']);
	});

	it('opens a new chat for a run\'s thread the card does not name, such as a mandate\'s', async () => {
		lists.open = { entries: [card({ origin: { source: 'task', triggerId: 'trg-1', runId: 'run-1', threadId: 'th-mandate' }, chatThreadId: null })], pending: 1 };
		await render();
		await click('[data-action="move-to-chat"]');
		expect(steps).toEqual(['decide move_to_chat', 'newChat', 'send approval:e-1', 'goto /app']);
	});

	it('opens no chat when the decision is refused, and says why', async () => {
		decideAnswer = { status: 409, body: { error: 'x', code: 'not_pending' } };
		await render();
		await click('[data-action="move-to-chat"]');
		expect(steps).toEqual(['decide move_to_chat']);
		expect(q('[data-notice="error"]')).not.toBeNull();
		// A stale list is read again, as after any refused decision.
		expect(listReads).toEqual(['open', 'open']);
	});

	it('is offered only on a waiting entry the owner may decide on, with a draft to load', async () => {
		const { checksum: _shown, ...asMandate } = card({ id: 'm' });
		lists.open = { entries: [
			card({ id: 'p' }), asMandate, card({ id: 'a', status: 'approved' }), card({ id: 'gone', mail: null, executable: false }),
			card({ id: 'x', executable: false }),
		], pending: 3 };
		await render();
		const offered = [...target.querySelectorAll('article')].filter((a) => a.querySelector('[data-action="move-to-chat"]') !== null).map((a) => a.getAttribute('data-approval-id'));
		expect(offered).toEqual(['p', 'x']);
	});
});

describe('opening a moved draft in chat again', () => {
	const movedCard = (over: Card = {}): Card => card({ status: 'rejected', outcome: 'moved_to_chat', decidedAt: '2026-10-21T09:00:00.000Z', ...over });

	it('opens the chat on the draft without deciding anything', async () => {
		lists.open = { entries: [movedCard()], pending: 0 };
		await render();
		await click('[data-action="reopen-chat"]');
		expect(decides).toEqual([]);
		expect(steps).toEqual(['newChat', 'send approval:e-1', 'goto /app']);
	});

	it('continues the same thread as moving it did, where the card names one', async () => {
		lists.open = { entries: [movedCard({ chatThreadId: 'th-own' })], pending: 0 };
		await render();
		await click('[data-action="reopen-chat"]');
		expect(decides).toEqual([]);
		expect(steps).toEqual(['goto /app', 'resume th-own', 'send approval:e-1']);
	});

	it('a double click loads the draft once', async () => {
		lists.open = { entries: [movedCard()], pending: 0 };
		await render();
		const button = q('[data-action="reopen-chat"]')!;
		button.click();
		button.click();
		await settle();
		expect(steps).toEqual(['newChat', 'send approval:e-1', 'goto /app']);
		// Control: once the first has settled, the button opens the chat again.
		await click('[data-action="reopen-chat"]');
		expect(steps.filter((x) => x === 'newChat')).toHaveLength(2);
	});

	it('is offered only on an entry moved to chat, on the owner\'s card, with a draft', async () => {
		const { checksum: _shown, ...mandates } = movedCard({ id: 'm' });
		lists.open = { entries: [
			movedCard({ id: 'mv' }), mandates, card({ id: 'd', status: 'rejected', outcome: 'discarded' }),
			card({ id: 'p' }), movedCard({ id: 'gone', mail: null }),
		], pending: 1 };
		await render();
		const offered = [...target.querySelectorAll('article')].filter((a) => a.querySelector('[data-action="reopen-chat"]') !== null).map((a) => a.getAttribute('data-approval-id'));
		expect(offered).toEqual(['mv']);
	});

	it('says the entry was moved to chat, not discarded', async () => {
		lists.open = { entries: [movedCard({ id: 'mv' }), card({ id: 'd', status: 'rejected', outcome: 'discarded' })], pending: 0 };
		await render();
		const label = (id: string): string => target.querySelector(`article[data-approval-id="${id}"] [data-status]`)?.textContent ?? '';
		expect(label('mv')).toBe('In den Chat verschoben');
		// Control: an entry discarded on its card keeps the discarded label.
		expect(label('d')).toBe('Verworfen');
	});
});
