import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { t, tf, setLocale, getLocale } from '../i18n.svelte.js';
import { reset, setTarget, startMigration, cancelMigration, getStep, getRetry, getError, getErrorReason, getErrorNotStarted, MIGRATION_HOLD_MS } from '../stores/migration.svelte.js';
import { getToasts, dismissToast } from '../stores/toast.svelte.js';
import { _resetManagedStatus } from '../stores/integrations/managed.svelte.js';

// `svelte` resolves to its server entry under node, where `mount` throws. The component is compiled
// for the client, so it is mounted with the client entry, loaded by path.
const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

// The wizard's error state: one place for the error, the UI's own words in the UI's language with
// the engine's sentence as its detail, a retry that follows what the engine says, and the step marks
// staying where the error came.

const SENTENCE = 'The target instance could not restore the data. It says: "Cannot restore — not all chunks received.". You can start the migration again in 30 minutes at the latest.';
let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let events: string;
/** When set, how the export route answers instead of the event stream. */
let exportAnswer: (() => Response) | null;
/** When set, how the preview route answers. */
let previewAnswer: (() => Response) | null;

beforeEach(() => {
	reset();
	for (const toast of getToasts()) dismissToast(toast.id);
	target = document.createElement('div');
	document.body.appendChild(target);
	_resetManagedStatus();
	events = '';
	exportAnswer = null;
	previewAnswer = null;
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const u = String(url);
		if (u.endsWith('/migration/export') && exportAnswer) return exportAnswer();
		if (u.endsWith('/migration/preview') && previewAnswer) return previewAnswer();
		if (u.endsWith('/migration/export')) return new Response(events, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
		const body = u.endsWith('/config') ? { billing_tier_set: false } : { secrets: 1, databases: ['engine.db'], artifacts: 0, hasConfig: true };
		return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
	}));
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

