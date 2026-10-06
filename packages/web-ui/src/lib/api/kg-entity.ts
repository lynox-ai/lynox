/** The relations of one knowledge-graph entity, or `null` when they could not be read. Never rejects. */
export async function fetchEntityRelations<R>(apiBase: string, id: string): Promise<R[] | null> {
	try {
		const res = await fetch(`${apiBase}/kg/entities/${id}`);
		if (!res.ok) return null;
		const data = (await res.json()) as { relations?: R[] };
		return Array.isArray(data.relations) ? data.relations : null;
	} catch {
		return null;
	}
}
