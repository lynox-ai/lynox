import { describe, it, expect } from 'vitest';
import { foldInterfacePolls } from './access-trail-fold.js';

type E =
	| { id: string; kind: 'event'; at: string; auto?: true; count?: number; until?: string; who: string; phase?: string; action?: string; target?: string | null }
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
		expect(out.map((i) => (i.kind === 'entry' ? i.entry.id : i.entries.map((e) => e.id).join('')))).toEqual(['a', 's', 'b']);
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

describe('the same read made again, one line with a count (U-306 C)', () => {
	const read = (id: string, at: string, over: Partial<Extract<E, { kind: 'event' }>> = {}): E =>
		({ id, kind: 'event', at, who: 'ida', phase: 'read', action: 'GET /api/bulk/runs/:id', target: '/api/bulk/runs/b1', ...over });
	const shape = (out: ReturnType<typeof foldInterfacePolls<E>>): string[] =>
		out.map((i) => (i.kind === 'entry' ? i.entry.id : `${i.kind}:${i.entries.map((e) => e.id).join('')}`));

	it('folds the same read of the same person, route and target, one after the other, and spans it', () => {
		const out = foldInterfacePolls([
			read('a', '2026-11-28T10:03:00.000Z'), read('b', '2026-11-28T10:02:00.000Z'), read('c', '2026-11-28T10:01:00.000Z'),
		], (e) => e.who);
		expect(shape(out)).toEqual(['repeat:abc']);
		expect(out[0]).toMatchObject({ kind: 'repeat', id: 'repeat:a', from: '2026-11-28T10:01:00.000Z', to: '2026-11-28T10:03:00.000Z' });
	});

	it('keeps a read single when the target, the route, the person or the phase differs, or another entry stands between', () => {
		const step: E = { id: 's', kind: 'step', at: '2026-11-28T10:00:30.000Z', who: 'ida' };
		expect(shape(foldInterfacePolls([read('a', '2026-11-28T10:02:00.000Z'), read('b', '2026-11-28T10:01:00.000Z', { target: '/api/bulk/runs/b2' })], (e) => e.who))).toEqual(['a', 'b']);
		expect(shape(foldInterfacePolls([read('a', '2026-11-28T10:02:00.000Z'), read('b', '2026-11-28T10:01:00.000Z', { action: 'GET /api/bulk/runs/:id/targets' })], (e) => e.who))).toEqual(['a', 'b']);
		expect(shape(foldInterfacePolls([read('a', '2026-11-28T10:02:00.000Z'), read('b', '2026-11-28T10:01:00.000Z', { who: 'eva' })], (e) => e.who))).toEqual(['a', 'b']);
		expect(shape(foldInterfacePolls([read('a', '2026-11-28T10:02:00.000Z'), read('b', '2026-11-28T10:01:00.000Z', { phase: 'refused' })], (e) => e.who))).toEqual(['a', 'b']);
		expect(shape(foldInterfacePolls([read('a', '2026-11-28T10:02:00.000Z'), step, read('b', '2026-11-28T10:00:00.000Z')], (e) => e.who))).toEqual(['a', 's', 'b']);
	});

	it('leaves a marked read to the status group, never to a repeat line', () => {
		const out = foldInterfacePolls([read('a', '2026-11-28T10:02:00.000Z', { auto: true }), read('b', '2026-11-28T10:01:00.000Z', { auto: true })], (e) => e.who);
		expect(shape(out)).toEqual(['polls:ab']);
	});
});
