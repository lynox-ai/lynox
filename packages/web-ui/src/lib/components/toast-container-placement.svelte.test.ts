import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// Below `sm` a standing toast sat at the bottom, on the chat input. It now sits at the top, under the
// header, newest first; from `sm` up it stays bottom right, newest last. jsdom has no media queries,
// so the placement is read from the container's classes.

const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element; props: Record<string, unknown> }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
};
let svelte: SvelteClient;
let target: HTMLElement;
let component: Record<string, unknown> | undefined;

beforeEach(async () => {
	vi.resetModules();
	svelte = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(() => {
	if (component) svelte.unmount(component);
	component = undefined;
	target.remove();
});

async function render(messages: string[]): Promise<HTMLElement> {
	const { addToast } = await import('../stores/toast.svelte.js');
	const { default: ToastContainer } = await import('./ToastContainer.svelte');
	component = svelte.mount(ToastContainer, { target, props: {} });
	for (const m of messages) addToast(m, 'error', null);
	svelte.flushSync();
	return target.querySelector('[data-testid="toast-container"]') as HTMLElement;
}

const classes = (el: HTMLElement): string[] => el.className.split(/\s+/);

describe('where a toast stands', () => {
	// 3.5rem is the app header's h-12 (3rem, AppShell) plus a 0.5rem gap, below the safe area.
	it('below sm: its class puts it at the top, at safe area + 3.5rem, not at the bottom', async () => {
		const c = classes(await render(['a']));
		expect(c).toContain('top-[calc(env(safe-area-inset-top,0px)+3.5rem)]');
		expect(c, 'no bottom anchor below sm').not.toContain('bottom-4');
		expect(c).toContain('left-4');
		expect(c).toContain('right-4');
	});

	it('from sm up: bottom right, as before', async () => {
		const c = classes(await render(['a']));
		expect(c).toContain('sm:top-auto');
		expect(c).toContain('sm:bottom-4');
		expect(c).toContain('sm:left-auto');
		expect(c).toContain('sm:max-w-sm');
	});

	it('below sm the newest stands first, from sm up last', async () => {
		const el = await render(['older', 'newer']);
		const c = classes(el);
		expect(c).toContain('flex-col-reverse');
		expect(c).toContain('sm:flex-col');
		// DOM order stays oldest first; the reverse column puts the newest on top below sm.
		expect([...el.children].map((n) => n.textContent?.trim())).toEqual(['older', 'newer']);
	});

	it('keeps the live region and the alert role', async () => {
		const el = await render(['a']);
		expect(el.getAttribute('aria-live')).toBe('polite');
		expect(el.querySelector('[role="alert"]')?.textContent).toContain('a');
	});
});
