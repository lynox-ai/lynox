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
	(webPush.sendNotification as ReturnType<typeof vi.fn>).mockImplementation(async () => undefined);
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

	it('reports delivered only when one of the owner\'s devices took it, however many of a mandate\'s did', async () => {
		const send = webPush.sendNotification as ReturnType<typeof vi.fn>;
		expect(ch.subscribe('https://push.example/eva', 'k', 'a', EVA)).toBe('ok');
		// Both take it: delivered, and both were reached (the distribution stays as it is).
		expect(await ch.send({ title: 't', body: 'b', priority: 'high' })).toBe('delivered');
		expect(sendCalls().sort()).toEqual(['https://push.example/abc', 'https://push.example/eva']);
		// The owner's device takes it, the mandate's refuses: delivered.
		send.mockClear();
		send.mockImplementation(async (sub: { endpoint: string }) => { if (sub.endpoint === 'https://push.example/eva') throw Object.assign(new Error('boom'), { statusCode: 500 }); });
		expect(await ch.send({ title: 't', body: 'b', priority: 'high' })).toBe('delivered');
		// The owner's device refuses, the mandate's takes it: sent, but not delivered.
		send.mockClear();
		send.mockImplementation(async (sub: { endpoint: string }) => { if (sub.endpoint === 'https://push.example/abc') throw Object.assign(new Error('boom'), { statusCode: 500 }); });
		expect(await ch.send({ title: 't', body: 'b', priority: 'high' })).toBe('reached_others');
		expect(sendCalls()).toContain('https://push.example/eva');
		// The owner's subscription is gone (expired), only the mandate's is left: not delivered either.
		send.mockImplementation(async (sub: { endpoint: string }) => { if (sub.endpoint === 'https://push.example/abc') throw Object.assign(new Error('gone'), { statusCode: 410 }); });
		await ch.send({ title: 't', body: 'b', priority: 'high' });
		send.mockClear();
		send.mockImplementation(async () => undefined);
		expect(await ch.send({ title: 't', body: 'b', priority: 'high' })).toBe('reached_others');
		expect(sendCalls()).toEqual(['https://push.example/eva']);
		// Nobody takes it: failed.
		send.mockImplementation(async () => { throw Object.assign(new Error('boom'), { statusCode: 500 }); });
		expect(await ch.send({ title: 't', body: 'b', priority: 'high' })).toBe('failed');
		send.mockImplementation(async () => undefined);
		// The mandate's own test send still reaches its device and counts as sent for it.
		const own = await ch.sendDetailed({ title: 't', body: 'b', priority: 'normal' }, EVA);
		expect([own.sent, own.sentToOwner]).toEqual([1, 0]);
	});

	it('through the router: a push only a mandate\'s device took reads not_delivered, yet counts as sent for the inbox throttle', async () => {
		const { NotificationRouter, summarizeDelivery } = await import('../../core/notification-router.js');
		const { createInboxNotifier } = await import('../inbox/notifier.js');
		const send = webPush.sendNotification as ReturnType<typeof vi.fn>;
		expect(ch.subscribe('https://push.example/eva', 'k', 'a', EVA)).toBe('ok');
		send.mockImplementation(async (sub: { endpoint: string }) => { if (sub.endpoint === 'https://push.example/abc') throw Object.assign(new Error('gone'), { statusCode: 410 }); });
		const router = new NotificationRouter();
		router.register(ch);
		// An escalation's summary: not delivered, which is what sends the owner the fallback mail
		// (`managed-hook.ts` reportEscalation reports every summary but `delivered`).
		expect(summarizeDelivery(await router.notify({ title: 'Needs you', body: 'b', priority: 'high' }))).toBe('not_delivered');
		// The owner's subscription is gone now; only the mandate's device is left. The inbox
		// throttle (1 a minute) counts the push that device took, so the second is held back.
		let t = 1_000_000;
		const notifier = createInboxNotifier({ router, now: () => t, perMinute: () => 1, perHour: () => 10 });
		const item = (id: string) => ({ id, bucket: 'requires_user', accountId: 'acc', subject: 's', reasonDe: 'r', fromAddress: 'a@example.invalid' }) as unknown as Parameters<typeof notifier.notifyNewItem>[0];
		send.mockClear();
		expect(await notifier.notifyNewItem(item('i1'))).toBe(true);
		t += 1_000;
		expect(await notifier.notifyNewItem(item('i2'))).toBe(false);
		expect(sendCalls()).toEqual(['https://push.example/eva']);
		send.mockImplementation(async () => undefined);
	});

	it('counts a mandate with no store of ends as ended: nothing is stored for it', async () => {
		const blind = new WebPushNotificationChannel(dataDir);
		expect(blind.subscribe('https://push.example/eva', 'k', 'a', EVA)).toBe('no_grant');
		expect(blind.addedBy('https://push.example/eva')).toBeUndefined();
		expect(blind.subscriptionCount()).toBe(1);
	});

	it('refuses a mandate whose grant has already ended, or whose end was never recorded', () => {
		live.delete('TEST-MANDATE-1');
		expect(ch.subscribe('https://push.example/eva', 'k', 'a', EVA)).toBe('no_grant');
		expect(ch.addedBy('https://push.example/eva')).toBeUndefined();
	});

	it('does not let a mandate take over a subscription someone else added in the same browser', async () => {
		// The owner's browser already holds this endpoint; a mandate turning notifications on there gets it back.
		expect(ch.subscribe('https://push.example/abc', 'k2', 'a2', EVA)).toBe('taken');
		expect(ch.addedBy('https://push.example/abc')).toEqual({ created_by: null });
		ch.subscribe('https://push.example/max', 'k', 'a', mandate('max@example.invalid', 'TEST-MANDATE-2'));
		expect(ch.subscribe('https://push.example/max', 'k', 'a', EVA)).toBe('taken');
		expect(ch.addedBy('https://push.example/max')).toEqual({ created_by: 'mandate:max@example.invalid' });
		// Its own endpoint again is fine.
		ch.subscribe('https://push.example/eva', 'k', 'a', EVA);
		expect(ch.subscribe('https://push.example/eva', 'k3', 'a3', EVA)).toBe('ok');
	});

	it('clears ended grants before it counts the room a mandate may take', () => {
		live.add('TEST-MANDATE-OLD');
		for (let i = 1; i < 50; i++) ch.subscribe(`https://push.example/old-${i}`, 'k', 'a', i <= 5 ? mandate(`old${i}@example.invalid`, 'TEST-MANDATE-OLD') : OWNER_PRINCIPAL);
		expect(ch.subscriptionCount()).toBe(50);
		live.delete('TEST-MANDATE-OLD');
		expect(ch.subscribe('https://push.example/eva', 'k', 'a', EVA)).toBe('ok');
		expect(ch.addedBy('https://push.example/old-1')).toBeUndefined();
	});

	it('keeps telling the owner when a grant lookup fails, and keeps but skips that mandate\'s', async () => {
		let busy = false;
		const flaky = new WebPushNotificationChannel(dataDir, { isMandateLive: (id) => { if (busy && id === 'TEST-MANDATE-2') throw new Error('engine.db busy'); return live.has(id); } });
		const max = mandate('max@example.invalid', 'TEST-MANDATE-2');
		flaky.subscribe('https://push.example/eva', 'k', 'a', EVA);
		expect(flaky.subscribe('https://push.example/max', 'k', 'a', max)).toBe('ok');
		busy = true;
		const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
		// Another subscribe runs the purge: a lookup that fails must not remove the row.
		flaky.subscribe('https://push.example/owner-2', 'k', 'a', OWNER_PRINCIPAL);
		expect(stderr.mock.calls.some(([line]) => String(line).includes('access grant could not be checked: engine.db busy'))).toBe(true);
		stderr.mockRestore();
		await flaky.send({ title: 't', body: 'b', priority: 'normal' });
		expect(sendCalls().sort()).toEqual(['https://push.example/abc', 'https://push.example/eva', 'https://push.example/owner-2']);
		expect(flaky.addedBy('https://push.example/max')).toEqual({ created_by: 'mandate:max@example.invalid' });
		expect(flaky.subscribe('https://push.example/max-2', 'k', 'a', max)).toBe('unavailable');
		busy = false;
		(webPush.sendNotification as ReturnType<typeof vi.fn>).mockClear();
		await flaky.sendDetailed({ title: 't', body: 'b', priority: 'normal' }, max);
		expect(sendCalls()).toEqual(['https://push.example/max']);
	});

	it('lets the owner take an endpoint a mandate holds, in the owner\'s own browser', () => {
		ch.subscribe('https://push.example/eva', 'k', 'a', EVA);
		expect(ch.subscribe('https://push.example/eva', 'k', 'a', OWNER_PRINCIPAL)).toBe('ok');
		expect(ch.addedBy('https://push.example/eva')).toEqual({ created_by: null });
		live.delete('TEST-MANDATE-1');
		expect(ch.subscriptionCount()).toBe(2);
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

	// A message for one side (the owner's and the mandates' sentences about a mail waiting for the
	// owner's approval) reaches that side's devices only, and a device of the other
	// side cannot make it count as delivered.
	it('sends an owner message to the owner\'s devices only', async () => {
		ch.subscribe('https://push.example/eva', 'k', 'a', EVA);
		expect(await ch.send({ title: 't', body: 'b', priority: 'normal', audience: 'owner' })).toBe('delivered');
		expect(sendCalls()).toEqual(['https://push.example/abc']);
		// The same message without an audience still reaches both, so the audience is what decides.
		(webPush.sendNotification as ReturnType<typeof vi.fn>).mockClear();
		await ch.send({ title: 't', body: 'b', priority: 'normal' });
		expect(sendCalls().sort()).toEqual(['https://push.example/abc', 'https://push.example/eva']);
	});

	it('sends a mandates message to its live grant\'s devices only, and none after the grant ended', async () => {
		ch.subscribe('https://push.example/eva', 'k', 'a', EVA);
		expect(await ch.send({ title: 't', body: 'b', priority: 'normal', audience: 'mandates', mandateId: 'TEST-MANDATE-1' })).toBe('delivered');
		expect(sendCalls()).toEqual(['https://push.example/eva']);
		(webPush.sendNotification as ReturnType<typeof vi.fn>).mockClear();
		live.delete('TEST-MANDATE-1');
		expect(await ch.send({ title: 't', body: 'b', priority: 'normal', audience: 'mandates', mandateId: 'TEST-MANDATE-1' })).toBe('failed');
		expect(sendCalls()).toEqual([]);
	});

	// A sentence about one grant's entry reaches that grant's devices only; a mandates' message that
	// names no grant reaches none, so leaving the grant out cannot widen it to every mandate.
	it('sends a mandates message to the named grant\'s devices only, and to none without a grant', async () => {
		ch.subscribe('https://push.example/eva', 'k', 'a', EVA);
		ch.subscribe('https://push.example/max', 'k', 'a', mandate('max@example.invalid', 'TEST-MANDATE-2'));
		expect(await ch.send({ title: 't', body: 'b', priority: 'normal', audience: 'mandates', mandateId: 'TEST-MANDATE-2' })).toBe('delivered');
		expect(sendCalls()).toEqual(['https://push.example/max']);
		(webPush.sendNotification as ReturnType<typeof vi.fn>).mockClear();
		expect(await ch.send({ title: 't', body: 'b', priority: 'normal', audience: 'mandates' })).toBe('failed');
		expect(await ch.send({ title: 't', body: 'b', priority: 'normal', audience: 'mandates', mandateId: 'TEST-MANDATE-9' })).toBe('failed');
		expect(sendCalls()).toEqual([]);
		// Control: the same message without a side still reaches every device.
		await ch.send({ title: 't', body: 'b', priority: 'normal' });
		expect(sendCalls().sort()).toEqual(['https://push.example/abc', 'https://push.example/eva', 'https://push.example/max']);
	});

	// A side narrows what `onlyFor` allows and never widens it.
	it('keeps a side within `onlyFor`: one mandate\'s own for the mandates\' side, nothing of the owner\'s', async () => {
		ch.subscribe('https://push.example/eva', 'k', 'a', EVA);
		ch.subscribe('https://push.example/max', 'k', 'a', mandate('max@example.invalid', 'TEST-MANDATE-2'));
		await ch.sendDetailed({ title: 't', body: 'b', priority: 'normal', audience: 'mandates', mandateId: 'TEST-MANDATE-1' }, EVA);
		expect(sendCalls()).toEqual(['https://push.example/eva']);
		(webPush.sendNotification as ReturnType<typeof vi.fn>).mockClear();
		// A grant named on the message cannot reach past `onlyFor`.
		expect((await ch.sendDetailed({ title: 't', body: 'b', priority: 'normal', audience: 'mandates', mandateId: 'TEST-MANDATE-2' }, EVA)).sent).toBe(0);
		expect(sendCalls()).toEqual([]);
		(webPush.sendNotification as ReturnType<typeof vi.fn>).mockClear();
		expect((await ch.sendDetailed({ title: 't', body: 'b', priority: 'normal', audience: 'owner' }, EVA)).sent).toBe(0);
		expect(sendCalls()).toEqual([]);
	});

	it('does not count an owner message as delivered when only a mandate\'s device exists', async () => {
		ch.unsubscribe('https://push.example/abc');
		ch.subscribe('https://push.example/eva', 'k', 'a', EVA);
		expect(await ch.send({ title: 't', body: 'b', priority: 'normal', audience: 'owner' })).toBe('failed');
		expect(sendCalls()).toEqual([]);
		// Without an audience, the mandate's device is reached, but only as someone other than the owner.
		expect(await ch.send({ title: 't', body: 'b', priority: 'normal' })).toBe('reached_others');
		// The mandates' side counts its own: reaching the mandate is its delivery.
		expect(await ch.send({ title: 't', body: 'b', priority: 'normal', audience: 'mandates', mandateId: 'TEST-MANDATE-1' })).toBe('delivered');
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
