import { test, expect, request, type Frame, type Page, type BrowserContext } from '@playwright/test';
import { mintOwnerSessionCookie } from './session-cookie.js';

/**
 * The app's page policy runs no injected script, and artifacts still work because they run in
 * the sandboxed frame endpoint `/_artifact-frame`. Measured on the production build: SvelteKit
 * sets the page policy inside its renderer, so a hooks unit test cannot see it.
 */

const SMOKE_SECRET = process.env['SMOKE_HTTP_SECRET'] ?? 'smoke-test-http-secret-ephemeral';
const CDNS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'unpkg.com', 'cloudflareinsights.com'];
const RENDER = 'lynox-frame-render';
const READY = 'lynox-frame-ready';
// A host no artifact may load images from. Served by a route, so the run needs no network.
const IMG_URL = 'https://img.csp-smoke.test/x.png';
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

// The policy the app had before: inline script allowed. Used only as the positive control that
// the injection below is a real one.
const OLD_POLICY = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:";

function directive(csp: string, name: string): string {
	const d = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name} `) || s === name);
	return d === undefined ? '' : d.slice(name.length).trim();
}

async function authenticate(page: Page): Promise<string> {
	await page.goto('/login');
	const origin = new URL(page.url()).origin;
	await page.context().addCookies([{
		name: 'lynox_session',
		value: mintOwnerSessionCookie(SMOKE_SECRET),
		url: origin,
		httpOnly: true,
		secure: origin.startsWith('https'),
		sameSite: 'Lax',
	}]);
	return origin;
}

/** Record every policy violation of every document, from before its first script runs. */
async function recordViolations(context: BrowserContext): Promise<void> {
	await context.addInitScript(() => {
		const w = window as unknown as { __csp: string[] };
		w.__csp = [];
		document.addEventListener('securitypolicyviolation', (e) => {
			w.__csp.push(`${e.effectiveDirective} ${e.blockedURI}`);
		});
	});
}

const violations = (page: Page | Frame): Promise<string[]> =>
	page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);

interface ArtifactInput { title: string; content: string; type: string }

/**
 * Save the artifacts once, before any page loads: the engine limits API requests per client
 * address, and every page load of the app spends some of that budget, so saves made later in
 * the run can be refused.
 */
async function saveArtifacts(baseURL: string, items: Record<string, ArtifactInput>): Promise<Record<string, string>> {
	const ctx = await request.newContext({
		baseURL,
		extraHTTPHeaders: { Cookie: `lynox_session=${mintOwnerSessionCookie(SMOKE_SECRET)}`, Origin: new URL(baseURL).origin },
	});
	const ids: Record<string, string> = {};
	try {
		for (const [key, a] of Object.entries(items)) {
			let res = await ctx.post('/api/artifacts', { data: a });
			// A run that follows other specs can find the window spent; wait it out once.
			if (res.status() === 429) {
				await new Promise((r) => setTimeout(r, (Number(res.headers()['retry-after'] ?? '60') + 1) * 1000));
				res = await ctx.post('/api/artifacts', { data: a });
			}
			expect(res.status(), await res.text()).toBe(201);
			ids[key] = ((await res.json()) as { id: string }).id;
		}
	} finally {
		await ctx.dispose();
	}
	return ids;
}

/**
 * Open an artifact in the gallery. The engine limits API requests per client address per minute,
 * and on the smoke stack every page of every spec comes from one address; when the list request
 * was refused, wait for the window and load once more, so the test measures the frame and not the
 * limiter.
 */
async function openArtifact(page: Page, id: string): Promise<void> {
	let retryAfter = 0;
	const onResponse = (r: import('@playwright/test').Response): void => {
		if (r.status() === 429 && r.url().includes('/api/')) retryAfter = Number(r.headers()['retry-after'] ?? '60');
	};
	page.on('response', onResponse);
	try {
		await page.goto(`/app/artifacts?id=${id}`);
		const dialog = page.locator('[role="dialog"][aria-modal="true"]');
		try {
			await dialog.waitFor({ timeout: 8_000 });
		} catch {
			if (retryAfter === 0) throw new Error('the artifact did not open, and no request was refused');
			await page.waitForTimeout((retryAfter + 1) * 1000);
			await page.goto(`/app/artifacts?id=${id}`);
			await dialog.waitFor({ timeout: 10_000 });
		}
	} finally {
		page.off('response', onResponse);
	}
}

const frames = (page: Page): Frame[] => page.frames().filter((f) => f.url().includes('/_artifact-frame'));

async function waitForFrames(page: Page, n: number): Promise<Frame[]> {
	await expect.poll(() => frames(page).length, { timeout: 10_000 }).toBe(n);
	return frames(page);
}

/** The text of `#m` in a frame, once the frame has rendered it. */
async function marker(f: Frame): Promise<string> {
	await f.waitForSelector('#m', { timeout: 10_000 });
	return f.evaluate(() => document.getElementById('m')?.textContent ?? '');
}

