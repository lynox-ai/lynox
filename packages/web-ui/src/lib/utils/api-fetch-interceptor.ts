// === window.fetch interceptor — flips sessionExpired on /api/* 401 ===
//
// Installed once from AppShell on mount. Wraps `window.fetch` and looks
// at every response. Any 401 from a `/api/*` URL flips the global
// `sessionExpired` state so the AppShell banner can offer a re-auth
// CTA — without forcing every view to migrate to a typed wrapper
// up-front.
//
// Idempotent: a re-mount checks `_installed` so we don't stack
// wrappers and double-fire.

import { markSessionExpired } from '../stores/session.svelte.js';

let _installed = false;

export function installApiFetchInterceptor(): void {
	if (_installed || typeof window === 'undefined') return;
	_installed = true;
	const original = window.fetch;
	window.fetch = async function lynoxFetchInterceptor(...args: Parameters<typeof fetch>) {
		const response = await original(...args);
		// Only treat /api/* 401s as session-expired — third-party fetches
		// (analytics, integrations) shouldn't trigger the auth banner.
		if (response.status === 401) {
			const url = typeof args[0] === 'string'
				? args[0]
				: args[0] instanceof URL
					? args[0].href
					: (args[0] as Request).url;
			if (url.includes('/api/')) {
				markSessionExpired();
			}
		}
		return response;
	};
}
