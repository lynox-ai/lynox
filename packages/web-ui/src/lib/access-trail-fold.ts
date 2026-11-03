/**
 * Groups the reads on routes a person's web UI polls by itself, in the owner's view of the actor trail
 * (row 1034, ux U-047). An open tab leaves about 23 of them a minute; without grouping, the
 * person's own steps are lost among them.
 *
 * The engine marks those reads (`auto`, from its fixed list `INTERFACE_POLLS` in
 * `audit-trail-view.ts`: the routes the status bar and the nav poll, by route); this
 * module only groups what is marked, so the client cannot choose what is grouped. It runs after
 * the view's filters, so a group holds only what the filters show. Runs, steps and every other
 * event stay single, and no entry is dropped: a group holds every read it stands for.
 */

/** The fields of a view entry the grouping reads. */
export interface FoldableEntry {
	readonly id: string;
	readonly kind: string;
	readonly at: string;
	readonly auto?: true | undefined;
}

export type FoldedItem<E extends FoldableEntry> =
	| { readonly kind: 'entry'; readonly entry: E }
	| {
			readonly kind: 'polls';
			/** Stable across renders: the first (newest) read's id. */
			readonly id: string;
			/** The reads, in the view's order (newest first). */
			readonly entries: ReadonlyArray<Extract<E, { kind: 'event' }>>;
			/** Oldest and newest time in the group. */
			readonly from: string;
			readonly to: string;
	  };

/** A read the engine marked as made by the web UI itself. */
function isMarkedRead<E extends FoldableEntry>(e: E): e is Extract<E, { kind: 'event' }> {
	return e.kind === 'event' && e.auto === true;
}

/**
 * Consecutive marked reads of the same person become one group; every other entry stays as it is.
 * `entries` are in the view's order, newest first; `personOf` gives the key the person filter uses.
 */
export function foldInterfacePolls<E extends FoldableEntry>(entries: readonly E[], personOf: (e: E) => string): Array<FoldedItem<E>> {
	const out: Array<FoldedItem<E>> = [];
	let run: Array<Extract<E, { kind: 'event' }>> = [];
	const close = (): void => {
		if (run.length === 0) return;
		// By time, not by position: pages that were loaded later are appended, so the order is not
		// guaranteed across a page edge.
		const times = run.map((e) => e.at).sort((a, b) => Date.parse(a) - Date.parse(b));
		out.push({ kind: 'polls', id: `polls:${run[0]!.id}`, entries: run, from: times[0]!, to: times[times.length - 1]! });
		run = [];
	};
	for (const e of entries) {
		if (isMarkedRead(e)) {
			if (run.length > 0 && personOf(run[0]!) !== personOf(e)) close();
			run.push(e);
		} else {
			close();
			out.push({ kind: 'entry', entry: e });
		}
	}
	close();
	return out;
}
