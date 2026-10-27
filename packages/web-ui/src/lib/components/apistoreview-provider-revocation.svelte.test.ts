import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

// After a provider revoked a profile's grant, the API page says when, offers "Reconnect" (a link
// to the engine's connect route, loaded as a full page), and while an erasure is pending shows
// when it falls and what the owner was told. A profile connected again while an erasure stands
// still says so: a mandate's reconnect with who it was and, inside the hold, the owner's way out;
// the owner's reconnect past the hold with the dates only. The notices come from an owner-only
// route: a refusal shows none.

const DAY = 24 * 3600 * 1000;
const revokedAtIso = new Date(Date.now() - DAY).toISOString();
const holdIso = new Date(Date.now() + 13 * DAY).toISOString();
const deadlineIso = new Date(Date.now() + 29 * DAY).toISOString();
const day = (iso: string): string => new Date(iso).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' });

/** A notice as the engine sends it: one pending erasure of `crm`, refused a day ago. */
const n = (recordId: number): Record<string, unknown> => ({ recordId, connectionId: 'crm', revokedAt: revokedAtIso, holdUntil: holdIso, deadline: deadlineIso, reconnected: false });
/** The same after a new consent connected the profile again. */
const r = (recordId: number): Record<string, unknown> => ({ ...n(recordId), reconnected: true });
const revokedProfile = { id: 'crm', name: 'CRM', base_url: 'https://crm.example', description: '', auth: { type: 'oauth2' }, oauth_grant: { state: 'revoked', revoked_at: revokedAtIso } };

let target: HTMLElement;
let component: Record<string, unknown> | undefined;

function serve(profiles: unknown[], records: { status: number; body?: unknown }): void {
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		if (url.endsWith('/connections/records')) return new Response(JSON.stringify(records.body), { status: records.status, headers: { 'Content-Type': 'application/json' } });
		return new Response(JSON.stringify({ profiles }), { status: 200, headers: { 'Content-Type': 'application/json' } });
	}));
}

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
});
afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
});

async function render(): Promise<void> {
	const { default: ApiStoreView } = await import('./ApiStoreView.svelte');
	component = mount(ApiStoreView, { target });
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}
const q = (id: string): HTMLElement | null => target.querySelector<HTMLElement>(`[data-testid="${id}"]`);