const sse = (e: string, d: unknown): string => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`;

async function failWith(error: Record<string, unknown>): Promise<void> {
	events = sse('progress', { phase: 'restoring', message: 'Restoring data on target...' }) + sse('error', error);
	const { default: MigrationWizard } = await import('./MigrationWizard.svelte');
	component = mount(MigrationWizard, { target });
	await settle();
	setTarget('https://target.example.com', 'a'.repeat(64));
	await startMigration();
	await settle();
	expect(getStep()).toBe('error');
}

const q = (id: string): HTMLElement | null => target.querySelector(`[data-testid="${id}"]`);
const text = (id: string): string | undefined => q(id)?.textContent?.trim();
const retryButton = (): HTMLButtonElement | null => q('migration-retry') as HTMLButtonElement | null;
const marks = (): string[] => [...target.querySelectorAll('.rounded-full.transition-all')].map((m) => (m.className.includes('w-6') ? 'here' : m.className.includes('bg-accent/50') ? 'past' : 'ahead'));

describe('the migration wizard after an error', () => {
	for (const lang of ['de', 'en'] as const) {
		it(`says it in the UI's language and keeps the engine's sentence as its English detail, once (${lang})`, async () => {
			const before = getLocale();
			setLocale(lang);
			try {
				await failWith({ message: SENTENCE, retry: 'now' });
				expect(text('migration-error-title')).toBe(t('migration.error_title'));
				expect(text('migration-error-detail')).toBe(SENTENCE);
				expect(q('migration-error-detail')?.getAttribute('lang')).toBe('en');
				// The card is the one place: no toast on top of it.
				expect(getToasts()).toHaveLength(0);
			} finally {
				setLocale(before);
			}
		});
	}

	it('offers the retry at once when the engine says now', async () => {
		await failWith({ message: SENTENCE, retry: 'now' });
		expect(retryButton()?.disabled).toBe(false);
		expect(q('migration-retry-from')).toBeNull();
		expect(q('migration-check-target')).toBeNull();
	});

	it('holds the retry until the target has released its session, and opens it then without a reload', async () => {
		vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
		vi.setSystemTime(new Date('2026-11-18T13:05:00Z'));
		await failWith({ message: SENTENCE, retry: 'later' });
		const time = new Date(Date.now() + MIGRATION_HOLD_MS).toLocaleTimeString(getLocale() === 'de' ? 'de-CH' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
		expect(retryButton()?.disabled).toBe(true);
		expect(text('migration-retry-from')).toBe(tf('migration.retry_from', { time }));
		vi.advanceTimersByTime(MIGRATION_HOLD_MS - 60_000);
		await settle();
		expect(retryButton()?.disabled).toBe(true);
		vi.advanceTimersByTime(75_000);
		await settle();
		expect(retryButton()?.disabled).toBe(false);
		expect(q('migration-retry-from')).toBeNull();
	});

	it('asks to check the target first, with no retry, when the restore may have run', async () => {
		await failWith({ message: 'The target instance could not restore the data. It says: "x". Check on the target instance whether your data arrived before you migrate again.', retry: 'check' });
		expect(text('migration-check-target')).toBe(t('migration.check_target_first'));
		expect(retryButton()).toBeNull();
	});

	it('takes an unknown or missing retry as now', async () => {
		await failWith({ message: SENTENCE, retry: 'soon' });
		expect(getRetry()).toBe('now');
		expect(retryButton()?.disabled).toBe(false);
	});

	it('keeps the step marks at the step the error came from', async () => {
		await failWith({ message: SENTENCE, retry: 'now' });
		expect(marks()).toEqual(['past', 'past', 'here', 'ahead']);
	});

	it('shows no English phase sentence under the localized phase while transferring', async () => {
		const { default: MigrationWizard } = await import('./MigrationWizard.svelte');
		let release: (() => void) | undefined;
		vi.stubGlobal('fetch', vi.fn(async (url: string) => {
			const u = String(url);
			if (u.endsWith('/migration/export')) {
				const body = new ReadableStream<Uint8Array>({
					start(c) {
						c.enqueue(new TextEncoder().encode(sse('progress', { phase: 'restoring', message: 'Restoring data on target...' })));
						release = () => c.close();
					},
				});
				return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
			}
			return new Response(JSON.stringify(u.endsWith('/config') ? {} : { secrets: 1, databases: ['engine.db'], artifacts: 0, hasConfig: true }), { status: 200 });
		}));
		component = mount(MigrationWizard, { target });
		await settle();
		setTarget('https://target.example.com', 'a'.repeat(64));
		const running = startMigration();
		await settle();
		expect(getStep()).toBe('transferring');
		expect(target.textContent).toContain(t('migration.restoring'));
		expect(target.textContent).not.toContain('Restoring data on target...');
		release?.();
		await running;
	});
});

describe('the migration wizard when this instance does not start the migration', () => {
	async function refusedWith(answer: () => Response): Promise<void> {
		exportAnswer = answer;
		const { default: MigrationWizard } = await import('./MigrationWizard.svelte');
		component = mount(MigrationWizard, { target });
		await settle();
		setTarget('https://target.example.com', 'a'.repeat(64));
		await startMigration();
		await settle();
		expect(getStep()).toBe('error');
	}

	for (const lang of ['de', 'en'] as const) {
		it(`says so in its own words and shows its reason beside it, in a box, not as the engine's (${lang})`, async () => {
			const before = getLocale();
			setLocale(lang);
			try {
				await refusedWith(() => new Response(JSON.stringify({ error: 'targetUrl must resolve to a public host' }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
				expect(text('migration-error-title')).toBe(t('migration.error_title_not_started'));
				expect(text('migration-error-detail')).toBe(t('migration.error_not_started'));
				expect(q('migration-error-detail')?.getAttribute('lang')).toBeNull();
				expect(text('migration-error-reason')).toBe(`${t('migration.error_reason')} targetUrl must resolve to a public host`);
				// The reason is someone else's value: in its own isolated box, not part of the sentence.
				expect(q('migration-error-reason')?.querySelector('bdi[data-foreign-value]')?.textContent).toBe('targetUrl must resolve to a public host');
				expect(q('migration-error-reason')?.getAttribute('lang')).toBeNull();
				expect(getRetry()).toBe('now');
			} finally {
				setLocale(before);
			}
		});
	}

	it('shows no reason for an answer that is not the instance\'s JSON, such as a proxy\'s error page', async () => {
		await refusedWith(() => new Response('<html><body><h1>502 Bad Gateway</h1></body></html>', { status: 502, headers: { 'Content-Type': 'text/html' } }));
		expect(text('migration-error-title')).toBe(t('migration.error_title_not_started'));
		expect(text('migration-error-detail')).toBe(t('migration.error_not_started'));
		expect(q('migration-error-reason')).toBeNull();
		expect(target.textContent).not.toContain('Bad Gateway');
	});

	it('shows the reason on one line, without control or bidi characters, and cut', async () => {
		await refusedWith(() => new Response(JSON.stringify({ error: `bad\n\u202Eline\u0007 ${'x'.repeat(400)}` }), { status: 400 }));
		const reason = text('migration-error-reason') ?? '';
		expect(reason).not.toMatch(/[\n\u202E\u0007]/);
		expect(reason.startsWith(`${t('migration.error_reason')} bad line x`)).toBe(true);
		expect(reason.endsWith('…')).toBe(true);
		expect([...reason].length).toBe([...`${t('migration.error_reason')} `].length + 200);
	});

	it('clears the reason, and that it did not start, once the user starts over', async () => {
		await refusedWith(() => new Response(JSON.stringify({ error: 'targetUrl must resolve to a public host' }), { status: 400 }));
		expect(q('migration-error-reason')).not.toBeNull();
		reset();
		await settle();
		expect(getErrorReason()).toBe('');
		expect(getErrorNotStarted()).toBe(false);
		expect(q('migration-error-reason')).toBeNull();
	});

	it('does not keep the reason under a later error of another kind', async () => {
		await refusedWith(() => new Response(JSON.stringify({ error: 'targetUrl must resolve to a public host' }), { status: 400 }));
		expect(q('migration-error-reason')).not.toBeNull();
		// The next attempt starts, and the engine stops it with its own sentence.
		exportAnswer = null;
		events = sse('error', { message: SENTENCE, retry: 'later' });
		await startMigration();
		await settle();
		expect(text('migration-error-detail')).toBe(SENTENCE);
		expect(q('migration-error-reason')).toBeNull();
		// It started this time, so it did not finish.
		expect(text('migration-error-title')).toBe(t('migration.error_title'));
	});

	it('shows no reason from an answer longer than it reads', async () => {
		await refusedWith(() => new Response(JSON.stringify({ error: 'x'.repeat(9000) }), { status: 400 }));
		expect(text('migration-error-detail')).toBe(t('migration.error_not_started'));
		expect(q('migration-error-reason')).toBeNull();
	});

	it('keeps the user\'s cancel when the refusal arrives while its answer is still being read', async () => {
		let finish: (() => void) | undefined;
		exportAnswer = () => new Response(new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(new TextEncoder().encode('{"error":"targetUrl must'));
				finish = () => { c.enqueue(new TextEncoder().encode(' resolve to a public host"}')); c.close(); };
			},
		}), { status: 400 });
		const { default: MigrationWizard } = await import('./MigrationWizard.svelte');
		component = mount(MigrationWizard, { target });
		await settle();
		setTarget('https://target.example.com', 'a'.repeat(64));
		const started = startMigration();
		await settle();
		cancelMigration();
		finish?.();
		await started;
		await settle();
		expect(getError()).toBe(t('migration.cancelled'));
		expect(getErrorReason()).toBe('');
		expect(q('migration-error-reason')).toBeNull();
	});
});

