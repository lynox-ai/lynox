// === Subject footprint HTTP client (Record-on-spine R2b) ===
//
// Pure async fetchers around the read-only subject-graph surface
// (`GET /api/subjects`, `GET /api/subjects/:id/footprint`). Kept off the
// Svelte store on purpose — the api base is passed in as a parameter so this
// module has no `$state` import and stays testable from the engine-root
// vitest config (mirrors `inbox-rules.ts`).
//
// Wire shapes mirror `core/src/core/subject-footprint-reader.ts` — keep in
// sync when the reader changes a section's shape.

export interface SubjectListItem {
	id: string;
	kind: string;
	name: string;
}

export interface SubjectFootprintMemory {
	id: string;
	text: string;
	createdAt: string;
	confidence: number;
}

/** A thread on the timeline — the server sends the full ThreadRecord; the view
 *  only reads these fields. */
export interface FootprintThread {
	id: string;
	title: string;
	updated_at: string;
	is_unread?: number;
}

/** A task in the adjacent section — subset of the engine's TaskRecord. */
export interface FootprintTask {
	id: string;
	title: string;
	status: string;
	priority: string;
	due_date: string | null;
}

export type SubjectTimelineEntry =
	| {
			type: 'record';
			occurredAt: string | null;
			occurredAtIsEventTime: boolean;
			collection: string;
			matchedColumns: string[];
			row: Record<string, unknown>;
	  }
	| {
			type: 'thread';
			occurredAt: string;
			thread: FootprintThread;
	  };

export interface SubjectFootprintTruncation {
	records: boolean;
	threads: boolean;
	memories: boolean;
	tasks: boolean;
}

export interface SubjectFootprint {
	subject: { id: string; kind: string; name: string };
	timeline: SubjectTimelineEntry[];
	memories: SubjectFootprintMemory[];
	tasks: FootprintTask[];
	truncated: SubjectFootprintTruncation;
}

export async function listSubjects(
	apiBase: string,
	opts?: { q?: string; limit?: number; offset?: number },
): Promise<{ subjects: SubjectListItem[]; total: number } | null> {
	const params = new URLSearchParams();
	if (opts?.q) params.set('q', opts.q);
	if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
	if (opts?.offset) params.set('offset', String(opts.offset));
	const qs = params.toString();
	try {
		const res = await fetch(`${apiBase}/subjects${qs ? `?${qs}` : ''}`);
		if (!res.ok) return null;
		const data = (await res.json()) as { subjects?: SubjectListItem[]; total?: number };
		return {
			subjects: Array.isArray(data.subjects) ? data.subjects : [],
			total: typeof data.total === 'number' ? data.total : 0,
		};
	} catch {
		return null;
	}
}

export async function fetchSubjectFootprint(
	apiBase: string,
	id: string,
	opts?: { limit?: number },
): Promise<SubjectFootprint | null> {
	const params = new URLSearchParams();
	if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
	const qs = params.toString();
	try {
		const res = await fetch(
			`${apiBase}/subjects/${encodeURIComponent(id)}/footprint${qs ? `?${qs}` : ''}`,
		);
		if (!res.ok) return null;
		return (await res.json()) as SubjectFootprint;
	} catch {
		return null;
	}
}
