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
