import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setPromptAttention, clearPromptAttention } from './prompt-attention.js';

// The util reads document/window/Notification (guarded for SSR). vitest runs in the
// node environment (no DOM), so we stub them — mirroring the real browser contract:
// a title-bar badge while the tab is hidden + at most one notification per prompt.

interface NotifRec { title: string; body?: string | undefined; closed: boolean }
let notifications: NotifRec[] = [];
let listeners: Record<string, Array<() => void>> = {};
const LABELS = { badge: 'Antwort nötig · lynox', notifyTitle: 'lynox wartet auf deine Antwort', notifyBody: 'Frage?' };

const fakeDoc = {
	hidden: true,
	title: 'lynox — Chat',
	addEventListener(ev: string, cb: () => void) { (listeners[ev] ||= []).push(cb); },
	removeEventListener(ev: string, cb: () => void) { listeners[ev] = (listeners[ev] || []).filter((f) => f !== cb); },
};
class FakeNotification {
	static permission = 'granted';
	onclick: (() => void) | null = null;
	rec: NotifRec;
	constructor(title: string, opts?: { body?: string; tag?: string }) {
		this.rec = { title, body: opts?.body, closed: false };
		notifications.push(this.rec);
	}
	close() { this.rec.closed = true; }
}
function fireVisibility() { (listeners['visibilitychange'] || []).forEach((f) => f()); }

beforeEach(() => {
	notifications = [];
	listeners = {};
	fakeDoc.hidden = true;
	fakeDoc.title = 'lynox — Chat';
	FakeNotification.permission = 'granted';
	(globalThis as unknown as { document: unknown }).document = fakeDoc;
	(globalThis as unknown as { window: unknown }).window = { focus() {} };
	(globalThis as unknown as { Notification: unknown }).Notification = FakeNotification;
});
afterEach(() => {
	clearPromptAttention();
	delete (globalThis as unknown as { document?: unknown }).document;
	delete (globalThis as unknown as { window?: unknown }).window;
	delete (globalThis as unknown as { Notification?: unknown }).Notification;
});

describe('prompt-attention (out-of-tab pending-prompt signal)', () => {
	it('hidden tab + new prompt → title badge + exactly one notification', () => {
		setPromptAttention('p1', LABELS);
		expect(fakeDoc.title).toBe('● Antwort nötig · lynox');
		expect(notifications).toHaveLength(1);
		expect(notifications[0]!.title).toBe(LABELS.notifyTitle);
	});

	it('same prompt again → no second notification (dedupe by key)', () => {
		setPromptAttention('p1', LABELS);
		setPromptAttention('p1', LABELS);
		expect(notifications).toHaveLength(1);
	});

	it('tab becomes visible → title restored, notification closed (prompt still pending)', () => {
		setPromptAttention('p1', LABELS);
		fakeDoc.hidden = false;
		fireVisibility();
		expect(fakeDoc.title).toBe('lynox — Chat');
		expect(notifications[0]!.closed).toBe(true);
	});

	it('new prompt while VISIBLE → no notification, no badge (user is looking)', () => {
		fakeDoc.hidden = false;
		setPromptAttention('p2', LABELS);
		expect(notifications).toHaveLength(0);
		expect(fakeDoc.title).toBe('lynox — Chat');
	});

	it('does NOT fire when permission is not granted', () => {
		FakeNotification.permission = 'default';
		setPromptAttention('p1', LABELS);
		expect(notifications).toHaveLength(0);
		expect(fakeDoc.title).toBe('● Antwort nötig · lynox'); // badge still applies (no permission needed)
	});

	it('clear → title restored + visibility listener removed', () => {
		setPromptAttention('p1', LABELS);
		clearPromptAttention();
		expect(fakeDoc.title).toBe('lynox — Chat');
		expect(listeners['visibilitychange'] ?? []).toHaveLength(0);
	});

	it('null key clears the signal (equivalent to clear)', () => {
		setPromptAttention('p1', LABELS);
		setPromptAttention(null, LABELS);
		expect(fakeDoc.title).toBe('lynox — Chat');
	});

	it('a NEW prompt key after answering fires a fresh notification', () => {
		setPromptAttention('p1', LABELS);
		expect(notifications).toHaveLength(1);
		setPromptAttention('p2', LABELS); // different pending prompt
		expect(notifications).toHaveLength(2);
	});
});