/** Inject a frame on the endpoint into the app page, the way markup that got past the sanitizer would. */
async function injectEndpointFrame(page: Page, id: string, sandbox: boolean): Promise<Frame> {
	await page.evaluate(({ id, sandbox }) => {
		const f = document.createElement('iframe');
		f.id = id;
		if (sandbox) f.setAttribute('sandbox', 'allow-scripts');
		f.src = '/_artifact-frame';
		document.body.appendChild(f);
	}, { id, sandbox });
	const handle = await page.waitForSelector(`#${id}`);
	await expect.poll(async () => (await handle.contentFrame())?.url() ?? '').toContain('/_artifact-frame');
	const frame = (await handle.contentFrame())!;
	await frame.waitForLoadState('load');
	return frame;
}

/** Post a render to an injected endpoint frame from the app page (its parent, the app origin). */
async function renderFromParent(page: Page, id: string, html: string): Promise<void> {
	await page.evaluate(({ id, html, type }) => {
		(document.getElementById(id) as HTMLIFrameElement).contentWindow!.postMessage({ type, html }, '*');
	}, { id, html, type: RENDER });
}

const PROBE_URL = 'https://cdn.jsdelivr.net/npm/csp-smoke-probe@1.0.0/probe.js';
const BUBBLE_INLINE = '<div id="m" style="height:640px">waiting</div><script>document.getElementById("m").textContent="inline-ran"</script>';
const BUBBLE_CDN = `<script src="${PROBE_URL}"></script><div id="m"></div><script>document.getElementById("m").textContent=window.__cdnProbe?"cdn-ran":"cdn-missing"</script>`;
const BUBBLE_ONLOAD = '<body onload="document.getElementById(\'m\').textContent=\'onload-ran\'"><div id="m"></div></body>';
const SAME = '<div id="m">same</div>';
// Markup shaped like a card with its frame slot, without the view's own marker: what a mail or a
// reply can carry through the sanitizer.
const FORGED = '<div class="artifact-container" data-html="PHAgaWQ9Im0iPmZvcmdlZDwvcD4="><div class="artifact-frame-slot" data-x="1"></div></div>';
const fence = (body: string): string => ['```artifact', body, '```', ''].join('\n');

const ARTIFACTS: Record<string, ArtifactInput> = {
	origin: {
		title: 'Origin probe', type: 'html',
		content: '<div id="m">waiting</div><script>document.getElementById("m").textContent="ran"</script>',
	},
	bubbles: { title: 'Bubbles', type: 'markdown', content: ['# Bubbles', '', fence(BUBBLE_INLINE), fence(BUBBLE_CDN), fence(BUBBLE_ONLOAD)].join('\n') },
	gallery: {
		title: 'Gallery', type: 'html',
		content: '<html><body onload="document.getElementById(\'o\').textContent=\'onload-ran\'"><div id="m"></div><div id="o"></div>'
			+ `<script src="${PROBE_URL}"></script>`
			+ '<script>document.getElementById("m").textContent=window.__cdnProbe?"inline+cdn-ran":"cdn-missing"</script></body></html>',
	},
	print: {
		title: 'Print me', type: 'html',
		content: '<html><body><p id="m">printable</p><script>window.__artifactRan=1</script></body></html>',
	},
	forged: { title: 'Forged', type: 'markdown', content: ['# Forged', '', FORGED, '', fence(SAME), fence(SAME)].join('\n') },
};

let ids: Record<string, string> = {};

// A file-level hook: it runs before the first test of the file, and so before the first page load spends API budget.
test.beforeAll(async ({ baseURL }) => {
	test.setTimeout(150_000);
	ids = await saveArtifacts(baseURL ?? 'http://localhost:3333', ARTIFACTS);
});


