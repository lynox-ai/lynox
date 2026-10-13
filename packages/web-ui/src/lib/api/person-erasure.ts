// === Person erasure HTTP client ===
//
// Pure async fetchers around `POST /api/privacy/person-erasure[/preview]`, plus the one
// decision the panel must not get wrong: which answer may be shown as "erased". Kept off the
// Svelte store, like `subject-footprint.ts`, so it is testable from the engine-root vitest.
//
// Wire shapes mirror `core/src/core/person-erasure.ts` — keep in sync when it changes.

/** What the erasure does not reach. Same keys, same order as the engine's list. */
export const PERSON_ERASURE_NOT_COVERED = [
	'backups',
	'exports',
	'chat_history',
	'mail',
	'crm_records',
	'flat_file_memory',
	'tasks_and_automations',
	'files',
	'debug_capture',
	'measurement_logs',
	'audit_log',
] as const;
export type PersonErasureNotCovered = (typeof PERSON_ERASURE_NOT_COVERED)[number];

export type PersonErasureStep = 'durable_knowledge' | 'memories_legacy' | 'memories_engine' | 'subject';

export interface PersonErasureEntry {
	id: string;
	status: string;
	text: string;
	matchedBy: 'subject' | 'hint' | 'mention';
}

export interface PersonErasureMemory {
	id: string;
	text: string;
	matchedBy: 'subject' | 'mention';
}

export interface PersonErasurePreview {
	subject: { id: string; name: string; aliases: string[] };
	entries: PersonErasureEntry[];
	memories: PersonErasureMemory[];
	blocksMentioning: Array<'profile' | 'playbook'>;
	plan: string;
	notCovered: PersonErasureNotCovered[];
}

export interface PersonErasureResult {
	erased: boolean;
	done: PersonErasureStep[];
	failed: PersonErasureStep | null;
	counts: { entries: number; legacyMemories: number; memoryStubs: number; subjects: number };
	left: { entries: number; memories: number; blocks: Array<'profile' | 'playbook'> };
	notCovered: PersonErasureNotCovered[];
}

/** What the panel shows for an answer. `erased` only for a 200 that says so. */
export type PersonErasureOutcome =
	| { kind: 'erased'; result: PersonErasureResult }
	| { kind: 'partial'; result: PersonErasureResult }
	| { kind: 'changed' }
	| { kind: 'busy' }
	| { kind: 'unreadable' }
	| { kind: 'forbidden' }
	| { kind: 'failed' };

type Answer = { status: number; body: Record<string, unknown> | null };

async function post(apiBase: string, path: string, body: unknown): Promise<Answer> {
	try {
		const res = await fetch(`${apiBase}${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			cache: 'no-store',
		});
		let parsed: Record<string, unknown> | null = null;
		try { parsed = (await res.json()) as Record<string, unknown>; } catch { parsed = null; }
		return { status: res.status, body: parsed };
	} catch {
		return { status: 0, body: null };
	}
}

function refusal(a: Answer): PersonErasureOutcome {
	const code = a.body?.['code'];
	if (a.status === 403) return { kind: 'forbidden' };
	if (code === 'plan_changed') return { kind: 'changed' };
	if (code === 'runs_active' || code === 'erasure_in_progress') return { kind: 'busy' };
	if (code === 'key_unavailable') return { kind: 'unreadable' };
	return { kind: 'failed' };
}

function isResult(b: Record<string, unknown> | null): b is Record<string, unknown> & PersonErasureResult {
	return b !== null && typeof b['erased'] === 'boolean' && Array.isArray(b['done']) && Array.isArray(b['notCovered']);
}

export async function previewPersonErasure(
	apiBase: string,
	subjectId: string,
): Promise<{ preview: PersonErasurePreview } | { refused: PersonErasureOutcome }> {
	const a = await post(apiBase, '/privacy/person-erasure/preview', { subjectId });
	if (a.status === 200 && a.body !== null && typeof a.body['plan'] === 'string') {
		return { preview: a.body as unknown as PersonErasurePreview };
	}
	return { refused: refusal(a) };
}

/**
 * Map an erase answer to what the panel shows. A 500 that carries a result is `partial`, never
 * `erased`, whatever its body says; only a 200 with `erased: true` is `erased`.
 */
export function erasureOutcome(a: Answer): PersonErasureOutcome {
	if (isResult(a.body)) {
		if (a.status === 200 && a.body.erased === true) return { kind: 'erased', result: a.body };
		if (a.status === 500 || a.body.erased === false) return { kind: 'partial', result: a.body };
	}
	return refusal(a);
}

export async function erasePerson(
	apiBase: string,
	input: { subjectId: string; plan: string; entryIds: string[]; memoryIds: string[] },
): Promise<PersonErasureOutcome> {
	return erasureOutcome(await post(apiBase, '/privacy/person-erasure', { ...input, confirm: 'ERASE_PERSON' }));
}
