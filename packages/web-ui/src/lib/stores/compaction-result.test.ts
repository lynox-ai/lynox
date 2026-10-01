import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { formatTokensShort, formatCompactionDelta } from './compaction-result.js';

/**
 * The ask was for compaction to be visible, "as a percentage if need be". A
 * percentage is the one thing it cannot honestly be — compaction is a single
 * blocking summarizer call with no intermediate state — so what ships is the
 * measured RESULT instead, and these tests are mostly about refusing to show a
 * number that would mislead.
 */

describe('formatTokensShort', () => {
	it('keeps small counts exact', () => {
		expect(formatTokensShort(0)).toBe('0');
		expect(formatTokensShort(999)).toBe('999');
	});

	// ⭐ The whole point of the line is the SIZE of the drop, so a compaction
	// down to 2 606 must not read as "3k" — that hides most of what happened.
	it('⭐ keeps one decimal below 10k so a small remainder stays legible', () => {
		expect(formatTokensShort(2606)).toBe('2.6k');
		expect(formatTokensShort(1500)).toBe('1.5k');
	});

	it('drops a trailing .0 rather than printing 2.0k', () => {
		expect(formatTokensShort(2000)).toBe('2k');
	});

	it('rounds to whole thousands above 10k', () => {
		expect(formatTokensShort(163492)).toBe('163k');
		expect(formatTokensShort(10500)).toBe('11k');
	});

	it('does not invent a number for nonsense input', () => {
		expect(formatTokensShort(Number.NaN)).toBe('?');
		expect(formatTokensShort(-1)).toBe('?');
		expect(formatTokensShort(Number.POSITIVE_INFINITY)).toBe('?');
	});
});

describe('formatCompactionDelta', () => {
	// The real case from the thread this came from.
	it('renders the measured pair', () => {
		expect(formatCompactionDelta(163492, 2606)).toBe('163k → 2.6k');
	});

	/**
	 * ⭐ An engine that predates this pair sends neither value. Returning null
	 * makes the marker say a compaction happened and stop there. A partial
	 * string — a lone arrow, or "→ 0" — would be a claim the client cannot
	 * support, which is the defect class this whole batch is about.
	 */
	it('⭐ returns null rather than a partial line when a number is missing', () => {
		expect(formatCompactionDelta(undefined, 2606)).toBeNull();
		expect(formatCompactionDelta(163492, undefined)).toBeNull();
		expect(formatCompactionDelta(undefined, undefined)).toBeNull();
	});

	/**
	 * ⭐ A compaction that reclaimed nothing reports nothing. "2.6k → 2.6k"
	 * invites the reader to conclude something failed; the honest reading is
	 * that there was nothing left to reclaim.
	 */
	it('⭐ stays silent when nothing was actually freed', () => {
		expect(formatCompactionDelta(2606, 2606)).toBeNull();
		expect(formatCompactionDelta(2606, 4000)).toBeNull();
	});

	it('rejects impossible inputs instead of formatting them', () => {
		expect(formatCompactionDelta(0, 0)).toBeNull();
		expect(formatCompactionDelta(Number.NaN, 100)).toBeNull();
		expect(formatCompactionDelta(1000, -5)).toBeNull();
	});
});

/**
 * Source-level wiring guard — `chat.svelte.ts` and `ChatView.svelte` cannot be
 * imported here (Svelte 5 runes, no svelte plugin in the root vitest config),
 * the same reason `prompt-origin.test.ts` and `chat-detach-reset.test.ts` read
 * their sources. Pins the call sites, because a helper nothing calls is the
 * failure mode these guards exist for.
 */
describe('the compaction result is wired from engine to marker', () => {
	const VIEW = readFileSync(
		fileURLToPath(new URL('../components/ChatView.svelte', import.meta.url)),
		'utf-8',
	);
	const STORE = readFileSync(
		fileURLToPath(new URL('./chat.svelte.ts', import.meta.url)),
		'utf-8',
	);

	it('⭐ the marker renders the delta when both numbers are known', () => {
		// Pinned on the GUARD, not merely on the expression appearing somewhere:
		// replacing the condition with `{#if false}` leaves the call intact inside
		// the span, so a `toContain` on the call alone survives that mutation.
		expect(VIEW).toContain('{#if formatCompactionDelta(msg.compactionNote.occupancyBefore, msg.compactionNote.occupancyAfter)}');
		// ...and the guarded body must actually print it.
		const guard = VIEW.slice(VIEW.indexOf('{#if formatCompactionDelta('));
		expect(guard.slice(0, guard.indexOf('{/if}'))).toContain('{formatCompactionDelta(');
	});

	// Both paths must carry the pair: the live SSE event AND the manual POST,
	// which has no SSE at all and would otherwise never show a result.
	it('⭐ both compaction paths carry the occupancy pair', () => {
		// Both halves of the pair, and as the ASSIGNMENT into the note — the bare
		// word also appears in the response type, so matching it alone survives
		// deleting the line that actually puts the value on the marker.
		const sse = STORE.slice(STORE.indexOf("case 'context_compacted':"));
		const sseBody = sse.slice(0, sse.indexOf('break;'));
		expect(sseBody).toContain('{ occupancyBefore: data[');
		expect(sseBody).toContain('{ occupancyAfter: data[');
		const manual = STORE.slice(STORE.indexOf('export async function compactNow'));
		const manualBody = manual.slice(0, manual.indexOf('\n}'));
		expect(manualBody).toContain('{ occupancyBefore: data.occupancyBefore }');
		// and it must be a TYPE check, not a presence check
		expect(manualBody).toContain("typeof data.occupancyBefore === 'number'");
		expect(manualBody).toContain('{ occupancyAfter: data.occupancyAfter }');
	});

	// The in-progress state is indeterminate by design; a percentage here would
	// have to be invented. Guards against someone "improving" it into a number.
	it('shows an indeterminate pulse while compacting, not a figure', () => {
		// Anchored on the button's own markup rather than a character offset: a
		// `- 900` slice is a distance, and a comment added inside the button moves
		// it silently. Bounded backwards from the label to the opening tag.
		const labelAt = VIEW.indexOf("t('chat.compact_in_progress')");
		expect(labelAt).toBeGreaterThan(-1);
		const openAt = VIEW.lastIndexOf('<button', labelAt);
		const region = VIEW.slice(openAt, VIEW.indexOf('</button>', labelAt));
		expect(region).toContain('motion-safe:animate-pulse');
		expect(region).toContain('{#if compacting}');
		// And no percentage snuck into the in-progress branch.
		expect(region).not.toMatch(/\{[^}]*Pct[^}]*\}%/);
	});

	/**
	 * ⭐ The chip leads the footer line. That line scrolls horizontally on
	 * mobile, and the segment a user checks mid-thread is the one that used to
	 * scroll out of view first.
	 */
	it('⭐ the context chip leads the footer line, ahead of the token sum', () => {
		const footer = VIEW.slice(VIEW.indexOf('overflow-x-auto scrollbar-none whitespace-nowrap'));
		const line = footer.slice(0, footer.indexOf('</div>'));
		const chipAt = line.indexOf("t('chat.ctx_occupancy_label')");
		const sumAt = line.indexOf('formatTurnTokens(usage)');
		expect(chipAt).toBeGreaterThan(-1);
		expect(sumAt).toBeGreaterThan(-1);
		expect(chipAt).toBeLessThan(sumAt);
	});
});
