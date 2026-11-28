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
 * The kind a subject's chip shows, for its word and its tint. The store narrows every kind to one
 * of core's `KNOWN_SUBJECT_KINDS`, which this list mirrors (a test holds the two equal). Anything
 * else is shown as "other": the stored value may come from outside, and the chip only ever shows
 * a word from this list.
 */
export const SUBJECT_KINDS = ['person', 'organization', 'engagement', 'product', 'service', 'other'] as const;
export type ShownSubjectKind = (typeof SUBJECT_KINDS)[number];

export function shownSubjectKind(kind: string): ShownSubjectKind {
	return (SUBJECT_KINDS as readonly string[]).includes(kind) ? (kind as ShownSubjectKind) : 'other';
}
