import { describe, expect, it } from 'vitest';
import { stripNowMarker } from './now-marker.js';

describe('stripNowMarker', () => {
	it('strips the legacy UTC-only marker shape (pre-PR-#246 form)', () => {
		// `[Now: <iso>]` with no local clause — what the engine wrote between
		// PR #242 and PR #246. Threads recorded then still need to render.
		const raw = '[Now: 2026-05-05T11:55:00.000Z]\n\nhello';
		expect(stripNowMarker(raw)).toBe('hello');
	});

	it('strips the marker with local clause (post-PR-#246 form)', () => {
		// The bug Rafael caught on staging: `[Now: …; user local … <tz>]\n\n`
		// was rendering verbatim inside the user's chat bubble.
		const raw = '[Now: 2026-05-05T11:55:00.000Z; user local 2026-05-05 13:55:00 Europe/Zurich]\n\n🎤 Voice test';
		expect(stripNowMarker(raw)).toBe('🎤 Voice test');
	});

	it('preserves text that does not start with the marker', () => {
		// A user-typed message starting with `[` (e.g. a markdown footnote
		// reference or a code snippet) must not get its first line eaten.
		expect(stripNowMarker('[note] hello')).toBe('[note] hello');
		expect(stripNowMarker('plain text')).toBe('plain text');
	});

	it('handles undefined / null / non-string input defensively', () => {
		// msg.content can be reactive; an early render with undefined
		// shouldn't throw.
		expect(stripNowMarker(undefined)).toBe('');
		expect(stripNowMarker(null)).toBe('');
		expect(stripNowMarker(42 as unknown as string)).toBe('');
	});

	it('only strips the marker, not the trailing user text it precedes', () => {
		// Multi-line user text must keep all of its content after the marker.
		const raw = '[Now: 2026-05-05T11:55:00Z]\n\nfirst line\nsecond line';
		expect(stripNowMarker(raw)).toBe('first line\nsecond line');
	});
});
