import { t, tf } from '../i18n.svelte.js';

/**
 * The person erasure's done line. Each count has its own singular, a count of 0 is left out,
 * and when both are 0 the line says so in words.
 */
export function erasureDoneText(entries: number, memories: number): string {
	if (entries === 0 && memories === 0) return t('erasure.done_none');
	const entriesPart = entries === 1 ? t('erasure.done_entries_one') : tf('erasure.done_entries', { n: String(entries) });
	const memoriesPart = memories === 1 ? t('erasure.done_memories_one') : tf('erasure.done_memories', { n: String(memories) });
	const parts = entries === 0
		? memoriesPart
		: memories === 0
			? entriesPart
			: tf('erasure.done_both', { entries: entriesPart, memories: memoriesPart });
	return tf('erasure.done', { parts });
}