// The approved texts as they stood in one piece before the layout split them into parts.
// Copied, not read from the table: the table is what is under test. The way out stands at its old place; in the revoked case it is not last.
const APPROVED: Record<'revoked' | 'connectedAgain' | 'reconnected', { de: string; en: string; parts: string[] }> = {
	revoked: {
		de: 'Wir löschen aus dem Verlauf deiner Läufe, was lynox über diese Verbindung an den Anbieter gesendet und von ihm zurückbekommen hat, seit sie zuletzt eingerichtet wurde oder sich geändert hat, wie sie sich beim Anbieter anmeldet (etwa Server-Adresse, Token-Endpunkt, Berechtigungen oder die Namen ihrer Zugangsdaten; ein neuer Wert für ein Secret oder eine neue Anmeldung beim Anbieter zählt nicht als Änderung), und zwar aus allen Läufen, die bis zum Ende der 14 Tage gestartet wurden. Es bleiben: was davon in einem Chat steht, das Profil, die Läufe selbst, alles, was lynox daraus ins Gedächtnis oder in Dateien übernommen hat, und Sicherungen. Wir löschen frühestens am {earliest} und spätestens am {latest}. Läuft dann noch ein Lauf über die Verbindung, löschen wir, sobald er endet; ist deine Instanz dann aus, beim nächsten Start. Wählst du innerhalb von 14 Tagen nach dem Widerruf beim Profil „Erneut verbinden“ und meldest dich beim Anbieter neu an, löschen wir nicht. Läufe, die nach Ablauf der 14 Tage noch über diese Verbindung gestartet werden, löschen wir nicht mit. Sie bleiben auf deiner Instanz.',
		en: 'We delete from the history of your runs what lynox sent to the provider over this connection and received back since it was last set up or the way it signs in to the provider changed (for example the server address, token endpoint, permissions or the names of its credentials; a new value for a secret or signing in to the provider again does not count as a change), from every run started before the 14 days are up. What stays: anything of it that appears in a chat, the profile, the runs themselves, everything lynox took from it into memory or files, and backups. We delete no earlier than {earliest} and no later than {latest}. If a run over the connection is still going then, we delete once it ends; if your instance is off then, when it next starts. If you choose “Reconnect” on the profile within 14 days of the revocation and sign in to the provider again, we don\'t delete anything. Runs started over this connection after the 14 days are up are not deleted with it. They stay on your instance.',
		parts: ['apis.erasure_notice', 'apis.erasure_notice_avert', 'apis.erasure_notice_tail'],
	},
	connectedAgain: {
		de: 'Dieses Profil ist wieder verbunden. Die Löschung nach dem Widerruf durch den Anbieter am {revoked} bleibt bestehen: Wir löschen frühestens am {earliest} und spätestens am {latest} aus dem Verlauf deiner Läufe, was lynox über diese Verbindung an den Anbieter gesendet und von ihm zurückbekommen hat, seit sie vor dem Widerruf zuletzt eingerichtet wurde oder sich geändert hat, wie sie sich beim Anbieter anmeldet (etwa Server-Adresse, Token-Endpunkt, Berechtigungen oder die Namen ihrer Zugangsdaten; ein neuer Wert für ein Secret oder eine neue Anmeldung beim Anbieter zählt nicht als Änderung). Was über die Verbindung läuft, seit sie wieder verbunden ist, löschen wir damit nicht. Es bleiben: was davon in einem Chat steht, alles, was lynox daraus ins Gedächtnis oder in Dateien übernommen hat, und Sicherungen. Läuft dann noch ein Lauf, der die Verbindung von vor dem Widerruf genutzt hat, löschen wir, sobald er endet; ist deine Instanz dann aus, beim nächsten Start. Wählst du innerhalb von 14 Tagen nach dem Widerruf „Erneut verbinden“ und meldest dich beim Anbieter neu an, löschen wir nicht.',
		en: 'This profile is connected again. The deletion after the provider\'s revocation on {revoked} still stands: no earlier than {earliest} and no later than {latest}, we delete from the history of your runs what lynox sent to the provider over this connection and received back since, before the revocation, it was last set up or the way it signs in to the provider changed (for example the server address, token endpoint, permissions or the names of its credentials; a new value for a secret or signing in to the provider again does not count as a change). Whatever runs over the connection since it was connected again is not deleted by this. What stays: anything of it that appears in a chat, everything lynox took from it into memory or files, and backups. If a run that used the connection from before the revocation is still going then, we delete once it ends; if your instance is off then, when it next starts. If you choose “Reconnect” within 14 days of the revocation and sign in to the provider again, we don\'t delete anything.',
		parts: ['apis.erasure_connected_again_notice', 'apis.erasure_connected_again_avert'],
	},
	reconnected: {
		de: '{who} hat dieses Profil neu verbunden. Die Löschung nach dem Widerruf durch den Anbieter am {revoked} bleibt bestehen: Wir löschen frühestens am {earliest} und spätestens am {latest} aus dem Verlauf deiner Läufe, was lynox über die frühere Verbindung an den Anbieter gesendet und von ihm zurückbekommen hat, seit sie zuletzt eingerichtet wurde oder sich geändert hat, wie sie sich beim Anbieter anmeldet (etwa Server-Adresse, Token-Endpunkt, Berechtigungen oder die Namen ihrer Zugangsdaten; ein neuer Wert für ein Secret oder eine neue Anmeldung beim Anbieter zählt nicht als Änderung). Es bleiben: was davon in einem Chat steht, alles, was lynox daraus ins Gedächtnis oder in Dateien übernommen hat, und Sicherungen. Läuft dann noch ein Lauf über die frühere Verbindung, löschen wir, sobald er endet; ist deine Instanz dann aus, beim nächsten Start. Was über die neue Verbindung von {who} läuft, löschen wir damit nicht. Wählst du innerhalb von 14 Tagen nach dem Widerruf „Erneut verbinden“ und meldest dich selbst beim Anbieter an, löschen wir nicht. Das Profil nutzt danach deine Anmeldung statt der von {who}.',
		en: '{who} reconnected this profile. The deletion after the provider\'s revocation on {revoked} still stands: no earlier than {earliest} and no later than {latest}, we delete from the history of your runs what lynox sent to the provider over the earlier connection and received back since it was last set up or the way it signs in to the provider changed (for example the server address, token endpoint, permissions or the names of its credentials; a new value for a secret or signing in to the provider again does not count as a change). What stays: anything of it that appears in a chat, everything lynox took from it into memory or files, and backups. If a run over the earlier connection is still going then, we delete once it ends; if your instance is off then, when it next starts. Whatever runs over {who}\'s new connection is not deleted by this. If you choose “Reconnect” within 14 days of the revocation and sign in to the provider yourself, we don\'t delete anything. The profile then uses your sign-in instead of {who}\'s.',
		parts: ['apis.erasure_reconnected_notice', 'apis.erasure_reconnected_avert'],
	},
};

