/**
 * What the Subjects view shows in its body. The open detail panel keeps the body in `list`
 * even when the list is empty: erasing the last listed person removes it from the list, and
 * the panel is where that erasure's result, the not-covered list and the scrub notice are
 * shown. An empty-list notice there would take all of it away.
 */
export type SubjectsBody = 'loading' | 'empty' | 'list';

export function subjectsBody(loading: boolean, listed: number, detailOpen: boolean): SubjectsBody {
	if (loading) return 'loading';
	if (listed === 0 && !detailOpen) return 'empty';
	return 'list';
}

/**
 * The i18n key for a subject's kind, for the chip in the list and the panel. The store narrows
 * every kind to one of these six (core `KNOWN_SUBJECT_KINDS`); anything else has no word, and the
 * chip shows the value as it came.
 */
const SUBJECT_KINDS = ['person', 'organization', 'engagement', 'product', 'service', 'other'] as const;

export function subjectKindKey(kind: string): string | null {
	return (SUBJECT_KINDS as readonly string[]).includes(kind) ? `subjects.kind.${kind}` : null;
}
