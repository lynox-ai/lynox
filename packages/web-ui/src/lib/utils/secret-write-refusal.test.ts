import { describe, expect, it } from 'vitest';
import { secretWriteRefusal } from './secret-write-refusal.js';

const reply = (status: number, body: string): Response => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });

describe('secretWriteRefusal', () => {
	it('reads a 403 marked as a built-in provider client secret', async () => {
		expect(await secretWriteRefusal(reply(403, JSON.stringify({ error: 'x', code: 'preset_client_secret' })))).toBe('preset_client');
	});

	it('reads any other 403 as a platform-managed name', async () => {
		expect(await secretWriteRefusal(reply(403, JSON.stringify({ error: 'Managed mode: …' })))).toBe('managed');
		expect(await secretWriteRefusal(reply(403, JSON.stringify({ error: 'x', code: 'something_else' })))).toBe('managed');
		expect(await secretWriteRefusal(reply(403, 'not json'))).toBe('managed');
	});

	it('reads a non-403 failure as a failed save, even with the code', async () => {
		expect(await secretWriteRefusal(reply(500, JSON.stringify({ code: 'preset_client_secret' })))).toBe('failed');
	});
});
