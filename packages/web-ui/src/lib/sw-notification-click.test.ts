import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

// The served service worker is plain script, so it is run as it is served: parsed and executed in
// a fresh context with a stand-in `self`, and the click handler it registers is called with a
// notification. Reading it as text would pass on a script that does not even parse.

const SW = readFileSync(fileURLToPath(new URL('../../static/sw.js', import.meta.url)), 'utf-8');

type Listener = (event: unknown) => void;

/** Clicks a notification carrying `data` with no lynox tab open; returns the URL it opens. */
async function clickWith(data: Record<string, string> | undefined): Promise<string[]> {
	const listeners = new Map<string, Listener>();
	const opened: string[] = [];
	const self = {
		addEventListener: (type: string, fn: Listener) => { listeners.set(type, fn); },
		registration: { scope: 'https://instance.example/', showNotification: async () => {} },
		clients: {
			matchAll: async () => [],
			openWindow: async (url: string) => { opened.push(url); return null; },
		},
	};
	runInNewContext(SW, { self });
	const click = listeners.get('notificationclick');
	if (click === undefined) throw new Error('sw.js registered no notificationclick listener');
	let done: Promise<unknown> = Promise.resolve();
	click({ notification: { close: () => {}, data }, waitUntil: (p: Promise<unknown>) => { done = p; } });
	await done;
	return opened;
}

describe('service worker — where a click on a push leads', () => {
	// The owner's approval push carries `approvals` (with the channel's own `priority` and `taskId`
	// beside it); a tap opens the list of mails waiting for approval.
	it('opens the approval list for the owner\'s approval push', async () => {
		expect(await clickWith({ approvals: '1', priority: 'normal', taskId: 'lynox-approval-queue' })).toEqual(['/app/approvals']);
	});

	// A mandate's push about the same mail carries no mark: it opens nothing that leads to an approval.
	it('opens the start page for a mandate\'s approval push', async () => {
		expect(await clickWith({ priority: 'normal', taskId: 'lynox-approval-queue-mandate' })).toEqual(['/']);
		expect(await clickWith(undefined)).toEqual(['/']);
	});

	// The owner's notice that plans are paused: a tap opens the plans view, where the notice
	// stands in full (the push shortens the name to fit).
	it('opens the plans view for the paused-plans push', async () => {
		expect(await clickWith({ pausedPlans: '1', priority: 'high' })).toEqual(['/app/hub?section=triggers']);
		expect(await clickWith({ approvals: '1', pausedPlans: '1' })).toEqual(['/app/approvals']);
	});

	// Controls: the existing deep links keep their targets and take precedence.
	it('keeps the inbox and thread deep links', async () => {
		expect(await clickWith({ itemId: 'i-1' })).toEqual(['/app/inbox?item=i-1']);
		expect(await clickWith({ threadId: 't-1' })).toEqual(['/app?thread=t-1']);
		expect(await clickWith({ threadId: 't-1', approvals: '1' })).toEqual(['/app?thread=t-1']);
	});
});
