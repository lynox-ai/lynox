// === Inbox body-refresh HTTP client ===
//
// Pulls the full mail body for a reading-pane item on demand. `apiBase` is a
// parameter so this module has no `$state` import and stays unit-testable in
// the engine-root vitest config. (The reply/compose draft client was removed
// when replying moved into chat — see the inbox→chat refactor.)

export type RefreshBodyFailure =
	| { kind: 'unavailable' }
	| { kind: 'unsupported' }
	| { kind: 'not_registered' }
	| { kind: 'empty_body' }
	| { kind: 'not_found' }
	| { kind: 'fetch_failed' }
	| { kind: 'aborted' }
	| { kind: 'network' };

/**
 * Pull the full mail body for an item from the provider and overwrite the
 * cached snippet, so the reading pane can show the complete message.
 * Discriminated failures let the UI surface the right copy for each error mode
 * (provider unconfigured, registry missing, mail no longer on server, etc.).
 */
export async function refreshItemBody(
	apiBase: string,
	itemId: string,
): Promise<{ ok: true; bodyMd: string } | { ok: false; reason: RefreshBodyFailure }> {
	try {
		const res = await fetch(`${apiBase}/inbox/items/${encodeURIComponent(itemId)}/body/refresh`, {
			method: 'POST',
		});
		if (res.ok) {
			const data = (await res.json()) as { bodyMd?: string };
			if (typeof data.bodyMd !== 'string') return { ok: false, reason: { kind: 'network' } };
			return { ok: true, bodyMd: data.bodyMd };
		}
		switch (res.status) {
			case 404: return { ok: false, reason: { kind: 'not_found' } };
			case 501: return { ok: false, reason: { kind: 'unsupported' } };
			case 422: {
				// Backend returns a structured `reason` field that the UI
				// reads directly — no fragile error-string matching.
				const body = await res.json().catch(() => null) as { reason?: string } | null;
				const kind = body?.reason === 'empty_body' ? 'empty_body' : 'not_registered';
				return { ok: false, reason: { kind } };
			}
			case 502: return { ok: false, reason: { kind: 'fetch_failed' } };
			case 503: return { ok: false, reason: { kind: 'unavailable' } };
			default:  return { ok: false, reason: { kind: 'network' } };
		}
	} catch {
		return { ok: false, reason: { kind: 'network' } };
	}
}
