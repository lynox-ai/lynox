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

/**
 * Ask the backend to LLM-draft a reply for an item. Returns the
 * generated body + version stamp on success. Discriminated failures
 * let the caller decide between "fall back to manual starter" (503 /
 * 501 / 422) and "abort + toast" (404 / network).
 */
export async function generateDraft(
	apiBase: string,
	itemId: string,
): Promise<{ ok: true; draft: GeneratedDraft } | { ok: false; reason: GenerateDraftFailure }> {
	try {
		const res = await fetch(`${apiBase}/inbox/items/${encodeURIComponent(itemId)}/draft/generate`, {
			method: 'POST',
		});
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
