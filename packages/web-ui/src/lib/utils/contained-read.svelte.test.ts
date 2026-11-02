import { describe, expect, it } from 'vitest';
import { containedReadKey } from './contained-read.js';
import { t } from '../i18n.svelte.js';

const res = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });

describe('containedReadKey', () => {
	it('names the text for the two refusals of a chat read, by code', async () => {
		expect(await containedReadKey(res(403, { code: 'contained_thread' }))).toBe('contained.thread_read_refused');
		expect(await containedReadKey(res(403, { code: 'run_chat_unknown' }))).toBe('contained.run_chat_unknown');
	});

	it('reads nothing else as one: another code, another status, a body that is not JSON', async () => {
		expect(await containedReadKey(res(403, { code: 'toString' }))).toBeNull();
		expect(await containedReadKey(res(403, { code: 'other' }))).toBeNull();
		expect(await containedReadKey(res(404, { code: 'contained_thread' }))).toBeNull();
		expect(await containedReadKey(new Response('not json', { status: 403 }))).toBeNull();
	});

	it('leaves the body for the caller to read', async () => {
		const r = res(403, { code: 'contained_thread', error: 'e' });
		await containedReadKey(r);
		expect(((await r.json()) as { error: string }).error).toBe('e');
	});

	it('has the text in both languages', () => {
		for (const key of ['contained.thread_read_refused', 'contained.run_chat_unknown']) expect(t(key)).not.toBe(key);
	});
});