test.describe('artifact frames', () => {
	// Room for one wait on the request limiter (see openArtifact).
	test.describe.configure({ timeout: 120_000 });

	test('(c) an artifact runs with an opaque origin: no storage, no parent DOM', async ({ page }) => {
		await authenticate(page);
		await openArtifact(page, ids['origin']!);
		const [f] = await waitForFrames(page, 1);
		expect(await marker(f!)).toBe('ran');
		const probe = await f!.evaluate(() => {
			const throws = (fn: () => unknown): boolean => { try { fn(); return false; } catch { return true; } };
			return {
				origin: self.origin,
				storage: throws(() => window.localStorage.getItem('x')),
				parentDom: throws(() => window.parent.document.title),
			};
		});
		expect(probe).toEqual({ origin: 'null', storage: true, parentDom: true });
	});

	test('(d) an injected endpoint frame without a sandbox attribute is still opaque and is sent nothing', async ({ page }) => {
		// Any page of the app under its page policy will do; the login page spends no API budget.
		await page.goto('/login');
		const f = await injectEndpointFrame(page, 'nosandbox', false);
		expect(await f.evaluate(() => self.origin)).toBe('null');
		await page.waitForTimeout(500);
		// Still the bootstrap: the app sent this unregistered frame no document.
		expect(await f.evaluate(() => [...document.body.children].map((e) => e.tagName))).toEqual(['SCRIPT']);
	});

	test('(e) a render from another window is ignored, the first render from the parent is taken, a second one ignored', async ({ page }) => {
		await page.goto('/login');
		const target = await injectEndpointFrame(page, 'target', true);
		// A same-origin window that is not the frame's parent: an about:blank frame of the app.
		await page.evaluate(() => {
			const b = document.createElement('iframe');
			b.id = 'stranger';
			document.body.appendChild(b);
		});
		const stranger = (await (await page.waitForSelector('#stranger')).contentFrame())!;
		await stranger.evaluate((type) => {
			const t = parent.document.getElementById('target') as HTMLIFrameElement;
			t.contentWindow!.postMessage({ type, html: '<p id="m">stranger</p>' }, '*');
		}, RENDER);
		await page.waitForTimeout(300);
		expect(await target.evaluate(() => document.getElementById('m'))).toBeNull();

		await renderFromParent(page, 'target', '<p id="m">first</p>');
		expect(await marker(target)).toBe('first');
		await renderFromParent(page, 'target', '<p id="m">second</p>');
		await page.waitForTimeout(300);
		expect(await marker(target)).toBe('first');
	});

	test('(i) the endpoint header alone blocks a fetch from the frame', async ({ page }) => {
		await page.goto('/login');
		const f = await injectEndpointFrame(page, 'fetcher', true);
		// No artifact meta in this document: only the response header can block it. The listener
		// is part of the document, because writing it drops the listeners of the one before.
		await renderFromParent(page, 'fetcher', '<p id="m">pending</p><p id="v"></p><script>'
			+ 'document.addEventListener("securitypolicyviolation",function(e){document.getElementById("v").textContent=e.effectiveDirective});'
			+ 'fetch("/api/health").then(function(){document.getElementById("m").textContent="fetched"},function(){document.getElementById("m").textContent="blocked"})</script>');
		await expect.poll(() => f.evaluate(() => document.getElementById('m')?.textContent)).toBe('blocked');
		expect(await f.evaluate(() => document.getElementById('v')?.textContent)).toBe('connect-src');
	});

	test('(k) the endpoint header alone blocks an image from another host, and no request leaves the frame', async ({ page }) => {
		const hits: string[] = [];
		await page.context().route('https://img.csp-smoke.test/**', (route) => {
			hits.push(route.request().url());
			return route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1PX });
		});
		await page.goto('/login');
		const f = await injectEndpointFrame(page, 'imager', true);
		// No artifact meta in this document: only the response header can block it.
		await renderFromParent(page, 'imager', '<p id="v"></p><p id="m">pending</p><script>'
			+ 'document.addEventListener("securitypolicyviolation",function(e){document.getElementById("v").textContent=e.effectiveDirective+" "+e.blockedURI});'
			+ '</script>'
			+ `<img src="${IMG_URL}" onload="document.getElementById('m').textContent='loaded'" onerror="document.getElementById('m').textContent='blocked'">`);
		await expect.poll(() => f.evaluate(() => document.getElementById('m')?.textContent)).toBe('blocked');
		const v = await f.evaluate(() => document.getElementById('v')?.textContent ?? '');
		expect(v.startsWith('img-src ')).toBe(true);
		expect(v).toContain('img.csp-smoke.test');
		await page.waitForTimeout(300);
		expect(hits).toEqual([]);

		// Control, same run: the route does see a request to that host when nothing blocks it.
		const probe = await page.context().newPage();
		await probe.goto(IMG_URL);
		await probe.close();
		expect(hits).toEqual([IMG_URL]);
	});

	test('(l) a document the frame is navigated to does not know its key and is sent nothing; the endpoint at its own key is (control)', async ({ page }) => {
		await authenticate(page);
		await openArtifact(page, ids['origin']!);
		const [f] = await waitForFrames(page, 1);
		expect(await marker(f!)).toBe('ran');
		const src = (await (await f!.frameElement()).getAttribute('src')) ?? '';
		const key = src.split('#')[1] ?? '';
		expect(key).toMatch(/^[0-9a-f]{32}$/);

		// The frame navigates itself, as a link in the artifact would. The page policy allows only
		// same-origin documents in a frame, and only the endpoint may be framed, so the document it
		// can reach is the endpoint at a URL without the key.
		const navigate = async (url: string): Promise<void> => {
			await f!.evaluate((u) => { setTimeout(() => { location.href = u; }, 0); }, url);
			await expect.poll(() => f!.url(), { timeout: 10_000 }).toContain(url.split('#')[0]!);
			await f!.waitForLoadState('load');
		};

		await navigate('/_artifact-frame?nav=1');
		// Its own ready carried an empty key; one more without any key field at all.
		await f!.evaluate((type) => { parent.postMessage({ type }, '*'); }, READY);
		await page.waitForTimeout(500);
		expect(await f!.evaluate(() => [...document.body.children].map((e) => e.tagName))).toEqual(['SCRIPT']);
		expect(await f!.evaluate(() => document.getElementById('m'))).toBeNull();

		// Control, same frame: the endpoint loaded with the frame's key gets the artifact again.
		await navigate(`/_artifact-frame?nav=2#${key}`);
		expect(await marker(f!)).toBe('ran');
	});

	test('(f) inline, CDN and onload-only scripts run in chat bubbles, which resize, and in the gallery', async ({ page }) => {
		await authenticate(page);
		// The CDN script is served by the test, so the run needs no network; the request only
		// reaches this route if the frame's policy allowed it.
		await page.context().route(PROBE_URL, (route) =>
			route.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.__cdnProbe = 1;' }));

		await openArtifact(page, ids['bubbles']!);
		const toolbars = page.locator('.artifact-container[lynox-own] > .artifact-toolbar');
		await expect(toolbars).toHaveCount(3);
		for (let i = 0; i < 3; i++) await toolbars.nth(i).click();
		const fs = await waitForFrames(page, 3);
		const texts = await Promise.all(fs.map(marker));
		expect([...texts].sort()).toEqual(['cdn-ran', 'inline-ran', 'onload-ran']);
		const tall = fs[texts.indexOf('inline-ran')]!;
		const el = (await tall.frameElement());
		await expect.poll(async () => parseFloat(await el.evaluate((e) => (e as HTMLElement).style.height || '0'))).toBeGreaterThanOrEqual(640);

		await openArtifact(page, ids['gallery']!);
		const [g] = await waitForFrames(page, 1);
		expect(await marker(g!)).toBe('inline+cdn-ran');
		await expect.poll(() => g!.evaluate(() => document.getElementById('o')?.textContent)).toBe('onload-ran');
	});

	test('(g) print opens a sandboxed popup that prints and closes, and nothing runs in the app origin', async ({ page }) => {
		await authenticate(page);
		await page.context().addInitScript(() => {
			window.print = () => { (window as unknown as { __printed: boolean }).__printed = true; };
		});
		const printHeaders: string[] = [];
		page.context().on('response', (r) => {
			if (r.url().includes('/_artifact-frame?print')) printHeaders.push(r.headers()['content-security-policy'] ?? '');
		});
		await openArtifact(page, ids['print']!);
		const popupP = page.waitForEvent('popup');
		await page.getByRole('button', { name: /^(Drucken|Print)$/ }).click();
		const popup = await popupP;
		await popup.waitForFunction(() => (window as unknown as { __printed?: boolean }).__printed === true);
		expect(await popup.evaluate(() => ({
			origin: self.origin,
			text: document.getElementById('m')?.textContent,
			ran: (window as unknown as { __artifactRan?: number }).__artifactRan,
		}))).toEqual({ origin: 'null', text: 'printable', ran: undefined });
		expect(await page.evaluate(() => (window as unknown as { __artifactRan?: number }).__artifactRan)).toBeUndefined();
		expect(printHeaders).toHaveLength(1);
		expect(printHeaders[0]!.startsWith('sandbox allow-scripts allow-modals;')).toBe(true);
		const closed = popup.waitForEvent('close');
		await popup.evaluate(() => window.dispatchEvent(new Event('afterprint')));
		await closed;
	});

	test('(h) a foreign opener cannot render into the endpoint; the app origin can (control)', async ({ page, context, baseURL }) => {
		const own = new URL(baseURL ?? 'http://localhost:3333');
		const foreign = new URL(own.href);
		foreign.hostname = own.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
		const endpoint = `${own.origin}/_artifact-frame?print`;

		const tryRender = async (openerOrigin: string): Promise<string | null> => {
			const opener = await context.newPage();
			await opener.goto(`${openerOrigin}/login`);
			const popupP = opener.waitForEvent('popup');
			await opener.evaluate((url) => { (window as unknown as { __w: Window | null }).__w = window.open(url, '_blank'); }, endpoint);
			const popup = await popupP;
			await popup.waitForLoadState('load');
			await opener.evaluate((type) => {
				(window as unknown as { __w: Window }).__w.postMessage({ type, html: '<p id="m">rendered</p>' }, '*');
			}, RENDER);
			await popup.waitForTimeout(500);
			const text = await popup.evaluate(() => document.getElementById('m')?.textContent ?? null);
			await popup.close();
			await opener.close();
			return text;
		};
		expect(await tryRender(foreign.origin)).toBeNull();
		expect(await tryRender(own.origin)).toBe('rendered');
	});

	test('(h) opened top-level without an opener it says nothing and renders nothing, and reflects no query', async ({ page, request }) => {
		await page.addInitScript(() => {
			const w = window as unknown as { __msgs: unknown[] };
			w.__msgs = [];
			window.addEventListener('message', (e) => { w.__msgs.push(e.data); });
		});
		await page.goto('/_artifact-frame');
		await page.evaluate((type) => window.postMessage({ type, html: '<p id="m">self</p>' }, '*'), RENDER);
		await page.waitForTimeout(300);
		const msgs = await page.evaluate(() => (window as unknown as { __msgs: unknown[] }).__msgs);
		// Only the probe's own message: the bootstrap said no `ready`.
		expect(msgs).toEqual([{ type: RENDER, html: '<p id="m">self</p>' }]);
		expect(await page.evaluate(() => document.getElementById('m'))).toBeNull();

		const body = await (await request.get('/_artifact-frame?x=%3Cb%20id%3Dreflected-probe%3E&v=reflected-probe')).text();
		expect(body).not.toContain('reflected-probe');
	});

	test('(j) forged placeholders get nothing, two equal artifacts both render, a theme flip re-renders and keeps a card open', async ({ page }) => {
		await authenticate(page);
		await page.emulateMedia({ colorScheme: 'dark' });
		await openArtifact(page, ids['forged']!);
		const own = page.locator('.artifact-container[lynox-own]');
		await expect(own).toHaveCount(2);
		await expect(page.locator('.artifact-container:not([lynox-own])')).toHaveCount(1);
		await expect(page.locator('.artifact-container:not([lynox-own]) iframe')).toHaveCount(0);
		await own.nth(0).locator('.artifact-toolbar').click();
		await own.nth(1).locator('.artifact-toolbar').click();
		const fs = await waitForFrames(page, 2);
		expect(await Promise.all(fs.map(marker))).toEqual(['same', 'same']);

		// Theme flip on a message with HTML artifacts and no diagram: the frames are rebuilt in the
		// new theme, and the cards stay open.
		const bg = (f: Frame): Promise<string> => f.evaluate(() => getComputedStyle(document.body).backgroundColor);
		expect(await bg(fs[0]!)).toBe('rgb(10, 10, 26)');
		await page.emulateMedia({ colorScheme: 'light' });
		await expect.poll(async () => {
			const now = frames(page);
			if (now.length !== 2) return 'frames:' + now.length;
			try { return (await Promise.all(now.map(bg))).join('|'); } catch { return 'loading'; }
		}, { timeout: 10_000 }).toBe('rgb(255, 255, 255)|rgb(255, 255, 255)');
		await expect(own.nth(0)).not.toHaveClass(/artifact-collapsed/);
		await expect(own.nth(1)).not.toHaveClass(/artifact-collapsed/);
	});
});

