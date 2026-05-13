import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('web-push', () => ({
  default: {
    generateVAPIDKeys: vi.fn(() => ({ publicKey: 'pub', privateKey: 'priv' })),
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(async () => undefined),
  },
}));

import webPush from 'web-push';
import { WebPushNotificationChannel } from './web-push-channel.js';

let dataDir: string;
let channel: WebPushNotificationChannel;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), 'lynox-webpush-test-'));
	channel = new WebPushNotificationChannel(dataDir);
	channel.subscribe('https://push.example/abc', 'p256dh-key', 'auth-key');
	(webPush.sendNotification as ReturnType<typeof vi.fn>).mockClear();
});

afterEach(async () => {
	await rm(dataDir, { recursive: true, force: true });
});

describe('WebPushNotificationChannel — msg.data passthrough', () => {
	it('forwards channel-specific data (e.g. itemId) into the rendered payload', async () => {
		await channel.send({
			title: 'Inbox',
			body: 'New mail',
			priority: 'normal',
			data: { itemId: 'inb_42' },
		});
		const sendArgs = (webPush.sendNotification as ReturnType<typeof vi.fn>).mock.calls[0];
		const payload = JSON.parse(sendArgs?.[1] as string) as { data: Record<string, unknown> };
		expect(payload.data.itemId).toBe('inb_42');
		expect(payload.data.priority).toBe('normal');
	});

	it('does NOT let caller-supplied data.priority override the typed priority field', async () => {
		await channel.send({
			title: 'Inbox',
			body: 'New mail',
			priority: 'high',
			// A caller crafted (or copy-pasted) `data` with overlapping keys —
			// the channel must keep the typed `priority` as authoritative.
			data: { itemId: 'inb_42', priority: 'low' },
		});
		const sendArgs = (webPush.sendNotification as ReturnType<typeof vi.fn>).mock.calls[0];
		const payload = JSON.parse(sendArgs?.[1] as string) as { data: Record<string, unknown> };
		expect(payload.data.priority).toBe('high');
		expect(payload.data.itemId).toBe('inb_42');
	});

	it('omits data passthrough when msg.data is undefined (no extra keys)', async () => {
		await channel.send({
			title: 'Inbox',
			body: 'New mail',
			priority: 'normal',
		});
		const sendArgs = (webPush.sendNotification as ReturnType<typeof vi.fn>).mock.calls[0];
		const payload = JSON.parse(sendArgs?.[1] as string) as { data: Record<string, unknown> };
		// JSON.stringify drops undefined values, so taskId is absent when
		// the caller didn't set one. Only `priority` survives.
		expect(Object.keys(payload.data).sort()).toEqual(['priority']);
	});
});
