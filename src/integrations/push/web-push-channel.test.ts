import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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
import Database from 'better-sqlite3';
import { MAX_MANDATE_SUBSCRIPTIONS, WebPushNotificationChannel } from './web-push-channel.js';
import { OWNER_PRINCIPAL, type RequestPrincipal } from '../../core/request-principal.js';

let dataDir: string;
let channel: WebPushNotificationChannel;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), 'lynox-webpush-test-'));
	channel = new WebPushNotificationChannel(dataDir);
	channel.subscribe('https://push.example/abc', 'p256dh-key', 'auth-key', OWNER_PRINCIPAL);
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

describe('WebPushNotificationChannel — outcome', () => {
	it('reports delivered when a subscription accepted the push', async () => {
		expect(await channel.send({ title: 't', body: 'b', priority: 'normal' })).toBe('delivered');
	});

	it('reports failed with no subscription: nobody was told', async () => {
		channel.unsubscribe('https://push.example/abc');
		expect(await channel.send({ title: 't', body: 'b', priority: 'normal' })).toBe('failed');
		expect(webPush.sendNotification).not.toHaveBeenCalled();
	});

	it('reports failed when every subscription refused it', async () => {
		const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
		(webPush.sendNotification as ReturnType<typeof vi.fn>).mockRejectedValueOnce(Object.assign(new Error('down'), { statusCode: 500 }));
		expect(await channel.send({ title: 't', body: 'b', priority: 'normal' })).toBe('failed');
		stderr.mockRestore();
	});
});