test.describe('app page policy', () => {
	test('a page carries a nonce script policy without inline script or CDNs, and may not be framed', async ({ request }) => {
		for (const path of ['/login', '/app']) {
			const res = await request.get(path, { headers: { Cookie: `lynox_session=${mintOwnerSessionCookie(SMOKE_SECRET)}` } });
			expect(res.status(), path).toBe(200);
			const csp = res.headers()['content-security-policy'] ?? '';
			const script = directive(csp, 'script-src');
			expect(script, path).toMatch(/'nonce-[^']+'/);
			expect(script, path).not.toContain('unsafe-inline');
			for (const cdn of CDNS) expect(csp, `${path}: ${cdn}`).not.toContain(cdn);
			expect(directive(csp, 'frame-ancestors'), path).toBe("'none'");
			expect(directive(csp, 'frame-src'), path).toBe("'self'");
		}
	});

	test('the frame endpoint carries its sandbox, the artifact policy and same-origin framing', async ({ request }) => {
		const frame = (await request.get('/_artifact-frame')).headers()['content-security-policy'] ?? '';
		expect(frame.startsWith('sandbox allow-scripts;')).toBe(true);
		expect(frame).not.toContain('allow-modals');
		expect(directive(frame, 'script-src')).toContain("'unsafe-inline'");
		expect(directive(frame, 'default-src')).toBe("'none'");
		expect(directive(frame, 'frame-ancestors')).toBe("'self'");
		const print = (await request.get('/_artifact-frame?print')).headers()['content-security-policy'] ?? '';
		expect(print.startsWith('sandbox allow-scripts allow-modals;')).toBe(true);
	});

	test('a request to be framed is refused on every path but the frame endpoint', async ({ request }) => {
		for (const dest of ['iframe', 'frame']) {
			for (const path of ['/app', '/login', '/auth/magic?token=x', '/']) {
				const res = await request.get(path, { headers: { 'Sec-Fetch-Dest': dest }, maxRedirects: 0 });
				expect(res.status(), `${dest} ${path}`).toBe(403);
				expect(await res.text(), `${dest} ${path}`).toBe('lynox cannot be shown inside another page. Open it in its own browser tab.');
			}
			expect((await request.get('/_artifact-frame', { headers: { 'Sec-Fetch-Dest': dest } })).status()).toBe(200);
		}
		// Control: the same page as a document loads.
		expect((await request.get('/login', { headers: { 'Sec-Fetch-Dest': 'document' } })).status()).toBe(200);
	});

	test('(a) login and the app load without a single policy violation', async ({ page }) => {
		await recordViolations(page.context());
		await page.goto('/login');
		await page.waitForLoadState('networkidle');
		expect(await violations(page)).toEqual([]);
		await authenticate(page);
		for (const path of ['/app', '/app/artifacts']) {
			await page.goto(path);
			await page.waitForLoadState('networkidle');
			expect(new URL(page.url()).pathname, 'not redirected to login').toBe(path);
			expect(await violations(page), path).toEqual([]);
		}
	});

	test('(a) the theme script in the page runs on its own, before any bundle', async ({ page }) => {
		await authenticate(page);
		await page.route('**/_app/immutable/**', (route) => route.abort());
		await page.goto('/app');
		await expect(page.locator('html')).toHaveAttribute('data-theme', /^(light|dark)$/);
	});

	test('(b) an injected inline handler does not run, and does run under the old policy', async ({ page }) => {
		await recordViolations(page.context());
		await authenticate(page);
		const inject = async (): Promise<unknown> => {
			await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<img id="inj" src="/nope-404.png" onerror="window.__pwned=1">'));
			await page.waitForFunction(() => {
				const img = document.getElementById('inj') as HTMLImageElement | null;
				return img !== null && img.complete;
			});
			await page.waitForTimeout(200);
			return page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned);
		};

		await page.goto('/app');
		await page.waitForLoadState('networkidle');
		expect(await inject()).toBeUndefined();
		const v = (await violations(page)).filter((s) => s.startsWith('script-src'));
		expect(v).toHaveLength(1);

		// Positive control, same run: the old policy on the same page lets the same injection run.
		await page.route('**/app', async (route) => {
			const res = await route.fetch();
			await route.fulfill({ response: res, headers: { ...res.headers(), 'content-security-policy': OLD_POLICY } });
		});
		await page.goto('/app');
		await page.waitForLoadState('networkidle');
		expect(await inject()).toBe(1);
	});
});
