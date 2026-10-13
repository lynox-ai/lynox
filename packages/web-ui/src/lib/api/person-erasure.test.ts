import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PERSON_ERASURE_NOT_COVERED as ENGINE_NOT_COVERED } from '../../../../../src/core/person-erasure.js';
import {
	PERSON_ERASURE_NOT_COVERED,
	erasePerson,
	erasureOutcome,
	previewPersonErasure,
	type PersonErasureResult,
} from './person-erasure.js';

const RESULT: PersonErasureResult = {
	erased: true,
	done: ['durable_knowledge', 'memories_legacy', 'memories_engine', 'subject'],
	failed: null,
	scrubbed: true,
	counts: { entries: 1, legacyMemories: 1, memoryStubs: 1, subjects: 1 },
	left: { entries: 0, memories: 0, blocks: [] },
	notCovered: [...PERSON_ERASURE_NOT_COVERED],
};
const PARTIAL: PersonErasureResult = { ...RESULT, erased: false, done: ['durable_knowledge'], failed: 'memories_legacy' };

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => { vi.unstubAllGlobals(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('erasureOutcome', () => {
	it('shows "erased" only for a 200 that says so', () => {
		expect(erasureOutcome({ status: 200, body: { ...RESULT } })).toEqual({ kind: 'erased', result: RESULT });
	});

	it('shows a failed step as partial, never as erased, whatever the body claims', () => {
		expect(erasureOutcome({ status: 500, body: { ...PARTIAL } }).kind).toBe('partial');
		expect(erasureOutcome({ status: 500, body: { ...RESULT } }).kind).toBe('partial');
		expect(erasureOutcome({ status: 200, body: { ...PARTIAL } }).kind).toBe('partial');
	});

	it('maps each refusal to its own notice', () => {
		expect(erasureOutcome({ status: 409, body: { code: 'plan_changed' } }).kind).toBe('changed');
		expect(erasureOutcome({ status: 409, body: { code: 'runs_active' } }).kind).toBe('busy');
		expect(erasureOutcome({ status: 409, body: { code: 'erasure_in_progress' } }).kind).toBe('busy');
		expect(erasureOutcome({ status: 503, body: { code: 'key_unavailable' } }).kind).toBe('unreadable');
		expect(erasureOutcome({ status: 403, body: { error: 'Only the owner' } }).kind).toBe('forbidden');
		expect(erasureOutcome({ status: 503, body: { code: 'audit_unavailable' } }).kind).toBe('failed');
		expect(erasureOutcome({ status: 0, body: null }).kind).toBe('failed');
	});
});

describe('the fetchers', () => {
	it('sends the selection with the confirmation word, and asks no cache to keep it', async () => {
		const fetchMock = vi.fn(async () => jsonResponse(RESULT));
		vi.stubGlobal('fetch', fetchMock);
		const out = await erasePerson('/api', { subjectId: 's1', plan: 'p1', entryIds: ['e1'], memoryIds: ['m1'] });
		expect(out.kind).toBe('erased');
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('/api/privacy/person-erasure');
		expect(init.cache).toBe('no-store');
		expect(JSON.parse(String(init.body))).toEqual({ subjectId: 's1', plan: 'p1', entryIds: ['e1'], memoryIds: ['m1'], confirm: 'ERASE_PERSON' });
	});

	it('returns the preview, or the refusal when there is none', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ subject: { id: 's1', name: 'N', aliases: [] }, entries: [], memories: [], blocksMentioning: [], plan: 'p', notCovered: [] })));
		expect('preview' in await previewPersonErasure('/api', 's1')).toBe(true);
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 'key_unavailable' }, 503)));
		expect(await previewPersonErasure('/api', 's1')).toEqual({ refused: { kind: 'unreadable' } });
	});
});

describe('what the panel names as not covered', () => {
	it('is the engine\'s list, key for key and in order', () => {
		expect([...PERSON_ERASURE_NOT_COVERED]).toEqual([...ENGINE_NOT_COVERED]);
	});

	// Source-level, like `cap-note-i18n.test.ts`: the root vitest has no svelte plugin, so the
	// i18n table cannot be imported. Exactly one live line per key, in both languages.
	it('has one German and one English label per key, and no label for a key the engine does not send', () => {
		const src = readFileSync(fileURLToPath(new URL('../i18n.svelte.ts', import.meta.url)), 'utf8');
		const live = src.split('\n').filter(l => /^\t'erasure\.nc\./.test(l));
		const keys = live.map(l => /^\t'erasure\.nc\.([a-z_]+)'/.exec(l)?.[1]);
		expect(keys).toEqual([...PERSON_ERASURE_NOT_COVERED]);
		for (const line of live) expect(line).toMatch(/\{ de: '[^']+', en: '[^']+' \},$/);
	});

	it('has a label for every step a failure can name', () => {
		const src = readFileSync(fileURLToPath(new URL('../i18n.svelte.ts', import.meta.url)), 'utf8');
		for (const step of ['durable_knowledge', 'memories_legacy', 'memories_engine', 'subject']) {
			expect(src.split('\n').filter(l => l.startsWith(`\t'erasure.step.${step}': { de: '`)).length, step).toBe(1);
		}
	});
});
