import { describe, it, expect } from 'vitest';
import { foldInterfacePolls } from './access-trail-fold.js';

type E =
	| { id: string; kind: 'event'; at: string; auto?: true; count?: number; until?: string; who: string }
	| { id: string; kind: 'step'; at: string; who: string };
const poll = (id: string, at: string, who = 'ida'): E => ({ id, kind: 'event', at, auto: true, who });

describe('foldInterfacePolls', () => {
	it('names the oldest and newest time of a group, also when the reads are out of order', () => {
		// A page loaded later is appended, so its reads can stand after older ones.
		const [group] = foldInterfacePolls([
			poll('a', '2026-10-28T10:05:00.000Z'),
			poll('b', '2026-10-28T10:09:00.000Z'),
			poll('c', '2026-10-28T10:01:00.000Z'),
		], (e) => e.who);
		expect(group).toMatchObject({ kind: 'polls', from: '2026-10-28T10:01:00.000Z', to: '2026-10-28T10:09:00.000Z' });
	});

	it('keeps every read, and every other entry single', () => {
		const step: E = { id: 's', kind: 'step', at: '2026-10-28T10:03:00.000Z', who: 'ida' };
		const out = foldInterfacePolls([poll('a', '2026-10-28T10:04:00.000Z'), step, poll('b', '2026-10-28T10:02:00.000Z')], (e) => e.who);
		expect(out.map((i) => (i.kind === 'polls' ? i.entries.map((e) => e.id).join('') : i.entry.id))).toEqual(['a', 's', 'b']);
	});

	it('counts a day row as the reads it stands for, and spans to its last read', () => {
		// A day row: the engine folded 40 reads of 20 October into one, after 30 days.
		const day: E = { id: 'd', kind: 'event', at: '2026-10-20T08:00:00.000Z', until: '2026-10-20T17:00:00.000Z', count: 40, auto: true, who: 'ida' };
		const [group] = foldInterfacePolls([poll('a', '2026-10-20T07:00:00.000Z'), day], (e) => e.who);
		expect(group).toMatchObject({ kind: 'polls', reads: 41, from: '2026-10-20T07:00:00.000Z', to: '2026-10-20T17:00:00.000Z' });
	});

	it('counts single reads one each', () => {
		const [group] = foldInterfacePolls([poll('a', '2026-10-28T10:05:00.000Z'), poll('b', '2026-10-28T10:09:00.000Z')], (e) => e.who);
		expect(group).toMatchObject({ kind: 'polls', reads: 2 });
	});
});
