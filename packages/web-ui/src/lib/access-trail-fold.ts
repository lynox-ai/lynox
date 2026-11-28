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
 *
 * A second fold, for the reads the person made (U-306 C, decided 2026-11-17): the
 * same read of the same person, the same route and the same target, one directly after the other,
 * becomes one line with a count and a span, expandable to each. A bulk run watched for five
 * minutes would leave 60 lines otherwise. It is the same object every time, so nothing is lost;
 * the engine still keeps each row.
 */

/** The fields of a view entry the grouping reads. */
export interface FoldableEntry {
	readonly id: string;
	readonly kind: string;
	readonly at: string;
	readonly auto?: true | undefined;
	/** A day row: the polls of one day, folded by the engine after 30 days; `count` reads up to `until`. */
	readonly count?: number | undefined;
	readonly until?: string | undefined;
	/** On an event: the row's phase, action and target, which the second fold compares. */
	readonly phase?: string | undefined;
	readonly action?: string | undefined;
	readonly target?: string | null | undefined;
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
			/** How many reads the group stands for: a day row counts as the reads it folded. */
			readonly reads: number;
	  }
	| {
			readonly kind: 'repeat';
			/** Stable across renders: the first (newest) read's id. */
			readonly id: string;
			/** The same read, two or more times, in the view's order (newest first). */
			readonly entries: ReadonlyArray<Extract<E, { kind: 'event' }>>;
			readonly from: string;
			readonly to: string;
	  };

/** A read the engine marked as made by the web UI itself. */
function isMarkedRead<E extends FoldableEntry>(e: E): e is Extract<E, { kind: 'event' }> {
	return e.kind === 'event' && e.auto === true;
}

/** A read the person made, the kind the second fold takes: not marked, not a day row. */
function isOwnRead<E extends FoldableEntry>(e: E): e is Extract<E, { kind: 'event' }> {
	return e.kind === 'event' && e.auto !== true && e.phase === 'read' && e.count === undefined && e.action !== undefined;
}

/**
 * Consecutive marked reads of the same person become one group; consecutive identical reads the
 * person made become one repeat line; every other entry stays as it is.
 * `entries` are in the view's order, newest first; `personOf` gives the key the person filter uses.
 */
export function foldInterfacePolls<E extends FoldableEntry>(entries: readonly E[], personOf: (e: E) => string): Array<FoldedItem<E>> {
	const out: Array<FoldedItem<E>> = [];
	let run: Array<Extract<E, { kind: 'event' }>> = [];
	const close = (): void => {
		if (run.length === 0) return;
		// By time, not by position: pages that were loaded later are appended, so the order is not
		// guaranteed across a page edge.
		const times = run.flatMap((e) => (e.until === undefined ? [e.at] : [e.at, e.until])).sort((a, b) => Date.parse(a) - Date.parse(b));
		const reads = run.reduce((n, e) => n + (e.count ?? 1), 0);
		out.push({ kind: 'polls', id: `polls:${run[0]!.id}`, entries: run, from: times[0]!, to: times[times.length - 1]!, reads });
		run = [];
	};
	const same = (a: Extract<E, { kind: 'event' }>, b: Extract<E, { kind: 'event' }>): boolean =>
		personOf(a) === personOf(b) && a.action === b.action && (a.target ?? null) === (b.target ?? null);
	for (const e of entries) {
		if (isMarkedRead(e)) {
			if (run.length > 0 && personOf(run[0]!) !== personOf(e)) close();
			run.push(e);
			continue;
		}
		close();
		const last = out[out.length - 1];
		if (isOwnRead(e) && last !== undefined) {
			if (last.kind === 'repeat' && same(last.entries[0]!, e)) {
				const entries = [...last.entries, e];
				const times = entries.map((x) => x.at).sort((a, b) => Date.parse(a) - Date.parse(b));
				out[out.length - 1] = { kind: 'repeat', id: last.id, entries, from: times[0]!, to: times[times.length - 1]! };
				continue;
			}
			if (last.kind === 'entry' && isOwnRead(last.entry) && same(last.entry, e)) {
				const times = [last.entry.at, e.at].sort((a, b) => Date.parse(a) - Date.parse(b));
				out[out.length - 1] = { kind: 'repeat', id: `repeat:${last.entry.id}`, entries: [last.entry, e], from: times[0]!, to: times[1]! };
				continue;
			}
		}
		out.push({ kind: 'entry', entry: e });
	}
	close();
	return out;
}
