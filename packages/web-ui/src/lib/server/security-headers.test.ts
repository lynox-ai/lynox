import { describe, it, expect } from 'vitest';
import { applySecurityHeaders, refuseFraming } from './security-headers.js';
import { APP_CSP_DIRECTIVES, APP_FALLBACK_CSP, serializeCsp } from './app-csp.js';
import config from '../../../svelte.config.js';

const CDNS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'unpkg.com', 'cloudflareinsights.com'];

function directive(csp: string, name: string): string {
	const d = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name} `));
	return d === undefined ? '' : d.slice(name.length).trim();
}

describe('the request refusal for frames', () => {
	it.each(['iframe', 'frame', 'IFRAME'])('refuses %s on app paths with 403 before any route runs', (dest) => {
		for (const path of ['/app', '/login', '/auth/magic', '/']) {
			const res = refuseFraming(path, dest);
			expect(res?.status, path).toBe(403);
			expect(res?.headers.get('X-Frame-Options')).toBe('DENY');
		}
	});

	it('lets the frame endpoint be framed and every other destination through', () => {
		expect(refuseFraming('/_artifact-frame', 'iframe')).toBeNull();
		expect(refuseFraming('/app', 'document')).toBeNull();
		expect(refuseFraming('/app', 'empty')).toBeNull();
		expect(refuseFraming('/app', null)).toBeNull();
	});
});

describe('the security headers', () => {
	it('set the strict fallback policy when a response has none', () => {
		const h = new Headers({ 'Content-Type': 'text/html' });
		applySecurityHeaders('/some-error', h);
		expect(h.get('Content-Security-Policy')).toBe(APP_FALLBACK_CSP);
		expect(directive(APP_FALLBACK_CSP, 'script-src')).toBe("'self'");
		expect(directive(APP_FALLBACK_CSP, 'frame-ancestors')).toBe("'none'");
		expect(directive(APP_FALLBACK_CSP, 'object-src')).toBe("'none'");
	});

	it('never replace a policy that is already there', () => {
		const h = new Headers({ 'Content-Type': 'text/html', 'Content-Security-Policy': "script-src 'self' 'nonce-abc'" });
		applySecurityHeaders('/app', h);
		expect(h.get('Content-Security-Policy')).toBe("script-src 'self' 'nonce-abc'");
		const f = new Headers({ 'Content-Type': 'text/html', 'Content-Security-Policy': 'sandbox allow-scripts' });
		applySecurityHeaders('/_artifact-frame', f);
		expect(f.get('Content-Security-Policy')).toBe('sandbox allow-scripts');
	});

	it('keep HTML out of every cache except the versioned frame endpoint', () => {
		const page = new Headers({ 'Content-Type': 'text/html; charset=utf-8' });
		applySecurityHeaders('/app', page);
		expect(page.get('Cache-Control')).toBe('no-store, must-revalidate');
		const frame = new Headers({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=31536000, immutable' });
		applySecurityHeaders('/_artifact-frame', frame);
		expect(frame.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
	});

	it('deny framing of pages to old browsers too, and allow it only for the endpoint', () => {
		const page = new Headers();
		applySecurityHeaders('/app', page);
		expect(page.get('X-Frame-Options')).toBe('DENY');
		const frame = new Headers();
		applySecurityHeaders('/_artifact-frame', frame);
		expect(frame.get('X-Frame-Options')).toBe('SAMEORIGIN');
	});
});

describe('the page policy handed to SvelteKit', () => {
	it('is the shared directive set, in auto mode, so pages get a nonce', () => {
		expect(config.kit?.csp?.mode).toBe('auto');
		expect(config.kit?.csp?.directives).toBe(APP_CSP_DIRECTIVES);
	});

	it('allows no inline script and no CDN, frames only the app, and is framed by nobody', () => {
		const csp = serializeCsp(APP_CSP_DIRECTIVES);
		expect(directive(csp, 'script-src')).toBe("'self'");
		for (const cdn of CDNS) expect(csp).not.toContain(cdn);
		expect(directive(csp, 'frame-src')).toBe("'self'");
		expect(directive(csp, 'frame-ancestors')).toBe("'none'");
	});
});
