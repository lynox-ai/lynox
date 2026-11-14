import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { setLocale, getLocale } from '../i18n.svelte.js';
import { resetSettingsViewer } from '../stores/settings-viewer.svelte.js';
import { markSearxngRemoved } from '../stores/integrations/secrets.svelte.js';
import { resetSearxngHealth, setSearxngUrl } from '../stores/integrations/search.svelte.js';

// A SearXNG URL the engine does not use is named with its reason and way out,
// in the page's own wording (written out here, not taken from the table this checks). A URL from
// the environment wins over the page, so its text says so, and the page offers nothing that would
// only seem to change it.

// `svelte` resolves to its server entry under node, where `mount` throws: the client entry by path.
const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

const ENV_DE = 'Sie kommt aus der Umgebungsvariable SEARXNG_URL, die Vorrang vor dieser Seite hat.';
const TEXT: Record<string, { plain: string; env: string }> = {
	'private-ip': {
		plain: 'Diese Adresse nennt eine private IP-Adresse als Zahl, dorthin schickt lynox keine Suche. Trag stattdessen den Hostnamen ein: http://localhost:<Port> für SearXNG auf diesem Rechner oder den Dienstnamen in Docker Compose, etwa http://searxng:8080.',
		env: `Diese Adresse nennt eine private IP-Adresse als Zahl, dorthin schickt lynox keine Suche. ${ENV_DE} Setz dort stattdessen den Hostnamen, etwa http://localhost:<Port> oder den Dienstnamen in Docker Compose (http://searxng:8080), und starte lynox danach neu.`,
	},
	invalid: {
		plain: 'Diese Adresse lässt sich nicht als URL lesen. Trag sie vollständig ein, mit http:// oder https:// am Anfang, etwa http://localhost:8888.',
		env: `Diese Adresse lässt sich nicht als URL lesen. ${ENV_DE} Trag sie dort vollständig ein, mit http:// oder https:// am Anfang, etwa http://localhost:8888, und starte lynox danach neu.`,
	},
	protocol: {
		plain: 'Diese Adresse beginnt nicht mit http:// oder https://, und lynox sucht nur über diese beiden. Setz eines davon an den Anfang, etwa http://localhost:8888.',
		env: `Diese Adresse beginnt nicht mit http:// oder https://, und lynox sucht nur über diese beiden. ${ENV_DE} Setz dort eines davon an den Anfang, etwa http://localhost:8888, und starte lynox danach neu.`,
	},
	metadata: {
		plain: 'Diese Adresse liegt im Bereich 169.254.…, in dem Cloud-Server unter anderem ihre internen Zugangsdaten bereitstellen; dorthin schickt lynox keine Suche. Trag die Adresse deiner SearXNG-Instanz ein, etwa http://localhost:8888 oder den Dienstnamen in Docker Compose.',
		env: `Diese Adresse liegt im Bereich 169.254.…, in dem Cloud-Server unter anderem ihre internen Zugangsdaten bereitstellen; dorthin schickt lynox keine Suche. ${ENV_DE} Trag dort die Adresse deiner SearXNG-Instanz ein, etwa http://localhost:8888 oder den Dienstnamen in Docker Compose, und starte lynox danach neu.`,
	},
};

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
const localeBefore = getLocale();

beforeEach(() => {
	setLocale('de');
	resetSettingsViewer();
	markSearxngRemoved();
	resetSearxngHealth();
	setSearxngUrl('');
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
	setLocale(localeBefore);
});

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

/** The page with `status` from `/api/secrets/status`, and the check answering `check`. */
async function render(status: Record<string, unknown>, check?: { status: number; body: unknown }): Promise<void> {
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const path = String(url).split('?')[0]!;
		if (path.endsWith('/searxng/check') && check) return Response.json(check.body, { status: check.status });
		if (path.endsWith('/secrets/status')) return Response.json(status);
		if (path.endsWith('/config')) return Response.json({ managed: 'self-host', viewer: 'owner' });
		return Response.json({ error: 'not found' }, { status: 404 });
	}));
	const { default: Page } = await import('./SearchSettings.svelte');
	component = mount(Page, { target });
	await settle();
}

const alerts = (): string[] => [...target.querySelectorAll('[role="alert"]')].map((e) => e.textContent?.trim() ?? '');
const buttons = (): string[] => [...target.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');
const stored = (problem: string, fromEnv: boolean) => ({
	configured: { search: false, api_key: true, searxng: true }, searxng_url: 'http://x.example', searxng_problem: problem, searxng_from_env: fromEnv,
});

describe('a stored SearXNG URL the engine does not use', () => {
	it.each(Object.keys(TEXT))('names %s, set on this page, with the way on this page', async (code) => {
		await render(stored(code, false));
		expect(alerts()).toEqual([TEXT[code]!.plain]);
		expect(target.textContent).toContain('Nicht verwendet');
		expect(target.textContent).not.toContain('Verbunden');
		expect(buttons()).toContain('Entfernen');
	});

	it.each(Object.keys(TEXT))('names %s from the environment, with the way there, and offers no removal', async (code) => {
		await render(stored(code, true));
		expect(alerts()).toEqual([TEXT[code]!.env]);
		expect(buttons()).not.toContain('Entfernen');
		expect(buttons()).not.toContain('Speichern');
		expect(target.querySelector('#searxng-url')).toBeNull();
	});

	it('offers no removal of a working URL from the environment either', async () => {
		await render({ configured: { search: true, api_key: true, searxng: true }, searxng_url: 'http://searxng:8080', searxng_problem: null, searxng_from_env: true });
		expect(alerts()).toEqual([]);
		expect(target.textContent).toContain('Verbunden');
		expect(buttons()).not.toContain('Entfernen');
	});
});

describe('the check of a typed URL', () => {
	it.each(Object.keys(TEXT))('names %s with the way on this page', async (code) => {
		await render({ configured: { search: false, api_key: true, searxng: false }, searxng_url: null, searxng_problem: null, searxng_from_env: false },
			{ status: 400, body: { error: 'refused', code: `searxng-${code}` } });
		setSearxngUrl('http://typed.example');
		await settle();
		const check = [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Verbindung testen');
		check!.click();
		await settle();
		expect(alerts()).toEqual([TEXT[code]!.plain]);
		expect(target.textContent).not.toContain('Nicht erreichbar');
	});
});