describe('a profile its provider revoked', () => {
	it('the owner with a pending erasure: revoked on, the window, the notice, and the button to the engine\'s connect route', async () => {
		serve([revokedProfile], { status: 200, body: { notices: [n(7)] } });
		await render();
		expect(q('api-revoked')?.textContent).toContain(`Vom Anbieter widerrufen am ${day(revokedAtIso)}`);
		expect(q('api-erasure-window')?.textContent).toBe(`Löschung frühestens am ${day(holdIso)}, spätestens am ${day(deadlineIso)}`);
		expect(q('api-erasure-notice')?.textContent).toContain(`Wir löschen frühestens am ${day(holdIso)} und spätestens am ${day(deadlineIso)}.`);
		expect(q('api-erasure-avert')?.textContent).toBe('Wählst du innerhalb von 14 Tagen nach dem Widerruf beim Profil „Erneut verbinden“ und meldest dich beim Anbieter neu an, löschen wir nicht.');
		expect(q('api-erasure-notice')?.textContent).not.toContain('Wählst du');
		const link = q('api-reconnect') as HTMLAnchorElement | null;
		expect(link?.textContent).toBe('Erneut verbinden');
		expect(link?.getAttribute('href')).toBe('/api/oauth/connect/crm');
		expect(link?.hasAttribute('data-sveltekit-reload')).toBe(true);
	});

	it('a refused records route (a mandate): revoked on and the button, no window and no notice', async () => {
		// A refusal is read as no notice, whatever its body holds.
		serve([revokedProfile], { status: 403, body: { notices: [n(7)] } });
		await render();
		expect(q('api-revoked')).not.toBeNull();
		expect(q('api-reconnect')).not.toBeNull();
		expect(q('api-erasure-window')).toBeNull();
		expect(q('api-erasure-notice')).toBeNull();
	});

	it('a notice whose deadline has passed is not shown', async () => {
		serve([revokedProfile], { status: 200, body: { notices: [{ ...n(7), holdUntil: new Date(Date.now() - 16 * DAY).toISOString(), deadline: new Date(Date.now() - 1000).toISOString() }] } });
		await render();
		expect(q('api-revoked')).not.toBeNull();
		expect(q('api-erasure-window')).toBeNull();
	});

	it('two pending erasures of one profile: from the earliest hold to the latest deadline', async () => {
		const laterHold = new Date(Date.now() + 20 * DAY).toISOString();
		const earlierDeadline = new Date(Date.now() + 25 * DAY).toISOString();
		serve([revokedProfile], { status: 200, body: { notices: [
			{ ...n(7), holdUntil: laterHold, deadline: earlierDeadline },
			n(8),
		] } });
		await render();
		expect(q('api-erasure-window')?.textContent).toBe(`Löschung frühestens am ${day(holdIso)}, spätestens am ${day(deadlineIso)}`);
	});

	it('the same two in the other order: the same span', async () => {
		const laterHold = new Date(Date.now() + 20 * DAY).toISOString();
		const earlierDeadline = new Date(Date.now() + 25 * DAY).toISOString();
		serve([revokedProfile], { status: 200, body: { notices: [
			n(8),
			{ ...n(7), holdUntil: laterHold, deadline: earlierDeadline },
		] } });
		await render();
		expect(q('api-erasure-window')?.textContent).toBe(`Löschung frühestens am ${day(holdIso)}, spätestens am ${day(deadlineIso)}`);
	});

	it('a notice that does not say whether the profile was connected again is not read', async () => {
		const { reconnected: _r, ...partial } = n(7);
		serve([revokedProfile], { status: 200, body: { notices: [partial] } });
		await render();
		expect(q('api-revoked')).not.toBeNull();
		expect(q('api-erasure-window')).toBeNull();
	});

	it('a notice of another profile does not show here', async () => {
		serve([revokedProfile], { status: 200, body: { notices: [{ ...n(7), connectionId: 'other' }] } });
		await render();
		expect(q('api-erasure-window')).toBeNull();
	});

	it('a connected profile without a pending erasure shows none of it', async () => {
		serve([{ ...revokedProfile, oauth_grant: { state: 'connected', revoked_at: revokedAtIso } }], { status: 200, body: { notices: [] } });
		await render();
		expect(q('api-revoked')).toBeNull();
		expect(q('api-reconnect')).toBeNull();
	});

	it('a revoked profile without a pending erasure (a closing record): revoked on and the button, nothing of an erasure', async () => {
		serve([revokedProfile], { status: 200, body: { notices: [] } });
		await render();
		expect(q('api-revoked')?.textContent).toContain(`Vom Anbieter widerrufen am ${day(revokedAtIso)}`);
		expect(q('api-reconnect')).not.toBeNull();
		expect(q('api-erasure-window')).toBeNull();
		expect(q('api-erasure-notice')).toBeNull();
	});

	it('a mandate\'s own grant revoked: the notice of a revoked profile, not the one of a reconnect', async () => {
		serve([{ ...revokedProfile, oauth_grant: { state: 'revoked', revoked_at: revokedAtIso, connected_by: 'mandate:helper@example.com' } }], { status: 200, body: { notices: [n(7)] } });
		await render();
		expect(q('api-erasure-notice')).not.toBeNull();
		expect(q('api-erasure-reconnected')).toBeNull();
		expect(q('api-reconnect')).not.toBeNull();
	});

	it('a revoked grant without a recorded time: the button and a mandate\'s tag change nothing, and no date is made up', async () => {
		serve([{ ...revokedProfile, oauth_grant: { state: 'revoked', connected_by: 'mandate:helper@example.com' } }], { status: 200, body: { notices: [] } });
		await render();
		expect(q('api-revoked')?.textContent).not.toContain('Vom Anbieter widerrufen am');
		expect(q('api-erasure-reconnected')).toBeNull();
		expect(q('api-reconnect')).not.toBeNull();
	});

	it('the revocation line names the earliest pending refusal, not the grant\'s latest', async () => {
		const later = new Date(Date.now() - 1000).toISOString();
		serve([{ ...revokedProfile, oauth_grant: { state: 'revoked', revoked_at: later } }], { status: 200, body: { notices: [{ ...n(8), revokedAt: later }, n(7)] } });
		await render();
		expect(q('api-revoked')?.textContent).toContain(`Vom Anbieter widerrufen am ${day(revokedAtIso)}`);
	});

	it('the same in the other order', async () => {
		const later = new Date(Date.now() - 1000).toISOString();
		serve([{ ...revokedProfile, oauth_grant: { state: 'revoked', revoked_at: later } }], { status: 200, body: { notices: [n(7), { ...n(8), revokedAt: later }] } });
		await render();
		expect(q('api-revoked')?.textContent).toContain(`Vom Anbieter widerrufen am ${day(revokedAtIso)}`);
	});

	it('the notice names what is deleted since the connection was set up or its sign-in changed', async () => {
		serve([revokedProfile], { status: 200, body: { notices: [n(7)] } });
		await render();
		expect(q('api-erasure-notice')?.textContent).toContain('seit sie zuletzt eingerichtet wurde oder sich geändert hat, wie sie sich beim Anbieter anmeldet (etwa Server-Adresse, Token-Endpunkt, Berechtigungen oder die Namen ihrer Zugangsdaten; ein neuer Wert für ein Secret oder eine neue Anmeldung beim Anbieter zählt nicht als Änderung)');
	});
});

