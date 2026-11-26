/**
 * The lists of plans one dialog has opened, by what they list. A dialog can name the same plans in
 * two sentences; pressing "and {n} more" in one opens both, so the list left folded below is not
 * read as another list. The dialog makes a new one for each preview, so a new preview starts folded.
 */
export class FoldGroup {
	#opened = $state<string[]>([]);
	has(key: string): boolean {
		return this.#opened.includes(key);
	}
	open(key: string): void {
		if (!this.has(key)) this.#opened = [...this.#opened, key];
	}
}