// PRD customer-granted-operator-access §3.13 B3: a subscription a mandate adds is its own and ends
// with the grant it was added under. The owner's subscriptions are the control throughout.
describe('WebPushNotificationChannel — a mandate\'s subscriptions', () => {
	const mandate = (email: string, mandateId: string): RequestPrincipal => ({ kind: 'mandate', email, mandateId });
	const EVA = mandate('eva@example.invalid', 'TEST-MANDATE-1');
	const sendCalls = (): string[] => (webPush.sendNotification as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as { endpoint: string }).endpoint);
	let live: Set<string>;
	let ch: WebPushNotificationChannel;

	beforeEach(() => {
		live = new Set(['TEST-MANDATE-1', 'TEST-MANDATE-2']);
		ch = new WebPushNotificationChannel(dataDir, { isMandateLive: (id) => live.has(id) });
	});

	it('reaches a live mandate\'s device, and after the grant ended neither reaches nor keeps it', async () => {
		expect(ch.subscribe('https://push.example/eva', 'k', 'a', EVA)).toBe('ok');
		await ch.send({ title: 't', body: 'b', priority: 'normal' });
		expect(sendCalls().sort()).toEqual(['https://push.example/abc', 'https://push.example/eva']);
		(webPush.sendNotification as ReturnType<typeof vi.fn>).mockClear();
		live.delete('TEST-MANDATE-1');
		await ch.send({ title: 't', body: 'b', priority: 'normal' });
		expect(sendCalls()).toEqual(['https://push.example/abc']);
		expect(ch.addedBy('https://push.example/eva')).toBeUndefined();
		// The owner's stays, mandate or not.
		expect(ch.addedBy('https://push.example/abc')).toEqual({ created_by: null });
	});

	it('counts a mandate with no store of ends as ended', async () => {
		const blind = new WebPushNotificationChannel(dataDir);
		expect(blind.subscribe('https://push.example/eva', 'k', 'a', EVA)).toBe('ok');
		expect(blind.subscriptionCount()).toBe(1);
		expect(blind.addedBy('https://push.example/eva')).toBeUndefined();
	});

	it('refuses a mandate whose session names no grant', () => {
		expect(ch.subscribe('https://push.example/x', 'k', 'a', { kind: 'mandate', email: 'eva@example.invalid' })).toBe('no_grant');
		expect(ch.addedBy('https://push.example/x')).toBeUndefined();
	});

	it('records who added it, and a later grant of the same address does not keep the earlier one\'s', () => {
		ch.subscribe('https://push.example/eva', 'k', 'a', EVA);
		expect(ch.addedBy('https://push.example/eva')).toEqual({ created_by: 'mandate:eva@example.invalid' });
		live.delete('TEST-MANDATE-1');
		expect(ch.subscriptionCount(mandate('eva@example.invalid', 'TEST-MANDATE-2'))).toBe(0);
	});

	it('counts and sends for a mandate only its own', async () => {
		ch.subscribe('https://push.example/eva', 'k', 'a', EVA);
		ch.subscribe('https://push.example/max', 'k', 'a', mandate('max@example.invalid', 'TEST-MANDATE-2'));
		expect(ch.subscriptionCount()).toBe(3);
		expect(ch.subscriptionCount(EVA)).toBe(1);
		await ch.sendDetailed({ title: 't', body: 'b', priority: 'normal' }, EVA);
		expect(sendCalls()).toEqual(['https://push.example/eva']);
	});

	it(`keeps at most ${MAX_MANDATE_SUBSCRIPTIONS} per mandate, making room among its own only`, () => {
		for (let i = 0; i < MAX_MANDATE_SUBSCRIPTIONS + 2; i++) expect(ch.subscribe(`https://push.example/eva-${i}`, 'k', 'a', EVA)).toBe('ok');
		expect(ch.subscriptionCount(EVA)).toBe(MAX_MANDATE_SUBSCRIPTIONS);
		expect(ch.addedBy('https://push.example/eva-0')).toBeUndefined();
		expect(ch.addedBy(`https://push.example/eva-${MAX_MANDATE_SUBSCRIPTIONS + 1}`)).toBeDefined();
		expect(ch.addedBy('https://push.example/abc')).toEqual({ created_by: null });
	});

	it('refuses a mandate when the instance is full of the owner\'s, and removes none of them', () => {
		for (let i = 1; i < 50; i++) ch.subscribe(`https://push.example/owner-${i}`, 'k', 'a', OWNER_PRINCIPAL);
		expect(ch.subscriptionCount()).toBe(50);
		expect(ch.subscribe('https://push.example/eva', 'k', 'a', EVA)).toBe('full');
		expect(ch.subscriptionCount()).toBe(50);
		expect(ch.addedBy('https://push.example/abc')).toEqual({ created_by: null });
	});

	it('always lets the owner in: when mandates fill the instance, the oldest of theirs makes room', () => {
		ch.unsubscribe('https://push.example/abc');
		for (let m = 0; m < 10; m++) {
			const id = `TEST-MANDATE-F${m}`;
			live.add(id);
			for (let i = 0; i < MAX_MANDATE_SUBSCRIPTIONS; i++) ch.subscribe(`https://push.example/m${m}-${i}`, 'k', 'a', mandate(`m${m}@example.invalid`, id));
		}
		expect(ch.subscriptionCount()).toBe(50);
		expect(ch.subscribe('https://push.example/owner', 'k', 'a', OWNER_PRINCIPAL)).toBe('ok');
		expect(ch.addedBy('https://push.example/owner')).toEqual({ created_by: null });
		expect(ch.subscriptionCount()).toBe(50);
		expect(ch.addedBy('https://push.example/m0-0')).toBeUndefined();
	});

	it('when the instance is full, the owner makes room from the owner\'s own oldest first, even with a mandate\'s older', () => {
		// The mandate's subscription is the oldest of all, so "the oldest of all" and "the owner's own
		// oldest" name different rows here.
		ch.unsubscribe('https://push.example/abc');
		ch.subscribe('https://push.example/eva', 'k', 'a', EVA);
		for (let i = 1; i < 50; i++) ch.subscribe(`https://push.example/owner-${i}`, 'k', 'a', OWNER_PRINCIPAL);
		expect(ch.subscriptionCount()).toBe(50);
		expect(ch.subscribe('https://push.example/owner-new', 'k', 'a', OWNER_PRINCIPAL)).toBe('ok');
		expect(ch.addedBy('https://push.example/owner-1')).toBeUndefined();
		expect(ch.addedBy('https://push.example/eva')).toEqual({ created_by: 'mandate:eva@example.invalid' });
	});

	it('opens a file from before as the owner\'s, adding the two columns', async () => {
		const legacyDir = join(dataDir, 'legacy');
		await mkdir(legacyDir);
		const old = new Database(join(legacyDir, 'push-subscriptions.db'));
		old.exec(`CREATE TABLE push_subscriptions (endpoint TEXT PRIMARY KEY, keys_p256dh TEXT NOT NULL, keys_auth TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
		old.prepare('INSERT INTO push_subscriptions (endpoint, keys_p256dh, keys_auth) VALUES (?, ?, ?)').run('https://push.example/old', 'k', 'a');
		old.close();
		const migrated = new WebPushNotificationChannel(legacyDir, { isMandateLive: () => false });
		expect(migrated.addedBy('https://push.example/old')).toEqual({ created_by: null });
		expect(migrated.subscriptionCount()).toBe(1);
	});
});