describe('a profile connected again while a provider\'s erasure still stands', () => {
	const byHelper = { ...revokedProfile, oauth_grant: { state: 'connected', connected_by: 'mandate:helper@example.com' } };
	const byOwner = { ...revokedProfile, oauth_grant: { state: 'connected', connected_by: 'owner' } };

	it('reconnected by a mandate, inside the hold: who, the dates, the way out and the button', async () => {
		serve([byHelper], { status: 200, body: { notices: [r(7)] } });
		await render();
		const text = q('api-erasure-reconnected')?.textContent ?? '';
		expect(text).toContain(`helper@example.com hat dieses Profil neu verbunden. Die Löschung nach dem Widerruf durch den Anbieter am ${day(revokedAtIso)} bleibt bestehen: Wir löschen frühestens am ${day(holdIso)} und spätestens am ${day(deadlineIso)}`);
		expect(text).toContain('über die frühere Verbindung an den Anbieter gesendet und von ihm zurückbekommen hat, seit sie zuletzt eingerichtet wurde oder sich geändert hat, wie sie sich beim Anbieter anmeldet');
		expect(text).toContain('Was über die neue Verbindung von helper@example.com läuft, löschen wir damit nicht.');
		expect(q('api-erasure-avert')?.textContent).toBe('Wählst du innerhalb von 14 Tagen nach dem Widerruf „Erneut verbinden“ und meldest dich selbst beim Anbieter an, löschen wir nicht. Das Profil nutzt danach deine Anmeldung statt der von helper@example.com.');
		expect(q('api-reconnect')?.getAttribute('href')).toBe('/api/oauth/connect/crm');
		expect(q('api-erasure-notice')).toBeNull();
	});

	it('reconnected by a mandate, past the hold: the notice until the deadline, no way out and no button', async () => {
		serve([byHelper], { status: 200, body: { notices: [{ ...r(7), holdUntil: new Date(Date.now() - 1000).toISOString() }] } });
		await render();
		expect(q('api-erasure-reconnected')).not.toBeNull();
		expect(q('api-erasure-avert')).toBeNull();
		expect(q('api-reconnect')).toBeNull();
	});

	it('reconnected by a mandate with two erasures, one past its hold: no way out, since a reconnect cancels only the held one', async () => {
		serve([byHelper], { status: 200, body: { notices: [r(7), { ...r(8), holdUntil: new Date(Date.now() - 1000).toISOString() }] } });
		await render();
		expect(q('api-erasure-avert')).toBeNull();
		expect(q('api-reconnect')).toBeNull();
	});

	it('reconnected by the owner past the hold: revoked on and the dates only, no notice, no way out, no button', async () => {
		serve([byOwner], { status: 200, body: { notices: [{ ...r(7), holdUntil: new Date(Date.now() - 1000).toISOString() }] } });
		await render();
		expect(q('api-revoked')?.textContent).toContain(`Vom Anbieter widerrufen am ${day(revokedAtIso)}`);
		expect(q('api-erasure-window')).not.toBeNull();
		expect(q('api-erasure-notice')).toBeNull();
		expect(q('api-erasure-reconnected')).toBeNull();
		expect(q('api-erasure-avert')).toBeNull();
		expect(q('api-reconnect')).toBeNull();
	});

	it('reconnected by a mandate, past the deadline: nothing', async () => {
		serve([byHelper], { status: 200, body: { notices: [{ ...r(7), holdUntil: new Date(Date.now() - 20 * DAY).toISOString(), deadline: new Date(Date.now() - 1000).toISOString() }] } });
		await render();
		expect(q('api-revoked')).toBeNull();
	});

	it('connected again without a new consent, inside the hold: the dates, the text of a profile connected again, and the button', async () => {
		serve([byOwner], { status: 200, body: { notices: [n(7)] } });
		await render();
		const text = q('api-erasure-connected-again')?.textContent ?? '';
		expect(text).toContain(`Dieses Profil ist wieder verbunden. Die Löschung nach dem Widerruf durch den Anbieter am ${day(revokedAtIso)} bleibt bestehen: Wir löschen frühestens am ${day(holdIso)} und spätestens am ${day(deadlineIso)}`);
		expect(text).toContain('seit sie vor dem Widerruf zuletzt eingerichtet wurde oder sich geändert hat, wie sie sich beim Anbieter anmeldet');
		expect(text).toContain('Was über die Verbindung läuft, seit sie wieder verbunden ist, löschen wir damit nicht.');
		expect(q('api-erasure-avert')?.textContent).toBe('Wählst du innerhalb von 14 Tagen nach dem Widerruf „Erneut verbinden“ und meldest dich beim Anbieter neu an, löschen wir nicht.');
		expect(text).not.toContain('Wählst du');
		expect(q('api-erasure-window')).not.toBeNull();
		expect(q('api-erasure-notice')).toBeNull();
		expect(q('api-erasure-reconnected')).toBeNull();
		expect(q('api-reconnect')?.getAttribute('href')).toBe('/api/oauth/connect/crm');
	});

	it('a mandate\'s tag carried over to a grant that is no new consent: the text of a profile connected again, naming no one', async () => {
		serve([byHelper], { status: 200, body: { notices: [n(7)] } });
		await render();
		expect(q('api-erasure-connected-again')).not.toBeNull();
		expect(q('api-erasure-reconnected')).toBeNull();
		expect(q('api-revoked')?.textContent).not.toContain('helper@example.com');
		expect(q('api-reconnect')).not.toBeNull();
	});

	it('connected again without a new consent, past the hold: revoked on and the dates only', async () => {
		serve([byHelper], { status: 200, body: { notices: [{ ...n(7), holdUntil: new Date(Date.now() - 1000).toISOString() }] } });
		await render();
		expect(q('api-revoked')?.textContent).toContain(`Vom Anbieter widerrufen am ${day(revokedAtIso)}`);
		expect(q('api-erasure-window')).not.toBeNull();
		expect(q('api-erasure-connected-again')).toBeNull();
		expect(q('api-erasure-reconnected')).toBeNull();
		expect(q('api-reconnect')).toBeNull();
	});

	it('a consent after one refusal but not after a later one: connected again, not reconnected by the mandate', async () => {
		serve([byHelper], { status: 200, body: { notices: [r(7), n(8)] } });
		await render();
		expect(q('api-erasure-connected-again')).not.toBeNull();
		expect(q('api-erasure-reconnected')).toBeNull();
	});

	it('the same in the other order', async () => {
		serve([byHelper], { status: 200, body: { notices: [n(8), r(7)] } });
		await render();
		expect(q('api-erasure-connected-again')).not.toBeNull();
		expect(q('api-erasure-reconnected')).toBeNull();
	});

	it('a mandate\'s connection the owner adopted while a hold still runs: the text of a profile connected again and the button', async () => {
		serve([byOwner], { status: 200, body: { notices: [r(7)] } });
		await render();
		expect(q('api-erasure-connected-again')).not.toBeNull();
		expect(q('api-erasure-reconnected')).toBeNull();
		expect(q('api-reconnect')).not.toBeNull();
	});

	it('connected again without a new consent: the button goes when the hold ends while the page is open', async () => {
		const timers: Array<() => void> = [];
		const real = globalThis.setInterval;
		vi.stubGlobal('setInterval', ((fn: () => void, ms?: number) => { timers.push(fn); return real(() => {}, ms); }) as typeof setInterval);
		serve([byOwner], { status: 200, body: { notices: [{ ...n(7), holdUntil: new Date(Date.now() + 200).toISOString() }] } });
		await render();
		expect(q('api-erasure-connected-again')).not.toBeNull();
		await new Promise((res) => setTimeout(res, 300));
		for (const fn of timers) fn();
		await tick();
		flushSync();
		expect(q('api-erasure-connected-again')).toBeNull();
		expect(q('api-erasure-window')).not.toBeNull();
		expect(q('api-reconnect')).toBeNull();
	});

	it('connected under another tag, or with none recorded, past the hold: the dates only', async () => {
		const past = { ...n(7), holdUntil: new Date(Date.now() - 1000).toISOString() };
		for (const grant of [{ state: 'connected', connected_by: 'cp-admin' }, { state: 'connected' }]) {
			serve([{ ...revokedProfile, oauth_grant: grant }], { status: 200, body: { notices: [past] } });
			await render();
			expect(q('api-erasure-window')).not.toBeNull();
			expect(q('api-erasure-reconnected')).toBeNull();
			expect(q('api-erasure-notice')).toBeNull();
			expect(q('api-reconnect')).toBeNull();
			if (component) unmount(component);
			component = undefined;
		}
	});

	it('a hold that ends while the page is open takes the way out and the button away', async () => {
		const timers: Array<() => void> = [];
		const real = globalThis.setInterval;
		vi.stubGlobal('setInterval', ((fn: () => void, ms?: number) => { timers.push(fn); return real(() => {}, ms); }) as typeof setInterval);
		serve([byHelper], { status: 200, body: { notices: [{ ...r(7), holdUntil: new Date(Date.now() + 200).toISOString() }] } });
		await render();
		expect(q('api-erasure-avert')).not.toBeNull();
		await new Promise((r) => setTimeout(r, 300));
		for (const fn of timers) fn();
		await tick();
		flushSync();
		expect(q('api-erasure-reconnected')).not.toBeNull();
		expect(q('api-erasure-avert')).toBeNull();
		expect(q('api-reconnect')).toBeNull();
	});

	it('a refused records route (a mandate\'s page): nothing', async () => {
		serve([byHelper], { status: 403, body: { notices: [r(7)] } });
		await render();
		expect(q('api-revoked')).toBeNull();
	});
});

