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
