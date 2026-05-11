// === Inbox drafts HTTP client ===
//
// Pure async fetchers around `/api/inbox/items/:id/draft` and
// `/api/inbox/drafts/:id`. Mirrors the inbox-rules client — `apiBase` is
// a parameter so this module has no `$state` import and stays unit-
// testable in the engine-root vitest config.
//
// Wire shapes mirror `core/src/types/inbox.ts InboxDraft`. Keep in sync
// when the engine adds a draft field.

export interface InboxDraft {
	id: string;
	tenantId: string;
	itemId: string;
	bodyMd: string;
	generatedAt: string;
	generatorVersion: string;
	userEditsCount: number;
	supersededBy?: string | undefined;
}

export interface CreateDraftBody {
	bodyMd: string;
	generatorVersion: string;
	supersededDraftId?: string | undefined;
	generatedAt?: string | undefined;
}

/** Returns the active (non-superseded) draft for an item, or null if none. */
export async function getItemDraft(
	apiBase: string,
	itemId: string,
): Promise<InboxDraft | null | undefined> {
	try {
		const res = await fetch(`${apiBase}/inbox/items/${encodeURIComponent(itemId)}/draft`);
		if (!res.ok) return undefined;
		const data = (await res.json()) as { draft: InboxDraft | null };
		return data.draft ?? null;
	} catch {
		return undefined;
	}
}

export async function getDraft(apiBase: string, id: string): Promise<InboxDraft | null> {
	try {
		const res = await fetch(`${apiBase}/inbox/drafts/${encodeURIComponent(id)}`);
		if (!res.ok) return null;
		const data = (await res.json()) as { draft: InboxDraft };
		return data.draft ?? null;
	} catch {
		return null;
	}
}

export async function createDraft(
	apiBase: string,
	itemId: string,
	body: CreateDraftBody,
): Promise<InboxDraft | null> {
	try {
		const res = await fetch(`${apiBase}/inbox/items/${encodeURIComponent(itemId)}/draft`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { draft: InboxDraft };
		return data.draft ?? null;
	} catch {
		return null;
	}
}

export interface GeneratedDraft {
	bodyMd: string;
	generatorVersion: string;
	bodyTruncated: boolean;
}

/**
 * Why discriminated: callers need to pick between "fall back to a manual
 * starter and keep going" (recoverable) and "surface an error and abort"
 * (terminal). `aborted` is the "pane was closed mid-flight" sentinel —
 * not really a failure, the caller should suppress all UI feedback.
 */
export type GenerateDraftFailure =
	| { kind: 'unavailable' }
	| { kind: 'unsupported' }
	| { kind: 'no_body' }
	| { kind: 'not_found' }
	| { kind: 'aborted' }
	| { kind: 'network' };

export type DraftTone = 'shorter' | 'formal' | 'warmer' | 'regenerate';

export interface GenerateDraftOpts {
	/** Tone modifier for the regenerate flow. Omit for first-time generation. */
	tone?: DraftTone | undefined;
	/** Previous draft body to rewrite — typically the live editor buffer. */
	previousBodyMd?: string | undefined;
}

/**
 * Ask the backend to LLM-draft a reply for an item. Returns the
 * generated body + version stamp on success. Discriminated failures
 * let the caller decide between "fall back to manual starter" (503 /
 * 501 / 422) and "abort + toast" (404 / network).
 *
 * When `opts.tone` + `opts.previousBodyMd` are both set, the backend
 * rewrites the previous draft with the chosen modifier — the
 * Kürzer / Förmlicher / Wärmer / Regenerate flow.
 */
export async function generateDraft(
	apiBase: string,
	itemId: string,
	opts: GenerateDraftOpts = {},
): Promise<{ ok: true; draft: GeneratedDraft } | { ok: false; reason: GenerateDraftFailure }> {
	try {
		const init: RequestInit = { method: 'POST' };
		if (opts.tone !== undefined || opts.previousBodyMd !== undefined) {
			init.headers = { 'Content-Type': 'application/json' };
			const body: Record<string, string> = {};
			if (opts.tone !== undefined) body['tone'] = opts.tone;
			if (opts.previousBodyMd !== undefined) body['previousBodyMd'] = opts.previousBodyMd;
			init.body = JSON.stringify(body);
		}
		const res = await fetch(`${apiBase}/inbox/items/${encodeURIComponent(itemId)}/draft/generate`, init);
		if (res.ok) {
			const data = (await res.json()) as Partial<GeneratedDraft>;
			if (typeof data.bodyMd === 'string' && typeof data.generatorVersion === 'string') {
				return {
					ok: true,
					draft: {
						bodyMd: data.bodyMd,
						generatorVersion: data.generatorVersion,
						bodyTruncated: data.bodyTruncated === true,
					},
				};
			}
			// Shape-mismatch on a 200 response — likely a backend rollback or
			// in-flight contract change. Surface as recoverable so the manual
			// fallback runs rather than blaming the user's network.
			return { ok: false, reason: { kind: 'unavailable' } };
		}
		switch (res.status) {
			case 404: return { ok: false, reason: { kind: 'not_found' } };
			case 501: return { ok: false, reason: { kind: 'unsupported' } };
			case 422: return { ok: false, reason: { kind: 'no_body' } };
			case 503: return { ok: false, reason: { kind: 'unavailable' } };
			default:  return { ok: false, reason: { kind: 'network' } };
		}
	} catch {
		return { ok: false, reason: { kind: 'network' } };
	}
}

export async function updateDraft(
	apiBase: string,
	id: string,
	bodyMd: string,
): Promise<InboxDraft | null> {
	try {
		const res = await fetch(`${apiBase}/inbox/drafts/${encodeURIComponent(id)}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ bodyMd }),
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { draft: InboxDraft };
		return data.draft ?? null;
	} catch {
		return null;
	}
}

/**
 * `aborted` is the "pane was closed mid-flight" sentinel — silent in
 * the UI, distinct from a real network failure.
 */
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
 * Pull the full mail body for an item from the provider and overwrite
 * the cached snippet. Subsequent `/generate` calls then see the full
 * body as context. Discriminated failures let the UI surface the right
 * copy for each error mode (provider unconfigured, registry missing,
 * mail no longer on server, etc.).
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