describe('the layout: the dates and the way out first, the long text closed below', () => {
	const placeholders = { revoked: '{revoked}', earliest: '{earliest}', latest: '{latest}', who: '{who}' };
	afterEach(async () => { (await import('../i18n.svelte.js')).setLocale('de'); });

	it.each([['revoked'], ['connectedAgain'], ['reconnected']] as const)('the %s parts, joined in the approved order, are the approved text in both languages', async (kase) => {
		const { setLocale, tf } = await import('../i18n.svelte.js');
		for (const locale of ['de', 'en'] as const) {
			setLocale(locale);
			expect(APPROVED[kase].parts.map((k) => tf(k, placeholders)).join(' '), `${kase} ${locale}`).toBe(APPROVED[kase][locale]);
		}
	});

	it('the revocation line, the dates and the way out stand outside the details, and the details are closed', async () => {
		serve([revokedProfile], { status: 200, body: { notices: [n(7)] } });
		await render();
		const details = q('api-erasure-details') as HTMLDetailsElement | null;
		expect(details).not.toBeNull();
		expect(details!.hasAttribute('open')).toBe(false);
		expect(details!.querySelector('summary')?.textContent).toBe('Was gelöscht wird und was bleibt');
		expect(details!.contains(q('api-erasure-notice'))).toBe(true);
		for (const id of ['api-erasure-window', 'api-erasure-avert', 'api-reconnect']) expect(details!.contains(q(id)), id).toBe(false);
		expect(details!.textContent).not.toContain('Vom Anbieter widerrufen am');
		expect(q('api-revoked')?.textContent).toContain(`Vom Anbieter widerrufen am ${day(revokedAtIso)}`);
		// The order the reader meets them in: the dates, the way out, the button, then the details.
		const order = ['api-erasure-window', 'api-erasure-avert', 'api-reconnect', 'api-erasure-details'].map((id) => q(id)!);
		for (let i = 1; i < order.length; i++) expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING, `${i}`).toBeTruthy();
	});

	it('a revoked profile past the hold: no way out, since a reconnect then cancels nothing; the button and the text stay', async () => {
		serve([revokedProfile], { status: 200, body: { notices: [{ ...n(7), holdUntil: new Date(Date.now() - 1000).toISOString() }] } });
		await render();
		expect(q('api-erasure-window')).not.toBeNull();
		expect(q('api-erasure-avert')).toBeNull();
		expect(target.textContent).not.toContain('Wählst du');
		expect(q('api-reconnect')).not.toBeNull();
		expect(q('api-erasure-notice')?.textContent).toContain('Sie bleiben auf deiner Instanz.');
	});

	it.each([
		['revoked', () => revokedProfile, n],
		['reconnected by a mandate', () => ({ ...revokedProfile, oauth_grant: { state: 'connected', connected_by: 'mandate:helper@example.com' } }), r],
		['connected again', () => ({ ...revokedProfile, oauth_grant: { state: 'connected', connected_by: 'owner' } }), n],
	] as const)('past the hold no way out is in the page: %s', async (_name, profile, notice) => {
		serve([profile()], { status: 200, body: { notices: [{ ...notice(7), holdUntil: new Date(Date.now() - 1000).toISOString() }] } });
		await render();
		expect(q('api-erasure-avert')).toBeNull();
		expect(target.textContent).not.toMatch(/Wählst du innerhalb von 14 Tagen/);
	});
});