describe('the migration wizard when the event stream breaks', () => {
	it('shows the browser\'s text as its own, not marked as the engine\'s sentence', async () => {
		exportAnswer = () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.error(new Error('stream broke')); } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
		const { default: MigrationWizard } = await import('./MigrationWizard.svelte');
		component = mount(MigrationWizard, { target });
		await settle();
		setTarget('https://target.example.com', 'a'.repeat(64));
		await startMigration();
		await settle();
		expect(getStep()).toBe('error');
		expect(getError()).toBe('stream broke');
		expect(text('migration-error-detail')).toBe('stream broke');
		expect(q('migration-error-detail')?.getAttribute('lang')).toBeNull();
	});
});

describe('the migration wizard when the preview cannot be loaded', () => {
	it('says so in its own words, not with the answer\'s text', async () => {
		previewAnswer = () => new Response('<html><body><h1>502 Bad Gateway</h1></body></html>', { status: 502, headers: { 'Content-Type': 'text/html' } });
		const { default: MigrationWizard } = await import('./MigrationWizard.svelte');
		component = mount(MigrationWizard, { target });
		await settle();
		expect(getError()).toBe(t('migration.error_preview'));
		expect(target.textContent).toContain(t('migration.error_preview'));
		expect(target.textContent).not.toContain('Bad Gateway');
	});
});
